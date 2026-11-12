import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { address, openDb } from "../core/db.ts";
import { briefing, FOLD, scribeInput, stateBlock, summariesBlock } from "../core/render.ts";
import { CHECKLIST, cutBatch, finish, prepare, submit } from "../core/scribe.ts";
import { transcript } from "./fixture.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), ".."); // a git repo, so it is a project
const TODAY = "2026-10-25";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "refrain-home-"));
  const db = openDb(join(home, "memory.db"));
  const t = transcript();
  const path = join(home, "t.jsonl");
  const prep = (extra: object = {}) => {
    t.write(path);
    return prepare(db, home, { ccSessionId: "cc-1", transcriptPath: path, cwd: repo, force: true, today: TODAY, ...extra });
  };
  const ready = () => {
    const p = prep();
    assert.equal(p.status, "ready");
    return (p as { runId: number }).runId;
  };
  // Every run must leave a summary (6.5); tests about something else get a one-line one on the batch's first entry.
  const note = (runId: number) => {
    const r = db.prepare("SELECT session_id, request FROM runs WHERE id = ?").get(runId) as { session_id: number; request: string };
    return { title: "测试", body: "测试用的摘要。", refs: [address(r.session_id, JSON.parse(r.request).batch[0])] };
  };
  return { home, db, t, path, prep, ready, sub: (runId: number, s: object, looked?: boolean) => submit(db, home, runId, { summaries: [note(runId)], ...s }, looked) };
}

const empty = { knowledge: [], state: null };
const rule = (refs = ["S1/T1#E1"]) => ({ op: "create", scope: "global", category: "rule", about_me: true, epistemic: "quote", pending: false,
  body: "先讨论再动手：给出推荐，等用户确认后再改文件。", refs, reason: "用户明确说过" });

test("the briefing header is the one in model-facing/briefing.md", () => {
  const doc = readFileSync(join(repo, "docs/model-facing/briefing.md"), "utf8");
  const expected = doc.slice(doc.indexOf("# 记忆\n\n"), doc.indexOf("\n\n## 跨项目知识")).replace("refrain（/home/user/refrain）", "refrain（/x/refrain）");
  const { db, t, ready, sub } = setup();
  t.human("以后先讨论再动手");
  assert.ok(sub(ready(), { ...empty, knowledge: [rule()] }).ok);
  const got = briefing(db, { projectId: 1, projectPath: "/x/refrain" }, "2026-10-25");
  assert.equal(got.slice(0, got.indexOf("\n\n## 跨项目知识")), expected);
});

