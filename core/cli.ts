// Entry point the mod calls: node core/cli.ts <command>, JSON on stdin, JSON on stdout (design.md 7.2).
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.ts";
import { disableAutoMemory } from "./enable.ts";
import { handoff } from "./handoff.ts";
import { backupIfDue, log, resume, writeStatus } from "./ops.ts";
import { panel } from "./panel.ts";
import { projectRoot } from "./project.ts";
import { briefing } from "./render.ts";
import { read, search } from "./retrieve.ts";
import { finish, findTranscript, prepare, submit } from "./scribe.ts";

const home = process.env.REFRAIN_HOME ?? join(homedir(), ".refrain");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const args = input.trim() ? JSON.parse(input) : {};
const db = openDb(join(home, "memory.db"));

// Where a main-session call stands, without creating rows: a session is recorded when its scribe first runs.
function where(db: DatabaseSync, a: { ccSessionId: string; cwd: string }) {
  const projectPath = projectRoot(a.cwd);
  const projectId = projectPath ? ((db.prepare("SELECT id FROM projects WHERE path = ?").get(projectPath) as { id: number } | undefined)?.id ?? null) : null;
  const s = db.prepare("SELECT id, transcript_path FROM sessions WHERE cc_session_id = ?").get(a.ccSessionId) as { id: number; transcript_path: string } | undefined;
  return { projectPath, projectId, sessionId: s?.id ?? null, transcriptPath: s?.transcript_path ?? null };
}

const commands: Record<string, () => unknown> = {
  prepare: () => prepare(db, home, args),
  submit: () => submit(db, home, args.runId, args.submission, args.looked ?? true),
  finish: () => finish(db, home, args.runId, args.usage, args.error),
  info: () => ({ home }),
  enable: () => {
    const root = projectRoot(args.cwd);
    const changed = root ? disableAutoMemory(root) : null;
    if (changed) log(home, "enable", { file: changed });
    return { changed };
  },
  // Asked at a conversation's first request and after each compaction: a good moment for the daily backup.
  briefing: () => {
    const w = where(db, args);
    const text = briefing(db, w);
    const backup = backupIfDue(db, home);
    log(home, "inject", { session: w.sessionId, project: w.projectId, chars: text.length, ...(backup ? { backup } : {}) });
    return { text };
  },
  handoff: () => {
    const w = where(db, args);
    const h = handoff(db, w.sessionId, w.transcriptPath ?? (w.sessionId ? findTranscript(args.ccSessionId) : null), args.instructions, args.trigger);
    log(home, "compact", { session: w.sessionId, trigger: args.trigger, ...(h.status === "ok" ? { chars: h.text.length, tailTurns: h.tail.turns } : h.status === "skip" ? { skip: h.notice } : { native: h.reason }) });
    return h;
  },
  resume: () => {
    const w = where(db, args);
    if (w.sessionId == null) return { text: "这个会话还没有整理过，没有可以恢复的。" };
    resume(db, w.sessionId);
    writeStatus(db, home, w.sessionId, "idle");
    log(home, "resume", { session: w.sessionId });
    return { text: "已恢复自动整理，失败计数清零。下一轮结束时会再试一次。" };
  },
  panel: () => ({ text: panel(db, where(db, args)) }),
  log: () => (log(home, args.event ?? "mod", args.fields ?? {}), { ok: true }),
  search: () => ({ text: search(db, where(db, args), args.args ?? {}) }),
  read: () => ({ text: read(db, where(db, args), args.address ?? "", args.full) }),
};
const run = commands[process.argv[2] ?? ""];
if (!run) {
  process.stderr.write(`usage: node core/cli.ts ${Object.keys(commands).join("|")}  (JSON args on stdin)\n`);
  process.exit(2);
}
try {
  process.stdout.write(JSON.stringify(run()) + "\n");
} catch (err) {
  log(home, "error", { command: process.argv[2], message: String(err) });
  throw err;
}
