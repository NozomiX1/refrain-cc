// What the scribe's input is made of, before and after clipping (design.md 5.1 LIMITS), from refrain's own database.
// usage: node composition.mjs <copy of memory.db>   (prints statistics only; the text never leaves the machine)
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const rows = db.prepare("SELECT role, kind, tool_name, raw_chars, text FROM entries WHERE status = 'active'").all();

const PASTE = /〔粘贴〕[\s\S]*?〔粘贴结束〕/g;
const cat = (r) => {
  if (r.role === "user") return "用户的话";
  if (r.kind === "text") return "Claude 的回复";
  if (r.kind === "tool_use") return "工具调用（输入）";
  return "工具结果";
};
const q = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
const stat = (xs) => { xs = [...xs].sort((a, b) => a - b); return { n: xs.length, p50: q(xs, 0.5), p90: q(xs, 0.9), p99: q(xs, 0.99), max: xs.at(-1) ?? 0 }; };

const by = {}, byTool = {};
let rawAll = 0, shownAll = 0;
for (const r of rows) {
  const c = cat(r);
  // raw_chars of a tool result is the result's own size; the shown text adds "<tool> 成功，原始 xKB：" in front.
  const raw = r.raw_chars, shown = r.text.length;
  const b = (by[c] ??= { n: 0, raw: 0, shown: 0, clipped: 0, lens: [] });
  b.n++; b.raw += raw; b.shown += shown; b.lens.push(raw);
  if (/……（中间省略 \d+ 字符）……/.test(r.text)) b.clipped++;
  rawAll += raw; shownAll += shown;
  if (r.kind !== "text") {
    const t = (byTool[`${r.tool_name ?? "?"} ${r.kind === "tool_use" ? "输入" : "结果"}`] ??= { n: 0, raw: 0, shown: 0, clipped: 0 });
    t.n++; t.raw += raw; t.shown += shown;
    if (/……（中间省略 \d+ 字符）……/.test(r.text)) t.clipped++;
  }
}
const pastes = rows.filter((r) => r.role === "user").flatMap((r) => r.text.match(PASTE) ?? []);

const pct = (a, b) => `${((a / b) * 100).toFixed(1)}%`;
console.log(`记录 ${rows.length} 条；截断前共 ${rawAll} 字，截断后共 ${shownAll} 字\n`);
console.log("类别\t条数\t截断前字数\t占比\t截断后字数\t占比\t被截条数");
for (const [c, b] of Object.entries(by)) console.log(`${c}\t${b.n}\t${b.raw}\t${pct(b.raw, rawAll)}\t${b.shown}\t${pct(b.shown, shownAll)}\t${b.clipped}`);
console.log("\n长度分布（截断前，字）");
for (const [c, b] of Object.entries(by)) console.log(c, JSON.stringify(stat(b.lens)));
console.log(`\n用户粘贴：${pastes.length} 段`);
console.log("\n按工具（截断前字数从多到少）\n工具\t条数\t截断前\t截断后\t被截");
for (const [t, b] of Object.entries(byTool).sort((a, b) => b[1].raw - a[1].raw).slice(0, 16)) console.log(`${t}\t${b.n}\t${b.raw}\t${b.shown}\t${b.clipped}`);
