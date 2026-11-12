// search / read / submit for a `claude -p` scribe, as a stdio MCP server (E7). Same descriptions and schemas
// as the mod registers (tools.md), same core calls as the mod's tool.call hooks; core does all the work.
// env: REFRAIN_HOME, E7_RUN_ID, E7_SESSION (CC session id), E7_CWD (the project the session ran in).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const root = new URL("../../", import.meta.url).pathname;
const doc = (name: string) => {
  const t = readFileSync(`${root}docs/model-facing/${name}`, "utf8");
  return t.slice(t.indexOf("\n---\n") + 5);
};
const tools = (["search", "read", "submit"] as const).map((name) => {
  const md = doc("tools.md");
  const sec = md.slice(md.indexOf(`## ${name}\n`)).split(/\n## /)[0];
  const fences = [...sec.matchAll(/```(?:json)?\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  return { name, description: fences[0], inputSchema: JSON.parse(fences[1]) };
});

const core = (cmd: string, args: unknown) =>
  JSON.parse(execFileSync("node", [`${root}core/cli.ts`, cmd], { input: JSON.stringify(args), encoding: "utf8", maxBuffer: 64 << 20 }));
const here = { ccSessionId: process.env.E7_SESSION, cwd: process.env.E7_CWD };

let looked = false; // one server per run, so this is the run's own
function call(name: string, a: any): { text: string; isError?: boolean } {
  if (name !== "submit") looked = true;
  if (name === "search") return { text: core("search", { ...here, args: { query: a.query, in: a.in, scope: a.scope, limit: a.limit } }).text };
  if (name === "read") return { text: core("read", { ...here, address: a.address, full: a.full }).text };
  const { summaries, knowledge, state, confirm } = a;
  const r = core("submit", { runId: Number(process.env.E7_RUN_ID), looked, submission: { summaries, knowledge, state, confirm } });
  return r.ok ? { text: r.text } : { text: r.text, isError: true };
}

const send = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  if (m.id === undefined) continue; // notifications
  if (m.method === "initialize") send(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "refrain", version: "e7" } });
  else if (m.method === "tools/list") send(m.id, { tools });
  else if (m.method === "tools/call") {
    let r;
    try { r = call(m.params.name, m.params.arguments ?? {}); } catch (err) { r = { text: `出错了：${String(err)}`, isError: true }; }
    send(m.id, { content: [{ type: "text", text: r.text }], isError: r.isError ?? false });
  } else send(m.id, {});
}
