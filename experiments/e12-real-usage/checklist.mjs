// usage: node checklist.mjs <the session's subagents dir>   (statistics only)
// Runs stopped by the "nothing looked up yet" check: what the scribe did next and how its second submit differed.
import { readFileSync, readdirSync } from "node:fs";
const dir = process.argv[2];
const norm = (x) => JSON.stringify(x ?? []);
for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
  const rows = readFileSync(`${dir}/${f}`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const calls = [], results = new Map(), seen = new Set(); const usage = new Map();
  for (const r of rows) {
    if (r.type === "assistant") {
      if (!seen.has(r.message.id)) { seen.add(r.message.id); usage.set(r.message.id, r.message.usage); }
      for (const c of r.message.content ?? []) if (c.type === "tool_use") calls.push({ id: c.id, name: c.name.replace(/^mcp__.*__/, ""), input: c.input, msg: r.message.id });
    }
    if (r.type === "user" && Array.isArray(r.message.content)) for (const c of r.message.content) if (c.type === "tool_result") results.set(c.tool_use_id, typeof c.content === "string" ? c.content : JSON.stringify(c.content));
  }
  const i = calls.findIndex((c) => c.name === "submit" && /还没有查过以前的记录/.test(results.get(c.id) ?? ""));
  if (i < 0) continue;
  const first = calls[i].input, after = calls.slice(i + 1);
  const second = after.find((c) => c.name === "submit")?.input ?? {};
  const between = after.slice(0, after.findIndex((c) => c.name === "submit")).map((c) => `${c.name}(${JSON.stringify(c.input).slice(0, 50)})`);
  const out = [...usage.values()].map((u) => u.output_tokens);
  const diff = ["summaries", "knowledge", "state"].map((k) => `${k} ${(first[k] ?? []).length}→${(second[k] ?? []).length}${norm(first[k]) === norm(second[k]) ? "（相同）" : "（变了）"}`);
  console.log(JSON.stringify({ confirm: !!second.confirm, between, diff: second.confirm ? "confirm" : diff.join("，"), outputs: out }));
}
