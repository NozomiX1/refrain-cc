// Silent duplicates the receipt cannot catch: a new state item that restates an old one the scribe also kept or updated.
// Lists every new item that shares at least 40% of its two-character pieces with an old item, for reading by hand.
// usage: node a-dups.ts <out dir>
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const grams = (s: string) => new Set([...s.replace(/\s/g, "")].map((_, i, a) => a[i] + (a[i + 1] ?? "")));
const sim = (a: string, b: string) => { const A = grams(a), B = grams(b); let n = 0; for (const g of A) if (B.has(g)) n++; return n / Math.min(A.size, B.size); };
const dir = process.argv[2];
let tries = 0, creates = 0;
for (const c of readdirSync(dir).sort()) for (const t of readdirSync(join(dir, c)).filter((t) => existsSync(join(dir, c, t, "result.json")))) {
  tries++;
  const db = new DatabaseSync(join(dir, c, t, "home", "memory.db"), { readOnly: true });
  const last = db.prepare("SELECT MAX(id) AS id FROM runs").get() as { id: number };
  for (const kind of ["project", "session"]) {
    const now = db.prepare("SELECT items, closed, project_id p, session_id s FROM states WHERE kind = ? AND run_id = ?").get(kind, last.id) as any;
    if (!now) continue;
    const prev = db.prepare(`SELECT items FROM states WHERE kind = ? AND ${kind === "project" ? "project_id" : "session_id"} = ? AND run_id < ? ORDER BY id DESC LIMIT 1`)
      .get(kind, kind === "project" ? now.p : now.s, last.id) as any;
    const old: any[] = prev ? JSON.parse(prev.items) : [];
    const items: any[] = JSON.parse(now.items);
    const closed = new Map((JSON.parse(now.closed) as any[]).map((x) => [x.no, x.outcome]));
    const oldTexts = new Set(old.map((o) => o.content));
    // New items: content not among the old ones (updated ones count too, so only report pairs where the old item survived).
    for (const it of items.filter((i) => !oldTexts.has(i.content))) {
      creates++;
      old.forEach((o, k) => {
        const s = sim(it.content, o.content);
        const fate = closed.get(k + 1) ? `已结束（${closed.get(k + 1)}）` : items.some((i) => i.content === o.content) ? "原样保留" : "被改写";
        if (s >= 0.4 && fate === "原样保留") console.log(`${c}/${t} ${kind} 相似 ${s.toFixed(2)}\n   新：${it.content.slice(0, 90)}\n   旧 ${k + 1}（${fate}）：${o.content.slice(0, 90)}`);
      });
    }
  }
}
console.log(`${tries} 次，新增或改写的项 ${creates} 个`);
