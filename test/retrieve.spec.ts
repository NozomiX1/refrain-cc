import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "../core/db.ts";
import { grewSince, handoff } from "../core/handoff.ts";
import { statusTurn } from "../core/ops.ts";
import { localTime } from "../core/render.ts";
import { parseTranscript } from "../core/transcript.ts";
import { rank, read, search, terms } from "../core/retrieve.ts";
import { prepare, submit } from "../core/scribe.ts";
import { transcript } from "./fixture.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const empty = { knowledge: [], state: null };

// Two scribe runs over a short session: one summary and knowledge item each, the second item later archived.
function world() {
  const home = mkdtempSync(join(tmpdir(), "refrain-home-"));
  const db = openDb(join(home, "memory.db"));
  const t = transcript();
  const path = join(home, "t.jsonl");
  const run = (s: object) => {
    t.write(path);
    const p = prepare(db, home, { ccSessionId: "cc-1", transcriptPath: path, cwd: repo, force: true, today: "2026-10-25" }) as any;
    const r = submit(db, home, p.runId, s);
    assert.ok(r.ok, r.text);
  };
  t.human("书记员的输出协议怎么定？");
  t.say("我建议用一个 submit 工具整份提交，校验不过就重交。要我写进 design.md 吗？");
  t.human("可以，写吧");
  t.call("c1", "Bash", { command: "npm test" });
  t.result("c1", "Error: submit schema rejected");
  run({ ...empty,
    summaries: [{ title: "讨论书记员的输出协议", tags: ["H6"], body: "Claude 提议用一个 submit 工具整份提交；用户同意。", refs: ["S1/T1#E2", "S1/T2#E1"] }],
    knowledge: [{ op: "create", scope: "project", category: "understanding", about_me: false, epistemic: "quote", pending: false,
      body: "书记员用一个 submit 工具整份提交。", refs: ["S1/T2#E1"], reason: "用户同意" }] });
  t.human("合并知识时保留较早的条目");
  t.say("好");
  t.human("算了，合并时新建一条");
  run({ ...empty,
    summaries: [{ title: "讨论合并怎么做", body: "用户先说保留较早的，后来改成新建一条。", refs: ["S1/T3#E1", "S1/T4#E1"] }],
    knowledge: [
      { op: "create", id: "new1", scope: "project", category: "understanding", about_me: false, epistemic: "quote", pending: false,
        body: "合并知识时新建一条、归档旧的。", refs: ["S1/T4#E1"], reason: "用户改了主意" },
      { op: "update", code: "K1", body: "书记员用一个 submit 工具整份提交，最多重交 3 次。", refs: ["S1/T2#E1"], reason: "补充次数" },
    ] });
  return { db, t, path, run, home, s: { sessionId: 1, projectId: 1 } };
}

