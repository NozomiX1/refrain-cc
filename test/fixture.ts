// Builds transcript rows shaped like CC 2.1.310's (field names checked against real transcripts).
// shortcut: hand-built rows, not recorded sessions; replace with the tmux-scripted transcripts of design.md 7.13.
import { writeFileSync } from "node:fs";
import type { Row } from "../core/transcript.ts";

export function transcript(prefix = "u") {
  const rows: Omit<Row, "line">[] = [];
  let n = 0;
  let clock = Date.parse("2026-10-01T00:00:00Z");
  let last: string | null = null;
  const add = (r: Omit<Row, "line">, parent: string | null = last) => {
    const row = { uuid: `${prefix}${++n}`, parentUuid: parent, timestamp: new Date((clock += 1000)).toISOString(), ...r };
    rows.push(row);
    last = row.uuid;
    return row.uuid;
  };
  const t = {
    rows,
    get last() {
      return last;
    },
    human: (text: string, parent?: string | null) =>
      add({ type: "user", origin: { kind: "human" }, promptSource: "typed", message: { content: text } }, parent),
    meta: (text: string) => add({ type: "user", isMeta: true, message: { content: text } }),
    notification: (text: string) => add({ type: "user", origin: { kind: "task-notification" }, message: { content: text } }),
    attachment: () => add({ type: "attachment" }),
    thinking: () => add({ type: "assistant", message: { content: [{ type: "thinking", thinking: "…" }] } }),
    say: (text: string, usage?: Record<string, number>) => add({ type: "assistant", message: { content: [{ type: "text", text }], ...(usage && { usage }) } }),
    call: (id: string, name: string, input: Record<string, unknown>, parent?: string | null) =>
      add({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } }, parent),
    result: (id: string, content: string, extra: Partial<Row> & { is_error?: boolean } = {}, parent?: string | null) => {
      const { is_error, ...rest } = extra;
      return add({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] }, ...rest }, parent);
    },
    interrupt: () => add({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
    // Compaction: a boundary with no parent, then CC rewrites the kept tail with new uuids and old timestamps (e0 C5).
    compact: (keptUuids: string[]) => {
      const before = last;
      add({ type: "system", subtype: "compact_boundary", logicalParentUuid: before }, null);
      for (const u of keptUuids) {
        const orig = rows.find((r) => r.uuid === u)!;
        const { uuid: _u, parentUuid: _p, ...copy } = orig;
        const row = { ...copy, uuid: `${prefix}${++n}`, parentUuid: last };
        rows.push(row);
        last = row.uuid;
      }
    },
    write(path: string) {
      writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    },
  };
  return t;
}
