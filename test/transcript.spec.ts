import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSession } from "../core/transcript.ts";
import { transcript } from "./fixture.ts";

const read = (t: ReturnType<typeof transcript>) => {
  const p = join(mkdtempSync(join(tmpdir(), "refrain-")), "t.jsonl");
  t.write(p);
  return readSession(p);
};
const brief = (t: ReturnType<typeof transcript>) => read(t).entries.map((e) => `${e.role}${e.newTurn ? "*" : ""} ${e.text}`);

test("keeps the user's words, replies and tool steps; drops injections", () => {
  const t = transcript();
  t.human("看一下 README");
  t.attachment();
  t.meta("<system-reminder>injected</system-reminder>");
  t.thinking();
  t.call("c1", "Read", { file_path: "/x/README.md" });
  t.result("c1", "# hello");
  t.notification("<task-notification>subagent done</task-notification>");
  t.say("README 只有一行。");
  assert.deepEqual(brief(t), [
    "user* 看一下 README",
    "assistant 调用 Read：\nfile_path: /x/README.md",
    "observation Read 成功，原始 0.0KB：# hello",
    "assistant README 只有一行。",
  ]);
});

test("pasted text is marked as context, slash commands keep their arguments", () => {
  const t = transcript();
  t.human('照这个改：<pasted_content id="1">别人写的方案</pasted_content id="1">');
  t.human("<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>只看 core/</command-args>");
  assert.deepEqual(brief(t), ["user* 照这个改：〔粘贴〕别人写的方案〔粘贴结束〕", "user* /review 只看 core/"]);
});

test("only a rejection by the user counts as the user's; classifier blocks are tool results", () => {
  const t = transcript();
  t.human("删掉 tmp");
  t.call("c1", "Bash", { command: "rm -rf tmp" });
  t.result("c1", "User rejected tool use", { toolDenialKind: "user-rejected", is_error: true });
  t.call("c2", "Bash", { command: "rm -rf tmp2" });
  t.result("c2", "Error: Permission for this action was denied", { toolDenialKind: "automode-blocked", is_error: true });
  t.interrupt();
  assert.deepEqual(brief(t).slice(2), [
    "user 〔拒绝了上面的工具调用〕",
    "assistant 调用 Bash：\ncommand: rm -rf tmp2",
    "observation Bash 失败，原始 0.0KB：Error: Permission for this action was denied",
    "user 〔打断〕",
  ]);
});

test("parallel tool results are kept although only the last one is on the parent chain", () => {
  const t = transcript();
  t.human("读两个文件");
  const a1 = t.call("c1", "Read", { file_path: "a" });
  const a2 = t.call("c2", "Read", { file_path: "b" });
  t.result("c1", "A", {}, a1);
  t.result("c2", "B", {}, a2);
  t.say("都读完了");
  assert.deepEqual(brief(t), ["user* 读两个文件", "assistant 调用 Read：\nfile_path: a", "assistant 调用 Read：\nfile_path: b", "observation Read 成功，原始 0.0KB：A", "observation Read 成功，原始 0.0KB：B", "assistant 都读完了"]);
});

test("a rewind drops the abandoned branch", () => {
  const t = transcript();
  const first = t.human("方案 A");
  t.say("好的，A");
  t.human("其实不对", first);
  t.say("改成 B");
  // The user rewinds to just after "方案 A" and says something else.
  t.human("换个问法", first);
  t.say("C");
  assert.deepEqual(brief(t), ["user* 方案 A", "user* 换个问法", "assistant C"]);
});

test("across a compaction: history before the boundary stays, the rewritten tail is skipped", () => {
  const t = transcript();
  t.human("第一轮");
  t.say("回复一");
  const keep1 = t.human("第二轮");
  const keep2 = t.say("回复二");
  t.compact([keep1, keep2]);
  t.human("压缩后");
  t.say("回复三");
  const { entries } = read(t);
  assert.deepEqual(entries.map((e) => e.text), ["第一轮", "回复一", "第二轮", "回复二", "压缩后", "回复三"]);
  assert.equal(entries[2].uuid, keep1, "bookmarks and refs point at the original, not the copy");
});

test("a kept-tail copy whose parent points back at the original does not bypass the boundary", () => {
  const t = transcript();
  t.human("第一轮");
  const call = t.call("c1", "Bash", { command: "ls" });
  t.result("c1", "a b");
  const reply = t.say("回复一");
  const keep = t.human("第二轮");
  const keepReply = t.say("回复二");
  t.compact([keep, keepReply]);
  // CC 2.1.310 rewrote one copy's parentUuid to a pre-compaction row (s1 run 2).
  t.rows.at(-2)!.parentUuid = call;
  t.human("压缩后");
  const { entries } = read(t);
  assert.ok(entries.some((e) => e.uuid === reply), "rows between that original and the boundary stay on the path");
  assert.deepEqual(entries.map((e) => e.text).slice(-3), ["第二轮", "回复二", "压缩后"]);
});

test("long text is clipped at both ends with the omitted size", () => {
  const t = transcript();
  t.human("跑测试");
  t.call("c1", "Bash", { command: "npm test" });
  t.result("c1", "x".repeat(5000));
  const obs = read(t).entries[2];
  assert.equal(obs.rawChars, 5000);
  assert.match(obs.text, /（中间省略 4600 字符）/);
});

test("a tool call shows every field, each value clipped alike", () => {
  const t = transcript();
  t.human("改一下");
  t.call("c1", "Edit", { file_path: "a.md", old_string: "旧".repeat(500), new_string: "新", replace_all: false });
  t.call("c2", "Bash", { command: "ls", description: "List files" });
  const [edit, bash] = read(t).entries.slice(1).map((e) => e.text);
  assert.equal(edit, `调用 Edit：\nfile_path: a.md\nold_string: ${"旧".repeat(150)} ……（中间省略 300 字符）…… ${"旧".repeat(50)}\nnew_string: 新\nreplace_all: false`);
  assert.equal(bash, "调用 Bash：\ncommand: ls\ndescription: List files");
});

test("without any origin field, falls back to plain user text and warns", () => {
  const t = transcript();
  t.rows.push({ type: "user", uuid: "old1", parentUuid: null, timestamp: "2026-10-01T00:00:00Z", message: { content: "老版本的消息" } });
  t.rows.push({ type: "user", uuid: "old2", parentUuid: "old1", timestamp: "2026-10-01T00:00:01Z", message: { content: "<local-command-stdout>x</local-command-stdout>" } });
  const { entries, warnings } = read(t);
  assert.deepEqual(entries.map((e) => e.text), ["老版本的消息"]);
  assert.equal(warnings.length, 1);
});
