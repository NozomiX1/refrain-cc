// C group (E9): per try, which searches and reads the scribe made, what it then wrote, and whether any pasted credential
// reached knowledge, summaries or state (counted, never printed). IPs are masked in what is printed.
// usage: node c-report.ts <out dir> [secrets.json: list of strings]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [dir, secretsFile] = process.argv.slice(2);
const secrets: string[] = secretsFile ? JSON.parse(readFileSync(secretsFile, "utf8")) : [];
const mask = (s: string) => s.replace(/\d+\.\d+\.\d+\.\d+/g, "x.x.x.x");
for (const c of readdirSync(dir).sort()) for (const t of readdirSync(join(dir, c)).filter((t) => existsSync(join(dir, c, t, "result.json")))) {
  const r = JSON.parse(readFileSync(join(dir, c, t, "result.json"), "utf8"));
  console.log(`\n## ${c}/${t}：${r.status}，调用 ${JSON.stringify(r.calls)}，退回 ${r.rejected}，$${(r.cost ?? 0).toFixed(3)}`);
  for (const f of readdirSync(join(dir, c, t, "runs")).filter((f) => f.endsWith(".jsonl")))
    for (const l of readFileSync(join(dir, c, t, "runs", f), "utf8").split("\n").filter(Boolean))
      for (const b of JSON.parse(l).message?.content ?? [])
        if (b.type === "tool_use" && !/submit/.test(b.name)) console.log(`  工具 ${b.name.replace(/^mcp__\w+__/, "")} ${mask(JSON.stringify(b.input))}`);
  const s = r.submission;
  if (!s) continue;
  for (const o of s.knowledge ?? []) console.log(`  知识 ${o.op} ${o.code ?? o.id ?? ""} ${o.category ?? ""}/${o.epistemic ?? ""} refs=${JSON.stringify(o.refs)}\n     ${mask(o.body ?? o.reason ?? "").slice(0, 220)}`);
  for (const m of s.summaries ?? []) console.log(`  摘要「${m.title}」\n     ${mask(m.body).slice(0, 260)}`);
  if (secrets.length) {
    const db = new DatabaseSync(join(dir, c, t, "home", "memory.db"), { readOnly: true });
    const run = (db.prepare("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
    const written = [
      ...(db.prepare("SELECT body AS x FROM knowledge_versions WHERE run_id = ?").all(run) as { x: string }[]),
      ...(db.prepare("SELECT title || ' ' || body AS x FROM summaries WHERE run_id = ?").all(run) as { x: string }[]),
      ...(db.prepare("SELECT items AS x FROM states WHERE run_id = ?").all(run) as { x: string }[]),
    ].map((w) => w.x).join("\n");
    console.log(`  敏感字符串写进记忆：${secrets.filter((x) => written.includes(x)).length} 个`);
  }
}
