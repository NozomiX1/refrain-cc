// One scribe case, run n times (E9): a replay's database rolled back to just before some run, then a single batch
// for the scribe, either that run's own batch or a made-up one appended to a session. Each try works on its own
// copy, so nothing leaks between tries or back into the replay.
// usage: node case.ts <case.json> <out dir> [effort] [scribe-system.md to use instead of the current one]
// case.json: { name, source: <memory.db>, before?: runId, run?: runId, add?: { session: ccId, today, turns: [[role, text], ...] },
//              cwd: <project path>, repeat }
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bookmark, openDb, startRun, type Numbered } from "../../core/db.ts";
import { scribeInput } from "../../core/render.ts";
import { scribeRunner } from "../e7-scribe/run-scribe.ts";

const [caseFile, outArg, effort = "high", promptFile] = process.argv.slice(2);
const c = JSON.parse(readFileSync(caseFile, "utf8"));
const scribeSystem = readFileSync(promptFile ?? new URL("../../docs/model-facing/scribe-system.md", import.meta.url), "utf8");
const src = new DatabaseSync(c.source, { readOnly: true });
const source = c.run ? (src.prepare("SELECT session_id, request FROM runs WHERE id = ?").get(c.run) as { session_id: number; request: string }) : null;

// Everything a run at or after `before` wrote goes; the full-text indexes are rebuilt from what is left.
function rollBack(db: DatabaseSync, before: number) {
  // Referrers first: summaries point at entries (a statement deleting both ends of a link is fine).
  for (const t of ["summaries", "states"]) db.prepare(`DELETE FROM ${t} WHERE run_id >= ?`).run(before);
  db.prepare("DELETE FROM knowledge_versions WHERE run_id >= ?").run(before);
  db.prepare("DELETE FROM knowledge WHERE created_run_id >= ?").run(before);
  db.prepare("DELETE FROM entries WHERE run_id >= ?").run(before);
  db.prepare("DELETE FROM runs WHERE id >= ?").run(before);
  db.exec("INSERT INTO entries_fts (entries_fts) VALUES ('rebuild'); INSERT INTO summaries_fts (summaries_fts) VALUES ('rebuild');");
}

// Replays from before 2026-10-29 kept a project session's own state apart; the scribe now reads one list, so append
// that session's items to the project's, as one list would have held them.
function mergeSessionState(db: DatabaseSync, projectId: number, sessionId: number) {
  const latest = (kind: string, col: string, id: number) =>
    db.prepare(`SELECT items, run_id FROM states WHERE kind = ? AND ${col} = ? AND void = 0 ORDER BY id DESC LIMIT 1`).get(kind, id) as { items: string; run_id: number } | undefined;
  const ses = latest("session", "session_id", sessionId);
  if (!ses || ses.items === "[]") return;
  const proj = latest("project", "project_id", projectId);
  const moved = JSON.parse(ses.items).map((it: any) => (["authorization", "instruction"].includes(it.type) ? { ...it, type: "instruction", session: sessionId } : it));
  const items = [...(proj ? JSON.parse(proj.items) : []), ...moved];
  db.prepare("INSERT INTO states (kind, project_id, items, run_id) VALUES ('project', ?, ?, ?)").run(projectId, JSON.stringify(items), Math.max(ses.run_id, proj?.run_id ?? 0));
}

const results = [];
for (let i = 1; i <= c.repeat; i++) {
  const out = resolve(outArg, c.name, String(i));
  rmSync(out, { recursive: true, force: true });
  for (const d of ["home", "runs", "cwd"]) mkdirSync(join(out, d), { recursive: true });
  src.exec(`VACUUM INTO '${join(out, "home", "memory.db")}'`);
  const db = openDb(join(out, "home", "memory.db"));
  const before = c.before ?? c.run;
  if (before) rollBack(db, before);
  let sessionId: number, batch: Numbered[], today: string;
  if (source) {
    const q = JSON.parse(source.request);
    [sessionId, batch, today] = [source.session_id, q.batch, q.today];
  } else {
    sessionId = (db.prepare("SELECT id FROM sessions WHERE cc_session_id = ?").get(c.add.session) as { id: number }).id;
    const last = (db.prepare("SELECT MAX(turn_no) AS t FROM entries WHERE session_id = ?").get(sessionId) as { t: number }).t;
    let turn = last, entry = 0;
    batch = c.add.turns.map(([role, text]: string[], k: number) => {
      if (role === "user") [turn, entry] = [turn + 1, 0];
      return { uuid: `case-${c.name}-${k}`, ts: `${c.add.today}T12:00:${String(k).padStart(2, "0")}Z`, role, kind: "text", rawChars: text.length,
        text, newTurn: role === "user", turnNo: turn, entryNo: ++entry };
    });
    today = c.add.today;
  }
  const s = db.prepare("SELECT s.cc_session_id AS cc, p.id AS pid, p.path FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?").get(sessionId) as any;
  if (s.pid != null) mergeSessionState(db, s.pid, sessionId);
  const prompt = scribeInput(db, { projectId: s.pid, projectPath: s.path, sessionId }, batch, today);
  const runId = startRun(db, sessionId, bookmark(db, sessionId));
  db.prepare("UPDATE runs SET request = ? WHERE id = ?").run(JSON.stringify({ prompt, batch, projectId: s.pid, today }), runId);
  const sys = join(out, "system.md");
  writeFileSync(sys, scribeSystem.slice(scribeSystem.indexOf("\n---\n") + 5).trim());
  const log: any[] = [];
  scribeRunner({ out, home: join(out, "home"), db, model: "haiku", effort, sys, log, logFile: join(out, "runs.json") })(runId, prompt, 0, s.cc, c.cwd);
  const run = db.prepare("SELECT status, response FROM runs WHERE id = ?").get(runId) as { status: string; response: string | null };
  const receipts = readFileSync(join(out, "runs", `${String(runId).padStart(3, "0")}.jsonl`), "utf8").split("\n").filter(Boolean)
    .flatMap((l) => JSON.parse(l).message?.content ?? []).filter((b: any) => b.type === "tool_result" && b.is_error)
    .map((b: any) => (typeof b.content === "string" ? b.content : b.content.map((x: any) => x.text).join("")));
  const r = { try: i, status: run.status, calls: log[0]?.calls, rejected: log[0]?.rejected, cost: log[0]?.cost, ms: log[0]?.ms, receipts,
    submission: run.response ? JSON.parse(run.response) : null };
  writeFileSync(join(out, "result.json"), JSON.stringify(r, null, 1));
  results.push(r);
  console.log(JSON.stringify({ case: c.name, try: i, status: r.status, calls: r.calls, rejected: r.rejected, cost: r.cost }));
}
writeFileSync(resolve(outArg, c.name, "results.json"), JSON.stringify(results, null, 1));
