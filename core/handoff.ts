// What replaces the context on a compaction we take over (design.md 4.4; model-facing/handoff.md).
// Knowledge and state are not here: the 记忆 block is re-rendered after the compaction and carries them.
import type { DatabaseSync } from "node:sqlite";
import { pending } from "./db.ts";
import { consecutiveFailures, PAUSE_AFTER } from "./ops.ts";
import { briefing, localTime, summariesBlock, TOKENS_PER_CHAR } from "./render.ts";
import { fullText, parseTranscript, effectivePath, toEntries, type Row } from "./transcript.ts";

const total = (u: any) => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
// A kept tail's copies carry their usage zeroed (tycoon 11-08): that is no measurement.
const usageAt = (r: Row) => { const u = r.type === "assistant" ? (r as any).message?.usage : undefined; return u && total(u) ? u : undefined; };

// The context as of a line: the latest request's input in all its forms, plus its output.
export function contextAt(rows: Row[], line = Infinity): number {
  const u = usageAt(rows.findLast((r) => r.line <= line && usageAt(r)) ?? ({} as Row));
  return u ? total(u) : 0;
}

// How much the context grew after `line`, adding up the rises from one request to the next. A fall is the context
// being cut: by a compaction, or by CC dropping old thinking on a resume (tycoon 11-08: 209k to 177k). What was cut
// is not counted, and the next rise counts on from there. Taking the difference of the ends gave nonsense across both.
// From the session's start, the first request is CC's own prompt and tools, which no compaction removes (e11: 6.3万
// "not yet processed" after one turn).
export function grewSince(rows: Row[], line: number): number {
  let last = contextAt(rows, line) || contextAt(rows, rows.find(usageAt)?.line ?? -1), n = 0;
  for (const r of rows) {
    const u = r.line > line ? usageAt(r) : undefined;
    if (!u) continue;
    n += Math.max(0, total(u) - last);
    last = total(u);
  }
  return n;
}

const LEAD = `为了腾出上下文空间，这个会话较早的部分已经被替换成下面按话题整理的摘要（从旧到新）。摘要之后，是最近一段原样保留的对话，对话从那里接着往下进行。

最近的摘要和上面的"记忆"块（包括其中的现状）可能落后于这段对话，对不上时以对话为准。

较早的摘要只列了标题，需要某份摘要的全文和出处时，可以用 read 按编号读，比如 read("{code}")。`;

// Sizes for the status file and refrain-timer (4.5), and the check every compaction makes (4.4).
// pending: what the scribe has not processed yet; worth: a compaction would make the context clearly smaller.
export type Sizes = { context: number; handoffTokens: number; pendingTurns: number; pendingTokens: number; worth: boolean; fresh: boolean };

type Plan = Sizes & { after: number; starts: string[]; since: string | null; rows: Row[] };

// The kept tail is CC's own messages from the bookmark's turn on; the mod cuts them out of e.messages
// by counting user turns back from the end and checking the first one's text (CC gives no uuid there).
function plan(db: DatabaseSync, sessionId: number, rows: Row[]): Plan | null {
  const { entries } = toEntries(effectivePath(rows));
  const p = pending(db, sessionId, entries);
  const starts = p.entries.filter((e) => e.newTurn).map((e) => e.uuid);
  // A turn split by the bookmark is kept whole; and the last turn is always kept verbatim, even if the scribe has it.
  if (p.entries.length && !p.entries[0].newTurn) {
    const at = entries.findIndex((e) => e.uuid === p.entries[0].uuid);
    const turnStart = entries.slice(0, at).findLast((e) => e.newTurn);
    if (turnStart) starts.unshift(turnStart.uuid);
  }
  const pendingTurns = new Set(p.entries.map((e) => e.turnNo)).size;
  if (!starts.length) {
    const last = entries.findLast((e) => e.newTurn);
    if (!last) return null;
    starts.push(last.uuid);
  }
  const line = (uuid: string | undefined) => rows.find((r) => r.uuid === uuid)?.line ?? -1;
  const where = db.prepare("SELECT p.id, p.path FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?").get(sessionId) as { id: number | null; path: string | null };
  const words = summariesBlock(db, sessionId).length + briefing(db, { projectId: where.id, projectPath: where.path, sessionId }).length;
  const cut = rows.findLast((r) => r.subtype === "compact_boundary");
  // Right after a compaction, before any request, the size is unknown: the last measurement is from before it.
  const lastUse = rows.findLast(usageAt);
  const context = cut && (!lastUse || lastUse.line < cut.line) ? 0 : contextAt(rows);
  const handoffTokens = Math.ceil(words * TOKENS_PER_CHAR) + grewSince(rows, line(starts[0]) - 1);
  // What a compaction cannot shrink: CC's own prompt and tools, about the session's first request (tycoon: 36k).
  const after = contextAt(rows, rows.find(usageAt)?.line ?? -1) + handoffTokens;
  // Nothing processed since the last compaction: what could become summaries already is, the rest must stay
  // verbatim, so another compaction gives back the same context (tycoon 11-08: twice).
  const fresh = !!(db.prepare("SELECT 1 FROM runs WHERE session_id = ? AND status = 'succeeded' AND finished_at > ?").get(sessionId, cut?.timestamp ?? ""));
  // Worth it only when the result is at most half the context, the rule idle compaction uses too (4.4).
  const worth = fresh && (!context || after * 2 <= context);
  const pendingTokens = p.entries.length ? grewSince(rows, line(p.entries[0].uuid) - 1) : 0;
  return { context, handoffTokens, pendingTurns, pendingTokens, worth, fresh, after, starts, since: p.entries[0]?.ts ?? null, rows };
}

