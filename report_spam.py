import asyncio
import os
import random
import sys

from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.errors import (
    FloodWaitError,
    PeerIdInvalidError,
    UsernameInvalidError,
    UsernameNotOccupiedError,
)
from telethon.tl.functions.messages import ReportSpamRequest
from telethon.tl.types import InputPeerChannel, InputPeerUser

load_dotenv("config.env")

API_ID = os.getenv("API_ID")
API_HASH = os.getenv("API_HASH")
PHONE_NUMBER = os.getenv("PHONE_NUMBER")

TARGETS_FILE = "targets.txt"
SESSION_FILE = "session"

MIN_DELAY = 3
MAX_DELAY = 10


def load_targets(path: str) -> list[str]:
    if not os.path.exists(path):
        print(f"[ERROR] Targets file '{path}' not found.")
        sys.exit(1)
    with open(path, "r", encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip() and not line.startswith("#")]
    if not lines:
        print("[ERROR] No targets found in targets.txt.")
        sys.exit(1)
    return lines


async def report_target(client: TelegramClient, target: str) -> None:
    print(f"\n[>] Processing target: {target}")
    try:
        entity = await client.get_entity(target)
        peer = await client.get_input_entity(entity)
        await client(ReportSpamRequest(peer=peer))
        print(f"[OK] Reported {target} for spam.")
    except FloodWaitError as e:
        print(f"[FLOOD] Rate limited by Telegram. Must wait {e.seconds} seconds. Exiting.")
        sys.exit(1)
    except (PeerIdInvalidError, UsernameInvalidError, UsernameNotOccupiedError):
        print(f"[SKIP] Target '{target}' not found or invalid. Skipping.")
    except ValueError as e:
        print(f"[SKIP] Could not resolve '{target}': {e}. Skipping.")
    except Exception as e:
        print(f"[ERROR] Unexpected error for '{target}': {type(e).__name__}: {e}. Skipping.")


async def main() -> None:
    if not API_ID or not API_HASH or not PHONE_NUMBER:
        print("[ERROR] API_ID, API_HASH, and PHONE_NUMBER must be set in config.env.")
        sys.exit(1)

    try:
        api_id = int(API_ID)
    except ValueError:
        print("[ERROR] API_ID must be an integer.")
        sys.exit(1)

    targets = load_targets(TARGETS_FILE)
    print(f"[INFO] Loaded {len(targets)} target(s) from {TARGETS_FILE}.")

    client = TelegramClient(SESSION_FILE, api_id, API_HASH)

    await client.start(phone=PHONE_NUMBER)
    print("[INFO] Logged in successfully.")

    for i, target in enumerate(targets):
        await report_target(client, target)

        if i < len(targets) - 1:
            delay = random.uniform(MIN_DELAY, MAX_DELAY)
            print(f"[WAIT] Sleeping {delay:.1f}s before next report...")
            await asyncio.sleep(delay)

    await client.disconnect()
    print("\n[DONE] All targets processed.")


if __name__ == "__main__":
    asyncio.run(main())
