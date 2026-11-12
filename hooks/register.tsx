// refrain's mod: catches the events and hands the work to core/cli.ts (design.md 7.2).
import type { Register } from "claude-code";

const SCRIBE = "refrain:scribe";
const TOOLS = { search: "mcp__refrain__search", read: "mcp__refrain__read", submit: "mcp__refrain__submit" } as const;
const PANE = "refrain";

type Options = { idleCompaction: boolean; idleMinTokens: number; scribeMinChars: number; scribeModel: string };

// Scribe agent id -> run id. shortcut: lost on a module reload; that run then times out (4.3 step 1) and the next turn retries.
const runs = new Map<string, number>();
const scribes = new Set<string>(); // every scribe agent id of this session: their end notices are dropped
const looked = new Set<string>(); // scribe agents that called search or read: a submit without either is held once (4.3)
let home = ""; // the data dir, from core, so the write guard matches what core uses
let enabled = false; // false when node is missing or too old: refrain stays out of the way (7.3)
let panelText = "";
const toldOnce = new Set<string>(); // one-time notices of this session (7.11)
let compacted = ""; // the line an idle compaction leaves, written once the compacted conversation is up

async function core($: any, cmd: string, args: object): Promise<any> {
  const r = await $.process.run(["node", `${$.plugin.root}/core/cli.ts`, cmd], { stdin: JSON.stringify(args), timeoutMs: 60000 });
  if (r.exitCode !== 0) throw new Error(`refrain core ${cmd}: ${r.stderr.trim().split("\n").at(-1)}`);
  return JSON.parse(r.stdout);
}

const here = async ($: any) => ({ ccSessionId: await $.session.id(), cwd: await $.session.root() });

function once($: any, key: string, text: string) {
  if (toldOnce.has(key)) return;
  toldOnce.add(key);
  $.ui.toast(text, { timeoutMs: 8000 });
}

async function failed($: any, where: string, err: unknown) {
  $.ui.log(`refrain ${where}: ${String(err)}`, { to: "debug" });
  await core($, "log", { event: "mod-error", fields: { where, message: String(err).slice(0, 300) } }).catch(() => {});
}

// Model-facing text lives in docs/model-facing/ only; the part below the first --- is what the model sees.
async function doc($: any, name: string): Promise<string> {
  const text: string = await $.fs.read(`${$.plugin.root}/docs/model-facing/${name}`);
  return text.slice(text.indexOf("\n---\n") + 5).trim();
}

