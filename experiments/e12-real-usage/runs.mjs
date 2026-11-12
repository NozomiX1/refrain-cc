// Each scribe run: what its input held, how big its context got and why, what it called, what it cost.
// usage: node runs.mjs <copy of memory.db> <the session's subagents dir>   (statistics only)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

const [dbPath, dir] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: true });
const runs = db.prepare("SELECT id, started_at, finished_at, usage, request, response FROM runs WHERE status = 'succeeded' ORDER BY id").all();

// The scribe's own transcripts: one per run, matched by the first prompt's text.
const agents = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(`${dir}/${f}`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const promptOf = (rows) => { const c = rows.find((r) => r.type === "user")?.message?.content; return typeof c === "string" ? c : (c ?? []).map((b) => b.text ?? "").join(""); };

const q = (xs, p) => { xs = [...xs].sort((a, b) => a - b); return xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]; };
const out = [];
for (const r of runs) {
  const req = JSON.parse(r.request), u = JSON.parse(r.usage);
  const rows = agents.find((a) => promptOf(a).includes(req.batch.at(-1).text.slice(0, 200)));
  if (!rows) { console.error("no transcript for run", r.id); continue; }
  const batch = req.batch.reduce((n, e) => n + e.text.length, 0);
  const replies = req.batch.filter((e) => e.role === "assistant" && e.kind === "text").reduce((n, e) => n + e.text.length, 0);
  const steps = [], seen = new Set(), tools = {};
  let resultChars = 0, rejected = 0;
  for (const x of rows) {
    if (x.type === "assistant" && !seen.has(x.message.id)) {
      seen.add(x.message.id);
      const v = x.message.usage;
      steps.push({ ctx: v.input_tokens + v.cache_read_input_tokens + v.cache_creation_input_tokens, out: v.output_tokens });
    }
    for (const c of x.type === "assistant" ? x.message.content ?? [] : []) if (c.type === "tool_use") { const n = c.name.replace(/^mcp__.*__/, ""); tools[n] = (tools[n] ?? 0) + 1; }
    for (const c of x.type === "user" && Array.isArray(x.message.content) ? x.message.content : []) if (c.type === "tool_result") {
      const t = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
      resultChars += t.length;
      if (c.is_error || /tool_use_error/.test(t)) rejected++;
    }
  }
  const resp = JSON.parse(r.response ?? "{}");
  out.push({
    id: r.id, minutes: (Date.parse(r.finished_at) - Date.parse(r.started_at)) / 60000,
    turns: req.batch.filter((e) => e.newTurn).length, batch, replies, prompt: promptOf(rows).length,
    firstCtx: steps[0].ctx, lastCtx: steps.at(-1).ctx, outTotal: u.output_tokens, firstOut: steps[0].out, requests: steps.length,
    resultChars, rejected, tools, summaries: resp.summaries?.length ?? 0, knowledge: resp.knowledge?.length ?? 0, state: resp.state?.length ?? 0,
    sumLens: (resp.summaries ?? []).map((s) => s.body.length), kLens: (resp.knowledge ?? []).filter((k) => k.body).map((k) => k.body.length),
  });
}

// Tokens per character of the prompt: a straight line through (prompt chars, first request tokens); the intercept
// is the scribe's system prompt and tools, the slope what one character of our input costs.
const n = out.length, mx = out.reduce((s, o) => s + o.prompt, 0) / n, my = out.reduce((s, o) => s + o.firstCtx, 0) / n;
const slope = out.reduce((s, o) => s + (o.prompt - mx) * (o.firstCtx - my), 0) / out.reduce((s, o) => s + (o.prompt - mx) ** 2, 0);
const cols = ["id", "minutes", "turns", "batch", "replies", "prompt", "firstCtx", "firstOut", "lastCtx", "outTotal", "requests", "resultChars", "rejected", "summaries", "knowledge", "state"];
console.log(cols.join("\t"));
for (const o of out) console.log(cols.map((c) => (typeof o[c] === "number" ? Math.round(o[c] * 10) / 10 : o[c])).join("\t"));
const med = (k) => q(out.map((o) => o[k]), 0.5);
console.log(`\n运行 ${n} 次。中位：用时 ${med("minutes").toFixed(1)} 分钟，${med("turns")} 轮，这批对话 ${med("batch")} 字（其中回复 ${med("replies")} 字），整份输入 ${med("prompt")} 字`);
console.log(`第一次请求 ${med("firstCtx")} token，最后一次 ${med("lastCtx")} token；输出共 ${med("outTotal")} token，其中第一次请求 ${med("firstOut")}`);
console.log(`回复占这批对话 ${(out.reduce((s, o) => s + o.replies, 0) / out.reduce((s, o) => s + o.batch, 0) * 100).toFixed(1)}%，占整份输入 ${(out.reduce((s, o) => s + o.replies, 0) / out.reduce((s, o) => s + o.prompt, 0) * 100).toFixed(1)}%`);
console.log(`拟合：第一次请求 ≈ ${Math.round(my - slope * mx)} token + 每字 ${slope.toFixed(3)} token × 输入字数`);
const all = (k) => out.flatMap((o) => o[k]);
const sl = all("sumLens"), kl = all("kLens");
console.log(`摘要 ${sl.length} 份：正文中位 ${q(sl, 0.5)} 字，p90 ${q(sl, 0.9)}，最长 ${Math.max(...sl)}（上限 600），≥550 字的 ${sl.filter((x) => x >= 550).length} 份`);
console.log(`知识写入 ${kl.length} 次：正文中位 ${q(kl, 0.5)} 字，p90 ${q(kl, 0.9)}，最长 ${Math.max(...kl)}（上限 400），≥370 字的 ${kl.filter((x) => x >= 370).length} 次`);
const tools = {};
for (const o of out) for (const [k, v] of Object.entries(o.tools)) tools[k] = (tools[k] ?? 0) + v;
console.log("工具调用合计", JSON.stringify(tools), "被拒", out.reduce((s, o) => s + o.rejected, 0));