test("search: one line per knowledge item naming its other matching versions, summaries with time and body, raw hits grouped under their summary", () => {
  const { db, s, t, run } = world();
  const out = search(db, s, { query: "submit 整份提交" });
  assert.match(out, /^找到 1 条知识、1 份摘要、2 条原始记录。/);
  assert.match(out, /K1  背景和决定 · 当前  书记员用一个 submit 工具整份提交，最多重交 3 次。（旧版本 @1 也提到这些词）\n/);
  assert.doesNotMatch(out, /^K1@1/m);
  assert.match(out, /M1  \d\d-\d\d \d\d:\d\d  讨论书记员的输出协议\n     Claude 提议/);
  assert.match(out, /▸ 出自 M1 讨论书记员的输出协议（1 条）\n    S1\/T1#E2 Claude/);
  assert.match(out, /▸ 没被任何摘要讲到的原始记录 1 条；整理这些记录时一起写的摘要有：M1 讨论书记员的输出协议\n    S1\/T2#E3 工具结果/);
  // Only old versions hold the words: the best of them is listed, pointing at the current one.
  t.human("别提 submit 工具了，就说提交不过就重交");
  run({ ...empty, summaries: [{ title: "改写 K1", body: "用户让 K1 不提工具名。", refs: ["S1/T5#E1"] }],
    knowledge: [{ op: "update", code: "K1", body: "书记员提交不过就重交，最多 3 次。", refs: ["S1/T5#E1"], reason: "用户要求" }] });
  assert.match(search(db, s, { query: "submit 工具", in: "knowledge" }), /^K1@\d  背景和决定 · 旧版本  书记员用一个 submit 工具整份提交.*（当前版本没有提到这些词，read\("K1"\) 看现在的内容）$/m);
});

test("search: plain words, however spaced; a row with only some of them still comes back; nothing at all says so", () => {
  const { db, s } = world();
  assert.match(search(db, s, { query: "合并 新建", in: "summaries" }), /找到 1 份摘要。/);
  assert.match(search(db, s, { query: "合并新建", in: "summaries" }), /找到 1 份摘要。/);
  assert.match(search(db, s, { query: "合并 schema", in: "summaries" }), /M2  .*讨论合并怎么做\n     用户先说/);
  assert.match(search(db, s, { query: "保留 | 重交", in: "raw" }), /找到 2 条原始记录/);
  assert.match(search(db, s, { query: "部署 端口", in: "summaries" }), /没有找到包含"部署 端口"的摘要（范围：当前项目）。\n可以换个说法/);
});

test("search ranks by relevance, not by time, and lists what the limit cut as titles", () => {
  const { db, s } = world();
  // M2 is newer, but M1 has more of the words (书记员 in its title, submit in its body).
  const out = search(db, s, { query: "合并 书记员 submit", in: "summaries", limit: 1 });
  assert.match(out, /找到 2 份摘要。\n\n摘要：\nM1  .*讨论书记员的输出协议\n     Claude 提议.*\n更多（只列标题）：\nM2  .*讨论合并怎么做$/);
});

test("terms: Latin by word, Chinese in two-character pieces, separators do not matter; rank: rarer and more terms first", () => {
  assert.deepEqual(terms("阿里云 | 退订"), ["阿里", "里云", "退订"]);
  assert.deepEqual(terms("crawl.js 失败，K75"), ["crawl.js", "失败", "k75"]);
  assert.deepEqual(terms("C 方案|原型"), ["c", "方案", "原型"]);
  const rows = [...Array.from({ length: 30 }, (_, i) => `第 ${i} 份 c 记录`), "原型 原型 c 三版", "原型 一句"];
  const order = rank(rows, (r) => r, ["c", "原型"], rows.length).map((r) => r.row);
  assert.deepEqual(order.slice(0, 2), ["原型 原型 c 三版", "原型 一句"], "c is in every row and weighs little");
  assert.equal(order.length, 32, "rows with only c still come back, after the rest");
});

test("search without a query lists the latest summaries, newest first", () => {
  const { db, s } = world();
  assert.match(search(db, s, {}), /^本项目最新的 2 份摘要（从新到旧）：\n\nM2 .*\n     用户先说.*\nM1 /);
});

test("read: knowledge history, a summary with its neighbours, a user entry with the reply it answers", () => {
  const { db, s } = world();
  const k = read(db, s, "K1");
  assert.match(k, /^K1  背景和决定 · 本项目 · 当前（第 2 版）\n书记员用一个 submit 工具整份提交，最多重交 3 次。\n依据：用户原话\n出处：S1\/T2#E1\n/);
  assert.match(k, /第 2 版  .*  更新  补充次数\n  第 1 版  .*  新建  用户同意/);
  assert.match(read(db, s, "K1@1"), /^K1@1  背景和决定 · 本项目 · 旧版本（第 1 版）/);
  assert.match(read(db, s, "M1"), /^M1  讨论书记员的输出协议\n会话 S1 · .* · 标签：H6\n出处：S1\/T1#E2、S1\/T2#E1\n\nClaude 提议.*\n\n同一会话里时间上相邻的摘要（不一定是同一个话题）：\n  后：M2 讨论合并怎么做$/);
  const e = read(db, s, "S1/T2#E1 @user");
  assert.match(e, /^〔上文：Claude 上一条回复的末尾〕\n…我建议用一个 submit 工具整份提交，校验不过就重交。要我写进 design\.md 吗？\n\nS1\/T2#E1  用户  .*\n可以，写吧\n\n这条记录出自 M1 讨论书记员的输出协议。$/);
  assert.match(read(db, s, "S1/T2#E3"), /同一时段的摘要：M1 讨论书记员的输出协议。$/);
});

test("read: a range of turns, the unclipped original, and addresses it cannot read", () => {
  const { db, s, t, path } = world();
  assert.match(read(db, s, "S1/T1-T2"), /^S1\/T1#E1  用户  .*\n书记员的输出协议怎么定？\n\nS1\/T1#E2/);
  t.write(path);
  assert.match(read(db, s, "S1/T2#E3", true), /Error: submit schema rejected/);
  assert.match(read(db, s, "S1/T99#E1"), /^没有找到 S1\/T99#E1。还没整理进记忆的记录读不到/);
  assert.match(read(db, s, "foo"), /^看不懂地址 foo。/);
});

test("handoff: summaries plus the user's note; the tail starts at the bookmark, and the last turn is kept even when processed", () => {
  const { db, t, path } = world();
  t.human("接下来写简报");
  t.say("好的");
  t.write(path);
  const h = handoff(db, 1, path, "重点保留合并的讨论") as any;
  assert.equal(h.status, "ok");
  assert.match(h.text, /^为了腾出上下文空间/);
  assert.match(h.text, /# 本会话到目前为止的摘要\n\n## M1 讨论书记员的输出协议/);
  assert.match(h.text, /「重点保留合并的讨论」$/);
  assert.deepEqual(h.tail, { turns: 1, firstText: "接下来写简报" });
  const all = handoff(db, 1, join(dirname(path), "t.jsonl")) as any;
  assert.ok(all.tail.turns >= 1);
  assert.equal(handoff(db, null, null).status, "skip", "nothing in memory yet");
});

test("handoff: a backlog that would leave more than half the context is not compacted, and says why", () => {
  const { db, t, path } = world();
  (t.rows.find((r) => r.type === "assistant") as any).message.usage = { input_tokens: 5000 }; // CC's own part, kept by any compaction
  const before = t.rows.findLast((r) => r.type === "assistant") as any;
  before.message.usage = { input_tokens: 10, cache_read_input_tokens: 90000 };
  t.human("接下来写简报");
  t.say("好的", { input_tokens: 5, cache_read_input_tokens: 100000, output_tokens: 200 });
  t.write(path);
  assert.equal(handoff(db, 1, path).status, "ok", "a 10k tail out of 100k");
  assert.match((handoff(db, 1, path, undefined, "plugin") as any).notice, /^refrain：缓存已过期（距上一轮结束 .*），已自动压缩，上下文由约 10 万 token 减至约 \d+(\.\d)? 万。$/);
  before.message.usage = { input_tokens: 10, cache_read_input_tokens: 20000 };
  t.write(path);
  assert.deepEqual(handoff(db, 1, path), { status: "skip", notice: "refrain：暂不压缩。上下文中大部分是尚未整理的最近对话（" +
    localTime(t.rows.find((r) => r.message?.content === "接下来写简报")!.timestamp!) + " 起的 1 轮对话），压缩时需原样保留，压缩后上下文不会明显减少。" }, "an 80k tail");
});

test("handoff: nothing processed since the last compaction is not compacted again; the scribe running or paused is said instead", () => {
  const { db, t, path } = world();
  t.human("接下来写简报");
  t.say("好的");
  t.compact([]);
  t.write(path);
  assert.equal(handoff(db, 1, path).status, "ok", "a run finished after the compaction");
  db.prepare("UPDATE runs SET finished_at = ?").run("2026-01-01T00:00:00.000Z");
  assert.match((handoff(db, 1, path) as any).notice, /^refrain：暂不压缩。上次压缩以后还没有新整理的对话（.* 起的 1 轮对话尚未整理），压缩后上下文不会明显减少。$/);
  const p = prepare(db, mkdtempSync(join(tmpdir(), "refrain-home-")), { ccSessionId: "cc-1", transcriptPath: path, cwd: repo, force: true }) as any;
  assert.equal(p.status, "ready");
  assert.match((handoff(db, 1, path, undefined, "plugin") as any).notice, /^refrain：缓存已过期，未自动压缩。书记员正在整理.* 起的 1 轮对话，预计 5 分钟内完成。$/);
  db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(p.runId);
  for (let i = 0; i < 2; i++) db.prepare("INSERT INTO runs (session_id, started_at, status) VALUES (1, ?, 'failed')").run(new Date().toISOString());
  assert.match((handoff(db, 1, path) as any).notice, /^refrain：暂不压缩。书记员已暂停（连续失败 3 次），.* 起的 1 轮对话尚未整理。查看原因：\/refrain；恢复：\/refrain resume。$/);
});

test("status file: what is not yet processed is counted at the turn's end and again once the scribe has it", () => {
  const { db, t, path, home } = world();
  t.human("接下来写简报");
  t.say("好的");
  t.write(path);
  const p = prepare(db, home, { ccSessionId: "cc-1", transcriptPath: path, cwd: repo, force: true }) as any;
  assert.equal(statusTurn(db, home, 1)?.pendingTurns, 1);
  submit(db, home, p.runId, { ...empty, summaries: [{ title: "讨论简报", body: "用户要写简报。", refs: ["S1/T5#E1"] }] });
  assert.equal(statusTurn(db, home, 1)?.pendingTurns, 0);
  assert.equal(statusTurn(db, home, 1)?.worth, true);
});

test("grewSince: what a compaction kept counts from before it, what it put in does not (tycoon 11-08)", () => {
  const t = transcript();
  t.say("整理到这里", { cache_read_input_tokens: 838000 });
  const kept = t.human("带一张图的那一轮");
  t.say("好", { cache_read_input_tokens: 847000 });
  t.compact([kept]);
  t.compact([kept]);
  t.human("先别急");
  t.say("好", { cache_read_input_tokens: 64000 });
  t.human("展开说说");
  t.say("好", { cache_read_input_tokens: 91000 });
  const path = join(mkdtempSync(join(tmpdir(), "refrain-t-")), "t.jsonl");
  t.write(path);
  const rows = parseTranscript(path);
  assert.equal(grewSince(rows, rows.find((r) => r.uuid === kept)!.line - 1), 9000 + 27000);
});

test("grewSince: from the session's start, CC's own prompt in the first request is not counted", () => {
  const t = transcript();
  const from = t.human("第一句");
  t.say("好", { cache_creation_input_tokens: 37000 });
  t.say("读完了", { cache_read_input_tokens: 60000 });
  const path = join(mkdtempSync(join(tmpdir(), "refrain-t-")), "t.jsonl");
  t.write(path);
  const rows = parseTranscript(path);
  assert.equal(grewSince(rows, rows.find((r) => r.uuid === from)!.line - 1), 23000);
});

test("grewSince: a resume that drops old thinking shrinks the context; the turns after it still count (tycoon 11-08)", () => {
  const t = transcript();
  t.say("整理到这里", { cache_read_input_tokens: 187000 });
  const from = t.human("还没整理的一轮");
  t.say("好", { cache_read_input_tokens: 209000 });
  t.human("恢复会话后的一轮");
  t.say("好", { cache_read_input_tokens: 177000 });
  t.say("接着做", { cache_read_input_tokens: 186000 });
  const path = join(mkdtempSync(join(tmpdir(), "refrain-t-")), "t.jsonl");
  t.write(path);
  const rows = parseTranscript(path);
  assert.equal(grewSince(rows, rows.find((r) => r.uuid === from)!.line - 1), 22000 + 9000);
});
