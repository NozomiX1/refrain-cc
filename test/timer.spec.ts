import assert from "node:assert/strict";
import { test } from "node:test";
import { due } from "../timer/hooks/register.ts";

const turn = { turnEndedAt: "2026-10-25T10:00:00Z", contextTokens: 200000, cacheTtlMs: 3600000, worth: true, idle: { enabled: true, minTokens: 150000 } };
const at = (min: number) => Date.parse(turn.turnEndedAt) + min * 60000;

test("idle compaction: only after the cache expired, on a big enough context that refrain finds worth compacting", () => {
  assert.equal(due(turn, "idle", at(59)), false, "cache still warm");
  assert.equal(due(turn, "idle", at(61)), true);
  assert.equal(due({ ...turn, contextTokens: 100000 }, "idle", at(61)), false, "too small to be worth it");
  assert.equal(due({ ...turn, worth: false }, "idle", at(61)), false, "would not clearly shrink: nothing said");
  assert.equal(due({ ...turn, idle: { ...turn.idle, enabled: false } }, "idle", at(61)), false, "switched off");
  assert.equal(due({ ...turn, cacheTtlMs: 300000 }, "idle", at(6)), true, "5-minute cache");
});

test("idle compaction: a scribe running or paused is asked about anyway, so refrain can say why it did not compact", () => {
  for (const state of ["running", "paused"]) assert.equal(due({ ...turn, worth: false }, state, at(61)), true, state);
  assert.equal(due({ ...turn, worth: false, contextTokens: 100000 }, "paused", at(61)), false, "still not below the floor");
});
