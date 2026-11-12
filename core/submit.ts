// The scribe's submit: validation with a readable receipt, then writes (design.md 6.5).
import type { DatabaseSync } from "node:sqlite";
import { address, type Numbered } from "./db.ts";
import { currentKnowledge, currentState, localDate, TOKENS_PER_CHAR, type Knowledge, type StateItem } from "./render.ts";

// knowledge and summary in characters (E6 may tune); state in items, a guard against runaway growth (E8: 9 → 32)
// well above the prompt's "about ten", so real todos are not squeezed out.
export const LIMITS = { knowledge: 400, summary: 600, attempts: 3, state: 20 };

type Op = {
  op?: string; id?: string; code?: string; scope?: string; category?: string; about_me?: boolean; epistemic?: string; pending?: boolean;
  body?: string; refs?: string[]; reason?: string;
};
type StateOp = { op?: string; no?: number; type?: string; body?: string; condition?: string | null; refs?: string[]; outcome?: string; reason?: string; to?: string };
export type Submission = {
  summaries?: Array<{ title?: string; tags?: string[]; body?: string; refs?: string[] }>;
  knowledge?: Op[];
  state?: StateOp[] | null;
};
export type Ctx = { db: DatabaseSync; sessionId: number; projectId: number | null; batch: Numbered[]; today: string };

const ADDR = /^S(\d+)\/T(\d+)#E(\d+)$/;
const TEMP = /^new\w*$/;
const CODE = /^K\d+$/;
const TYPES = ["phase", "progress", "todo", "verify", "instruction"];
const isStr = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";
const strip = (r: string) => r.trim().replace(/\s*@(user|assistant|observation)$/, "");
const opening = (t: unknown) => (isStr(t) ? `"${t.length > 30 ? t.slice(0, 30) + "…" : t}"` : "");
// Receipts name an item by what the scribe wrote (code or number, then its opening words); a 0-based position read as a
// second numbering, so a position appears only when nothing was written or two names come out the same.
function names(key: string, list: unknown, what: (x: any) => [unknown, ...string[]]): string[] {
  const base = (Array.isArray(list) ? list : []).map((x) => {
    const [op, ...ids] = what(x ?? {});
    const id = ids.filter(Boolean).join(" ");
    return { op: typeof op === "string" ? op : "", id, both: [typeof op === "string" ? op : "", id].filter(Boolean).join(" ") };
  });
  return base.map(({ op, id, both }, i) => {
    const pos = `你交的第 ${i + 1} 个`;
    return `${key}（${!id ? [op, pos].filter(Boolean).join("，") : base.filter((b) => b.both === both).length > 1 ? `${both}，${pos}` : both}）`;
  });
}
const twice = (seen: Map<string, string[]>, say: (x: string, ops: string[]) => string) =>
  [...seen].filter(([, ops]) => ops.length > 1).map(([x, ops]) => say(x, ops));

type Ref = { role: string; ts: string };

function refLookup(ctx: Ctx) {
  const inBatch = new Map(ctx.batch.map((e) => [address(ctx.sessionId, e), e]));
  const q = ctx.db.prepare("SELECT role, ts FROM entries WHERE session_id = ? AND turn_no = ? AND entry_no = ? AND status = 'active'");
  return (ref: string): (Ref & { inBatch: boolean }) | null => {
    const e = inBatch.get(ref);
    if (e) return { role: e.role, ts: e.ts, inBatch: true };
    const m = ref.match(ADDR);
    const row = m ? (q.get(Number(m[1]), Number(m[2]), Number(m[3])) as Ref | undefined) : undefined;
    return row ? { ...row, inBatch: false } : null;
  };
}

