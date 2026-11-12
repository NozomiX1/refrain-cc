// What /refrain shows: the briefing, then how the scribe is doing (design.md 4.8, 7.11).
// The panel never reaches the model (ADR-0017).
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { consecutiveFailures, PAUSE_AFTER, runCost } from "./ops.ts";
import { briefing, currentKnowledge, localDate, localTime, TOKENS_PER_CHAR } from "./render.ts";
import { readSession } from "./transcript.ts";

export const BUDGET = { global: 4000, project: 15000 }; // reminder lines in tokens, not limits (5.5)

type Where = { projectId: number | null; projectPath: string | null; sessionId: number | null; transcriptPath: string | null };

const dollars = (n: number) => `≈$${n.toFixed(2)}`;

export function panel(db: DatabaseSync, w: Where): string {
  // The briefing's opening explains the marks to the model; the person reading the panel starts at the first section.
  const full = briefing(db, w);
  const brief = full ? full.slice(full.indexOf("## ")) : "还没有任何记忆。书记员第一次整理之后，这里会显示长期知识和现状。\n";
  const lines: string[] = [];
  if (w.sessionId != null) {
    const failures = consecutiveFailures(db, w.sessionId);
    const last = db.prepare("SELECT status, started_at, error FROM runs WHERE session_id = ? AND status != 'undone' ORDER BY id DESC LIMIT 1").get(w.sessionId) as
      | { status: string; started_at: string; error: string | null }
      | undefined;
    const state = failures >= PAUSE_AFTER ? `已暂停（连续失败 ${failures} 次，执行 /refrain resume 恢复）` : last?.status === "running" ? "整理中" : "空闲";
    lines.push(`- 书记员：${state}`);
    if (last) lines.push(`- 上次整理：${localTime(last.started_at)}，${{ succeeded: "成功", failed: `失败（${last.error ?? "原因不明"}）`, running: "还在进行" }[last.status] ?? last.status}`);
    if (w.transcriptPath && existsSync(w.transcriptPath)) {
      // Read-only peek: pending() would undo runs after a rewind, which a panel must not do.
      const marks = new Set((db.prepare("SELECT cc_uuid FROM entries WHERE session_id = ? AND status = 'active'").all(w.sessionId) as { cc_uuid: string }[]).map((r) => r.cc_uuid));
      const left = readSession(w.transcriptPath).entries.filter((e) => !marks.has(e.uuid));
      lines.push(`- 还没整理的：${left.filter((e) => e.newTurn).length} 轮，约 ${left.reduce((n, e) => n + e.text.length, 0)} 字`);
    }
  } else lines.push("- 书记员：这个会话还没有整理过");
  const runs = db.prepare("SELECT session_id, started_at, usage FROM runs WHERE usage IS NOT NULL").all() as { session_id: number; started_at: string; usage: string }[];
  const cost = (pred: (r: (typeof runs)[number]) => boolean) => runs.filter(pred).reduce((n, r) => n + runCost(JSON.parse(r.usage)), 0);
  const today = localDate(new Date());
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  lines.push(`- 书记员的花费（折算成 API 价格）：本会话 ${dollars(cost((r) => r.session_id === w.sessionId))}，今天 ${dollars(cost((r) => localDate(r.started_at) === today))}，近 7 天 ${dollars(cost((r) => r.started_at >= weekAgo))}`);
  const live = currentKnowledge(db).filter((k) => k.status === "active");
  // From the text, not the stored estimate: rows written before 11-12 counted 0.65 per character.
  const tok = (ks: typeof live) => Math.ceil(ks.reduce((n, k) => n + k.body.length, 0) * TOKENS_PER_CHAR);
  const g = tok(live.filter((k) => k.scope === "global"));
  const p = w.projectId == null ? 0 : tok(live.filter((k) => k.scope === "project" && k.project_id === w.projectId));
  const over = (n: number, cap: number) => (n > cap ? "，超过提醒线了，可以考虑让书记员合并一下" : "");
  lines.push(`- 知识的规模：跨项目约 ${g} token（提醒线 ${BUDGET.global}${over(g, BUDGET.global)}）` + (w.projectId == null ? "" : `，本项目约 ${p} token（提醒线 ${BUDGET.project}${over(p, BUDGET.project)}）`));
  return `${brief}\n## refrain 的状态\n\n${lines.join("\n")}\n`;
}
