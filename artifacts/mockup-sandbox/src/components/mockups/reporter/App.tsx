import { useEffect, useRef, useState } from "react";

const BASE = "/api";

// ─── Types ─────────────────────────────────────────────────────────────────────
interface Account {
  id: string;
  phone: string;
  username: string;
  first_name: string;
  status: string;
  created_at: number;
}

interface LogEntry {
  level: "info" | "success" | "error" | "warn" | "done";
  message: string;
  ts: number;
}

interface Reason {
  key: string;
  label: string;
}

const DEFAULT_REASONS: Reason[] = [
  { key: "spam",        label: "Спам" },
  { key: "violence",    label: "Насилие" },
  { key: "child_abuse", label: "Детская порнография" },
  { key: "pornography", label: "Порнография" },
  { key: "copyright",   label: "Авторские права" },
  { key: "other",       label: "Другое" },
];

// ─── Helpers ────────────────────────────────────────────────────────────────────
function fmt(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString("ru-RU");
}

const LOG_COLOR: Record<string, string> = {
  success: "text-emerald-400",
  error:   "text-red-400",
  warn:    "text-amber-400",
  info:    "text-slate-300",
  done:    "text-sky-400",
};

// ─── API calls ─────────────────────────────────────────────────────────────────
async function apiFetch(path: string, opts?: RequestInit) {
  const r = await fetch(`${BASE}${path}`, opts);
  if (!r.ok) {
    const body = await r.text();
    throw new Error(body || r.statusText);
  }
  return r.json();
}

