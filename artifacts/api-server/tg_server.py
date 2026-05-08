import asyncio
import json
import os
import random
import re
import shutil
import sqlite3
import tempfile
import time
import uuid
import zipfile
from pathlib import Path
from typing import AsyncGenerator

import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from telethon import TelegramClient
from telethon.errors import (
    FloodWaitError,
    PeerIdInvalidError,
    UsernameInvalidError,
    UsernameNotOccupiedError,
    SessionPasswordNeededError,
)
from telethon.tl.functions.account import ReportPeerRequest
from telethon.tl.types import (
    InputReportReasonSpam,
    InputReportReasonViolence,
    InputReportReasonChildAbuse,
    InputReportReasonPornography,
    InputReportReasonCopyright,
    InputReportReasonOther,
)

# ─── Config ────────────────────────────────────────────────────────────────────
API_ID = 2040
API_HASH = "b18441a1ff607e10a989891a5462e627"
PORT = int(os.environ.get("PORT", 8080))
BASE = "/api"

SESSIONS_DIR = Path("tg_sessions")
DB_PATH = Path("tg_reporter.db")
TDATA_WORK = Path("tdata_tmp")

SESSIONS_DIR.mkdir(exist_ok=True)
TDATA_WORK.mkdir(exist_ok=True)

# ─── Database ──────────────────────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS accounts (
                id TEXT PRIMARY KEY,
                phone TEXT,
                username TEXT,
                first_name TEXT,
                session_file TEXT,
                status TEXT DEFAULT 'active',
                created_at REAL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS report_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT,
                level TEXT,
                message TEXT,
                ts REAL
            )
        """)
        conn.commit()


init_db()

# ─── Reason map ────────────────────────────────────────────────────────────────
REASON_OBJECTS = {
    "spam":        InputReportReasonSpam,
    "violence":    InputReportReasonViolence,
    "child_abuse": InputReportReasonChildAbuse,
    "pornography": InputReportReasonPornography,
    "copyright":   InputReportReasonCopyright,
    "other":       InputReportReasonOther,
}

REASON_LABELS = {
    "spam":        "Спам",
    "violence":    "Насилие",
    "child_abuse": "Детская порнография",
    "pornography": "Порнография",
    "copyright":   "Авторские права",
    "other":       "Другое",
}

# ─── SSE queues ────────────────────────────────────────────────────────────────
job_queues: dict[str, asyncio.Queue] = {}

# ─── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(root_path=BASE)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Models ────────────────────────────────────────────────────────────────────
class ReportRequest(BaseModel):
    target: str
    reason: str
    custom_message: str = ""
    account_ids: list[str] = []


# ─── Helpers ───────────────────────────────────────────────────────────────────
def log_to_db(job_id: str, level: str, message: str):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO report_log (job_id, level, message, ts) VALUES (?,?,?,?)",
            (job_id, level, message, time.time()),
        )
        conn.commit()


async def push_log(job_id: str, level: str, message: str):
    log_to_db(job_id, level, message)
    q = job_queues.get(job_id)
    if q:
        await q.put({"level": level, "message": message, "ts": time.time()})


async def get_client(session_file: str) -> TelegramClient:
    path = str(SESSIONS_DIR / session_file)
    client = TelegramClient(path, API_ID, API_HASH)
    await client.connect()
    return client


def resolve_target(raw: str) -> str:
    raw = raw.strip()
    raw = re.sub(r"^https?://t\.me/", "@", raw)
    raw = re.sub(r"^t\.me/", "@", raw)
    return raw


async def report_one(client: TelegramClient, target: str, reason_key: str, custom_message: str, job_id: str):
    display = target
    try:
        entity = await client.get_entity(target)
        peer = await client.get_input_entity(entity)
        reason_cls = REASON_OBJECTS.get(reason_key, InputReportReasonSpam)
        message_text = custom_message if reason_key == "other" and custom_message else ""
        await client(ReportPeerRequest(peer=peer, reason=reason_cls(), message=message_text))
        await push_log(job_id, "success", f"✓ Пожаловались на {display}")
        return True
    except FloodWaitError as e:
        await push_log(job_id, "warn", f"⚠ Flood wait {e.seconds}с — пауза аккаунта")
        await asyncio.sleep(min(e.seconds, 30))
        return False
    except (PeerIdInvalidError, UsernameInvalidError, UsernameNotOccupiedError, ValueError):
        await push_log(job_id, "error", f"✗ Не найдено: {display} — пропуск")
        return False
    except Exception as e:
        await push_log(job_id, "error", f"✗ Ошибка {display}: {type(e).__name__}: {e}")
        return False


# ─── Routes ────────────────────────────────────────────────────────────────────

@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/sessions")
def list_sessions():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM accounts ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]


@app.delete("/sessions/{account_id}")
def delete_session(account_id: str):
    with get_db() as conn:
        row = conn.execute("SELECT session_file FROM accounts WHERE id=?", (account_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Аккаунт не найден")
        sf = row["session_file"]
        for ext in ["", ".session"]:
            p = SESSIONS_DIR / (sf + ext)
            if p.exists():
                p.unlink()
        conn.execute("DELETE FROM accounts WHERE id=?", (account_id,))
        conn.commit()
    return {"ok": True}


@app.post("/sessions/import")
async def import_sessions(file: UploadFile = File(...)):
    """Принимает ZIP-архив с одной или несколькими папками TData."""
    suffix = Path(file.filename or "upload").suffix.lower()
    if suffix not in (".zip",):
        raise HTTPException(400, "Ожидается ZIP-файл")

    work_dir = TDATA_WORK / str(uuid.uuid4())
    work_dir.mkdir(parents=True)

    try:
        zip_bytes = await file.read()
        zip_path = work_dir / "upload.zip"
        zip_path.write_bytes(zip_bytes)

        with zipfile.ZipFile(zip_path) as z:
            z.extractall(work_dir / "extracted")

        imported = 0
        errors = []
        extracted = work_dir / "extracted"

        # Find TData folders (contain a 'key_data' file)
        tdata_dirs = []
        for p in extracted.rglob("key_datas"):
            tdata_dirs.append(p.parent)
        if not tdata_dirs:
            # Maybe the root IS the tdata folder
            if (extracted / "key_datas").exists():
                tdata_dirs = [extracted]

        if not tdata_dirs:
            raise HTTPException(400, "TData-папки не найдены в архиве. Убедитесь, что папка содержит файл 'key_datas'.")

        for tdata_dir in tdata_dirs[:1000]:
            acc_id = str(uuid.uuid4())
            session_file = acc_id
            try:
                try:
                    from opentele.td import TDesktop
                    from opentele.api import UseCurrentSession, API as OtelAPI

                    tdesk = TDesktop(str(tdata_dir))
                    if not tdesk.isLoaded():
                        errors.append(f"TData не загружена: {tdata_dir.name}")
                        continue

                    client = await tdesk.ToTelethon(
                        session=str(SESSIONS_DIR / session_file),
                        flag=UseCurrentSession,
                        api=OtelAPI.TelegramDesktop,
                    )
                    await client.connect()
                    me = await client.get_me()
                    await client.disconnect()

                    phone = getattr(me, "phone", "") or ""
                    username = getattr(me, "username", "") or ""
                    first_name = getattr(me, "first_name", "") or ""

                    with get_db() as conn:
                        conn.execute(
                            "INSERT OR REPLACE INTO accounts (id,phone,username,first_name,session_file,status,created_at) VALUES (?,?,?,?,?,?,?)",
                            (acc_id, phone, username, first_name, session_file, "active", time.time()),
                        )
                        conn.commit()
                    imported += 1

                except ImportError:
                    errors.append("Библиотека opentele не установлена. Установите: pip install opentele")
                    break

            except Exception as e:
                errors.append(f"Ошибка {tdata_dir.name}: {e}")

        return {"imported": imported, "errors": errors}

    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


@app.post("/report")
async def start_report(req: ReportRequest, background_tasks=None):
    if req.reason not in REASON_OBJECTS:
        raise HTTPException(400, f"Неизвестная причина: {req.reason}")
    if not req.target.strip():
        raise HTTPException(400, "Укажите цель")

    with get_db() as conn:
        if req.account_ids:
            placeholders = ",".join("?" * len(req.account_ids))
            rows = conn.execute(
                f"SELECT * FROM accounts WHERE id IN ({placeholders}) AND status='active'",
                req.account_ids,
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM accounts WHERE status='active' LIMIT 1000").fetchall()

    if not rows:
        raise HTTPException(400, "Нет активных аккаунтов. Импортируйте TData.")

    job_id = str(uuid.uuid4())
    job_queues[job_id] = asyncio.Queue()

    target = resolve_target(req.target)

    asyncio.create_task(run_report_job(job_id, target, req.reason, req.custom_message, [dict(r) for r in rows]))

    return {"job_id": job_id}


async def run_report_job(job_id: str, target: str, reason: str, custom_message: str, accounts: list):
    reason_label = REASON_LABELS.get(reason, reason)
    msg_suffix = f" ({custom_message})" if reason == "other" and custom_message else ""
    await push_log(job_id, "info", f"Старт репортинга: {target} | Причина: {reason_label}{msg_suffix}")
    await push_log(job_id, "info", f"Аккаунтов для работы: {len(accounts)}")

    success = 0
    failed = 0

    for i, acc in enumerate(accounts):
        sf = acc["session_file"]
        name = acc.get("first_name") or acc.get("username") or acc.get("phone") or acc["id"]
        await push_log(job_id, "info", f"[{i+1}/{len(accounts)}] Аккаунт: {name}")

        try:
            client = await get_client(sf)
            if not await client.is_user_authorized():
                await push_log(job_id, "warn", f"  Аккаунт {name}: не авторизован — пропуск")
                await client.disconnect()
                failed += 1
                continue

            ok = await report_one(client, target, reason, custom_message, job_id)
            await client.disconnect()
            if ok:
                success += 1
            else:
                failed += 1

        except Exception as e:
            await push_log(job_id, "error", f"  Подключение {name}: {e}")
            failed += 1

        if i < len(accounts) - 1:
            delay = random.uniform(3, 10)
            await push_log(job_id, "info", f"  Пауза {delay:.1f}с...")
            await asyncio.sleep(delay)

    await push_log(job_id, "info", f"Готово. Успешно: {success}, ошибок: {failed}")
    await push_log(job_id, "done", "DONE")

    q = job_queues.get(job_id)
    if q:
        await q.put(None)


@app.get("/report/stream/{job_id}")
async def stream_logs(job_id: str):
    q = job_queues.get(job_id)
    if q is None:
        # Replay historical logs
        with get_db() as conn:
            rows = conn.execute(
                "SELECT level, message, ts FROM report_log WHERE job_id=? ORDER BY id",
                (job_id,),
            ).fetchall()
        if not rows:
            raise HTTPException(404, "Job не найден")

        async def replay():
            for r in rows:
                yield f"data: {json.dumps({'level': r['level'], 'message': r['message'], 'ts': r['ts']})}\n\n"
            yield "data: {\"level\":\"done\",\"message\":\"DONE\"}\n\n"

        return StreamingResponse(replay(), media_type="text/event-stream")

    async def event_gen() -> AsyncGenerator[str, None]:
        while True:
            item = await asyncio.wait_for(q.get(), timeout=60)
            if item is None:
                yield "data: {\"level\":\"done\",\"message\":\"DONE\"}\n\n"
                job_queues.pop(job_id, None)
                break
            yield f"data: {json.dumps(item)}\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream")


@app.get("/logs")
def get_logs(job_id: str | None = None, limit: int = 200):
    with get_db() as conn:
        if job_id:
            rows = conn.execute(
                "SELECT * FROM report_log WHERE job_id=? ORDER BY id DESC LIMIT ?",
                (job_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM report_log ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
    return [dict(r) for r in reversed(rows)]


@app.get("/reasons")
def get_reasons():
    return [{"key": k, "label": v} for k, v in REASON_LABELS.items()]


# ─── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
