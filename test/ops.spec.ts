import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "../core/db.ts";
import { backupIfDue, log, resume, runCost } from "../core/ops.ts";
import { panel } from "../core/panel.ts";
import { finish, prepare, submit } from "../core/scribe.ts";
import { transcript } from "./fixture.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "refrain-home-"));
  const db = openDb(join(home, "memory.db"));
  const t = transcript();
  const path = join(home, "t.jsonl");
  const prep = () => {
    t.write(path);
    return prepare(db, home, { ccSessionId: "cc-1", transcriptPath: path, cwd: repo, force: true, today: "2026-10-25" }) as any;
  };
  const status = () => JSON.parse(readFileSync(join(home, "status/cc-1.json"), "utf8"));
  return { home, db, t, path, prep, status };
}

test("cost: tokens times the price table, cache write at 1.25x and read at 0.1x of input", () => {
  const u = { input_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6, output_tokens: 1e6, model: "claude-haiku-5-5" };
  assert.equal(Number(runCost(u).toFixed(4)), 0.1 + 0.125 + 0.01 + 0.5);
  assert.equal(runCost(null), 0);
});

test("three failures in a row pause the session; resume clears the count", () => {
  const { home, db, t, prep, status } = setup();
  t.human("一");
  for (let i = 0; i < 3; i++) {
    const p = prep();
    assert.equal(p.status, "ready");
    assert.equal(status().state, "running");
    finish(db, home, p.runId, { output_tokens: 1000, model: "haiku" });
  }
  assert.equal(status().state, "paused");
  assert.equal(status().failures, 3);
  assert.deepEqual(prep(), { status: "skip", reason: "paused" });
  resume(db, 1);
  const p = prep();
  assert.equal(p.status, "ready", "a resumed session runs again");
  assert.ok(submit(db, home, p.runId, { summaries: [{ title: "测试", body: "测试用的摘要。", refs: ["S1/T1#E1"] }], knowledge: [], state: null }).ok);
  assert.equal(status().state, "idle");
  assert.equal(status().costUsd, 0.0015, "the failed runs' tokens still count");
});

test("backup once a day, newest seven kept", () => {
  const { home, db } = setup();
  const dir = join(home, "backup");
  const today = backupIfDue(db, home)!;
  assert.match(today, /^memory-\d{4}-\d{2}-\d{2}\.db$/);
  assert.equal(backupIfDue(db, home), null, "already done today");
  for (let d = 1; d <= 9; d++) writeFileSync(join(dir, `memory-2026-01-0${d}.db`), "");
  rmSync(join(dir, today));
  backupIfDue(db, home);
  assert.equal(readdirSync(dir).length, 7);
  assert.ok(!existsSync(join(dir, "memory-2026-01-01.db")) && existsSync(join(dir, today)));
});

test("the log rotates past 1 MB", () => {
  const { home } = setup();
  writeFileSync(join(home, "log.txt"), "x".repeat(1024 * 1024 + 1));
  log(home, "compact", { chars: 10 });
  assert.ok(existsSync(join(home, "log.txt.1")));
  assert.match(readFileSync(join(home, "log.txt"), "utf8"), /compact \{"chars":10\}\n$/);
});

test("the panel shows the briefing and how the scribe is doing", () => {
  const { home, db, t, path, prep } = setup();
  t.human("以后先讨论再动手");
  const p = prep();
  submit(db, home, p.runId, { summaries: [{ title: "测试", body: "测试用的摘要。", refs: ["S1/T1#E1"] }], state: null, knowledge: [
    { op: "create", scope: "global", category: "rule", about_me: true, epistemic: "quote", pending: false, body: "先讨论再动手。", refs: ["S1/T1#E1"], reason: "用户说的" }] });
  t.human("下一件事");
  t.write(path);
  const text = panel(db, { projectId: 1, projectPath: repo, sessionId: 1, transcriptPath: path });
  assert.match(text, /^## 跨项目知识\n\n### 规则\n- K1 先讨论再动手。/, "starts at the knowledge, without the model-facing opening");
  assert.match(text, /- 书记员：空闲\n- 上次整理：.*，成功\n- 还没整理的：1 轮，约 4 字\n- 书记员的花费（折算成 API 价格）：本会话 ≈\$0\.00/);
  assert.match(text, /跨项目约 \d+ token（提醒线 4000），本项目约 0 token（提醒线 15000）/);
});
