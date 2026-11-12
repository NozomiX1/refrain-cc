// Reader: turns a CC transcript into the entries refrain keeps (design.md 6.2, 6.4; ADR-0012, ADR-0014).
import { readFileSync } from "node:fs";

export type Row = {
  line: number;
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string } | null;
  promptSource?: string;
  toolDenialKind?: string;
  message?: { content?: unknown };
};

export type Entry = {
  uuid: string;
  ts: string;
  role: "user" | "assistant" | "observation";
  kind: "text" | "tool_use" | "tool_result";
  toolName?: string;
  isError?: boolean;
  rawChars: number;
  text: string;
  newTurn: boolean; // a message the user typed: starts turn T+1
};

type Block = { type?: string; text?: string; name?: string; id?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean };

export const LIMITS = { assistant: 4000, toolHead: 200, toolTail: 200, inputHead: 150, inputTail: 50, pasteHead: 300, pasteTail: 200 };

export function parseTranscript(path: string): Row[] {
  const rows: Row[] = [];
  readFileSync(path, "utf8").split("\n").forEach((l, i) => {
    if (!l.trim()) return;
    try {
      rows.push({ ...JSON.parse(l), line: i });
    } catch {
      // CC may be mid-write on the last line; the next read picks it up.
    }
  });
  return rows;
}

const isToolResult = (r: Row) => Array.isArray(r.message?.content) && (r.message.content as Block[]).some((b) => b?.type === "tool_result");

// Rows on the branch that is live now, oldest first (design.md 6.4).
export function effectivePath(rows: Row[]): Row[] {
  const byUuid = new Map<string, Row>();
  const children = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.uuid || r.isSidechain) continue;
    byUuid.set(r.uuid, r);
    if (r.parentUuid) children.set(r.parentUuid, [...(children.get(r.parentUuid) ?? []), r]);
  }
  const boundaries = rows.filter((r) => r.subtype === "compact_boundary");
  // A copy of a kept tail: after a boundary, with an older timestamp (e0 C5). Its parentUuid may point back at
  // the pre-compaction original instead of the boundary (seen in s1 run 2), so a walk through it goes via the boundary.
  const copyOf = (r: Row) => boundaries.findLast((b) => b.line < r.line && !!r.timestamp && !!b.timestamp && r.timestamp < b.timestamp);
  const last = rows.findLast((r) => r.uuid && !r.isSidechain);
  const onPath = new Set<Row>();
  for (let cur = last; cur && !onPath.has(cur); ) {
    onPath.add(cur);
    const b = cur.subtype === "compact_boundary" ? undefined : copyOf(cur);
    if (b) {
      cur = b;
      continue;
    }
    // A compact boundary has no parentUuid; logicalParentUuid links back to the pre-compaction history.
    const up = cur.subtype === "compact_boundary" ? cur.logicalParentUuid : cur.parentUuid;
    cur = up ? byUuid.get(up) : undefined;
  }
  // Parallel tool calls: each result hangs off its own call, a sibling of the path, not on it.
  for (const r of [...onPath]) for (const c of children.get(r.uuid!) ?? []) if (isToolResult(c)) onPath.add(c);

  const out: Row[] = [];
  let boundaryTs: string | undefined;
  for (const r of [...onPath].sort((a, b) => a.line - b.line)) {
    if (r.subtype === "compact_boundary") {
      boundaryTs = r.timestamp;
      continue;
    }
    // A kept tail is rewritten after the boundary with new uuids but its original timestamps (e0 C5).
    if (boundaryTs && r.timestamp && r.timestamp < boundaryTs) continue;
    out.push(r);
  }
  return out;
}

export function clip(s: string, head: number, tail: number): string {
  s = s.trim();
  if (s.length <= head + tail + 20) return s;
  return `${s.slice(0, head)} ……（中间省略 ${s.length - head - tail} 字符）…… ${s.slice(-tail)}`;
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[]).map((b) => (b?.type === "text" ? b.text ?? "" : b?.type === "image" ? "〔图片〕" : "")).join("\n");
}

// Pasted spans are context, not the user's own words (ADR-0014).
function renderPaste(t: string): string {
  // The closing tag repeats the id: <pasted_content id="e1b4">…</pasted_content id="e1b4"> (CC 2.1.310, recorded).
  return t.replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, (_, body: string) => `〔粘贴〕${clip(body, LIMITS.pasteHead, LIMITS.pasteTail)}〔粘贴结束〕`);
}

// "<command-name>/x</command-name>…<command-args>a</command-args>" -> "/x a"
function renderCommand(t: string): string {
  const name = t.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1];
  if (!name) return t;
  const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

