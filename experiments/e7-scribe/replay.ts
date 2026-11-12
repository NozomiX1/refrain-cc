// Replay a real transcript turn by turn through the real core, with the scribe run by `claude -p` (E7).
// At every main-turn end the transcript so far is what CC would have on disk; prepare decides whether the scribe
// runs, as it does in the mod. At the cut everything left is forced through, so every setting ends having read it all.
// usage: node replay.ts <src.jsonl> <first uuid after the cut> <project cwd> <out dir> <haiku|sonnet> <effort> [trim on|off] [minChars] [maxChars]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bookmark, openDb } from "../../core/db.ts";
import { localDate } from "../../core/render.ts";
import { prepare, RUN } from "../../core/scribe.ts";
import { effectivePath, LIMITS, parseTranscript, toEntries } from "../../core/transcript.ts";
import { scribeRunner } from "./run-scribe.ts";

const [src, cutUuid, cwd, outArg, model, effort, trim = "on", minChars = "20000", maxChars = "120000"] = process.argv.slice(2);
const out = resolve(outArg);
const home = join(out, "home");
const transcript = join(out, "transcript.jsonl");
for (const d of [home, join(out, "runs"), join(out, "cwd")]) mkdirSync(d, { recursive: true });
RUN.maxChars = Number(maxChars);
if (trim === "off") for (const k of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) LIMITS[k] = Infinity;

const lines = readFileSync(src, "utf8").split("\n");
const cut = lines.findIndex((l) => l.includes(`"uuid":"${cutUuid}"`));
if (cut < 0) throw new Error(`cut uuid ${cutUuid} not in ${src}`);
const kept = lines.slice(0, cut);
writeFileSync(transcript, kept.join("\n") + "\n");
const rows = parseTranscript(transcript);
const lineOf = new Map(rows.map((r) => [r.uuid, r.line]));
// A main turn ends just before the next message the user typed.
const ends = toEntries(effectivePath(rows)).entries.filter((e, i) => e.newTurn && i > 0).map((e) => lineOf.get(e.uuid)!);
ends.push(kept.length);

const sessionId = JSON.parse(kept.find((l) => l.includes('"sessionId"'))!).sessionId as string;
const db = openDb(join(home, "memory.db"));
const sys = join(out, "system.md");
const scribeSystem = readFileSync(new URL("../../docs/model-facing/scribe-system.md", import.meta.url), "utf8");
writeFileSync(sys, scribeSystem.slice(scribeSystem.indexOf("\n---\n") + 5).trim());
// Resuming a stopped replay: the killed run never submitted (no entries), so its row goes. Ends up to the bookmark
// are skipped, since a prefix without it would look like a rewind. A run killed after its submit is in the database
// but not in the log; it is logged without its cost.
const logFile = join(out, "runs.json");
const log: any[] = existsSync(logFile) ? JSON.parse(readFileSync(logFile, "utf8")) : [];
db.prepare("DELETE FROM runs WHERE status = 'running'").run();
const sid = (db.prepare("SELECT id FROM sessions WHERE cc_session_id = ?").get(sessionId) as { id: number } | undefined)?.id;
const mark = sid === undefined ? null : bookmark(db, sid);
const markLine = mark ? lineOf.get(mark)! : -1;
for (const r of db.prepare("SELECT id FROM runs WHERE status = 'succeeded' AND id > ?").all(log.at(-1)?.runId ?? 0) as { id: number }[])
  log.push({ runId: r.id, end: markLine + 1, status: "succeeded", cost: null, note: "killed after submit; cost not recorded" } as any);

const runScribe = scribeRunner({ out, home, db, model, effort, sys, log, logFile });

for (const [i, end] of ends.entries()) {
  if (end <= markLine) continue;
  writeFileSync(transcript, kept.slice(0, end).join("\n") + "\n");
  const last = i === ends.length - 1;
  const ts = rows.findLast((r) => r.line < end && r.timestamp)?.timestamp as string;
  // At the cut, keep going until nothing is left (a batch stops at maxChars).
  for (;;) {
    const r = prepare(db, home, { ccSessionId: sessionId, transcriptPath: transcript, cwd, today: localDate(ts), minChars: Number(minChars), force: last });
    if (r.status !== "ready") break;
    runScribe(r.runId, r.prompt, end, sessionId, cwd);
    if (!last) break;
  }
}
console.log("done", JSON.stringify({ runs: log.length, cost: log.reduce((n, r: any) => n + (r.cost ?? 0), 0) }));
