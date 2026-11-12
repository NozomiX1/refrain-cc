// Search test set (E10): does the answer show up in what search returns, at which place, and how much was cut off.
// No model is called, so it can be rerun after every change to search.
// usage: node run.ts <cases.json>   cases: { db, session, cases: [{ name, expect: [code | address], queries: [SearchArgs] }] }
import { readFileSync } from "node:fs";
import { openDb } from "../../core/db.ts";
import { search } from "../../core/retrieve.ts";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const db = openDb(spec.db);
const s = db.prepare("SELECT s.id AS sessionId, p.id AS projectId, p.path AS projectPath FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?").get(spec.session) as any;

// Where the answer sits: which part of the result (knowledge, summaries, raw), its place there, and whether it is shown
// in full or only as a title past the limit. Knowledge and summary lines start with their code; raw groups name their
// summary, raw lines start with their address.
function place(out: string, expect: string[]): string | null {
  let part = "", n = 0, folded = false;
  for (const l of out.split("\n")) {
    if (/^(知识|摘要)：$/.test(l) || /^原始记录 \d+ 条/.test(l)) [part, n, folded] = [l.slice(0, 2) === "原始" ? "原始记录" : l.slice(0, 2), 0, false];
    if (/^更多（/.test(l)) folded = true;
    const id = l.match(/^(K\d+|M\d+)(@\d+)?\s/)?.[1] ?? l.match(/^▸ 出自 (M\d+)/)?.[1] ?? l.match(/^\s+(S\d+\/T\d+#E\d+)\s/)?.[1];
    if (!id) continue;
    n++;
    if (expect.includes(id)) return `${part}第 ${n} 个${folded ? "（折叠的标题里）" : ""}`;
  }
  return null;
}

let found = 0, total = 0;
for (const c of spec.cases) {
  console.log(`\n## ${c.name}（答案 ${c.expect.join("、")}）`);
  for (const q of c.queries) {
    total++;
    const out = search(db, s, { scope: "project", ...q });
    const at = place(out, c.expect);
    // The same query with no cap: how many matched in all, so a miss can be told apart from "not matched at all".
    const reachable = place(search(db, s, { scope: "project", ...q, limit: 100000 }), c.expect);
    if (at) found++;
    console.log(`  ${at ? "✓" : "✗"} ${JSON.stringify(q)}  →  ${at ?? (reachable ? `匹配到了但被截掉（不截时在${reachable}）` : "根本没匹配到")}\n      ${out.split("\n")[0]}`);
  }
}
console.log(`\n合计：${found} / ${total} 次检索的结果里有答案`);