// Returns problems as numbered sentences for the receipt; empty means it can be written.
export function validate(ctx: Ctx, s: Submission): string[] {
  const errs: string[] = [];
  const look = refLookup(ctx);
  const known = new Map(currentKnowledge(ctx.db).map((k) => [k.code, k]));
  if (typeof s !== "object" || s == null) return ["提交的内容不是一个 JSON 对象。"];
  for (const key of ["summaries", "knowledge"] as const)
    if (!Array.isArray(s[key])) errs.push(`缺少 ${key}，没有内容也要交空列表 []。`);
  if (!("state" in s)) errs.push("缺少 state，没有变化就交 null。");
  // A blank submit was the scribe skipping its input (E7: twice, on 24k and 61k-char batches), never an empty batch.
  if (Array.isArray(s.summaries) && !s.summaries.length)
    errs.push("summaries 是空的。每次至少写一份摘要，对话再短也用一两句概括。要处理的对话在输入最后的「# 这次要处理的对话」一节，每次都有内容。");
  const ops = Array.isArray(s.knowledge) ? s.knowledge : [];

  const kNames = names("knowledge", ops, (o) => [o.op, o.op !== "create" && isStr(o.code) ? o.code : "", o.op === "create" && isStr(o.id) ? o.id : "", opening(o.body)]);
  const temps = new Map<string, number>();
  ops.forEach((o, i) => {
    if (o?.op === "create" && o.id !== undefined) {
      if (!isStr(o.id) || !TEMP.test(o.id)) errs.push(`${kNames[i]}：临时标签要写成 new1、new2 这样。`);
      else if (temps.has(o.id)) errs.push(`${kNames[i]}：临时标签 ${o.id} 前面已经用过了，同一次提交里每个标签只能用一次。`);
      else temps.set(o.id, i);
    }
  });

  // Checks one refs list; returns the roles it resolves to (K codes expand to their current refs).
  const checkRefs = (where: string, refs: unknown, opts: { batchOnly?: boolean; allowCodes?: boolean } = {}): string[] => {
    if (!Array.isArray(refs) || !refs.length) {
      errs.push(`${where}：缺少 refs，要写出处的地址。`);
      return [];
    }
    const roles: string[] = [];
    for (const raw of refs) {
      const ref = isStr(raw) ? strip(raw) : "";
      if (opts.allowCodes && CODE.test(ref)) {
        const k = known.get(ref);
        if (!k) errs.push(`${where}：refs 里的 ${ref} 不存在。`);
        else for (const r of JSON.parse(k.refs) as string[]) roles.push(look(r)?.role ?? "");
        continue;
      }
      if (opts.allowCodes && TEMP.test(ref)) {
        if (!temps.has(ref)) errs.push(`${where}：refs 里的 ${ref} 没有对应的 create（临时标签要在同一次提交里新建）。`);
        continue;
      }
      const hit = look(ref);
      if (!hit) errs.push(`${where}：refs 里的 ${raw} 不是一条存在的记录（地址形如 S3/T120#E1）。`);
      else if (opts.batchOnly && !hit.inBatch) errs.push(`${where}：摘要的出处必须在"这次要处理的对话"里，${ref} 不在。`);
      else roles.push(hit.role);
    }
    return roles;
  };

  const sNames = names("summaries", s.summaries, (m) => [undefined, opening(m.title) || opening(m.body)]);
  (Array.isArray(s.summaries) ? s.summaries : []).forEach((m, i) => {
    const w = sNames[i];
    if (!isStr(m?.title)) errs.push(`${w}：缺少 title。`);
    if (!isStr(m?.body)) errs.push(`${w}：缺少 body。`);
    else if (m.body.length > LIMITS.summary) errs.push(`${w}：正文 ${m.body.length} 字，超过上限 ${LIMITS.summary} 字。内容多就拆成几份按话题切开的摘要。`);
    if (m?.tags !== undefined && !(Array.isArray(m.tags) && m.tags.every((t) => typeof t === "string"))) errs.push(`${w}：tags 要是字符串列表。`);
    checkRefs(w, m?.refs, { batchOnly: true });
  });

  const touched = new Map<string, string[]>();
  ops.forEach((o, i) => {
    const w = kNames[i];
    if (isStr(o?.code) && o.op !== "create") touched.set(o.code, [...(touched.get(o.code) ?? []), String(o.op)]);
    if (!["create", "update", "archive"].includes(o?.op ?? "")) return errs.push(`${w}：op 只能是 create、update 或 archive。`);
    let prev: Knowledge | undefined;
    if (o.op !== "create") {
      prev = isStr(o.code) ? known.get(o.code) : undefined;
      if (!isStr(o.code)) return errs.push(`${w}：缺少 code。`);
      if (!prev) return errs.push(`${w}：${o.code} 不存在。`);
      if (o.op === "archive" && prev.status !== "active") errs.push(`${w}：${o.code} 已经归档了。`);
    }
    if (o.op !== "archive") {
      if (!isStr(o.body)) errs.push(`${w}：缺少 body。`);
      // E9 B: what grows is lists and quotes, so the receipt says how much to cut and what to cut first.
      else if (o.body.length > LIMITS.knowledge)
        errs.push(`${w}：正文 ${o.body.length} 字，超过上限 ${LIMITS.knowledge} 字，至少要删掉 ${o.body.length - LIMITS.knowledge} 字。一条知识只写结论；文档、来源这类清单只写去哪看，不逐个列；原话最多留一两句，优先留最新的，更早的出处会自动保留。`);
    }
    if (!isStr(o.reason)) errs.push(`${w}：缺少 reason。`);
    if (o.op === "create") {
      for (const f of ["scope", "category", "epistemic"] as const) if (!isStr(o[f])) errs.push(`${w}：缺少 ${f}。`);
      for (const f of ["about_me", "pending"] as const) if (typeof o[f] !== "boolean") errs.push(`${w}：${f} 要写 true 或 false。`);
      if (o.scope === "project" && ctx.projectId == null) errs.push(`${w}：这个会话不属于任何项目，只能新建 global 的知识。`);
    }
    const scope = o.scope ?? prev?.scope, category = o.category ?? prev?.category, epistemic = o.epistemic ?? prev?.epistemic;
    if (scope && !["global", "project"].includes(scope)) errs.push(`${w}：scope 只能是 global 或 project。`);
    if (category && !["rule", "understanding", "goal", "reference"].includes(category)) errs.push(`${w}：category 只能是 rule、understanding、goal 或 reference。`);
    if (epistemic && !["quote", "inference", "observed"].includes(epistemic)) errs.push(`${w}：epistemic 只能是 quote、inference 或 observed。`);
    if (o.op === "update" && o.scope === "project" && prev?.scope === "global" && ctx.projectId == null) errs.push(`${w}：这个会话不属于任何项目，不能改成 project。`);
    const roles = checkRefs(w, o.refs, { allowCodes: true });
    // Judged on the version as it will be stored: previous refs merged in for update (6.5 check 3).
    const prevRoles = prev && o.op === "update" ? (JSON.parse(prev.refs) as string[]).map((r) => look(r)?.role ?? "") : [];
    if (o.op !== "archive" && epistemic === "quote" && ![...roles, ...prevRoles].includes("user"))
      errs.push(`${w}：epistemic 是 quote，但 refs 里没有一条是用户本人的话（@user）。`);
    if (o.op !== "archive" && epistemic === "observed" && category === "rule")
      errs.push(`${w}：观察（observed）不能是规则：只有用户本人的话能变成"以后要这样做"。`);
  });

  errs.push(...twice(touched, (code, list) => `knowledge：${code} 写了 ${list.length} 次（${list.join("、")}）。一个编号只能有一个操作。`));

  const state = (prevItems: StateItem[]) => {
    const key = "state";
    const st = s.state;
    if (st == null) return;
    if (!Array.isArray(st)) return errs.push(`${key}：有变化时交一个操作列表（keep、update、close、create）；没变化就交 null。`);
    const kept = st.filter((o) => o?.op !== "close").length;
    if (kept > LIMITS.state)
      errs.push(`state：交完后有 ${kept} 项，最多 ${LIMITS.state} 项。合并同一件事的几项，结束已经做完或已经过时的，不卡住接下来工作的待核实留在摘要里就够了。`);
    const phases = st.filter((o) => o?.op !== "close" && (o?.type ?? (typeof o?.no === "number" ? prevItems[o.no - 1]?.type : undefined)) === "phase").length;
    if (phases && ctx.projectId == null) errs.push("state：这个会话不属于任何项目，没有阶段（phase）；正在做的事用 progress。");
    else if (phases > 1) errs.push(`state：交完后有 ${phases} 项阶段（phase），阶段只能有一项：项目整体到哪了合成一项写；某件具体的事正在做，用 progress。`);
    const seen = new Map<string, string[]>();
    const stNames = names(key, st, (o) => [o.op, o.op !== "create" && o.no !== undefined ? `第 ${o.no} 项` : "", opening(o.body)]);
    st.forEach((o, i) => {
      const w = stNames[i];
      if (!["keep", "update", "close", "create"].includes(o?.op ?? "")) return errs.push(`${w}：op 只能是 keep、update、close 或 create。结束一项（完成、放弃、升级）都用 close，在 outcome 里写是哪种。`);
      let prev: StateItem | undefined;
      if (o.op === "create") {
        if (o.no !== undefined) return errs.push(`${w}：create 不带 no。改上一版的某一项，即使内容几乎全换了，也用 update。`);
      } else {
        if (typeof o.no !== "number" || !Number.isInteger(o.no) || o.no < 1 || o.no > prevItems.length)
          return errs.push(o.no === undefined ? `${w}：${o.op} 要写 no，就是上一版的序号。` : `${w}：上一版没有第 ${o.no} 项（共 ${prevItems.length} 项）。`);
        seen.set(String(o.no), [...(seen.get(String(o.no)) ?? []), String(o.op)]);
        prev = prevItems[o.no - 1];
      }
      if (o.op === "keep") {
        if (Object.keys(o).some((f) => f !== "op" && f !== "no")) errs.push(`${w}：keep 只写 op 和 no；要改内容用 update。`);
        return;
      }
      if (o.op === "close") {
        if (!["done", "abandoned", "promoted"].includes(o.outcome ?? "")) errs.push(`${w}：outcome 只能是 done、abandoned 或 promoted。`);
        if (o.outcome === "abandoned" && !isStr(o.reason)) errs.push(`${w}：放弃（abandoned）要写 reason。`);
        if (o.outcome === "promoted" && !(isStr(o.to) && (known.has(o.to) || temps.has(o.to)))) errs.push(`${w}：升级（promoted）要写 to：一个已有的编号，或者这次新建条目的临时标签。`);
        return;
      }
      const type = o.type ?? prev?.type;
      if (!type || !TYPES.includes(type)) errs.push(`${w}：type 只能是 ${TYPES.join("、")} 之一。`);
      if (!isStr(o.body)) errs.push(`${w}：缺少 body。`);
      if (type === "instruction") {
        if (!checkRefs(w, o.refs ?? prev?.refs).includes("user")) errs.push(`${w}：用户的临时要求的 refs 里要有一条是用户本人的话（@user）。`);
      } else if (o.refs !== undefined) checkRefs(w, o.refs);
    });
    errs.push(...twice(seen, (no, list) => `${key}：第 ${no} 项写了 ${list.length} 次（${list.join("、")}）。一项只能写一次。`));
    prevItems.forEach((p, i) => {
      if (!seen.has(String(i + 1))) errs.push(`${key}：上一版第 ${i + 1} 项（"${p.content.slice(0, 30)}"）这次没有写。每一项都要用 keep、update 或 close 写一次。`);
    });
  };
  state(currentState(ctx.db, ctx.projectId, ctx.sessionId).items);
  return errs;
}