// ─── Subcomponents ─────────────────────────────────────────────────────────────
function Badge({ children, color = "bg-slate-700 text-slate-300" }: { children: React.ReactNode; color?: string }) {
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${color}`}>{children}</span>;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">{children}</h2>;
}

// ─── Main component ────────────────────────────────────────────────────────────
export function App() {
  const [tab, setTab] = useState<"report" | "accounts" | "logs">("report");

  // Report form
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("spam");
  const [customMsg, setCustomMsg] = useState("");
  const [selectedAccIds, setSelectedAccIds] = useState<string[]>([]);

  // Accounts
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Job / logs
  const [jobId, setJobId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [errMsg, setErrMsg] = useState("");
  const logsEndRef = useRef<HTMLDivElement>(null);

  // SSE ref
  const esRef = useRef<EventSource | null>(null);

  // Load accounts on mount and tab switch
  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    try {
      const data: Account[] = await apiFetch("/sessions");
      setAccounts(data);
    } catch {
      // backend not ready yet
    }
  }

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => esRef.current?.close();
  }, []);

  // ─── Import TData ──────────────────────────────────────────────────────────
  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportMsg(null);

    const fd = new FormData();
    fd.append("file", file);

    try {
      const res = await apiFetch("/sessions/import", { method: "POST", body: fd });
      await loadAccounts();
      const errList: string[] = res.errors ?? [];
      setImportMsg({
        ok: res.imported > 0,
        text: `Импортировано: ${res.imported} аккаунт(ов).` + (errList.length ? ` Ошибки: ${errList.slice(0, 3).join("; ")}` : ""),
      });
    } catch (err: unknown) {
      setImportMsg({ ok: false, text: String(err) });
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleDeleteAccount(id: string) {
    try {
      await apiFetch(`/sessions/${id}`, { method: "DELETE" });
      setAccounts((prev) => prev.filter((a) => a.id !== id));
    } catch (err: unknown) {
      alert("Ошибка удаления: " + String(err));
    }
  }

  function toggleAccId(id: string) {
    setSelectedAccIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  // ─── Report ────────────────────────────────────────────────────────────────
  async function handleReport() {
    if (!target.trim()) { setErrMsg("Введите цель"); return; }
    if (accounts.length === 0) { setErrMsg("Импортируйте аккаунты"); return; }
    setErrMsg("");
    setRunning(true);
    setLogs([]);
    setJobId(null);
    esRef.current?.close();

    try {
      const res = await apiFetch("/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          reason,
          custom_message: customMsg,
          account_ids: selectedAccIds,
        }),
      });
      const jid: string = res.job_id;
      setJobId(jid);
      setTab("logs");

      const es = new EventSource(`${BASE}/report/stream/${jid}`);
      esRef.current = es;

      es.onmessage = (e) => {
        const entry: LogEntry = JSON.parse(e.data);
        setLogs((prev) => [...prev, entry]);
        if (entry.level === "done") {
          es.close();
          setRunning(false);
          loadAccounts();
        }
      };
      es.onerror = () => {
        es.close();
        setRunning(false);
      };
    } catch (err: unknown) {
      setErrMsg(String(err));
      setRunning(false);
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  const activeAccounts = accounts.filter((a) => a.status === "active");
  const successCount = logs.filter((l) => l.level === "success").length;
  const errorCount   = logs.filter((l) => l.level === "error").length;

  return (
    <div className="min-h-screen bg-[#0e1117] text-slate-100 font-sans flex flex-col select-none">

      {/* Header */}
      <header className="bg-[#161b27] border-b border-slate-700/50 px-5 py-3 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-blue-700 flex items-center justify-center font-bold text-sm shadow">T</div>
        <div className="flex-1">
          <h1 className="text-sm font-semibold leading-tight">Telegram Репортёр</h1>
          <p className="text-[11px] text-slate-500">Массовая жалоба на спам и нарушения</p>
        </div>
        <Badge color={running ? "bg-amber-500/20 text-amber-400" : "bg-emerald-500/20 text-emerald-400"}>
          {running ? "Работает..." : "Готово"}
        </Badge>
      </header>

      {/* Tabs */}
      <div className="bg-[#161b27] border-b border-slate-700/40 px-5 flex gap-0.5">
        {([
          { key: "report",   label: "Жалоба" },
          { key: "accounts", label: `Аккаунты (${activeAccounts.length})` },
          { key: "logs",     label: `Журнал${logs.length ? ` (${logs.length})` : ""}` },
        ] as { key: typeof tab; label: string }[]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === key
                ? "border-sky-500 text-sky-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-1 overflow-hidden">

        {/* ── Content ─────────────────────────────────────────────────────── */}
        <main className="flex-1 overflow-auto p-5">

          {/* ── REPORT TAB ──────────────────────────────────────────────── */}
          {tab === "report" && (
            <div className="max-w-xl space-y-5">
              <div>
                <SectionTitle>Цель (канал / чат / бот / пользователь)</SectionTitle>
                <input
                  type="text"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="@username, t.me/channel, -1001234567890"
                  className="w-full bg-[#1e2536] border border-slate-600/60 rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-sky-500 transition-colors font-mono"
                />
              </div>

              <div>
                <SectionTitle>Причина жалобы</SectionTitle>
                <div className="space-y-1.5">
                  {DEFAULT_REASONS.map((r) => (
                    <label
                      key={r.key}
                      className={`flex items-center gap-3 px-4 py-2.5 rounded-lg cursor-pointer border transition-all ${
                        reason === r.key
                          ? "border-sky-500/60 bg-sky-900/20 text-sky-300"
                          : "border-slate-700/40 bg-[#1e2536] text-slate-300 hover:border-slate-600"
                      }`}
                    >
                      <input
                        type="radio"
                        name="reason"
                        value={r.key}
                        checked={reason === r.key}
                        onChange={() => setReason(r.key)}
                        className="accent-sky-500"
                      />
                      <span className="text-sm">{r.label}</span>
                    </label>
                  ))}
                </div>

                {reason === "other" && (
                  <textarea
                    value={customMsg}
                    onChange={(e) => setCustomMsg(e.target.value)}
                    placeholder="Опишите нарушение подробнее..."
                    rows={3}
                    className="mt-3 w-full bg-[#1e2536] border border-slate-600/60 rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-sky-500 transition-colors resize-none"
                  />
                )}
              </div>

              {accounts.length > 0 && (
                <div>
                  <SectionTitle>Аккаунты для жалобы (оставьте пустым — все активные)</SectionTitle>
                  <div className="space-y-1 max-h-40 overflow-auto pr-1">
                    {accounts.map((a) => {
                      const name = a.first_name || a.username || a.phone || a.id.slice(0, 8);
                      const sub  = a.username ? `@${a.username}` : a.phone || "";
                      const sel  = selectedAccIds.includes(a.id);
                      return (
                        <label
                          key={a.id}
                          className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer border text-sm transition-all ${
                            sel
                              ? "border-sky-500/50 bg-sky-900/20"
                              : "border-slate-700/30 bg-[#1a2235] hover:border-slate-600"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={sel}
                            onChange={() => toggleAccId(a.id)}
                            className="accent-sky-500"
                          />
                          <span className="font-medium flex-1">{name}</span>
                          <span className="text-slate-500 text-xs">{sub}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {errMsg && (
                <p className="text-red-400 text-sm bg-red-900/20 border border-red-700/30 rounded-lg px-4 py-2">
                  {errMsg}
                </p>
              )}

              <button
                onClick={handleReport}
                disabled={running}
                className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-all ${
                  running
                    ? "bg-amber-600/20 text-amber-400 cursor-not-allowed"
                    : "bg-sky-600 hover:bg-sky-500 text-white shadow-md"
                }`}
              >
                {running ? "Репортинг идёт..." : "Подать жалобы"}
              </button>

              {accounts.length === 0 && (
                <div className="bg-amber-900/20 border border-amber-700/30 rounded-lg px-4 py-3 text-xs text-amber-400">
                  Сначала импортируйте аккаунты на вкладке <strong>«Аккаунты»</strong>.
                </div>
              )}
            </div>
          )}

          {/* ── ACCOUNTS TAB ────────────────────────────────────────────── */}
          {tab === "accounts" && (
            <div className="max-w-2xl space-y-5">
              <div>
                <SectionTitle>Импорт TData (до 1000 аккаунтов)</SectionTitle>
                <div className="bg-[#1a2235] border border-slate-700/40 rounded-lg p-4 space-y-3">
                  <p className="text-xs text-slate-400">
                    Упакуйте одну или несколько папок <code className="bg-slate-800 px-1 rounded">TData</code> в ZIP-архив и загрузите ниже.
                    Каждая папка — один аккаунт. Архив обрабатывается на сервере, сессии сохраняются локально.
                  </p>
                  <div className="flex items-center gap-3">
                    <label className={`flex-1 flex items-center justify-center py-2.5 rounded-lg text-sm font-medium cursor-pointer border transition-all ${
                      importing
                        ? "border-slate-600 text-slate-500 cursor-not-allowed"
                        : "border-sky-600/60 text-sky-400 hover:bg-sky-900/20 hover:border-sky-500"
                    }`}>
                      {importing ? "Загрузка..." : "Выбрать ZIP-архив"}
                      <input
                        ref={fileRef}
                        type="file"
                        accept=".zip"
                        onChange={handleImport}
                        disabled={importing}
                        className="hidden"
                      />
                    </label>
                  </div>
                  {importMsg && (
                    <p className={`text-xs px-3 py-2 rounded-lg border ${
                      importMsg.ok
                        ? "text-emerald-400 bg-emerald-900/20 border-emerald-700/30"
                        : "text-red-400 bg-red-900/20 border-red-700/30"
                    }`}>
                      {importMsg.text}
                    </p>
                  )}
                </div>
              </div>

              <div>
                <SectionTitle>Загруженные аккаунты ({accounts.length})</SectionTitle>
                {accounts.length === 0 ? (
                  <p className="text-slate-600 text-sm text-center py-10">Аккаунты не импортированы</p>
                ) : (
                  <div className="space-y-2">
                    {accounts.map((a, i) => {
                      const name = a.first_name || a.username || a.phone || a.id.slice(0, 8);
                      const sub  = [a.username ? `@${a.username}` : "", a.phone].filter(Boolean).join(" · ");
                      return (
                        <div
                          key={a.id}
                          className="flex items-center gap-3 bg-[#1e2536] border border-slate-700/40 rounded-lg px-4 py-2.5 group"
                        >
                          <span className="text-slate-600 text-xs w-5 text-right select-none">{i + 1}</span>
                          <span className={`w-2 h-2 rounded-full shrink-0 ${a.status === "active" ? "bg-emerald-500" : "bg-slate-600"}`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{name}</p>
                            {sub && <p className="text-xs text-slate-500 truncate">{sub}</p>}
                          </div>
                          <Badge color={a.status === "active" ? "bg-emerald-900/40 text-emerald-400" : "bg-slate-700 text-slate-500"}>
                            {a.status === "active" ? "активен" : a.status}
                          </Badge>
                          <button
                            onClick={() => handleDeleteAccount(a.id)}
                            className="text-slate-700 hover:text-red-400 transition-colors text-xs opacity-0 group-hover:opacity-100"
                          >
                            Удалить
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── LOGS TAB ────────────────────────────────────────────────── */}
          {tab === "logs" && (
            <div className="max-w-3xl">
              <div className="flex items-center justify-between mb-3">
                <SectionTitle>Журнал действий</SectionTitle>
                <div className="flex gap-2">
                  {logs.length > 0 && (
                    <>
                      <span className="text-xs text-emerald-400">✓ {successCount}</span>
                      <span className="text-xs text-red-400">✗ {errorCount}</span>
                      <button
                        onClick={() => setLogs([])}
                        className="text-xs text-slate-600 hover:text-slate-400 transition-colors ml-3"
                      >
                        Очистить
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="bg-[#0a0d13] border border-slate-700/40 rounded-lg p-4 font-mono text-xs min-h-64 max-h-[500px] overflow-auto space-y-1">
                {logs.length === 0 ? (
                  <p className="text-slate-700">Журнал пуст. Нажмите «Подать жалобы» на вкладке «Жалоба».</p>
                ) : (
                  logs.map((l, i) => (
                    <p key={i} className={`flex gap-2 ${LOG_COLOR[l.level] ?? "text-slate-300"}`}>
                      <span className="text-slate-700 shrink-0 select-none">{fmt(l.ts)}</span>
                      <span className="break-all">{l.message}</span>
                    </p>
                  ))
                )}
                <div ref={logsEndRef} />
              </div>
            </div>
          )}
        </main>

        {/* ── Right sidebar ────────────────────────────────────────────── */}
        <aside className="w-56 border-l border-slate-700/50 bg-[#161b27] p-4 flex flex-col gap-4 shrink-0">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Статус</p>
            <div className="space-y-2">
              {[
                { label: "Аккаунтов", val: activeAccounts.length, color: "text-slate-200" },
                { label: "Успешно",   val: successCount, color: "text-emerald-400" },
                { label: "Ошибок",    val: errorCount,   color: "text-red-400" },
              ].map((s) => (
                <div key={s.label} className="flex justify-between text-xs">
                  <span className="text-slate-500">{s.label}</span>
                  <span className={`font-mono font-bold ${s.color}`}>{s.val}</span>
                </div>
              ))}
            </div>
          </div>

          <hr className="border-slate-700/50" />

          <div className="text-xs text-slate-600 space-y-2">
            <p className="text-slate-400 font-semibold">API</p>
            <p>Telegram Desktop<br /><span className="text-slate-700">api_id: 2040</span></p>

            <p className="text-slate-400 font-semibold mt-2">Задержка</p>
            <p>3–10 сек между аккаунтами</p>

            <p className="text-slate-400 font-semibold mt-2">Формат TData</p>
            <p>ZIP-архив с папкой <code className="text-slate-500">tdata/</code></p>
          </div>

          <div className="mt-auto">
            <button
              onClick={loadAccounts}
              className="w-full py-1.5 text-xs text-slate-500 hover:text-slate-300 border border-slate-700/40 rounded-lg transition-colors"
            >
              Обновить список
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
