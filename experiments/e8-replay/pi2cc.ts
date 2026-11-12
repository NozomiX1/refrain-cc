// Convert a Pi session (~/.pi/agent/sessions/…/*.jsonl) into the CC transcript shape core/transcript.ts reads, so a
// replay can mix Pi and CC sessions of one project (E8). Only what the reader looks at is written: typed user text
// (origin human), assistant text and tool calls, tool results. Thinking, system prompts, compaction summaries and
// extension messages (subagent notices) are dropped, as the reader drops their CC counterparts.
// usage: node pi2cc.ts <pi session.jsonl> <out.jsonl>
import { readFileSync, writeFileSync } from "node:fs";

const [src, dst] = process.argv.slice(2);
const recs = readFileSync(src, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sessionId = recs.find((r) => r.type === "session").id as string;
const byId = new Map(recs.map((r) => [r.id, r]));
// The live branch: from the last message up the parent chain (a rewind in Pi leaves a sibling branch behind).
const path: any[] = [];
for (let r = recs.findLast((r) => r.type === "message"); r; r = byId.get(r.parentId)) if (r.type === "message") path.unshift(r);

const rows: object[] = [];
let parent: string | null = null;
const row = (r: any, type: string, content: unknown, extra: object = {}, uuid = r.id) => {
  rows.push({ type, uuid, parentUuid: parent, timestamp: r.timestamp, sessionId, isSidechain: false, message: { role: type, content }, ...extra });
  parent = uuid;
};
for (const r of path) {
  const m = r.message;
  if (m.role === "user") {
    row(r, "user", m.content.map((b: any) => (b.type === "text" ? { type: "text", text: b.text } : { type: "image" })), { origin: { kind: "human" } });
  } else if (m.role === "assistant") {
    const content = m.content.flatMap((b: any) =>
      b.type === "text" ? [{ type: "text", text: b.text }] : b.type === "toolCall" ? [{ type: "tool_use", id: b.id, name: b.name, input: b.arguments }] : []);
    // CC writes one content block per row and the reader keys entries by row uuid (e0 C4), so split them.
    content.forEach((b: object, i: number) => row(r, "assistant", [b], {}, i ? `${r.id}-${i}` : r.id));
  } else if (m.role === "toolResult") {
    const text = m.content.map((b: any) => (b.type === "text" ? b.text : "〔图片〕")).join("\n");
    row(r, "user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: text, is_error: !!m.isError }]);
  }
}
writeFileSync(dst, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
console.log(dst, rows.length, "rows from", path.length, "messages");