// "## name" section of tools.md: the fenced description, then the fenced JSON schema.
function toolDoc(md: string, name: string): { description: string; inputSchema: Record<string, unknown> } {
  const sec = md.slice(md.indexOf(`## ${name}\n`)).split(/\n## /)[0] ?? "";
  const fences = [...sec.matchAll(/```(?:json)?\n([\s\S]*?)\n```/g)].map((m) => m[1] ?? "");
  return { description: fences[0] ?? "", inputSchema: JSON.parse(fences[1] ?? "{}") };
}

// The fenced text after a lead line of tool-results.md: the refusals and errors the model reads.
async function said($: any, lead: string): Promise<string> {
  const md: string = await $.fs.read(`${$.plugin.root}/docs/model-facing/tool-results.md`);
  return md.slice(md.indexOf(lead)).match(/```\n([\s\S]*?)\n```/)?.[1] ?? "";
}

// Kept by handle, a reply is written again under its original message id and a tool result linked to the original
// call, and --resume then doubles the reply and walks back past the compaction (e11; CC #99727, #105781). Those two
// are rebuilt from what the hook sees, losing their thinking (dropped after a compaction anyway) and images in tool
// results. The person's own messages have neither problem and keep their handle, images included. A reply that was
// only thinking would come back as "(no content)", so it is left out.
const fresh = (m: any) =>
  m.role === "user" && !m.toolResults?.length ? m : { role: m.role, text: m.text, toolUses: m.toolUses ?? [], ...(m.toolResults && { toolResults: m.toolResults }) };

// Where the kept tail starts in e.messages: the n-th user turn from the end, checked against the text core expects.
function tailStart(msgs: any[], turns: number, firstText: string): number {
  const norm = (s: string) => s.replace(/〔图片〕/g, "").replace(/\s+/g, "").slice(0, 200);
  const want = norm(firstText);
  const isTurn = (m: any) => m.role === "user" && !m.toolResults?.length && Boolean(m.text);
  const starts = msgs.flatMap((m, i) => (isTurn(m) ? [i] : []));
  const guess = starts[starts.length - turns];
  if (guess !== undefined && norm(msgs[guess].text) === want) return guess;
  // Interruptions and injected reminders can look like turns; fall back to the last message with that text.
  return msgs.findLastIndex((m) => m.role === "user" && norm(m.text ?? "") === want);
}

export const register: Register = (on, options) => {
  const opt = options as unknown as Options;

  on("session.start", async ($, e, next) => {
    const r = await next(e);
    try {
      const v = (await $.process.run(["node", "--version"])).stdout.trim();
      if (Number(v.replace(/^v/, "").split(".")[0]) < 24) throw new Error(`node ${v}`);
      home = (await core($, "info", {})).home;
      enabled = true;
    } catch (err) {
      $.ui.toast("已停用：需要 Node 24 或更新的版本（找不到 node，或者版本太旧）。CC 照常工作，只是没有记忆。", { timeoutMs: 10000 });
      $.ui.log(`refrain disabled: ${String(err)}`, { to: "debug" });
      return r;
    }
    const tools = await doc($, "tools.md");
    for (const name of ["search", "read", "submit"] as const) await $.tool.register({ name, ...toolDoc(tools, name), isDeferred: false });
    await $.agent.register({
      name: "scribe",
      description: "refrain's background scribe; spawned only by refrain.",
      prompt: await doc($, "scribe-system.md"),
      tools: [TOOLS.search, TOOLS.read, TOOLS.submit],
      model: opt.scribeModel ?? "haiku",
      effort: "high", // E8: high kept every core item low lost (8/8 vs 5/8) at about twice the quota; unset, the user's own default (often xhigh) applies
      omitClaudeMd: true,
      background: true,
    });
    const { changed } = await core($, "enable", await here($));
    if (changed) once($, "enable", `已在 ${changed} 里关掉 CC 自带的 auto memory（记忆改由 refrain 整理），从下一个会话起生效。`);
    await $.command.register({ name: "refrain", description: "打开 refrain 的面板：现在的记忆和书记员的状态。/refrain resume 恢复暂停的自动整理", argumentHint: "[resume]" });
    return r;
  });

  on("agent.offer", { agent: SCRIBE }, () => ({ isOffered: false }));

  on("command.run", { command: "refrain" }, async ($, e: any) => {
    if (!enabled) return { text: "现在是停用的（需要 Node 24 或更新的版本）。" };
    if (e.args.trim() === "resume") return { text: (await core($, "resume", await here($))).text };
    panelText = (await core($, "panel", await here($))).text;
    await $.ui.open({ id: PANE, title: "refrain", focus: true, closeOnEscape: true });
    // This line reaches the model; the panel itself does not (ADR-0017).
    return { text: "面板已打开（Esc 关闭）。" };
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e: any) => {
    const { Box, Text } = $.ui.resolve(e);
    return (
      <Box flexDirection="column">
        {panelText.trimEnd().split("\n").map((line) => (line.startsWith("#") ? <Text bold>{line.replace(/^#+\s*/, "")}</Text> : <Text>{line || " "}</Text>))}
      </Box>
    );
  });

  // A turn's closing line waits for its background agents' end notices ("Waiting for 1 background agent to
  // finish"); the scribe's notice is dropped, so a line waiting only on scribes would wait forever (s1 run 3).
  // The turn itself has ended: draw the line as finished.
  on("ui.render", { component: "TurnDuration" }, async ($, e: any, next) => {
    const w = e.props?.waitingFor;
    if (!w || w.workflows || !w.agents?.length || !w.agents.every((a: any) => a.agentType === SCRIBE)) return next(e);
    const { Text } = $.ui.resolve(e);
    const s = Math.round(e.props.durationMs / 1000);
    const done = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return <Text dimColor>✻ {e.props.word} for {s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`} · done {done}</Text>;
  });

  // The briefing goes in through SessionStart, which only the main session has: prompt.context reached every
  // subagent too (s1 run 3, e2). It fires at startup, /clear and after each compaction; a resumed or forked
  // conversation still holds its briefing, so adding one there would duplicate it (e2).
  // Not gated on `enabled`: SessionStart may run before session.start has finished; a missing node just fails here.
  on("classic.SessionStart", async ($, e: any, next) => {
    const r: any = await next(e);
    if (e.source === "compact" && compacted) {
      $.ui.log(compacted);
      compacted = "";
    }
    if (e.source === "resume" || e.source === "fork") return r;
    try {
      const { text } = await core($, "briefing", await here($));
      if (text) return { ...r, additionalContext: [...(r?.additionalContext ?? []), text] };
    } catch (err) {
      await failed($, "SessionStart", err);
    }
    return r;
  });

  on("session.compact", async ($, e: any, next) => {
    if (!enabled || e.agentId) return next(e); // subagents compact the native way (4.4 step 1)
    // A precomputed result would be reused later with an older bookmark; ours costs nothing at the moment itself.
    if (e.trigger === "precompute") return { skip: "refrain builds its handoff when the compaction happens" };
    // CC's automatic and idle compactions are refused: after them the engine puts the old 记忆 block back
    // (4.4, CC #92949), and idle compaction is refrain-timer's job, on our own conditions (4.5).
    if (e.trigger === "auto" || e.trigger === "idle") {
      once($, "auto", "拦下了一次 CC 的自动压缩（或空闲压缩）。需要压缩时手动 /compact。");
      return { skip: "refrain 关掉了 CC 的自动压缩和空闲压缩，需要时手动 /compact" };
    }
    try {
      const h = await core($, "handoff", { ...(await here($)), instructions: e.instructions, trigger: e.trigger });
      // Nothing to gain: the person sees why, and CC does not summarise in our place (4.4).
      if (h.status === "skip") return { skip: h.notice };
      if (h.status !== "ok") return next(e);
      const from = tailStart(e.messages, h.tail.turns, h.tail.firstText);
      if (from < 0) throw new Error("kept tail not found in the messages");
      compacted = h.notice ?? "";
      return { messages: [{ role: "user", text: h.text, toolUses: [] }, ...e.messages.slice(from).filter((m: any) => m.role === "user" || m.text || m.toolUses?.length).map(fresh)] };
    } catch (err) {
      await failed($, "session.compact", err);
      once($, "handoff", "这次没能接管压缩，交给了 CC 原生的压缩。记忆没有受影响。");
      return next(e); // CC's own compaction (4.4 step 5)
    }
  });

  // search and read errors go back to the model as the tool's result, never as a thrown hook (7.12).
  on("tool.call", { tool: TOOLS.search }, async ($, e: any) => {
    if (e.agentId && runs.has(e.agentId)) looked.add(e.agentId);
    const { query, in: kind, scope, limit } = e;
    try {
      return { result: (await core($, "search", { ...(await here($)), args: { query, in: kind, scope, limit } })).text };
    } catch (err) {
      await failed($, "search", err);
      return { result: await said($, "数据库暂时读不到") };
    }
  });

  on("tool.call", { tool: TOOLS.read }, async ($, e: any) => {
    if (e.agentId && runs.has(e.agentId)) looked.add(e.agentId);
    try {
      return { result: (await core($, "read", { ...(await here($)), address: e.address, full: e.full })).text };
    } catch (err) {
      await failed($, "read", err);
      return { result: await said($, "数据库暂时读不到") };
    }
  });

  // The main model also sees submit; only a scribe this mod spawned may use it (6.5).
  on("tool.call", { tool: TOOLS.submit }, async ($, e: any) => {
    const runId = e.agentId ? runs.get(e.agentId) : undefined;
    if (runId === undefined) return { deny: await said($, "主模型调用 submit") };
    const { summaries, knowledge, state, confirm } = e;
    const r = await core($, "submit", { runId, looked: looked.has(e.agentId), submission: { summaries, knowledge, state, confirm } });
    return r.ok ? { result: r.text } : { deny: r.text };
  });

  // Memory is written only by the scribe (4.8).
  on("tool.call", { tool: ["Edit", "Write", "NotebookEdit"] }, async ($, e: any, next) => {
    const path: string = e.file_path ?? e.notebook_path ?? "";
    if (home && (path === home || path.startsWith(home + "/"))) return { deny: await said($, "主模型用 Edit、Write") };
    return next(e);
  });

  // A background agent's end reaches the main model as a task notification (e0 C1); the scribe's must not.
  on("prompt.submit", async ($, e: any, next) => {
    if ([...scribes].some((id) => e.text?.includes(id))) return { drop: "refrain：记忆已整理" };
    return next(e);
  });

  // Our scribe ending: a run without a valid submit has failed (4.3). Its own hook: an agent spawned from a hook
  // passes that hook by, so the hook below that spawns the scribe never hears it end. The matcher lists every
  // reason, so it filters nothing; a second hook on one event must have one. Other subagents are ignored (ADR-0019).
  on("turn.complete", { reason: ["answer", "aborted", "refusal", "error"] }, async ($, e: any, next) => {
    const r = await next(e);
    const runId = e.agentId ? runs.get(e.agentId) : undefined;
    if (!enabled || runId === undefined) return r;
    runs.delete(e.agentId);
    try {
      if ((await core($, "finish", { runId, usage: e.usage })).paused)
        once($, "paused", "书记员连续失败 3 次，这个会话的自动整理已暂停。看原因用 /refrain，恢复用 /refrain resume。");
    } catch (err) {
      await failed($, "turn.complete", err);
    }
    return r;
  });

  on("turn.complete", async ($, e: any, next) => {
    const r = await next(e);
    if (!enabled || e.agentId) return r;
    try {
      const p = await core($, "prepare", {
        ...(await here($)),
        minChars: opt.scribeMinChars,
        idle: { enabled: opt.idleCompaction ?? true, minTokens: opt.idleMinTokens ?? 150000 },
      });
      if (p.reason === "paused") once($, "paused", "这个会话的自动整理已暂停（书记员连续失败 3 次）。看原因用 /refrain，恢复用 /refrain resume。");
      if (p.status !== "ready") return r;
      const s: any = await $.agent.spawn({ subagentType: SCRIBE, prompt: p.prompt, description: "refrain 整理记忆" });
      if (s.agentId) {
        runs.set(s.agentId, p.runId);
        scribes.add(s.agentId);
      } else await core($, "finish", { runId: p.runId, error: `没能起书记员：${s.deny ?? JSON.stringify(s)}` });
    } catch (err) {
      await failed($, "turn.complete", err);
    }
    return r;
  });
};
