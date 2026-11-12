// One scribe run by `claude -p`, its three tools served by mcp.ts, then finish in the core; shared by the replays.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { finish } from "../../core/scribe.ts";

type Opts = { out: string; home: string; db: DatabaseSync; model: string; effort: string; sys: string; log: object[]; logFile: string };

// Auto memory off, as in a project refrain runs in: the replays sit inside this repo, whose MEMORY.md otherwise
// reaches the scribe (E8: twice the scribe said its input had no conversation, once naming MEMORY.md as all it saw).
export function scribeRunner({ out, home, db, model, effort, sys, log, logFile }: Opts) {
  return (runId: number, prompt: string, end: number, ccSessionId: string, cwd: string) => {
    const cfg = join(out, "mcp.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { refrain: { command: "node", args: [new URL("mcp.ts", import.meta.url).pathname],
      env: { REFRAIN_HOME: home, E7_RUN_ID: String(runId), E7_SESSION: ccSessionId, E7_CWD: cwd } } } }));
    const t0 = Date.now();
    // 6 min: the longest of 293 successful runs took 226 s; a dropped connection used to hang the full 15 (E8 lab).
    const p = spawnSync("claude", ["-p", "--model", model, "--effort", effort, "--system-prompt-file", sys, "--tools", "",
      "--mcp-config", cfg, "--strict-mcp-config", "--allowedTools", "mcp__refrain__search,mcp__refrain__read,mcp__refrain__submit",
      "--setting-sources", "project", "--settings", JSON.stringify({ autoMemoryEnabled: false }), "--output-format", "stream-json", "--verbose", "--no-session-persistence"],
      { cwd: join(out, "cwd"), input: prompt, encoding: "utf8", maxBuffer: 256 << 20, timeout: 6 * 60000, killSignal: "SIGKILL" });
    writeFileSync(join(out, "runs", `${String(runId).padStart(3, "0")}.jsonl`), p.stdout ?? "");
    const msgs = (p.stdout ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const result = msgs.find((m) => m.type === "result");
    const calls: Record<string, number> = {};
    const ids = new Map<string, string>();
    let rejected = 0;
    for (const m of msgs) for (const b of m.message?.content ?? []) {
      if (b.type === "tool_use") { const n = b.name.replace("mcp__refrain__", ""); calls[n] = (calls[n] ?? 0) + 1; ids.set(b.id, n); }
      if (b.type === "tool_result" && b.is_error && ids.get(b.tool_use_id) === "submit") rejected++;
    }
    const usage = result?.usage ? { ...result.usage, model } : undefined;
    const f = finish(db, home, runId, usage, p.error ? `e7: ${p.error.message}` : undefined);
    const rec = { runId, end, session: ccSessionId, status: f.status, cost: result?.total_cost_usd ?? null, ms: Date.now() - t0, turns: result?.num_turns ?? null,
      calls, rejected, output: result?.usage?.output_tokens ?? null, promptChars: prompt.length };
    log.push(rec);
    writeFileSync(logFile, JSON.stringify(log, null, 1));
    console.log(JSON.stringify(rec));
  };
}
