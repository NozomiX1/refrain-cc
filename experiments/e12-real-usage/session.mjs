// The main session: context at each turn end, the breaks long enough for the cache to expire, each compaction's
// before/after, resumes and whether they kept the cache.   usage: node session.mjs <transcript.jsonl>   (statistics only)
import { readFileSync } from "node:fs";

const rows = readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const total = (u) => u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens + u.output_tokens;
const reqs = [], seen = new Set();
for (const r of rows) {
  const u = r.type === "assistant" && !r.isSidechain ? r.message?.usage : undefined;
  if (!u || seen.has(r.message.id) || !total(u)) continue;
  seen.add(r.message.id);
  reqs.push({ ts: r.timestamp, ctx: total(u), read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens });
}
// A turn ends at a turn_duration record; its context is the last request before it.
// A compaction copies the kept tail's records again, turn ends included: one per timestamp.
const ends = [...new Map(rows.filter((r) => r.subtype === "turn_duration").map((r) => [r.timestamp, r])).values()].map((r) => ({ ts: r.timestamp, ctx: reqs.findLast((q) => q.ts <= r.timestamp)?.ctx ?? 0 }));
const q = (xs, p) => { xs = [...xs].sort((a, b) => a - b); return xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]; };
const man = (n) => `${(n / 10000).toFixed(1)}万`;

console.log(`请求 ${reqs.length} 次，轮 ${ends.length} 个；轮末上下文 中位 ${man(q(ends.map((e) => e.ctx), 0.5))}，p90 ${man(q(ends.map((e) => e.ctx), 0.9))}，最大 ${man(Math.max(...ends.map((e) => e.ctx)))}`);

// Breaks: from a turn's end to the next request.
const breaks = [];
for (const e of ends) {
  const next = reqs.find((r) => r.ts > e.ts);
  if (!next) continue;
  const gap = (Date.parse(next.ts) - Date.parse(e.ts)) / 60000;
  if (gap > 60) breaks.push({ at: e.ts.slice(5, 16), gap: Math.round(gap), ctx: e.ctx, nextRead: next.read, nextWrite: next.write });
}
console.log(`\n离开超过 1 小时 ${breaks.length} 次（缓存已过期）：`);
for (const b of breaks) console.log(`  ${b.at}  离开 ${(b.gap / 60).toFixed(1)} 小时  当时上下文 ${man(b.ctx)}  回来第一次请求 读 ${man(b.nextRead)} 写 ${man(b.nextWrite)}`);
const cut = [100000, 150000, 200000].map((t) => `≥${t / 10000}万 ${breaks.filter((b) => b.ctx >= t).length} 次`).join("，");
console.log(`  其中当时上下文 ${cut}`);

console.log("\n压缩：");
for (const b of rows.filter((r) => r.subtype === "compact_boundary")) {
  const after = reqs.find((r) => r.ts > b.timestamp);
  const notice = rows.find((r) => r.subtype === "informational" && Math.abs(Date.parse(r.timestamp) - Date.parse(b.timestamp)) < 2000 && /refrain/.test(r.content ?? ""))?.content ?? "";
  console.log(`  ${b.timestamp.slice(5, 16)}  压缩前 ${man(b.compactMetadata.preTokens)}  压后第一次请求 ${after ? man(after.ctx) + `（读 ${man(after.read)} 写 ${man(after.write)}，${after.ts.slice(5, 16)}）` : "-"}  ${notice.match(/减至约 [\d.]+ 万/)?.[0] ?? ""}`);
}

console.log("\n恢复会话：");
for (const s of rows.filter((r) => r.attachment?.hookEvent === "SessionStart" && /resume/.test(r.attachment?.hookName ?? ""))) {
  const before = reqs.findLast((r) => r.ts < s.timestamp), after = reqs.find((r) => r.ts > s.timestamp);
  console.log(`  ${s.timestamp.slice(5, 16)}  距上次请求 ${Math.round((Date.parse(s.timestamp) - Date.parse(before.ts)) / 60000)} 分钟  上次上下文 ${man(before.ctx)}  恢复后第一次 读 ${man(after.read)} 写 ${man(after.write)}`);
}
