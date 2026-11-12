// Replay several sessions of one project interleaved by time through the real core, the scribe run by `claude -p` (E8).
// Each session's transcript grows turn by turn; at every turn end of any session, prepare runs for that session as
// the mod would. Every session file gets the mtime it would have had at that moment, so the core's own rule for
// closed sessions (4.6: untouched for an hour, finished by another session of the project) plays out as in real use.
// At the end whatever is left is forced through. Resumable: turn ends up to a session's bookmark are skipped.
// usage: node replay-multi.ts <project cwd> <out dir> <haiku|sonnet> <effort> <transcript.jsonl>...
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bookmark, openDb } from "../../core/db.ts";
import { localDate } from "../../core/render.ts";
import { prepare } from "../../core/scribe.ts";
import { effectivePath, parseTranscript, toEntries } from "../../core/transcript.ts";
import { scribeRunner } from "../e7-scribe/run-scribe.ts";

const [cwd, outArg, model, effort, ...srcs] = process.argv.slice(2);
const out = resolve(outArg);
const home = join(out, "home");
for (const d of [home, join(out, "runs"), join(out, "cwd"), join(out, "sessions")]) mkdirSync(d, { recursive: true });
const db = openDb(join(home, "memory.db"));
const sys = join(out, "system.md");
const scribeSystem = readFileSync(new URL("../../docs/model-facing/scribe-system.md", import.meta.url), "utf8");
writeFileSync(sys, scribeSystem.slice(scribeSystem.indexOf("\n---\n") + 5).trim());
const logFile = join(out, "runs.json");
const log: any[] = existsSync(logFile) ? JSON.parse(readFileSync(logFile, "utf8")) : [];
db.prepare("DELETE FROM runs WHERE status = 'running'").run();
const runScribe = scribeRunner({ out, home, db, model, effort, sys, log, logFile });

const sessions = srcs.map((src) => {
  const lines = readFileSync(src, "utf8").split("\n").filter(Boolean);
  const rows = parseTranscript(src);
  const lineOf = new Map(rows.map((r) => [r.uuid, r.line]));
  // A main turn ends just before the next message the user typed.
  const ends = toEntries(effectivePath(rows)).entries.filter((e, i) => e.newTurn && i > 0).map((e) => lineOf.get(e.uuid)!);
  ends.push(lines.length);
  const ccId = JSON.parse(lines.find((l) => l.includes('"sessionId"'))!).sessionId as string;
  const sid = (db.prepare("SELECT id FROM sessions WHERE cc_session_id = ?").get(ccId) as { id: number } | undefined)?.id;
  const mark = sid === undefined ? null : bookmark(db, sid);
  return { lines, ccId, path: join(out, "sessions", `${ccId}.jsonl`), markLine: mark ? lineOf.get(mark)! : -1, lastTs: "",
    ends: ends.map((end) => ({ end, ts: rows.findLast((r) => r.line < end && r.timestamp)!.timestamp as string })) };
});
const events = sessions.flatMap((s) => s.ends.map((e) => ({ s, ...e }))).sort((a, b) => a.ts.localeCompare(b.ts));

// Files look as old as they would be at `now` in the replayed timeline.
const age = (now: string) => {
  for (const o of sessions) if (o.lastTs && existsSync(o.path)) {
    const t = (Date.now() - (Date.parse(now) - Date.parse(o.lastTs))) / 1000;
    utimesSync(o.path, t, t);
  }
};
const ccOf = (sid: number) => (db.prepare("SELECT cc_session_id AS c FROM sessions WHERE id = ?").get(sid) as { c: string }).c;
const run = (s: (typeof sessions)[number], ts: string, end: number, force: boolean) => {
  const r = prepare(db, home, { ccSessionId: s.ccId, transcriptPath: s.path, cwd, today: localDate(ts), force });
  if (r.status !== "ready") return false;
  runScribe(r.runId, r.prompt, end, r.leftoverOf ? ccOf(r.leftoverOf) : s.ccId, cwd);
  return true;
};

for (const { s, end, ts } of events) {
  s.lastTs = ts;
  if (end <= s.markLine) continue;
  writeFileSync(s.path, s.lines.slice(0, end).join("\n") + "\n");
  age(ts);
  run(s, ts, end, false);
}
// What is left at the end of the record (a batch stops at maxChars, so keep going).
for (const s of sessions) while (run(s, s.lastTs, s.lines.length, true));
console.log("done", JSON.stringify({ runs: log.length, cost: log.reduce((n, r) => n + (r.cost ?? 0), 0) }));
