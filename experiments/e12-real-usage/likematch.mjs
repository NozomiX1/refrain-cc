// Could the program find the old item a new piece of knowledge belongs to, with the search we have? Ground truth: every
// update the scribe made names the item it updated. Query each new version's text against the knowledge as it stood
// just before, and see where that item ranks. usage: node likematch.mjs <copy of memory.db>   (statistics only)
import { DatabaseSync } from "node:sqlite";
import { rank, terms } from "../../core/retrieve.ts";

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const versions = db.prepare("SELECT id, knowledge_id, version_no, op, status, body FROM knowledge_versions ORDER BY id").all();
const first = (s) => s.split(/(?<=[。；！？])/)[0];
// shortcut: Lucene's "more like this" in small: the query keeps its n rarest terms by document frequency.
const rarest = (s, n, corpus) => {
  const ws = terms(s);
  const df = (w) => corpus.filter((t) => t.includes(w)).length;
  return ws.map((w) => [w, df(w)]).filter(([, d]) => d > 0).sort((a, b) => a[1] - b[1]).slice(0, n).map(([w]) => w);
};
const ways = { 全文: (s) => terms(s), 第一句: (s) => terms(first(s)), 最少见的20个词: (s, c) => rarest(s, 20, c) };
const res = Object.fromEntries(Object.keys(ways).map((k) => [k, []]));
// How much of the old text the new version kept: updates mostly rewrite a little, an easy case. The least similar
// quarter stands in for a duplicate written in other words.
const overlap = (a, b) => { const x = new Set(terms(a)), y = new Set(terms(b)); return [...x].filter((w) => y.has(w)).length / Math.max(1, new Set([...x, ...y]).size); };
const sims = [];
for (const v of versions.filter((v) => v.op === "update")) {
  // The knowledge just before this write: each item's latest version so far, the active ones.
  const latest = new Map();
  for (const x of versions) if (x.id < v.id) latest.set(x.knowledge_id, x);
  const live = [...latest.values()].filter((x) => x.status === "active");
  const texts = live.map((x) => x.body.toLowerCase());
  sims.push(overlap(v.body, latest.get(v.knowledge_id).body));
  for (const [name, q] of Object.entries(ways)) {
    const ranked = rank(live, (x) => x.body, q(v.body, texts), live.length);
    const at = ranked.findIndex((r) => r.row.knowledge_id === v.knowledge_id);
    res[name].push(at < 0 ? Infinity : at + 1);
  }
}
const n = res.全文.length;
const cut = [...sims].sort((a, b) => a - b)[Math.floor(n / 4)];
const hard = sims.map((x, i) => (x <= cut ? i : -1)).filter((i) => i >= 0);
console.log(`更新 ${n} 次：拿新写的内容去搜当时的有效知识，被更新的那条排第几`);
for (const [name, xs] of Object.entries(res)) {
  const top = (k) => xs.filter((x) => x <= k).length;
  console.log(`${name}：第 1 名 ${top(1)}，前 3 ${top(3)}，前 5 ${top(5)}，前 10 ${top(10)}，没搜到 ${xs.filter((x) => x === Infinity).length}`);
  const h = hard.map((i) => xs[i]);
  console.log(`  其中和旧版最不像的 ${h.length} 次（词重合 ≤ ${(cut * 100).toFixed(0)}%）：第 1 名 ${h.filter((x) => x <= 1).length}，前 3 ${h.filter((x) => x <= 3).length}，前 5 ${h.filter((x) => x <= 5).length}`);
}
