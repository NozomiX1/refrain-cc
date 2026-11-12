// usage: node tpc.mjs <copy of memory.db> <the session's subagents dir> <another project's memory.db>   (statistics only)
// Tokens per character, split into CJK and other characters, fitted on the scribe's runs; then what that predicts for
// the summaries and knowledge text of another project's database.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
const [dbPath, dir, other] = process.argv.slice(2);
const CJK = /[　-〿㐀-鿿＀-￯]/g;
const split = (s) => { const c = (s.match(CJK) ?? []).length; return [c, s.length - c]; };
// points: the scribe's first request (prompt) and the step where only one tool result was added
const pts = [];
const agents = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(`${dir}/${f}`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
for (const rows of agents) {
  const reqs = [], seen = new Set();
  for (const r of rows) {
    if (r.type === "assistant" && !seen.has(r.message.id)) { seen.add(r.message.id); const u = r.message.usage; reqs.push({ ctx: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, out: u.output_tokens, res: [], calls: [] }); }
    if (r.type === "assistant") for (const c of r.message.content ?? []) if (c.type === "tool_use") reqs.at(-1).calls.push(c.name);
    if (r.type === "user" && Array.isArray(r.message.content) && reqs.length) for (const c of r.message.content) if (c.type === "tool_result") reqs.at(-1).res.push(typeof c.content === "string" ? c.content : c.content.map((x) => x.text ?? "").join(""));
  }
  for (let i = 0; i + 1 < reqs.length; i++) {
    const x = reqs[i];
    if (x.res.length === 1 && x.calls.every((n) => /search|read/.test(n)) && x.res[0].length > 500) pts.push({ text: x.res[0], tokens: reqs[i + 1].ctx - x.ctx - x.out });
  }
}
// least squares through the origin: tokens = a*cjk + b*other
let s11 = 0, s12 = 0, s22 = 0, t1 = 0, t2 = 0;
for (const p of pts) { const [c, o] = split(p.text); s11 += c * c; s12 += c * o; s22 += o * o; t1 += c * p.tokens; t2 += o * p.tokens; }
const det = s11 * s22 - s12 * s12, a = (t1 * s22 - t2 * s12) / det, b = (s11 * t2 - s12 * t1) / det;
console.log(`点 ${pts.length} 个（搜索、读取结果）：每个中文字符 ${a.toFixed(2)} token，每个其他字符 ${b.toFixed(2)} token`);
for (const p of pts) { const [c, o] = split(p.text); console.log(`  中文 ${c} 其他 ${o} 实际 ${p.tokens} 预测 ${Math.round(a * c + b * o)}`); }
for (const [name, path] of [["tycoon", dbPath], ["other", other]]) {
  const db = new DatabaseSync(path, { readOnly: true });
  const text = [...db.prepare("SELECT body FROM summaries WHERE void = 0").all(), ...db.prepare("SELECT body FROM knowledge_versions").all()].map((r) => r.body).join("");
  const [c, o] = split(text);
  console.log(`${name} 的摘要和知识：${text.length} 字，中文占 ${Math.round(c / text.length * 100)}%，预测每字 ${((a * c + b * o) / text.length).toFixed(2)} token`);
}