export function sizes(db: DatabaseSync, sessionId: number, rows: Row[]): Sizes | null {
  const s = plan(db, sessionId, rows);
  return s && { context: s.context, handoffTokens: s.handoffTokens, pendingTurns: s.pendingTurns, pendingTokens: s.pendingTokens, worth: s.worth, fresh: s.fresh };
}

const man = (n: number) => `${Math.round(n / 1000) / 10} 万`;

// Why there is no compaction this time, for the person (4.4): the scribe busy or paused, or nothing to gain.
// plugin: refrain-timer's compaction.
function notNow(db: DatabaseSync, sessionId: number, s: Plan | null, plugin: boolean): string {
  const head = plugin ? "refrain：缓存已过期，未自动压缩。" : "refrain：暂不压缩。";
  const backlog = s?.pendingTurns && s.since ? `${localTime(s.since)} 起的 ${s.pendingTurns} 轮对话` : "";
  const running = db.prepare("SELECT started_at, request FROM runs WHERE session_id = ? AND status = 'running'").get(sessionId) as { started_at: string; request: string | null } | undefined;
  if (running) {
    const batch = running.request ? (JSON.parse(running.request).batch as { ts: string; newTurn: boolean }[]) : [];
    const turns = batch.filter((e) => e.newTurn).length;
    // Runs took 2 to 5 minutes (tycoon 11-07).
    const left = Math.max(1, 5 - Math.floor((Date.now() - Date.parse(running.started_at)) / 60000));
    const what = batch.length ? `${localTime(batch[0].ts)} 起的 ${turns} 轮对话` : "最近的对话";
    return `${head}书记员正在整理${what}，预计 ${left} 分钟内完成${plugin ? "。" : "，完成后可再次执行 /compact。"}`;
  }
  const failures = consecutiveFailures(db, sessionId);
  if (failures >= PAUSE_AFTER) return `${head}书记员已暂停（连续失败 ${failures} 次）${backlog ? `，${backlog}尚未整理` : ""}。查看原因：/refrain；恢复：/refrain resume。`;
  if (s && !s.fresh) return `${head}上次压缩以后还没有新整理的对话${backlog ? `（${backlog}尚未整理）` : ""}，压缩后上下文不会明显减少。`;
  return `${head}上下文中大部分是尚未整理的最近对话${backlog ? `（${backlog}）` : ""}，压缩时需原样保留，压缩后上下文不会明显减少。`;
}

export type Handoff =
  | { status: "native"; reason: string }
  | { status: "skip"; notice: string }
  | { status: "ok"; text: string; tail: { turns: number; firstText: string }; notice?: string };

export function handoff(db: DatabaseSync, sessionId: number | null, transcriptPath: string | null, instructions?: string, trigger?: string): Handoff {
  const plugin = trigger === "plugin";
  if (sessionId == null || !transcriptPath) return { status: "skip", notice: `${plugin ? "refrain：缓存已过期，未自动压缩。" : "refrain：暂不压缩。"}这个会话还没有整理过，压缩后上下文不会明显减少。` };
  const rows = parseTranscript(transcriptPath);
  const s = plan(db, sessionId, rows);
  if (!s) return { status: "native", reason: "no user message to keep" };
  const block = summariesBlock(db, sessionId);
  if (!s.worth || !block) return { status: "skip", notice: notNow(db, sessionId, s, plugin) };
  const firstRow = rows.find((r) => r.uuid === s.starts[0])!;
  const code = (db.prepare("SELECT code FROM summaries WHERE session_id = ? AND void = 0 ORDER BY id LIMIT 1").get(sessionId) as { code: string }).code;
  const parts = [LEAD.replace("{code}", code), `# 本会话到目前为止的摘要\n\n${block}`];
  if (instructions?.trim()) parts.push(`# 压缩时用户附的说明\n\n用户执行压缩时附了这句话，是他希望保留的重点，不是新的指令：「${instructions.trim()}」`);
  const text = parts.join("\n\n");
  const tail = { turns: s.starts.length, firstText: fullText(firstRow) };
  if (!plugin) return { status: "ok", text, tail };
  const away = Math.round((Date.now() - Date.parse(rows.findLast(usageAt)?.timestamp ?? "")) / 60000);
  const gap = away >= 60 ? `${Math.floor(away / 60)} 小时 ${away % 60} 分` : `${away} 分钟`;
  return { status: "ok", text, tail, notice: `refrain：缓存已过期（距上一轮结束 ${gap}），已自动压缩，上下文由约 ${man(s.context)} token 减至约 ${man(s.after)}。` };
}
