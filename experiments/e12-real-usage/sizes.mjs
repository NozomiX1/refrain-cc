// The briefing the main model gets and the memory part of the scribe's input, section by section, from one database.
// usage: node sizes.mjs <copy of memory.db>   (statistics only)
import { DatabaseSync } from "node:sqlite";
import { briefing, scribeInput, summariesBlock, TOKENS_PER_CHAR } from "../../core/render.ts";

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const s = db.prepare("SELECT s.id, s.project_id, p.path FROM sessions s LEFT JOIN projects p ON p.id = s.project_id ORDER BY s.id DESC LIMIT 1").get();
const w = { projectId: s.project_id, projectPath: s.path, sessionId: s.id };
const sections = (text, heads) => Object.fromEntries(heads.map((h, i) => {
  const at = text.indexOf(h), next = heads.slice(i + 1).map((x) => text.indexOf(x)).find((x) => x > at) ?? text.length;
  return [h.replace(/^#+ /, ""), at < 0 ? 0 : next - at];
}));
const tok = (n) => `${n} 字 ≈ ${Math.round(n * TOKENS_PER_CHAR / 100) / 100} 万 token`;
const b = briefing(db, w);
console.log("简报（新会话开头、压缩后，主模型看到）：", tok(b.length));
for (const [k, v] of Object.entries(sections(b, ["# 记忆", "## 跨项目知识", "## 本项目", "## 现状"]))) console.log("  ", k, tok(v));
const x = scribeInput(db, w, [], "2026-11-12");
console.log("书记员输入里的已有记忆（不含这批对话）：", tok(x.indexOf("# 这次要处理的对话")));
for (const [k, v] of Object.entries(sections(x, ["# 已有的长期知识", "## 跨项目知识", "## 本项目知识", "# 本会话之前的摘要", "# 现状", "# 这次要处理的对话"]))) if (k !== "这次要处理的对话") console.log("  ", k, tok(v));
console.log("压缩后主模型看到的摘要块：", tok(summariesBlock(db, s.id).length));
const folded = (b.match(/较早的背景、决定和参考（只列开头）\n([\s\S]*?)(\n\n|$)/)?.[1] ?? "").split("\n").filter(Boolean).length;
console.log(`简报里被折成一行的知识：${folded} 条`);
const versions = db.prepare("SELECT count(*) AS n, sum(length(body)) AS c FROM knowledge_versions").get();
console.log(`数据库里知识的全部版本：${versions.n} 个，${versions.c} 字（书记员只看每条的当前版）`);
