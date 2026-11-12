// refrain-timer: starts refrain's idle compaction (design.md 4.5). A separate plugin because a mod's own
// timer-started compaction skips its own session.compact hook (e0 C6); started from here, refrain's hook runs.
import type { Register } from "claude-code";

const CHECK_MS = 60000;

type Turn = { turnEndedAt: string; contextTokens: number; cacheTtlMs: number; worth: boolean; idle: { enabled: boolean; minTokens: number } };

let busy = false; // a main turn is running: never compact under it
let compactedAfter = ""; // the turn end we already compacted after

// The cache has expired, so the next request re-reads the whole context at full price anyway; swap it for the
// handoff when the context is big enough and refrain finds the handoff clearly smaller (4.5). With its scribe
// running or paused, ask anyway: refrain then leaves one line saying why it did not, which the person needs to know.
export function due(t: Turn, state: string | undefined, now: number): boolean {
  if (!t.idle.enabled || now - Date.parse(t.turnEndedAt) <= t.cacheTtlMs || t.contextTokens < t.idle.minTokens) return false;
  return t.worth || state === "running" || state === "paused";
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const r = await next(e);
    // refrain's data dir, as its core resolves it.
    const home = (await $.process.run(["sh", "-c", 'printf %s "${REFRAIN_HOME:-$HOME/.refrain}"'])).stdout;
    $.clock.every(CHECK_MS, async () => {
      if (busy) return;
      let status: { state?: string; turn?: Turn };
      try {
        status = JSON.parse(await $.fs.read(`${home}/status/${await $.session.id()}.json`));
      } catch {
        return; // refrain has not seen a turn of this session yet
      }
      const turn = status.turn;
      if (!turn || turn.turnEndedAt === compactedAfter || !due(turn, status.state, Date.now())) return;
      compactedAfter = turn.turnEndedAt;
      await $.session.compact();
    });
    return r;
  });

  // Only the person's own prompt starts a turn here: a task notification may be dropped (refrain drops the
  // scribe's) and then no turn.complete would ever clear the flag.
  // shortcut: prompts arriving another way (Remote Control) are not counted; add their origin kinds if that is used.
  on("prompt.submit", async ($, e: any, next) => {
    if (e.origin?.kind === "composer") busy = true;
    return next(e);
  });

  on("turn.complete", async ($, e: any, next) => {
    if (!e.agentId) busy = false;
    return next(e);
  });
};
