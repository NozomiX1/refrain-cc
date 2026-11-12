// Score one finished replay against the pre-registered key (E8): Sonnet matches each key item to what the scribe
// wrote, in three calls (events vs summaries; knowledge and numbers vs knowledge, the final state and summaries —
// numbers that change belong in the state since 2026-10-29; state vs the final state). Counts that need no judge (sizes, runs, rejections, cost) are computed here.
// usage: node match.ts <replay out dir> <key.json> <out.json>
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb } from "../../core/db.ts";
import { localTime } from "../../core/render.ts";

const [dirArg, keyFile, outFile] = process.argv.slice(2);
const dir = resolve(dirArg);
const key = JSON.parse(readFileSync(keyFile, "utf8"));
const db = openDb(join(dir, "home", "memory.db"));
const LABEL: Record<string, string> = { quote: "原话", inference: "推断", observed: "观察" };
const CAT: Record<string, string> = { rule: "规则", understanding: "背景和决定", goal: "目标", reference: "参考" };

const versions = db.prepare(`SELECT k.code, v.version_no, v.status, v.scope, v.body, v.epistemic, v.category, v.reason,
  v.version_no = (SELECT MAX(version_no) FROM knowledge_versions WHERE knowledge_id = k.id AND void = 0) AS latest
  FROM knowledge_versions v JOIN knowledge k ON k.id = v.knowledge_id WHERE v.void = 0 ORDER BY k.id, v.version_no`).all() as any[];
const tag = (v: any) => `〔${v.scope === "global" ? "跨项目" : "本项目"}·${CAT[v.category]}·${LABEL[v.epistemic]}〕`;
const current = versions.filter((v) => v.latest && v.status === "active");
const old = versions.filter((v) => !(v.latest && v.status === "active"));
const knowledgeText = [
  `# 当前生效的知识\n\n${current.map((v) => `${v.code} ${tag(v)} ${v.body}`).join("\n")}`,
  `# 旧版本和已归档的知识（不再生效）\n\n${old.map((v) => `${v.code} 第 ${v.version_no} 版${v.status === "archived" ? "（已归档" + (v.reason ? "：" + v.reason : "") + "）" : "（旧版本）"} ${v.body}`).join("\n") || "（无）"}`,
].join("\n\n");

const summaries = db.prepare(`SELECT s.code, s.title, s.body, e.ts FROM summaries s LEFT JOIN entries e ON e.id = s.last_entry_id
  WHERE s.void = 0 ORDER BY s.id`).all() as any[];
const summaryText = `# 摘要\n\n${summaries.map((s) => `## ${s.code} [${s.ts ? localTime(s.ts) : "?"}] ${s.title}\n${s.body}`).join("\n\n")}`;

const lastState = (kind: string) => (db.prepare(`SELECT items FROM states WHERE kind = ? AND void = 0 ORDER BY id DESC LIMIT 1`).get(kind) as any)?.items;
const stateText = ["project", "session"].map((k) => {
  const items = JSON.parse(lastState(k) ?? "[]");
  // Since 2026-10-29 a project keeps one list (kind project); a session's own list is the state only outside a project.
  return `# ${k === "project" ? "项目现状" : "会话现状（不属于任何项目的会话；10-29 以前的回放里是本会话现状）"}\n\n${items.map((i: any) => `- [${i.type}] ${i.content}${i.condition ? `（条件：${i.condition}）` : ""}`).join("\n") || "（空）"}`;
}).join("\n\n");

