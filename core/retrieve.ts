// search and read, as the main model and the scribe see them (design.md 4.7; model-facing/tool-results.md).
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { localTime } from "./render.ts";
import { fullText, parseTranscript } from "./transcript.ts";

export type Scope = { sessionId: number | null; projectId: number | null };

const ROLE: Record<string, string> = { user: "用户", assistant: "Claude", observation: "工具结果" };
const CATEGORY: Record<string, string> = { rule: "规则", understanding: "背景和决定", goal: "目标", reference: "参考" };
const BASIS: Record<string, string> = { quote: "用户原话", inference: "推断", observed: "观察" };
const OP: Record<string, string> = { create: "新建", update: "更新", archive: "归档" };
const READ_CAP = 30000; // characters for a range of turns, about 20k tokens

type Entry = { id: number; session_id: number; turn_no: number; entry_no: number; role: string; text: string; ts: string; run_id: number; cc_uuid: string };
type Summary = { id: number; code: string; session_id: number; project_id: number | null; title: string; tags: string; body: string; refs: string; run_id: number; last_entry_id: number | null };

const addr = (e: Entry) => `S${e.session_id}/T${e.turn_no}#E${e.entry_no}`;
const projectName = (db: DatabaseSync, id: number | null) =>
  id == null ? "无项目" : basename((db.prepare("SELECT path FROM projects WHERE id = ?").get(id) as { path: string } | undefined)?.path ?? "?");

