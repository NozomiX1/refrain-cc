// Running refrain: cost, pausing, the status file, the log and backups (design.md 7.10–7.12, ADR-0021).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { localDate } from "./render.ts";

// Dollars per million tokens. Cache write and read are multiples of the input price; subagents use the 5-minute cache (e0 C2).
// shortcut: Haiku's 5x tier above 100K-token prompts is not applied; a scribe batch stays below it (RUN.maxChars).
const PRICES: Record<string, { input: number; output: number; read: number }> = {
  haiku: { input: 0.1, output: 0.5, read: 0.1 },
  sonnet: { input: 2, output: 10, read: 0.1 },
  opus: { input: 4, output: 20, read: 0.05 },
};
export const PAUSE_AFTER = 3; // consecutive failed runs of one session (7.12)

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; model?: string };

export function runCost(u: Usage | null): number {
  if (!u) return 0;
  const p = Object.entries(PRICES).find(([k]) => u.model?.includes(k))?.[1] ?? PRICES.haiku;
  const m = 1e-6 * p.input;
  return (u.input_tokens ?? 0) * m + (u.cache_creation_input_tokens ?? 0) * m * 1.25 + (u.cache_read_input_tokens ?? 0) * m * p.read + (u.output_tokens ?? 0) * 1e-6 * p.output;
}

export function sessionCost(db: DatabaseSync, sessionId: number, since?: string): number {
  const rows = db.prepare("SELECT usage FROM runs WHERE session_id = ? AND usage IS NOT NULL AND started_at >= ?").all(sessionId, since ?? "") as { usage: string }[];
  return rows.reduce((n, r) => n + runCost(JSON.parse(r.usage)), 0);
}

// Failures are counted from the run records, back from the newest, only after the last /refrain resume (7.12).
export function consecutiveFailures(db: DatabaseSync, sessionId: number): number {
  const resumed = (db.prepare("SELECT value FROM meta WHERE key = ?").get(`resumed:${sessionId}`) as { value: string } | undefined)?.value ?? "";
  const runs = db.prepare("SELECT status FROM runs WHERE session_id = ? AND started_at > ? AND status != 'undone' ORDER BY id DESC").all(sessionId, resumed) as { status: string }[];
  let n = 0;
  while (n < runs.length && runs[n].status === "failed") n++;
  return n;
}

export function resume(db: DatabaseSync, sessionId: number): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(`resumed:${sessionId}`, new Date().toISOString());
}

export type State = "idle" | "running" | "paused";

// What refrain-timer needs to decide on an idle compaction (4.5), written at every main turn's end and again when a
// scribe run ends (worth and the pending part change then). pendingTurns/pendingTokens: not yet processed, for the status line.
export type TurnInfo = { turnEndedAt: string; contextTokens: number; cacheTtlMs: number; handoffTokens: number; worth: boolean;
  pendingTurns: number; pendingTokens: number; idle: { enabled: boolean; minTokens: number } };

// The turn part of a session's status file, if a main turn has ended yet.
export function statusTurn(db: DatabaseSync, home: string, sessionId: number): TurnInfo | undefined {
  const s = db.prepare("SELECT cc_session_id AS id FROM sessions WHERE id = ?").get(sessionId) as { id: string } | undefined;
  try {
    return s && JSON.parse(readFileSync(join(home, "status", `${s.id}.json`), "utf8")).turn;
  } catch {
    return undefined;
  }
}

// status/<CC session id>.json: read by the status line script once a second (7.11) and by refrain-timer.
// A field left out keeps its last value.
export function writeStatus(db: DatabaseSync, home: string, sessionId: number, state?: State, turn?: TurnInfo): void {
  const s = db.prepare("SELECT cc_session_id AS id FROM sessions WHERE id = ?").get(sessionId) as { id: string } | undefined;
  if (!s) return;
  const dir = join(home, "status");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${s.id}.json`);
  let old: { state?: State; turn?: TurnInfo } = {};
  try {
    old = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // first write for this session
  }
  const next = { state: state ?? old.state ?? "idle", costUsd: Number(sessionCost(db, sessionId).toFixed(4)), failures: consecutiveFailures(db, sessionId),
    turn: turn ?? old.turn, updatedAt: new Date().toISOString() };
  writeFileSync(path + ".tmp", JSON.stringify(next));
  renameSync(path + ".tmp", path);
}

const LOG_MAX = 1024 * 1024;

// One line per event; never transcript text, which may hold passwords (7.10, F3).
export function log(home: string, event: string, fields: Record<string, unknown> = {}): void {
  try {
    mkdirSync(home, { recursive: true });
    const path = join(home, "log.txt");
    if (existsSync(path) && statSync(path).size > LOG_MAX) renameSync(path, path + ".1");
    appendFileSync(path, `${new Date().toISOString()} ${event} ${JSON.stringify(fields)}\n`);
  } catch {
    // Logging must never be the reason a hook fails.
  }
}

// Once a day, at the first injection of a session: VACUUM INTO backup/, keep the newest 7 (7.12).
export function backupIfDue(db: DatabaseSync, home: string, keep = 7): string | null {
  const dir = join(home, "backup");
  mkdirSync(dir, { recursive: true });
  const name = `memory-${localDate(new Date())}.db`;
  const files = readdirSync(dir).filter((f) => /^memory-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  if (files.includes(name)) return null;
  db.exec(`VACUUM INTO '${join(dir, name).replaceAll("'", "''")}'`);
  for (const old of [...files, name].sort().slice(0, -keep)) rmSync(join(dir, old));
  return name;
}