const tokens = (s: string) => Math.ceil(s.length * TOKENS_PER_CHAR); // shortcut: chars-based estimate; use a tokenizer if budgets get tight

// Writes a validated submission. Runs inside finishRun's transaction, after the batch's entries are inserted.
export function apply(ctx: Ctx, s: Submission, runId: number, entryIds: Map<string, number>): string {
  const { db } = ctx;
  const known = new Map(currentKnowledge(db).map((k) => [k.code, k]));
  const tsOf = db.prepare("SELECT ts FROM entries WHERE session_id = ? AND turn_no = ? AND entry_no = ? AND status = 'active'");
  const day = (refs: string[]) => {
    const days = refs.map((r) => {
      const m = r.match(ADDR);
      const row = m ? (tsOf.get(Number(m[1]), Number(m[2]), Number(m[3])) as { ts: string } | undefined) : undefined;
      return row?.ts ? localDate(row.ts) : "";
    });
    return days.reduce((a, b) => (b > a ? b : a), "") || ctx.today;
  };
  const codes = new Map<string, string>(); // temp label -> real code
  const real = (x: string) => codes.get(x) ?? x;
  const swapLabels = (text: string) => text.replace(/\bnew\w*\b/g, (t) => codes.get(t) ?? t);
  const expand = (refs: string[]) => [...new Set(refs.map(strip).flatMap((r) => (CODE.test(r) && known.has(r) ? (JSON.parse(known.get(r)!.refs) as string[]) : TEMP.test(r) ? [] : [r])))];

  const order = new Map(ctx.batch.map((e, i) => [address(ctx.sessionId, e), i]));
  const sums = [...(s.summaries ?? [])].sort((a, b) => Math.min(...a.refs!.map((r) => order.get(strip(r))!)) - Math.min(...b.refs!.map((r) => order.get(strip(r))!)));
  const insSummary = db.prepare(`INSERT INTO summaries (code, session_id, project_id, title, tags, body, refs, first_entry_id, last_entry_id, tokens, run_id)
    VALUES ('M' || (SELECT COALESCE(MAX(id), 0) + 1 FROM summaries), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const m of sums) {
    const refs = m.refs!.map(strip).sort((a, b) => order.get(a)! - order.get(b)!);
    insSummary.run(ctx.sessionId, ctx.projectId, m.title!, JSON.stringify(m.tags ?? []), m.body!, JSON.stringify(refs),
      entryIds.get(refs[0]) ?? null, entryIds.get(refs.at(-1)!) ?? null, tokens(m.body!), runId);
  }

  const insK = db.prepare(`INSERT INTO knowledge (code, origin_project_id, created_run_id) VALUES ('K' || (SELECT COALESCE(MAX(id), 0) + 1 FROM knowledge), ?, ?)`);
  const insV = db.prepare(`INSERT INTO knowledge_versions (knowledge_id, version_no, parent_version_id, op, status, scope, project_id, body, epistemic,
      pending, about_me, category, as_of, reason, refs, tokens, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const ops = s.knowledge ?? [];
  const count = { create: 0, update: 0, archive: 0 };
  // Creates first, so archives and promotions in the same submission can point at their temp labels.
  for (const o of ops.filter((o) => o.op === "create")) {
    const kid = Number(insK.run(ctx.projectId, runId).lastInsertRowid);
    const code = (db.prepare("SELECT code FROM knowledge WHERE id = ?").get(kid) as { code: string }).code;
    if (o.id) codes.set(o.id, code);
    const refs = expand(o.refs!);
    insV.run(kid, 1, null, "create", "active", o.scope!, o.scope === "project" ? ctx.projectId : null, o.body!, o.epistemic!,
      o.pending ? 1 : 0, o.about_me ? 1 : 0, o.category!, day(refs), o.reason!, JSON.stringify(refs), tokens(o.body!), runId);
    count.create++;
  }
  for (const o of ops.filter((o) => o.op !== "create")) {
    const p = known.get(o.code!)!;
    // Voided versions keep their numbers, so count past them (version numbers are never reused).
    const versionNo = (db.prepare("SELECT MAX(version_no) AS v FROM knowledge_versions WHERE knowledge_id = ?").get(p.knowledge_id) as { v: number }).v + 1;
    const refs = [...new Set([...(JSON.parse(p.refs) as string[]), ...expand(o.refs!)])];
    const scope = o.scope ?? p.scope;
    const body = o.op === "archive" ? p.body : o.body!;
    insV.run(p.knowledge_id, versionNo, p.version_id, o.op!, o.op === "archive" ? "archived" : "active", scope,
      scope === "project" ? p.project_id ?? ctx.projectId : null, body, o.epistemic ?? p.epistemic,
      Number(o.pending ?? !!p.pending), Number(o.about_me ?? !!p.about_me), o.category ?? p.category, day(refs), swapLabels(o.reason!),
      JSON.stringify(refs), tokens(body), runId);
    count[o.op as "update" | "archive"]++;
  }

  const insState = db.prepare("INSERT INTO states (kind, project_id, session_id, items, closed, run_id) VALUES (?, ?, ?, ?, ?, ?)");
  let stateNote = "现状没有变化";
  if (s.state != null) {
    const { items: prev, others } = currentState(db, ctx.projectId, ctx.sessionId);
    const items: StateItem[] = [];
    const closed: object[] = [];
    // Fields an update leaves out stay as they were, like knowledge; the date moves only when the text does.
    for (const o of s.state) {
      const p = o.no ? prev[o.no - 1] : undefined;
      if (o.op === "keep") items.push(p!);
      else if (o.op === "close") closed.push({ no: o.no, outcome: o.outcome, reason: o.reason, to: o.to ? real(o.to) : undefined });
      else {
        const type = o.type ?? p!.type;
        items.push({ type, content: o.body!, condition: "condition" in o ? o.condition ?? null : p?.condition ?? null,
          refs: o.refs?.map(strip) ?? p?.refs, as_of: p && p.content === o.body ? p.as_of : ctx.today, ...(type === "instruction" ? { session: ctx.sessionId } : {}) });
      }
    }
    // Another session's temporary requests ride along unseen, for when that session comes back.
    items.push(...others);
    const project = ctx.projectId != null;
    insState.run(project ? "project" : "session", project ? ctx.projectId : null, project ? null : ctx.sessionId, JSON.stringify(items), JSON.stringify(closed), runId);
    stateNote = "现状已更新";
  }
  const k = Object.entries(count).filter(([, n]) => n).map(([op, n]) => `${{ create: "新建", update: "更新", archive: "归档" }[op]} ${n} 条`);
  return `已保存：${sums.length} 份摘要，${k.length ? "知识" + k.join("、") : "知识没有变化"}，${stateNote}。这次整理完成，不用再回复。`;
}

export function rejection(errs: string[], attemptsLeft: number): string {
  const head = attemptsLeft > 0
    ? `有 ${errs.length} 处问题，这次提交没有保存。请改好后整份重新提交（还可以再交 ${attemptsLeft} 次）：`
    : `有 ${errs.length} 处问题，这次提交没有保存。已经交了 ${LIMITS.attempts} 次，这次整理到此结束，什么都没有保存，不用再提交：`;
  return `${head}\n${errs.map((e, i) => `${i + 1}. ${e}`).join("\n")}`;
}