// The query is plain words, split here (E10): Latin letters and digits by word, Chinese into overlapping two-character
// pieces, so "之前那台阿里云服务器" finds 阿里云服务器 however it is spaced. The model used to write a small syntax
// (space = all of, | = any of) and slipped on it: "阿里云 | 退订" became two required words, "C 方案|方案 C" split a phrase.
export function terms(q: string): string[] {
  const out: string[] = [];
  for (const m of q.toLowerCase().matchAll(/[a-z0-9][a-z0-9_.\-\/#@]*|[\p{Script=Han}]+/gu)) {
    const w = m[0].replace(/[._\-\/#@]+$/, "");
    if (!/\p{Script=Han}/u.test(w)) out.push(w);
    else if (w.length === 1) out.push(w);
    else for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
  }
  return [...new Set(out)];
}

// Substring match ranked here by BM25 (k1 1.2, b 0.75) over the query's terms, ties newest first (the caller's order).
// The trigram index could not see two-character words, which most Chinese words are, so those queries came back newest
// first with no notion of relevance. A row with more of the terms, and rarer ones, ranks higher; one with only some
// still comes back.
// shortcut: scans every matching row in code (E10: 17k entries, 4.3M chars, under 50 ms); index bigrams if projects get much bigger.
type Ranked<T> = { row: T; score: number };
export function rank<T>(rows: T[], text: (r: T) => string, words: string[], total: number): Ranked<T>[] {
  const texts = rows.map((r) => text(r).toLowerCase());
  const count = (t: string, w: string) => t.split(w).length - 1;
  const df = new Map(words.map((w) => [w, texts.filter((t) => t.includes(w)).length]));
  const avg = texts.reduce((n, t) => n + t.length, 0) / Math.max(1, texts.length);
  const bm25 = (t: string, w: string) => {
    const tf = count(t, w);
    if (!tf) return 0;
    const idf = Math.log(1 + (total - df.get(w)! + 0.5) / (df.get(w)! + 0.5));
    return (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * t.length) / avg));
  };
  return rows
    .map((row, i) => ({ row, score: words.reduce((n, w) => n + bm25(texts[i], w), 0) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

// Rows holding any of the terms; the ranking sorts out which matter.
function anyWord(words: string[], column: string) {
  return { where: `(${words.map(() => `${column} LIKE ?`).join(" OR ")})`, params: words.map((w) => `%${w}%`) };
}
const MORE = 30; // titles listed past the limit, so an older match is still in sight

function snippet(text: string, words: string[]): string {
  const lower = text.toLowerCase();
  const at = Math.max(0, Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0)));
  const s = Math.max(0, at - 100);
  return `…${text.slice(s, at + 100).replace(/\s+/g, " ")}…`;
}

function scopeSql(scope: string, s: Scope, alias: string): { sql: string; params: number[] } {
  if (scope === "all") return { sql: "1", params: [] };
  if (scope === "session" || s.projectId == null) return { sql: `${alias}.session_id = ?`, params: [s.sessionId ?? -1] };
  return { sql: `${alias}.session_id IN (SELECT id FROM sessions WHERE project_id = ?)`, params: [s.projectId] };
}

const summaryTime = (db: DatabaseSync, m: Summary) =>
  m.last_entry_id ? localTime((db.prepare("SELECT ts FROM entries WHERE id = ?").get(m.last_entry_id) as { ts: string }).ts) : "";

export type SearchArgs = { query?: string; in?: "summaries" | "raw" | "knowledge"; scope?: "session" | "project" | "all"; limit?: number };

export function search(db: DatabaseSync, s: Scope, a: SearchArgs): string {
  const scope = a.scope ?? "project";
  const limit = a.limit ?? 10;
  const all = scope === "all";
  const tag = (pid: number | null) => (all ? `  [${projectName(db, pid)}]` : "");
  const where = all ? "所有项目" : scope === "session" || s.projectId == null ? "当前会话" : "当前项目";
  const sumScope = all ? { sql: "1", params: [] as number[] } : scope === "session" || s.projectId == null ? { sql: "m.session_id = ?", params: [s.sessionId ?? -1] } : { sql: "m.project_id = ?", params: [s.projectId] };
  const sumLine = (m: Summary, body: boolean) => `${m.code}  ${summaryTime(db, m)}${tag(m.project_id)}  ${m.title}${body ? `\n     ${m.body}` : ""}`;

  if (!a.query?.trim()) {
    const ms = db.prepare(`SELECT m.* FROM summaries m JOIN entries e ON e.id = m.last_entry_id WHERE m.void = 0 AND ${sumScope.sql} ORDER BY e.ts DESC LIMIT ?`)
      .all(...sumScope.params, limit) as Summary[];
    if (!ms.length) return `${where}还没有整理出摘要。`;
    return `${where === "当前项目" ? "本项目" : where}最新的 ${ms.length} 份摘要（从新到旧）：\n\n${ms.map((m) => sumLine(m, true)).join("\n")}`;
  }
  const words = terms(a.query);
  const out: string[] = [];
  const counts: string[] = [];
  const rest = (n: number, unit: string) => (n > 0 ? `\n（还有 ${n} ${unit}没列出，换更具体、更少见的词，相关的会排到前面）` : "");

  if (words.length && (!a.in || a.in === "knowledge")) {
    const km = anyWord(words, "v.body");
    const visible = all ? "1" : s.projectId == null ? "v.scope = 'global'" : "(v.scope = 'global' OR v.project_id = ?)";
    const vp = visible.includes("?") ? [s.projectId!] : [];
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_versions v WHERE v.void = 0 AND ${visible}`).get(...vp) as { n: number }).n;
    const rows = db.prepare(`SELECT k.code, k.id AS kid, v.version_no, v.status, v.category, v.body, v.reason, v.project_id,
        (SELECT MAX(version_no) FROM knowledge_versions WHERE knowledge_id = k.id AND void = 0) AS latest
      FROM knowledge_versions v JOIN knowledge k ON k.id = v.knowledge_id
      WHERE v.void = 0 AND ${visible} AND ${km.where} ORDER BY k.id DESC, v.version_no DESC`).all(...vp, ...km.params) as any[];
    // One line per item (E9 C: one item's seven versions filled seven of ten lines): the current version when it
    // matches, the other matching versions named after it; otherwise the best matching old one, so "did we once decide X"
    // is still answered.
    const byItem = new Map<number, Ranked<any>[]>();
    for (const r of rank(rows, (r) => r.body, words, total)) byItem.set(r.row.kid, [...(byItem.get(r.row.kid) ?? []), r]);
    const items = [...byItem.values()].map((vs) => {
      const shown = vs.find((v) => v.row.version_no === v.row.latest) ?? vs[0];
      return { ...shown, others: vs.filter((v) => v !== shown).map((v) => v.row.version_no).sort((x, y) => x - y) };
    }).sort((x, y) => y.score - x.score);
    counts.push(`${items.length} 条知识`);
    const line = (r: (typeof items)[number], short: boolean) => {
      const current = r.row.version_no === r.row.latest;
      const label = !current ? "旧版本" : r.row.status === "archived" ? "已归档" : "当前";
      const why = current && r.row.status === "archived" && r.row.reason ? `（归档原因：${r.row.reason}）` : "";
      const body = short && r.row.body.length > 40 ? r.row.body.slice(0, 40) + "…" : r.row.body;
      const note = !current ? `（当前版本没有提到这些词，read("${r.row.code}") 看现在的内容）`
        : r.others.length ? `（旧版本 ${r.others.map((n) => "@" + n).join("、")} 也提到这些词）` : "";
      return `${r.row.code}${current ? "" : "@" + r.row.version_no}${tag(r.row.project_id)}  ${CATEGORY[r.row.category]} · ${label}  ${body}${short ? "" : why}${short ? "" : note}`;
    };
    if (items.length)
      out.push("知识：\n" + items.slice(0, limit).map((r) => line(r, false)).join("\n")
        + (items.length > limit ? `\n更多（只列开头）：\n${items.slice(limit, limit + MORE).map((r) => line(r, true)).join("\n")}` : "")
        + rest(items.length - limit - MORE, "条"));
  }

  if (words.length && (!a.in || a.in === "summaries")) {
    const sm = anyWord(words, "(m.title || ' ' || m.tags || ' ' || m.body)");
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM summaries m WHERE m.void = 0 AND ${sumScope.sql}`).get(...sumScope.params) as { n: number }).n;
    const ms = db.prepare(`SELECT m.* FROM summaries m LEFT JOIN entries e ON e.id = m.last_entry_id
      WHERE m.void = 0 AND ${sumScope.sql} AND ${sm.where} ORDER BY e.ts DESC`).all(...sumScope.params, ...sm.params) as Summary[];
    // The title counts twice: it names what the discussion was about.
    const ranked = rank(ms, (m) => `${m.title} ${m.title} ${m.tags} ${m.body}`, words, total);
    counts.push(`${ranked.length} 份摘要`);
    if (ranked.length)
      out.push("摘要：\n" + ranked.slice(0, limit).map((r, i) => sumLine(r.row, i < 3)).join("\n")
        + (ranked.length > limit ? `\n更多（只列标题）：\n${ranked.slice(limit, limit + MORE).map((r) => sumLine(r.row, false)).join("\n")}` : "")
        + rest(ranked.length - limit - MORE, "份"));
  }

  if (words.length && (!a.in || a.in === "raw")) {
    const em = anyWord(words, "e.text");
    const sc = scopeSql(scope, s, "e");
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM entries e WHERE e.status = 'active' AND ${sc.sql}`).get(...sc.params) as { n: number }).n;
    const rows = db.prepare(`SELECT e.* FROM entries e WHERE e.status = 'active' AND ${sc.sql} AND ${em.where} ORDER BY e.ts DESC`)
      .all(...sc.params, ...em.params) as Entry[];
    const ranked = rank(rows, (e) => e.text, words, total);
    counts.push(`${ranked.length} 条原始记录`);
    if (ranked.length) out.push(rawGroups(db, ranked.slice(0, 500).map((r) => r.row), words, limit, all, ranked.length));
  }

  if (out.length === 0) {
    const what = a.in === "knowledge" ? "知识" : a.in === "summaries" ? "摘要" : a.in === "raw" ? "原始记录" : "知识、摘要或原始记录";
    return `没有找到包含"${a.query}"的${what}（范围：${where}）。\n可以换个说法，或者把几种说法一起写上${all ? "" : '，或者用 scope: "all" 搜所有项目'}。`;
  }
  return `找到 ${counts.join("、")}。\n\n${out.join("\n\n")}`;
}

// Raw hits grouped under the summary that cites them, else under the run that processed them (4.7).
function rawGroups(db: DatabaseSync, hits: Entry[], words: string[], limit: number, all: boolean, total: number): string {
  const runSummaries = new Map<number, Summary[]>();
  const ofRun = (run: number) => {
    if (!runSummaries.has(run)) runSummaries.set(run, db.prepare("SELECT * FROM summaries WHERE run_id = ? AND void = 0 ORDER BY id").all(run) as Summary[]);
    return runSummaries.get(run)!;
  };
  const groups = new Map<string, { head: string; cited?: Summary; items: Entry[] }>();
  for (const e of hits) {
    const ms = ofRun(e.run_id);
    const cited = ms.filter((m) => (JSON.parse(m.refs) as string[]).includes(addr(e)));
    const key = cited.length ? cited[0].code : `run${e.run_id}`;
    if (!groups.has(key)) {
      const proj = all ? `  [${projectName(db, (db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(e.session_id) as { project_id: number | null }).project_id)}]` : "";
      const head = cited.length
        ? `出自 ${cited[0].code} ${cited[0].title}${cited.length > 1 ? `（也被 ${cited.slice(1).map((m) => m.code).join("、")} 引用）` : ""}${proj}`
        : ms.length
          ? `没被任何摘要讲到的原始记录；整理这些记录时一起写的摘要有：${ms.map((m) => `${m.code} ${m.title}`).join("、")}${proj}`
          : `没被任何摘要讲到的原始记录；整理这些记录时没有写摘要${proj}`;
      groups.set(key, { head, cited: cited[0], items: [] });
    }
    groups.get(key)!.items.push(e);
  }
  const shown = [...groups.values()].slice(0, limit).map((g) => {
    const lines = g.items.slice(0, 2).map((e) => `    ${addr(e)} ${ROLE[e.role]}  ${localTime(e.ts)}  ${snippet(e.text, words)}`);
    const rest = g.items.length - 2;
    if (rest > 0) lines.push(g.cited ? `    （另有 ${rest} 条。想看这段讨论的全貌，read("${g.cited.code}")；只找某个细节，就换更具体的词。）` : `    （另有 ${rest} 条）`);
    const head = g.head.replace("没被任何摘要讲到的原始记录", `没被任何摘要讲到的原始记录 ${g.items.length} 条`);
    return `▸ ${g.cited ? `${head}（${g.items.length} 条）` : head}\n${lines.join("\n")}`;
  });
  const more = groups.size > limit ? `\n\n（还有 ${groups.size - limit} 组没列出，可以换更具体的词）` : "";
  return `原始记录 ${total} 条，${total > hits.length ? `相关度最高的 ${hits.length} 条` : ""}按所在的讨论分组：\n\n${shown.join("\n\n")}${more}`;
}

function attribution(db: DatabaseSync, e: Entry): string {
  const ms = db.prepare("SELECT * FROM summaries WHERE run_id = ? AND void = 0 ORDER BY id").all(e.run_id) as Summary[];
  const cited = ms.find((m) => (JSON.parse(m.refs) as string[]).includes(addr(e)));
  if (cited) return `这条记录出自 ${cited.code} ${cited.title}。`;
  return ms.length ? `同一时段的摘要：${ms.map((m) => `${m.code} ${m.title}`).join("、")}。` : "整理这段记录时没有写摘要。";
}

const entryBlock = (e: Entry, text = e.text) => `${addr(e)}  ${ROLE[e.role]}  ${localTime(e.ts)}\n${text}`;

export function read(db: DatabaseSync, s: Scope, address: string, full = false): string {
  const a = address.trim().replace(/\s*@(user|assistant|observation)$/, "");
  let m: RegExpMatchArray | null;
  if ((m = a.match(/^K(\d+)(?:@(\d+))?$/))) return readKnowledge(db, s, `K${m[1]}`, m[2] ? Number(m[2]) : null);
  if ((m = a.match(/^M\d+$/))) return readSummary(db, a);
  if ((m = a.match(/^S(\d+)\/T(\d+)#E(\d+)$/))) {
    const e = db.prepare("SELECT * FROM entries WHERE session_id = ? AND turn_no = ? AND entry_no = ? AND status = 'active'").get(Number(m[1]), Number(m[2]), Number(m[3])) as Entry | undefined;
    if (!e) return `没有找到 ${a}。还没整理进记忆的记录读不到；如果它是这个会话最近的对话，内容就在当前上文里。`;
    let body = e.text;
    let note = "";
    if (full) {
      const path = (db.prepare("SELECT transcript_path AS p FROM sessions WHERE id = ?").get(e.session_id) as { p: string }).p;
      const row = existsSync(path) ? parseTranscript(path).find((r) => r.uuid === e.cc_uuid) : undefined;
      if (row) body = fullText(row);
      else note = "这条记录的未裁剪原文已经没有了，下面是保存下来的裁剪版：\n\n";
    }
    let before = "";
    // "可以" alone means nothing; the proposal it answers is at the end of Claude's previous reply (4.7).
    if (e.role === "user") {
      const prev = db.prepare(`SELECT text FROM entries WHERE session_id = ? AND status = 'active' AND role = 'assistant' AND kind = 'text'
        AND (turn_no < ? OR (turn_no = ? AND entry_no < ?)) ORDER BY turn_no DESC, entry_no DESC LIMIT 1`).get(e.session_id, e.turn_no, e.turn_no, e.entry_no) as { text: string } | undefined;
      if (prev) before = `〔上文：Claude 上一条回复的末尾〕\n…${prev.text.slice(-800)}\n\n`;
    }
    return `${note}${before}${entryBlock(e, body)}\n\n${attribution(db, e)}`;
  }
  if ((m = a.match(/^S(\d+)\/T(\d+)(?:-T(\d+))?$/))) {
    const [sid, from, to] = [Number(m[1]), Number(m[2]), Number(m[3] ?? m[2])];
    const rows = db.prepare("SELECT * FROM entries WHERE session_id = ? AND turn_no BETWEEN ? AND ? AND status = 'active' ORDER BY turn_no, entry_no").all(sid, from, to) as Entry[];
    if (!rows.length) return `没有找到 ${a}。还没整理进记忆的记录读不到；如果它是这个会话最近的对话，内容就在当前上文里。`;
    const parts: string[] = [];
    let size = 0;
    for (const e of rows) {
      const block = entryBlock(e);
      if (size + block.length > READ_CAP && parts.length) {
        parts.push(`（太长，先读到这里。接着读：read("S${sid}/T${e.turn_no}-T${to}")）`);
        break;
      }
      parts.push(block);
      size += block.length;
    }
    return parts.join("\n\n");
  }
  return `看不懂地址 ${address}。地址的写法：K12、K12@2、M34、S3/T120#E1、S3/T120、S3/T118-T120。`;
}

function readKnowledge(db: DatabaseSync, s: Scope, code: string, versionNo: number | null): string {
  const vs = db.prepare(`SELECT v.*, r.finished_at FROM knowledge_versions v JOIN knowledge k ON k.id = v.knowledge_id JOIN runs r ON r.id = v.run_id
    WHERE k.code = ? AND v.void = 0 ORDER BY v.version_no DESC`).all(code) as any[];
  if (!vs.length) return `没有找到 ${code}。`;
  const v = versionNo == null ? vs[0] : vs.find((x) => x.version_no === versionNo);
  if (!v) return `${code} 没有第 ${versionNo} 版。现有的版本：${vs.map((x) => x.version_no).join("、")}。`;
  const current = v === vs[0];
  const label = !current ? "旧版本" : v.status === "archived" ? "已归档" : "当前";
  const where = v.scope === "global" ? "跨项目" : v.project_id === s.projectId ? "本项目" : `${projectName(db, v.project_id)} 项目`;
  const lines = [
    `${code}${current ? "" : "@" + v.version_no}  ${CATEGORY[v.category]} · ${where} · ${label}（第 ${v.version_no} 版）`,
    `${v.body}${v.pending ? "〔待定〕" : ""}`,
    `依据：${BASIS[v.epistemic]}`,
    `出处：${(JSON.parse(v.refs) as string[]).join("、")}`,
  ];
  if (current && v.status === "archived" && v.reason) lines.push(`归档原因：${v.reason}`);
  lines.push("", "修改历史：", ...vs.map((x) => `  第 ${x.version_no} 版  ${x.finished_at ? localTime(x.finished_at) : ""}  ${OP[x.op]}  ${x.reason ?? ""}`));
  return lines.join("\n");
}

function readSummary(db: DatabaseSync, code: string): string {
  const m = db.prepare("SELECT * FROM summaries WHERE code = ? AND void = 0").get(code) as Summary | undefined;
  if (!m) return `没有找到 ${code}。`;
  const tags = JSON.parse(m.tags) as string[];
  const near = (dir: "<" | ">") =>
    (db.prepare(`SELECT code, title FROM summaries WHERE session_id = ? AND void = 0 AND id ${dir} ? ORDER BY id ${dir === "<" ? "DESC" : "ASC"} LIMIT 2`).all(m.session_id, m.id) as { code: string; title: string }[])
      .sort((x, y) => Number(x.code.slice(1)) - Number(y.code.slice(1)))
      .map((x) => `${x.code} ${x.title}`).join("、");
  const before = near("<"), after = near(">");
  const lines = [
    `${m.code}  ${m.title}`,
    `会话 S${m.session_id} · ${summaryTime(db, m)}${tags.length ? ` · 标签：${tags.join("、")}` : ""}`,
    `出处：${(JSON.parse(m.refs) as string[]).join("、")}`,
    "",
    m.body,
  ];
  if (before || after) lines.push("", "同一会话里时间上相邻的摘要（不一定是同一个话题）：", ...(before ? [`  前：${before}`] : []), ...(after ? [`  后：${after}`] : []));
  return lines.join("\n");
}
