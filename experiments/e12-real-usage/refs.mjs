// What the scribe cites: for each summary and knowledge version, the kind of record each source address points to.
// usage: node refs.mjs <copy of memory.db>   (statistics only)
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const kind = new Map();
for (const e of db.prepare("SELECT turn_no, entry_no, role, kind FROM entries WHERE status = 'active'").all())
  kind.set(`${e.turn_no}#${e.entry_no}`, e.role === "user" ? "用户" : e.kind === "text" ? "回复" : e.kind === "tool_use" ? "工具调用" : "工具结果");
const count = (rows, label) => {
  const c = {}; let refs = 0, other = 0;
  for (const r of rows) for (const a of JSON.parse(r.refs)) {
    refs++;
    const m = a.match(/^S\d+\/T(\d+)#E(\d+)$/);
    if (!m) { other++; continue; }
    const k = kind.get(`${m[1]}#${m[2]}`) ?? "?";
    c[k] = (c[k] ?? 0) + 1;
  }
  console.log(`${label}：${rows.length} 条，出处 ${refs} 个（其中指向摘要、知识编号等 ${other} 个）`, JSON.stringify(c));
};
count(db.prepare("SELECT refs FROM summaries WHERE void = 0").all(), "摘要");
for (const ep of ["quote", "inference", "observed"]) count(db.prepare("SELECT refs FROM knowledge_versions WHERE epistemic = ?").all(ep), `知识 ${ep}`);