test("a valid submission is written in one go and the briefing follows", () => {
  const { home, db, t, ready, sub } = setup();
  t.human("以后先讨论再动手，给我推荐");
  t.say("好的，我会先给推荐。");
  const runId = ready();
  const r = sub(runId, {
    summaries: [{ title: "约定做事方式", tags: ["流程"], body: "用户要求以后先讨论再动手。", refs: ["S1/T1#E1", "S1/T1#E2 @assistant"] }],
    knowledge: [rule()],
    state: [{ op: "create", type: "phase", body: "实现阶段" }],
  });
  assert.equal(r.text, "已保存：1 份摘要，知识新建 1 条，现状已更新。这次整理完成，不用再回复。");
  const k = db.prepare("SELECT k.code, v.as_of, v.refs FROM knowledge k JOIN knowledge_versions v ON v.knowledge_id = k.id").get() as any;
  assert.deepEqual([k.code, JSON.parse(k.refs)], ["K1", ["S1/T1#E1"]]);
  assert.equal(db.prepare("SELECT code FROM summaries").get()!.code, "M1");
  const file = briefing(db, { projectId: 1, projectPath: repo });
  assert.match(file, /### 规则\n- K1 先讨论再动手/);
  assert.match(file, /## 现状\n\n1\. 阶段：实现阶段〔截至 10-25〕/);
  const run = db.prepare("SELECT status, request, response FROM runs WHERE id = ?").get(runId) as any;
  assert.equal(run.status, "succeeded");
  assert.match(JSON.parse(run.request).prompt, /以后先讨论再动手/, "the scribe's input is kept");
  assert.ok(run.response);
});

test("problems come back as a numbered receipt and nothing is saved", () => {
  const { db, t, ready, sub } = setup();
  t.human("你看着办");
  t.say("我决定用 SQLite。");
  const runId = ready();
  const r = sub(runId, {
    summaries: [{ title: "选存储", body: "Claude 选了 SQLite。", refs: ["S1/T9#E1"] }],
    knowledge: [{ ...rule(["S1/T1#E2"]), epistemic: "quote" }, { ...rule(["S1/T1#E2"]), epistemic: "observed" }],
    state: [{ op: "create", type: "instruction", body: "可以直接改 docs/", refs: ["S1/T1#E2"] }],
  });
  assert.equal(r.ok, false);
  assert.match(r.text, /^有 4 处问题，这次提交没有保存。请改好后整份重新提交（还可以再交 2 次）：/);
  assert.match(r.text, /summaries（"选存储"）：refs 里的 S1\/T9#E1 不是一条存在的记录/);
  assert.match(r.text, /knowledge（create "先讨论再动手：给出推荐，等用户确认后再改文件。"，你交的第 1 个）：epistemic 是 quote，但 refs 里没有一条是用户本人的话/);
  assert.match(r.text, /knowledge（create "先讨论再动手：给出推荐，等用户确认后再改文件。"，你交的第 2 个）：观察（observed）不能是规则/);
  assert.match(r.text, /用户的临时要求的 refs 里要有一条是用户本人的话/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge").get()!.n, 0);
});

test("three rejected submissions fail the run; the bookmark stays and the next run retries", () => {
  const { db, t, ready, sub, prep } = setup();
  t.human("一");
  const runId = ready();
  for (let i = 0; i < 3; i++) sub(runId, { summaries: "x" });
  assert.equal((db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as any).status, "failed");
  assert.match(sub(runId, empty).text, /已经结束/);
  const again = prep();
  assert.equal(again.status, "ready");
  assert.match((again as any).prompt, /\[S1\/T1#E1 @user\] 一/);
});

test("a submit without a summary goes back: the scribe skipped its input", () => {
  const { t, ready, sub } = setup();
  t.human("接下来写简报");
  const r = sub(ready(), { ...empty, summaries: [] });
  assert.equal(r.ok, false);
  assert.match(r.text, /summaries 是空的。每次至少写一份摘要/);
});

test("a valid submit with no search or read is held once: confirm saves it, stopping there saves it too", () => {
  const { home, db, t, ready, sub } = setup();
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM knowledge").get() as { n: number }).n;
  t.human("以后先讨论再动手");
  const id = ready();
  assert.match(sub(id, { confirm: true }, false).text, /没有等你确认的提交/);
  const held = sub(id, { ...empty, knowledge: [rule()] }, false);
  assert.deepEqual([held.ok, held.text, count()], [false, CHECKLIST, 0]);
  assert.equal((db.prepare("SELECT attempts FROM runs WHERE id = ?").get(id) as any).attempts, 0, "neither the stray confirm nor the held submit counts as a try");
  const ok = sub(id, { confirm: true }, false);
  assert.ok(ok.ok, ok.text);
  assert.equal(count(), 1);
  t.human("回复里别贴整段代码");
  const id2 = ready();
  assert.equal(sub(id2, { ...empty, knowledge: [{ ...rule(["S1/T2#E1"]), body: "回复里不贴整段代码。" }] }, false).text, CHECKLIST);
  assert.equal(finish(db, home, id2).status, "succeeded", "held work is saved when the scribe stops at the checklist");
  assert.equal(count(), 2);
});

test("a state item that starts with its own type is not labelled twice", () => {
  const at = { as_of: "2026-10-25" };
  assert.equal(stateBlock([
    { type: "phase", content: "阶段：实现阶段", ...at },
    { type: "progress", content: "进度: 正在讨论 H8", ...at },
    { type: "todo", content: "待核实：字段含义", ...at },
  ]), "1. 阶段：实现阶段〔截至 10-25〕\n2. 进行中：正在讨论 H8〔截至 10-25〕\n3. 待办：待核实：字段含义〔截至 10-25〕");
});

test("a state over the cap goes back", () => {
  const { t, ready, sub } = setup();
  t.human("列一下待办");
  const ops = Array.from({ length: 21 }, (_, i) => ({ op: "create", type: "todo", body: `待办 ${i + 1}` }));
  const r = sub(ready(), { ...empty, state: ops });
  assert.equal(r.ok, false);
  assert.match(r.text, /state：交完后有 21 项，最多 20 项/);
});

test("the state has at most one phase, and none outside a project", () => {
  const { t, ready, sub } = setup();
  t.human("到哪了");
  const two = sub(ready(), { ...empty, state: [{ op: "create", type: "phase", body: "实现阶段" }, { op: "create", type: "phase", body: "已上线" }] });
  assert.match(two.text, /state：交完后有 2 项阶段（phase），阶段只能有一项/);
  const o = setup();
  o.t.human("闲聊");
  const p = o.prep({ cwd: o.home }) as { runId: number };
  const none = o.sub(p.runId, { ...empty, state: [{ op: "create", type: "phase", body: "闲聊" }] });
  assert.match(none.text, /这个会话不属于任何项目，没有阶段/);
});

test("a user's temporary request holds only in the session that gave it", () => {
  const { db, home, t, ready, sub } = setup();
  t.human("这几轮可以直接改 README");
  assert.ok(sub(ready(), { ...empty, state: [
    { op: "create", type: "instruction", body: "这几轮可以直接改 README", refs: ["S1/T1#E1"] },
    { op: "create", type: "todo", body: "写测试" },
  ] }).ok);
  assert.match(briefing(db, { projectId: 1, projectPath: repo, sessionId: 1 }), /1\. 用户的临时要求：这几轮可以直接改 README/);
  assert.doesNotMatch(briefing(db, { projectId: 1, projectPath: repo, sessionId: null }), /直接改 README/, "not in a new session");
  const t2 = transcript("w");
  t2.human("继续");
  t2.write(join(home, "t2.jsonl"));
  const p = prepare(db, home, { ccSessionId: "cc-2", transcriptPath: join(home, "t2.jsonl"), cwd: repo, force: true, today: TODAY }) as { runId: number; prompt: string };
  assert.match(p.prompt, /# 现状\n\n1\. 待办：写测试〔/, "the other session's request is not shown, and numbering starts after it");
  assert.ok(sub(p.runId, { ...empty, state: [{ op: "keep", no: 1 }] }).ok);
  assert.doesNotMatch(briefing(db, { projectId: 1, projectPath: repo, sessionId: 2 }), /直接改 README/);
  assert.match(briefing(db, { projectId: 1, projectPath: repo, sessionId: 1 }), /2\. 用户的临时要求：这几轮可以直接改 README/, "back in the first session, it is there again");
});

test("the briefing folds this project's older 背景和决定 past the budget; the scribe still reads them whole", () => {
  const { db, t, ready, sub } = setup();
  t.human("记一下这些背景");
  const bg = (i: number) => ({ ...rule(), scope: "project", category: "understanding", about_me: false,
    body: `第${i}条背景的结论写在开头。${"细节".repeat(100)}` });
  // 30 × ~214 chars: the newest stay whole up to FOLD.background, the oldest fold; the rule never folds.
  assert.ok(sub(ready(), { ...empty, knowledge: [{ ...rule(), scope: "project" }, ...Array.from({ length: 30 }, (_, i) => bg(i + 1))] }).ok);
  const b = briefing(db, { projectId: 1, projectPath: repo });
  assert.match(b, /### 规则\n- K1 先讨论再动手/);
  assert.match(b, /### 较早的背景、决定和参考（只列开头）\n- K2 第1条背景的结论写在开头。\n/);
  assert.match(b, /- K31 第30条背景的结论写在开头。细节/, "the newest is whole");
  t.human("再聊一句");
  const input = scribeInput(db, { projectId: 1, projectPath: repo, sessionId: 1 }, [], TODAY);
  assert.match(input, /- K2 第1条背景的结论写在开头。细节/);
  assert.match(input, /<对话记录>\n[\s\S]*<\/对话记录>\n\n以上是这次要整理的对话记录。[^\n]*调用 submit 提交。\n$/, "the transcript is fenced and the input ends on what to do");
});

test("a closed session's leftover is finished by the next session of the project, whatever its size", () => {
  const { home, db, t, path, prep, sub } = setup();
  t.human("第一个会话最后定的事");
  t.say("好的，记下了");
  assert.equal(prep({ force: false }).status, "skip", "below the threshold, as a session's last few turns usually are");
  const t2 = transcript();
  t2.human("第二个会话");
  const path2 = join(home, "t2.jsonl");
  t2.write(path2);
  const second = () => prepare(db, home, { ccSessionId: "cc-2", transcriptPath: path2, cwd: repo, today: TODAY }) as any;
  assert.equal(second().status, "skip", "the first session was written just now: it may still be open");
  const hoursAgo = (Date.now() - 2 * 3600000) / 1000;
  utimesSync(path, hoursAgo, hoursAgo);
  const r = second();
  assert.equal(r.status, "ready");
  assert.equal(r.leftoverOf, 1);
  assert.match(r.prompt, /第一个会话最后定的事/);
  assert.ok(sub(r.runId, empty).ok);
  assert.equal(second().status, "skip", "caught up");
  assert.ok(db.prepare("SELECT 1 FROM meta WHERE key = 'caught-up:1'").get(), "remembered, so the file is not read again");
});

test("finishing without a submit fails the run", () => {
  const { db, t, ready } = setup();
  t.human("一");
  const runId = ready();
  assert.equal(finish(db, mkdtempSync(join(tmpdir(), "refrain-home-")), runId).status, "failed");
  assert.equal((db.prepare("SELECT error FROM runs WHERE id = ?").get(runId) as any).error, "没有调用 submit 就结束了");
});

test("only one run at a time", () => {
  const { t, ready, prep } = setup();
  t.human("一");
  ready();
  assert.deepEqual(prep(), { status: "skip", reason: "another scribe run is in progress" });
});

test("update merges old refs; merge via temp label archives the old items; archived items leave the briefing", () => {
  const { db, t, ready, sub } = setup();
  t.human("以后先讨论再动手");
  assert.ok(sub(ready(), { ...empty, knowledge: [rule(), { ...rule(), body: "改之前先给推荐。" }] }).ok);
  t.human("还有，确认后再改文件");
  assert.ok(sub(ready(), { ...empty, knowledge: [{ op: "update", code: "K1", body: "先讨论再动手，确认后再改文件。", refs: ["S1/T2#E1"], reason: "用户补充了确认后再改" }] }).ok);
  t.human("这两条其实是一件事");
  const twice = sub(ready(), { ...empty, knowledge: [
    { op: "update", code: "K1", body: "x", refs: ["S1/T3#E1"], reason: "y" },
    { op: "archive", code: "K1", refs: ["S1/T3#E1"], reason: "z" }] });
  assert.match(twice.text, /knowledge：K1 写了 2 次（update、archive）。一个编号只能有一个操作/);
  const r = sub((db.prepare("SELECT MAX(id) AS id FROM runs").get() as any).id, {
    ...empty,
    knowledge: [
      { op: "create", id: "new1", scope: "global", category: "rule", about_me: true, epistemic: "quote", pending: false,
        body: "先讨论、给推荐，确认后再改文件。", refs: ["K1", "K2"], reason: "由 K1、K2 合并" },
      { op: "archive", code: "K1", refs: ["new1"], reason: "并入 new1" },
      { op: "archive", code: "K2", refs: ["new1"], reason: "并入 new1" },
    ],
  });
  assert.ok(r.ok, r.text);
  const v = db.prepare("SELECT k.code, v.op, v.reason, v.refs FROM knowledge_versions v JOIN knowledge k ON k.id = v.knowledge_id ORDER BY v.id").all() as any[];
  assert.deepEqual(v.map((x) => `${x.code} ${x.op}`), ["K1 create", "K2 create", "K1 update", "K3 create", "K1 archive", "K2 archive"]);
  assert.equal(v[4].reason, "并入 K3");
  assert.deepEqual(JSON.parse(v[2].refs), ["S1/T1#E1", "S1/T2#E1"], "update keeps the earlier evidence");
  assert.deepEqual(JSON.parse(v[3].refs), ["S1/T1#E1", "S1/T2#E1"], "K codes expand to their current refs");
  const b = briefing(db, { projectId: 1, projectPath: repo });
  assert.ok(b.includes("- K3 ") && !b.includes("- K1 ") && !b.includes("- K2 "));
});

test("state ops: keep copies, update inherits what it leaves out, every old item must appear once, promotion points at a new item", () => {
  const { db, t, ready, sub } = setup();
  t.human("先别提交");
  assert.ok(sub(ready(), { ...empty, state: [
    { op: "create", type: "instruction", body: "先别提交", refs: ["S1/T1#E1"] },
    { op: "create", type: "todo", body: "写测试", condition: "等接口定了" },
    { op: "create", type: "todo", body: "改 README" },
  ] }).ok);
  t.human("以后都先别提交，等我看 diff");
  const id = ready();
  const bad = sub(id, { ...empty, state: [
    { op: "keep", no: 2, body: "写测试" },
    { op: "update", no: 3 },
    { op: "keep", no: 3 },
    { op: "create", no: 4, type: "todo", body: "x" },
    { op: "keep" },
    { op: "abandon", no: 1 },
  ] });
  assert.match(bad.text, /state（keep，你交的第 5 个）：keep 要写 no，就是上一版的序号/);
  assert.match(bad.text, /state（abandon 第 1 项 ?）?：op 只能是 keep、update、close 或 create。结束一项（完成、放弃、升级）都用 close/);
  assert.match(bad.text, /state（keep 第 2 项 "写测试"）：keep 只写 op 和 no；要改内容用 update/);
  assert.match(bad.text, /state（update 第 3 项）：缺少 body/);
  assert.match(bad.text, /state：第 3 项写了 2 次（update、keep）。一项只能写一次/);
  assert.match(bad.text, /state（create "x"）：create 不带 no/);
  assert.match(bad.text, /state：上一版第 1 项（"先别提交"）这次没有写。每一项都要用 keep、update 或 close 写一次/);
  const ok = sub(id, {
    ...empty,
    knowledge: [{ ...rule(["S1/T2#E1"]), id: "new1", body: "提交前先等用户看 diff。" }],
    state: [{ op: "update", no: 3, body: "改 README 和 CHANGELOG" }, { op: "keep", no: 2 }, { op: "close", no: 1, outcome: "promoted", to: "new1" }],
  });
  assert.ok(ok.ok, ok.text);
  const st = db.prepare("SELECT items, closed FROM states ORDER BY id DESC LIMIT 1").get() as any;
  assert.deepEqual(JSON.parse(st.items), [
    { type: "todo", content: "改 README 和 CHANGELOG", condition: null, as_of: TODAY },
    { type: "todo", content: "写测试", condition: "等接口定了", as_of: TODAY },
  ]);
  assert.deepEqual(JSON.parse(st.closed), [{ no: 1, outcome: "promoted", to: "K1" }]);
});

test("a rewind undoes the run and its knowledge disappears from the briefing", () => {
  const { db, t, ready, sub, prep } = setup();
  const first = t.human("以后先讨论再动手");
  const reply = t.say("好");
  assert.ok(sub(ready(), { ...empty, knowledge: [rule()] }).ok);
  assert.match(briefing(db, { projectId: 1, projectPath: repo }), /K1/);
  t.human("当我没说", first);
  void reply;
  const p = prep();
  assert.equal(p.status, "ready");
  assert.equal(briefing(db, { projectId: 1, projectPath: repo }), "", "nothing left to inject");
});

test("summaries fold in batches of K behind the newest N", () => {
  const { db, t, ready, sub } = setup();
  t.human("x");
  const n = FOLD.n + FOLD.k + 3;
  const ms = Array.from({ length: n }, (_, i) => ({ title: `话题${i + 1}`, body: `正文${i + 1}`, refs: ["S1/T1#E1"] }));
  assert.ok(sub(ready(), { ...empty, summaries: ms }).ok);
  const block = summariesBlock(db, 1);
  assert.match(block, /^M1 话题1\nM2 话题2/);
  assert.ok(block.includes(`M${FOLD.k} 话题${FOLD.k}\n\n## M${FOLD.k + 1} 话题${FOLD.k + 1}`), "boundary on a multiple of K");
});

test("a batch is whole turns, at least one", () => {
  const e = (turnNo: number, len: number) => ({ turnNo, entryNo: 1, text: "x".repeat(len) }) as any;
  assert.deepEqual(cutBatch([e(1, 60), e(1, 60), e(2, 10)], 100).map((x) => x.turnNo), [1, 1]);
  assert.deepEqual(cutBatch([e(1, 30), e(2, 30), e(3, 50)], 100).map((x) => x.turnNo), [1, 2]);
});
