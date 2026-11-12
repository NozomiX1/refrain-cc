// Every local main session, rendered the way the scribe sees it: how much each turn adds, how much of it is
// Claude's replies, how often 20000 characters would start a run, and whether the reply tells what the tools did.
// usage: node others.mjs <~/.claude/projects>   (statistics only)
import { readdirSync, statSync } from "node:fs";
import { effectivePath, parseTranscript, toEntries } from "../../core/transcript.ts";

const root = process.argv[2];
const MIN = 20000;
const q = (xs, p) => { xs = [...xs].sort((a, b) => a - b); return xs[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0; };
console.log("项目\t轮\t有对话的天\t每轮字数中位\tp90\t回复占(截后)\t回复占(截前)\t批数\t每批轮数中位\t每天批数\t带工具的轮\t其中回复<200字");
const all = { turns: [], replyShort: 0, toolTurns: 0 };
for (const dir of readdirSync(root)) {
  if (!statSync(`${root}/${dir}`).isDirectory() || /experiments|private-tmp/.test(dir)) continue;
  const turns = [];
  for (const f of readdirSync(`${root}/${dir}`).filter((f) => f.endsWith(".jsonl"))) {
    let entries;
    try { entries = toEntries(effectivePath(parseTranscript(`${root}/${dir}/${f}`))).entries; } catch { continue; }
    let t;
    for (const e of entries) {
      if (e.newTurn || !t) turns.push((t = { day: e.ts.slice(0, 10), shown: 0, raw: 0, reply: 0, replyRaw: 0, tools: 0 }));
      t.shown += e.text.length; t.raw += e.rawChars;
      if (e.role === "assistant" && e.kind === "text") { t.reply += e.text.length; t.replyRaw += e.rawChars; }
      if (e.kind === "tool_use") t.tools++;
    }
  }
  if (turns.length < 20) continue;
  // Runs as the scribe would start them: whole turns until the batch reaches MIN.
  const batches = []; let b = { chars: 0, turns: 0 };
  for (const t of turns) { b.chars += t.shown; b.turns++; if (b.chars >= MIN) { batches.push(b); b = { chars: 0, turns: 0 }; } }
  const days = new Set(turns.map((t) => t.day)).size;
  const sum = (k) => turns.reduce((s, t) => s + t[k], 0);
  const tool = turns.filter((t) => t.tools > 0), short = tool.filter((t) => t.reply < 200);
  all.turns.push(...turns); all.toolTurns += tool.length; all.replyShort += short.length;
  console.log([dir.replace(/^-Users-nozomi-/, ""), turns.length, days, q(turns.map((t) => t.shown), 0.5), q(turns.map((t) => t.shown), 0.9),
    `${Math.round(sum("reply") / sum("shown") * 100)}%`, `${Math.round(sum("replyRaw") / sum("raw") * 100)}%`, batches.length,
    q(batches.map((x) => x.turns), 0.5), (batches.length / days).toFixed(1), tool.length, short.length].join("\t"));
}
const ts = all.turns;
console.log(`\n合计 ${ts.length} 轮：每轮字数中位 ${q(ts.map((t) => t.shown), 0.5)}，p90 ${q(ts.map((t) => t.shown), 0.9)}；每轮回复中位 ${q(ts.map((t) => t.reply), 0.5)} 字；带工具的轮 ${all.toolTurns} 个，其中回复不到 200 字的 ${all.replyShort} 个`);
