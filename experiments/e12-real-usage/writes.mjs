// usage: node writes.mjs <transcript.jsonl> <copy of memory.db>   (file names and counts only)
// Every Write/Edit in the main session: the file, how much content the scribe did not see, and whether the replies
// in the same turn and the summaries mention the file at all.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const [file, dbPath] = process.argv.slice(2);
const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const db = new DatabaseSync(dbPath, { readOnly: true });
const sums = db.prepare("SELECT code, title, body FROM summaries WHERE void = 0").all();
const seen = new Set();
let turn = 0; const turnOf = new Map(), replies = new Map();
for (const r of rows) {
  if (r.type === "user" && typeof r.message?.content === "string" && !r.isMeta) turn++;
  if (r.type === "user" && Array.isArray(r.message?.content) && r.message.content.some((c) => c.type === "text") && !r.isMeta) turn++;
  if (r.type !== "assistant") continue;
  for (const c of r.message.content ?? []) {
    if (c.type === "text") replies.set(turn, (replies.get(turn) ?? "") + c.text);
    if (c.type === "tool_use" && /^(Write|Edit)$/.test(c.name) && !seen.has(c.id)) { seen.add(c.id); turnOf.set(c.id, { turn, ts: r.timestamp, name: c.name, path: c.input.file_path, size: (c.input.content ?? c.input.new_string ?? "").length }); }
  }
}
for (const w of turnOf.values()) {
  const base = w.path.split("/").pop();
  const rep = replies.get(w.turn) ?? "";
  const inSum = sums.filter((s) => (s.body + s.title).includes(base.replace(/\.md$/, ""))).map((s) => s.code);
  console.log([w.ts.slice(5, 16), w.name, w.path.replace(/.*tycoon\//, ""), w.size, rep.includes(base) || rep.includes(base.replace(/\.\w+$/, "")) ? "回复提到" : "回复没提", rep.length, inSum.slice(0, 4).join(",")].join("\t"));
}
