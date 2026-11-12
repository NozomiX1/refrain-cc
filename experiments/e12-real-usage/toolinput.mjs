// Tool calls rendered two ways, over every local main session: now (one field picked by a fixed order, clipped 250/50)
// and field by field (every field shown, each value clipped the same way). How many characters each way, per tool.
// usage: node toolinput.mjs <~/.claude/projects> [head] [tail]   (statistics only)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { clip } from "../../core/transcript.ts";

const [root, head = "150", tail = "50"] = process.argv.slice(2);
const now = (input) => {
  for (const k of ["command", "file_path", "pattern", "url", "query", "description", "prompt"]) if (k in input) return clip(String(input[k]), 250, 50);
  return clip(JSON.stringify(input), 250, 50);
};
const each = (input) => Object.entries(input).map(([k, v]) => `${k}: ${clip(typeof v === "string" ? v : JSON.stringify(v), +head, +tail)}`).join("\n");

const by = {}, seen = new Set();
let total = { now: 0, each: 0 };
for (const dir of readdirSync(root)) {
  if (!statSync(`${root}/${dir}`).isDirectory() || /experiments|private-tmp/.test(dir)) continue;
  for (const f of readdirSync(`${root}/${dir}`).filter((f) => f.endsWith(".jsonl"))) {
    for (const l of readFileSync(`${root}/${dir}/${f}`, "utf8").split("\n")) {
      if (!l.includes('"tool_use"')) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (r.type !== "assistant" || r.isSidechain) continue;
      for (const c of r.message?.content ?? []) {
        if (c.type !== "tool_use" || seen.has(c.id)) continue;
        seen.add(c.id);
        const name = c.name.startsWith("mcp__") ? "mcp 工具" : c.name;
        const b = (by[name] ??= { n: 0, raw: 0, now: 0, each: 0, keys: {} });
        const a = now(c.input ?? {}).length, e = each(c.input ?? {}).length;
        b.n++; b.raw += JSON.stringify(c.input ?? {}).length; b.now += a; b.each += e; total.now += a; total.each += e;
        for (const k of Object.keys(c.input ?? {})) b.keys[k] = (b.keys[k] ?? 0) + 1;
      }
    }
  }
}
console.log(`每个字段截成开头 ${head}、结尾 ${tail}\n工具\t次数\t原始\t现在\t逐字段\t字段（出现次数）`);
for (const [t, b] of Object.entries(by).sort((x, y) => y[1].n - x[1].n).slice(0, 18))
  console.log([t, b.n, b.raw, b.now, b.each, Object.entries(b.keys).map(([k, v]) => `${k}${v < b.n ? `(${v})` : ""}`).join(" ")].join("\t"));
console.log(`合计：现在 ${total.now} 字，逐字段 ${total.each} 字（${((total.each / total.now - 1) * 100).toFixed(0)}%）`);
