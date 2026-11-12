// A group (E9): per try, the receipts it got, and for every "old item not written" what the accepted submission did with
// that item, so a modified-as-new slip can be told from a plain omission by looking at the item.
// usage: node a-report.ts <out dir>
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const kinds: Record<string, RegExp> = {
  "旧项没写": /既没有被 from 引用|这次没有写/,
  "知识超长": /正文 \d+ 字，超过上限 400/,
  "create 带序号": /create 不带 no/,
  "keep 带内容": /keep 只写 op 和 no/,
};
const tally: Record<string, number> = { 次数: 0, 失败: 0, 退回: 0 };
let cost = 0;
for (const c of readdirSync(dir).sort()) for (const t of readdirSync(join(dir, c)).filter((t) => existsSync(join(dir, c, t, "result.json")))) {
  const r = JSON.parse(readFileSync(join(dir, c, t, "result.json"), "utf8"));
  tally.次数++; cost += r.cost ?? 0;
  if (r.status !== "succeeded") tally.失败++;
  // The no-search checklist comes back as an error too, but it is a question, not a problem in the submission.
  const asked = r.receipts.filter((x: string) => x.includes("还没有查过")).length;
  tally.退回 += (r.rejected ?? 0) - asked;
  tally.清单 = (tally.清单 ?? 0) + asked;
  tally.查了 = (tally.查了 ?? 0) + ((r.calls?.search ?? 0) + (r.calls?.read ?? 0) > 0 ? 1 : 0);
  console.log(`\n## ${c}/${t}：${r.status}，退回 ${(r.rejected ?? 0) - asked}，清单 ${asked}，调用 ${JSON.stringify(r.calls)}，$${(r.cost ?? 0).toFixed(3)}`);
  for (const rc of r.receipts) for (const line of rc.split("\n").filter((l: string) => /^\d+\. /.test(l))) {
    const k = Object.keys(kinds).find((k) => kinds[k].test(line)) ?? "其他";
    tally[k] = (tally[k] ?? 0) + 1;
    console.log(`  [${k}] ${line.slice(0, 160)}`);
    const m = line.match(/(project_state|session_state)：上一版第 (\d+) 项/);
    if (m && r.submission) {
      const st = r.submission[m[1]];
      const no = Number(m[2]);
      // Old format: {items:[{from}], closed:[{no}]}; new format: [{op, no}].
      const how = Array.isArray(st) ? st.filter((o: any) => o.no === no).map((o: any) => o.op === "close" ? `close ${o.outcome}` : o.op)
        : [...(st?.items ?? []).filter((i: any) => i.from === no).map((i: any) => (Object.keys(i).length === 1 ? "keep" : "update")),
           ...(st?.closed ?? []).filter((x: any) => x.no === no).map((x: any) => `close ${x.outcome}`)];
      console.log(`      → 最后通过的提交里：${how.join("、") || "（没有提交通过）"}`);
    }
  }
}
console.log("\n合计", tally, `额度（API 价）$${cost.toFixed(2)}`);