// Every field on its own line, each value clipped alike: one rule for every tool, MCP ones included. Picking one
// field dropped Bash's description and all that Write and Edit wrote (E12).
function inputBrief(input: Record<string, unknown> = {}): string {
  return Object.entries(input).map(([k, v]) => `\n${k}: ${clip(typeof v === "string" ? v : JSON.stringify(v), LIMITS.inputHead, LIMITS.inputTail)}`).join("");
}

function resultText(b: Block): string {
  const c = b.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return (c as Block[]).map((x) => x?.text ?? "").join("\n");
  return JSON.stringify(c ?? "");
}

// One entry per kept row; CC writes one content block per row (e0 C4), except a user's text plus images.
export function toEntries(path: Row[]): { entries: Entry[]; warnings: string[] } {
  const warnings: string[] = [];
  // ADR-0014 fallback: without any origin field we cannot tell typed messages apart, so take plain user text.
  const hasOrigin = path.some((r) => r.type === "user" && r.origin != null);
  const toolNames = new Map<string, string>();
  const entries: Entry[] = [];
  const push = (r: Row, e: Omit<Entry, "uuid" | "ts" | "newTurn"> & { newTurn?: boolean }) =>
    entries.push({ uuid: r.uuid!, ts: r.timestamp ?? "", newTurn: false, ...e });

  for (const r of path) {
    if (r.isMeta || r.isCompactSummary || (r.type !== "user" && r.type !== "assistant")) continue;
    const content = r.message?.content;
    if (r.type === "assistant") {
      if (!Array.isArray(content)) continue;
      for (const b of content as Block[]) {
        if (b?.type === "text" && b.text?.trim()) {
          push(r, { role: "assistant", kind: "text", rawChars: b.text.length, text: clip(b.text, LIMITS.assistant / 2, LIMITS.assistant / 2) });
        } else if (b?.type === "tool_use") {
          toolNames.set(b.id ?? "", b.name ?? "工具");
          const raw = JSON.stringify(b.input ?? {});
          push(r, { role: "assistant", kind: "tool_use", toolName: b.name, rawChars: raw.length, text: `调用 ${b.name}：${inputBrief(b.input)}` });
        }
      }
      continue;
    }
    const text = userText(content);
    if (text.startsWith("[Request interrupted by user")) {
      push(r, { role: "user", kind: "text", rawChars: text.length, text: "〔打断〕" });
      continue;
    }
    if (Array.isArray(content) && isToolResult(r)) {
      const b = (content as Block[]).find((x) => x?.type === "tool_result")!;
      const name = toolNames.get(b.tool_use_id ?? "");
      if (r.toolDenialKind === "user-rejected") {
        push(r, { role: "user", kind: "tool_result", toolName: name, rawChars: 0, text: "〔拒绝了上面的工具调用〕" });
        continue;
      }
      const body = resultText(b);
      const kb = (Buffer.byteLength(body) / 1024).toFixed(1);
      push(r, { role: "observation", kind: "tool_result", toolName: name, isError: !!b.is_error, rawChars: body.length,
        text: `${name ?? "工具"} ${b.is_error ? "失败" : "成功"}，原始 ${kb}KB：${clip(body, LIMITS.toolHead, LIMITS.toolTail)}` });
      continue;
    }
    const typed = hasOrigin ? r.origin?.kind === "human" : !text.trimStart().startsWith("<");
    if (!typed || !text.trim()) continue;
    push(r, { role: "user", kind: "text", rawChars: text.length, text: renderPaste(renderCommand(text)).trim(), newTurn: true });
  }
  // Sessions with only local commands (/exit) have no origin either; warn only when the fallback took something.
  if (!hasOrigin && entries.some((e) => e.newTurn)) warnings.push("no origin field in this session; fell back to blacklist filtering (ADR-0014)");
  return { entries, warnings };
}

// A row's whole text, unclipped: read(..., full: true) and the start of a compaction's kept tail.
export function fullText(r: Row): string {
  const c = r.message?.content;
  if (r.type === "user" && !isToolResult(r)) return userText(c);
  if (!Array.isArray(c)) return typeof c === "string" ? c : "";
  return (c as Block[]).map((b) => (b?.type === "text" ? b.text ?? "" : b?.type === "tool_use" ? `调用 ${b.name}：${JSON.stringify(b.input ?? {})}` : b?.type === "tool_result" ? resultText(b) : "")).filter(Boolean).join("\n");
}

export function readSession(path: string) {
  return toEntries(effectivePath(parseTranscript(path)));
}
