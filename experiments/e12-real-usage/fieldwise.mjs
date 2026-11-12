// Before/after for rendering tool calls field by field (every field, each value clipped head/tail), per project:
// what the scribe sees in total, the shares, and how often 20000 characters would start a run.
// usage: node fieldwise.mjs <~/.claude/projects> [head] [tail]   (statistics only)
import { readdirSync, statSync } from "node:fs";
import { clip, effectivePath, parseTranscript, toEntries } from "../../core/transcript.ts";

const [root, head = "150", tail = "50"] = process.argv.slice(2);
const MIN = 20000;
const each = (input) => Object.entries(input ?? {}).map(([k, v]) => `${k}: ${clip(typeof v === "string" ? v : JSON.stringify(v), +head, +tail)}`).join("\n");
const q = (xs, p) => { xs = [...xs].sort((a, b) => a - b); return xs[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0; };
const batches = (turns, k) => { const out = []; let b = { chars: 0, turns: 0 }; for (const t of turns) { b.chars += t[k]; b.turns++; if (b.chars >= MIN) { out.push(b); b = { chars: 0, turns: 0 }; } } return out; };
const pct = (a, b) => `${Math.round((a / b) * 100)}%`;

console.log(`每个字段截成开头 ${head}、结尾 ${tail}`);
console.log("项目\t轮\t天\t总字数 前→后\t变化\t工具调用占 前→后\t回复占 前→后\t每轮中位 前→后\t每批轮数 前→后\t每天整理 前→后");
const sum = { now: 0, new: 0 };
for (const dir of readdirSync(root)) {
  if (!statSync(`${root}/${dir}`).isDirectory() || /experiments|private-tmp/.test(dir)) continue;
  const turns = [];
  for (const f of readdirSync(`${root}/${dir}`).filter((f) => f.endsWith(".jsonl"))) {
    let path, entries;
    try { path = effectivePath(parseTranscript(`${root}/${dir}/${f}`)); entries = toEntries(path).entries; } catch { continue; }
    const byUuid = new Map(path.map((r) => [r.uuid, r]));
    let t;
    for (const e of entries) {
      if (e.newTurn || !t) turns.push((t = { day: e.ts.slice(0, 10), now: 0, new: 0, useNow: 0, useNew: 0, reply: 0 }));
      let after = e.text.length;
      if (e.kind === "tool_use") {
        const b = (byUuid.get(e.uuid)?.message?.content ?? []).find((c) => c.type === "tool_use" && c.name === e.toolName);
        after = `调用 ${e.toolName}：\n${each(b?.input)}`.length;
        t.useNow += e.text.length; t.useNew += after;
      }
      if (e.role === "assistant" && e.kind === "text") t.reply += e.text.length;
      t.now += e.text.length; t.new += after;
    }
  }
  if (turns.length < 20) continue;
  const S = (k) => turns.reduce((s, x) => s + x[k], 0);
  const days = new Set(turns.map((x) => x.day)).size;
  const bn = batches(turns, "now"), bw = batches(turns, "new");
  sum.now += S("now"); sum.new += S("new");
  console.log([dir.replace(/^-Users-nozomi-(lab-)?/, ""), turns.length, days, `${S("now")}→${S("new")}`, `+${pct(S("new") - S("now"), S("now"))}`,
    `${pct(S("useNow"), S("now"))}→${pct(S("useNew"), S("new"))}`, `${pct(S("reply"), S("now"))}→${pct(S("reply"), S("new"))}`,
    `${q(turns.map((x) => x.now), 0.5)}→${q(turns.map((x) => x.new), 0.5)}`,
    `${q(bn.map((x) => x.turns), 0.5)}→${q(bw.map((x) => x.turns), 0.5)}`, `${(bn.length / days).toFixed(1)}→${(bw.length / days).toFixed(1)}`].join("\t"));
}
console.log(`合计：${sum.now} → ${sum.new} 字（+${pct(sum.new - sum.now, sum.now)}）`);
