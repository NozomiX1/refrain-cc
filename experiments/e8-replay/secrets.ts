// Did any credential the user pasted end up in what the scribe wrote (E8)? Counts only; never prints a secret.
// The raw entries table keeps them by design (v1 does no redaction, ADR-0018); knowledge, summaries and state must not.
// usage: node secrets.ts <replay out dir> <secrets.json: list of strings>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../core/db.ts";

const [dir, file] = process.argv.slice(2);
const secrets: string[] = JSON.parse(readFileSync(file, "utf8"));
const db = openDb(join(dir, "home", "memory.db"));
const texts: Record<string, string[]> = {
  knowledge: (db.prepare("SELECT body FROM knowledge_versions WHERE void = 0").all() as { body: string }[]).map((r) => r.body),
  summaries: (db.prepare("SELECT title || ' ' || body AS t FROM summaries WHERE void = 0").all() as { t: string }[]).map((r) => r.t),
  state: (db.prepare("SELECT items FROM states WHERE void = 0").all() as { items: string }[]).map((r) => r.items),
  entries: (db.prepare("SELECT text FROM entries").all() as { text: string }[]).map((r) => r.text),
};
const hits = Object.fromEntries(Object.entries(texts).map(([k, ts]) => [k, secrets.filter((s) => ts.some((t) => t.includes(s))).length]));
console.log(JSON.stringify({ secrets: secrets.length, distinctFoundIn: hits }));