function judge(prompt: string, items: Record<string, unknown>) {
  const schema = { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object", required: Object.keys(items), properties: items } } } };
  const r = spawnSync("claude", ["-p", "--model", "sonnet", "--effort", "medium", "--tools", "", "--setting-sources", "project", "--output-format", "json",
    "--no-session-persistence", "--json-schema", JSON.stringify(schema)], { cwd: "/tmp", input: prompt, encoding: "utf8", maxBuffer: 64 << 20, timeout: 20 * 60000 });
  const res = JSON.parse(r.stdout);
  return { items: res.structured_output.items as any[], cost: res.total_cost_usd as number, promptChars: prompt.length };
}

const INTRO = `你在核对一个记忆系统的输出。一段很长的对话（${key.context ?? "用户和 AI 助手 Claude 一起设计、实现一个叫 refrain 的记忆插件"}）被后台的"书记员"分批整理成了摘要、长期知识和现状。下面给出事先写好的标准答案，逐条判断书记员写的内容里有没有。只按下面给出的材料判断，不要用常识补；意思对上就算，不要求措辞一样。`;

const events = judge(`${INTRO}

对每个事件判断 verdict：covered（摘要里写到了这件事的要点）、partial（提到了，但要点缺了一部分或说得不准）、missing（找不到）、wrong（写了但和标准答案矛盾）。codes 填相关摘要的编号（M 开头），没有就空数组。note 一句话。

# 标准答案：事件

${key.events.map(([id, t]: string[]) => `- ${id}：${t}`).join("\n")}

${summaryText}`, { id: { type: "string" }, verdict: { enum: ["covered", "partial", "missing", "wrong"] }, codes: { type: "array", items: { type: "string" } }, note: { type: "string" } });

const kItems = [
  ...key.knowledge.map((k: any) => `- ${k.id}：${k.text}${k.old ? `\n  以前的版本（后来被改掉了）：${k.old.join("；")}` : ""}${k.why ? `\n  理由：${k.why}` : ""}`),
  ...key.numbers.map(([id, t]: string[]) => `- ${id}（数字）：${t}`),
];
const knowledge = judge(`${INTRO}

对每一条判断：
- verdict：captured（当前生效的知识里有这条；标着"数字"的，最后的现状里有也算）、partial（有，但缺了一部分或说得不准）、only_summary（知识里没有，只在摘要里有）、missing（都找不到）、wrong（写了但和标准答案矛盾）。
- codes：相关的知识编号（K 开头）或摘要编号（M 开头）；数字在现状里的，写"现状"。
- current_ok：这一条有"以前的版本"时，当前生效的知识是不是新版本、旧说法没有还当作生效的（yes / no）；没有"以前的版本"填 na。旧说法出现在"旧版本和已归档"里是正确的。
- why_at：这一条有"理由"时，理由在哪：knowledge（写在生效的知识里）、summary（只在摘要里）、none（都没有）；没有"理由"填 na。理由写出主要原因就算，不必每个细节都有。
- note：一句话。

# 标准答案：知识和数字

${kItems.join("\n")}

${knowledgeText}

${stateText}

${summaryText}`, { id: { type: "string" }, verdict: { enum: ["captured", "partial", "only_summary", "missing", "wrong"] }, codes: { type: "array", items: { type: "string" } },
  current_ok: { enum: ["yes", "no", "na"] }, why_at: { enum: ["knowledge", "summary", "none", "na"] }, note: { type: "string" } });

const stateKey = [...key.state.done.map((t: string, i: number) => `- D${i + 1}（已完成）：${t}`), ...key.state.pending.map((t: string, i: number) => `- P${i + 1}（还没做）：${t}`)];
const state = judge(`${INTRO}

这次只看对话结束时的现状。对每一条判断 verdict：present（现状里如实反映：已完成的写成完成或已不在待办里、还没做的列为待办）、stale（现状里有，但状态过时或不对，比如做完了还挂着）、missing（现状里没有）。note 一句话。另外，现状里如果有明显过时或错误的项，用 id "X1"、"X2"… 各列一条，verdict 填 stale，note 写是哪一项、为什么不对。

# 标准答案：对话结束时的现状

${stateKey.join("\n")}

${stateText}`, { id: { type: "string" }, verdict: { enum: ["present", "stale", "missing"] }, note: { type: "string" } });

// Traps (E8 lab): words that hold only where the user said them; written as a general preference they mislead elsewhere
// (the user's example: "docker is too heavy for a permission sandbox" stored as "the user dislikes docker").
const traps = key.traps?.length ? judge(`${INTRO}

下面每一条是用户在某个场合说的话，容易被写成脱离场合的一般偏好。只看"当前生效的知识"，对每一条判断 verdict：absent（没有相关的知识）、scoped（有，并且保留了场合或条件，读者不会拿去套到别的情况）、widened（有，但写成了脱离场合的一般偏好或规则）。codes 填相关的知识编号。note 一句话。

# 容易被扩大的说法

${key.traps.map(([id, t]: string[]) => `- ${id}：${t}`).join("\n")}

${knowledgeText}`, { id: { type: "string" }, verdict: { enum: ["absent", "scoped", "widened"] }, codes: { type: "array", items: { type: "string" } }, note: { type: "string" } }) : null;

// What a subscription's limit counts, roughly (report.ts in e7): uncached input, cache writes and output at API prices.
const PRICE: Record<string, [number, number]> = { haiku: [0.1, 0.5], sonnet: [2, 10], opus: [4, 20] };
let quota = 0;
for (const f of readdirSync(join(dir, "runs"))) {
  const line = readFileSync(join(dir, "runs", f), "utf8").split("\n").find((l) => l.includes('"type":"result"'));
  for (const [model, u] of Object.entries<any>(line ? JSON.parse(line).modelUsage : {})) {
    const [i, o] = PRICE[Object.keys(PRICE).find((k) => model.includes(k)) ?? "haiku"];
    quota += ((u.inputTokens + u.cacheCreationInputTokens) * i + u.outputTokens * o) / 1e6;
  }
}
const runs = JSON.parse(readFileSync(join(dir, "runs.json"), "utf8")) as any[];
const count = (xs: any[], f: string, v: string) => xs.filter((x) => x[f] === v).length;
const core = new Set(key.knowledge.filter((k: any) => k.core).map((k: any) => k.id));
const kIds = new Set(key.knowledge.map((k: any) => k.id)), nIds = new Set(key.numbers.map(([id]: string[]) => id));
const kOnly = knowledge.items.filter((x) => kIds.has(x.id));
const avg = (xs: string[]) => Math.round(xs.reduce((n, s) => n + s.length, 0) / Math.max(1, xs.length));
const tally = (xs: any[], f: string) => Object.fromEntries([...new Set(xs.map((x) => x[f]))].map((v) => [v, count(xs, f, v)]));
const sum = {
  events: tally(events.items, "verdict"),
  knowledge: tally(kOnly, "verdict"),
  coreKnowledge: tally(kOnly.filter((x) => core.has(x.id)), "verdict"),
  currentOk: tally(kOnly.filter((x) => x.current_ok !== "na"), "current_ok"),
  whyAt: tally(kOnly.filter((x) => x.why_at !== "na"), "why_at"),
  numbers: tally(knowledge.items.filter((x) => nIds.has(x.id)), "verdict"),
  state: tally(state.items.filter((x) => !x.id.startsWith("X")), "verdict"),
  stateWrongExtras: state.items.filter((x) => x.id.startsWith("X")).length,
  ...(traps ? { traps: tally(traps.items, "verdict") } : {}),
  sizes: { knowledgeActive: current.length, knowledgeOld: old.length, knowledgeAvgChars: avg(current.map((v) => v.body)),
    summaries: summaries.length, summaryAvgChars: avg(summaries.map((s) => s.body)) },
  runs: { n: runs.length, failed: runs.filter((r) => r.status !== "succeeded").length, rejected: runs.reduce((n, r) => n + (r.rejected ?? 0), 0),
    searches: runs.reduce((n, r) => n + (r.calls?.search ?? 0) + (r.calls?.read ?? 0), 0),
    apiCost: Math.round(runs.reduce((n, r) => n + (r.cost ?? 0), 0) * 1000) / 1000, quota: Math.round(quota * 1000) / 1000 },
  judgeCost: Math.round((events.cost + knowledge.cost + state.cost + (traps?.cost ?? 0)) * 1000) / 1000,
};
writeFileSync(outFile, JSON.stringify({ ...sum, detail: { events: events.items, knowledge: knowledge.items, state: state.items, traps: traps?.items ?? [] } }, null, 1));
console.log(JSON.stringify(sum, null, 1));
