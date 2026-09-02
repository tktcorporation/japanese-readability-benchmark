import { describe, expect, it } from "vitest";
import { summarizeVotes } from "../src/human/aggregate.ts";
import { buildHumanPairs } from "../src/human/pairs.ts";
import { aggregate, improvementPct, majority } from "../src/report/aggregate.ts";
import { renderMarkdown } from "../src/report/markdown.ts";
import type { HumanVote, Judgment, Sample, ScoreRecord } from "../src/types.ts";

function sample(id: string, modelId: string, interventionId: string, sourceId = "t1"): Sample {
  return { id, runId: "r", sourceType: "task", sourceId, modelId, interventionId, sampleIndex: 0, text: `text ${id}`, steps: [], createdAt: "" };
}
function score(sampleId: string, s: Sample, metrics: Record<string, number>, rules: Record<string, number> = {}): ScoreRecord {
  return { sampleId, sourceId: s.sourceId, modelId: s.modelId, interventionId: s.interventionId, metrics, textlintRules: rules, textlintMessages: [] };
}

const samples = [
  sample("m1-base", "m1", "baseline"),
  sample("m1-fix", "m1", "textlint-fix"),
  sample("m2-base", "m2", "baseline"),
  sample("m2-fix", "m2", "textlint-fix"),
];
const scores = [
  score("m1-base", samples[0]!, { textlintPer1k: 10, meanSentenceLength: 80, jreadability: 2 }, { "x/a": 2 }),
  score("m1-fix", samples[1]!, { textlintPer1k: 5, meanSentenceLength: 60, jreadability: 3 }, { "x/a": 1 }),
  score("m2-base", samples[2]!, { textlintPer1k: 4, meanSentenceLength: 40, jreadability: 4 }),
  score("m2-fix", samples[3]!, { textlintPer1k: 4, meanSentenceLength: 40, jreadability: 4 }),
];
const judgments: Judgment[] = [
  { kind: "rubric", sampleId: "m1-base", judgeModel: "j", promptVersion: "v", createdAt: "", rationale: "", scores: { readability: 2, clarity: 2, naturalness: 2, concision: 2, structure: 2, overall: 2 } },
  { kind: "rubric", sampleId: "m1-fix", judgeModel: "j", promptVersion: "v", createdAt: "", rationale: "", scores: { readability: 4, clarity: 4, naturalness: 4, concision: 4, structure: 4, overall: 4 } },
  { kind: "pairwise", scheme: "interventions", sourceId: "t1", aSampleId: "m1-fix", bSampleId: "m1-base", judgeModel: "j", promptVersion: "v", verdictAB: "A", verdictBA: "A", verdict: "A", rationale: "", createdAt: "" },
  { kind: "pairwise", scheme: "interventions", sourceId: "t1", aSampleId: "m2-fix", bSampleId: "m2-base", judgeModel: "j", promptVersion: "v", verdictAB: "tie", verdictBA: "tie", verdict: "tie", rationale: "", createdAt: "" },
  { kind: "pairwise", scheme: "models", sourceId: "t1", aSampleId: "m1-base", bSampleId: "m2-base", judgeModel: "j", promptVersion: "v", verdictAB: "B", verdictBA: "B", verdict: "B", rationale: "", createdAt: "" },
];

describe("improvementPct", () => {
  it("lower-is-better は減ればプラス、higher-is-better は増えればプラス", () => {
    expect(improvementPct(10, 5, "textlintPer1k")).toBe(50);
    expect(improvementPct(10, 15, "textlintPer1k")).toBe(-50);
    expect(improvementPct(2, 3, "jreadability")).toBe(50);
    expect(improvementPct(4, 4, "judgeOverall")).toBe(0);
    expect(improvementPct(0, 0, "textlintPer1k")).toBe(0);
  });
});

describe("aggregate", () => {
  const report = aggregate({ runId: "r", samples, scores, judgments });

  it("モデル比較は baseline だけを使い、対戦勝率を持つ", () => {
    const m1 = report.models.find((m) => m.modelId === "m1")!;
    const m2 = report.models.find((m) => m.modelId === "m2")!;
    expect(m1.metrics.textlintPer1k?.mean).toBe(10);
    expect(m1.metrics.judgeOverall?.mean).toBe(2);
    expect(m1.judgeWinRate).toMatchObject({ wins: 0, losses: 1, rate: 0 });
    expect(m2.judgeWinRate).toMatchObject({ wins: 1, losses: 0, rate: 1 });
  });
  it("介入セルは baseline との差と改善率を持つ", () => {
    const cell = report.cells.find((c) => c.modelId === "m1" && c.interventionId === "textlint-fix")!;
    expect(cell.delta?.textlintPer1k).toBe(-5);
    expect(cell.improvementPct?.textlintPer1k).toBe(50);
    expect(cell.improvementPct?.meanSentenceLength).toBe(25);
    expect(cell.improvementPct?.jreadability).toBe(50);
    expect(cell.improvementPct?.judgeOverall).toBe(100);
    expect(cell.judgeWinRate).toMatchObject({ wins: 1, n: 1 });
    const base = report.cells.find((c) => c.modelId === "m1" && c.interventionId === "baseline")!;
    expect(base.improvementPct).toBeUndefined();
  });
  it("モデル横断の介入行は勝率を合算する", () => {
    const fix = report.interventions.find((c) => c.interventionId === "textlint-fix")!;
    expect(fix.judgeWinRate).toMatchObject({ wins: 1, ties: 1, n: 2, rate: 0.75 });
    expect(fix.improvementPct?.textlintPer1k).toBeCloseTo(35.7, 0);
    expect(fix.matched).toBe(2);
  });
  it("改善率は対にできた baseline だけと比べる（介入が一部の課題にしかなくても構成の差を改善と見なさない）", () => {
    // m1 の介入は易しい課題 t2 にしかない。t2 の baseline は t1 より良い
    const ss = [
      sample("t1-base", "m1", "baseline", "t1"),
      sample("t2-base", "m1", "baseline", "t2"),
      sample("t2-x", "m1", "x", "t2"),
    ];
    const sc = [
      score("t1-base", ss[0]!, { textlintPer1k: 20 }),
      score("t2-base", ss[1]!, { textlintPer1k: 4 }),
      score("t2-x", ss[2]!, { textlintPer1k: 4 }),
    ];
    const r = aggregate({ runId: "r", samples: ss, scores: sc, judgments: [] });
    const x = r.cells.find((c) => c.interventionId === "x")!;
    // 全 baseline の平均（12）と比べると +66% に見えるが、対にした t2 の baseline と比べれば 0%
    expect(x.improvementPct?.textlintPer1k).toBe(0);
    expect(x.delta?.textlintPer1k).toBe(0);
    expect(x.matched).toBe(1);
    expect(r.interventions.find((c) => c.interventionId === "x")?.improvementPct?.textlintPer1k).toBe(0);
    // 対にできる baseline が 1 つもなければ改善率は出さない
    const orphan = aggregate({ runId: "r", samples: [ss[0]!, sample("t9-x", "m1", "x", "t9")], scores: [sc[0]!, score("t9-x", ss[2]!, { textlintPer1k: 1 })], judgments: [] });
    expect(orphan.cells.find((c) => c.interventionId === "x")?.improvementPct).toBeUndefined();
  });
  it("判定モデルが複数あるときは 1 つに絞って集計する", () => {
    const other: Judgment[] = [
      { kind: "rubric", sampleId: "m1-base", judgeModel: "z", promptVersion: "v", createdAt: "", rationale: "", scores: { readability: 5, clarity: 5, naturalness: 5, concision: 5, structure: 5, overall: 5 } },
      { kind: "pairwise", scheme: "models", sourceId: "t1", aSampleId: "m1-base", bSampleId: "m2-base", judgeModel: "z", promptVersion: "v", verdictAB: "A", verdictBA: "A", verdict: "A", rationale: "", createdAt: "" },
    ];
    const mixed = aggregate({ runId: "r", samples, scores, judgments: [...judgments, ...other] });
    expect(mixed.judgeModels).toEqual(["j", "z"]);
    expect(mixed.judgeModel).toBe("j");
    expect(mixed.models.find((m) => m.modelId === "m1")?.metrics.judgeOverall?.mean).toBe(2);
    expect(mixed.counts.pairwise).toBe(3);

    const z = aggregate({ runId: "r", samples, scores, judgments: [...judgments, ...other], judgeModel: "z" });
    expect(z.models.find((m) => m.modelId === "m1")?.metrics.judgeOverall?.mean).toBe(5);
    expect(z.models.find((m) => m.modelId === "m1")?.judgeWinRate).toMatchObject({ wins: 1, n: 1 });
    expect(renderMarkdown(z)).toContain("他に j の判定あり");
    expect(() => aggregate({ runId: "r", samples, scores, judgments, judgeModel: "nope" })).toThrow();
  });
  it("コーパス run では baseline を持つモデルがないのでモデル比較を出さない", () => {
    const corpusSamples = [
      { ...sample("orig", "none", "baseline", "c1"), sourceType: "corpus" as const },
      { ...sample("rw", "m1", "rewrite-pass", "c1"), sourceType: "corpus" as const },
    ];
    const r = aggregate({ runId: "r", samples: corpusSamples, scores: [], judgments: [] });
    expect(r.models).toEqual([]);
    expect(r.cells.map((c) => `${c.modelId}|${c.interventionId}`)).toEqual(["m1|rewrite-pass", "none|baseline"]);
    expect(renderMarkdown(r)).not.toContain("モデル比較");
  });
  it("ルール別の違反数を介入ごとに合計する", () => {
    expect(report.ruleCounts.baseline?.["x/a"]).toBe(2);
    expect(report.ruleCounts["textlint-fix"]?.["x/a"]).toBe(1);
  });
  it("Markdown を出力できる", () => {
    const md = renderMarkdown(report);
    expect(md).toContain("モデル比較");
    expect(md).toContain("textlint-fix");
    expect(md).toContain("+50.0%");
  });
  it("一部のサンプルでしか計算されていない指標には件数を添える", () => {
    // baseline 行は 2 サンプルあるが、LLM 採点は m1-base の 1 件だけ
    const base = report.interventions.find((c) => c.interventionId === "baseline")!;
    expect(base.metrics.judgeOverall?.n).toBe(1);
    expect(base.metrics.textlintPer1k?.n).toBe(2);
    const md = renderMarkdown(report);
    expect(md).toMatch(/\| baseline \| 2 \| 7\.00 \| .*2\.00 \[n=1\]/);
  });
});

describe("人手評価", () => {
  const sources = new Map([["t1", { id: "t1", title: "課題" }]]);
  it("buildHumanPairs は決定的で、max で切れる", () => {
    const a = buildHumanPairs(samples, { schemes: ["interventions", "models"], baselineId: "baseline", sources });
    const b = buildHumanPairs(samples, { schemes: ["interventions", "models"], baselineId: "baseline", sources });
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
    expect(a.length).toBe(3);
    expect(buildHumanPairs(samples, { schemes: ["models"], baselineId: "baseline", sources, max: 1 }).length).toBe(1);
    expect(a[0]!.taskTitle).toBe("課題");
  });
  it("投票を集計し、LLM 判定との一致率を出す", () => {
    const pairs = buildHumanPairs(samples, { schemes: ["interventions"], baselineId: "baseline", sources });
    const p = pairs.find((x) => x.aSampleId === "m1-fix")!;
    const votes: HumanVote[] = [
      { pairId: p.id, choice: "A", leftWasA: true, raterId: "r1", createdAt: "", seconds: 10 },
      { pairId: p.id, choice: "A", leftWasA: false, raterId: "r2", createdAt: "", seconds: 20 },
      { pairId: p.id, choice: "B", leftWasA: true, raterId: "r3", createdAt: "" },
    ];
    const stale: HumanVote = { pairId: "old-pair", choice: "A", leftWasA: true, raterId: "r9", createdAt: "", seconds: 999 };
    const summary = summarizeVotes(pairs, [...votes, stale]);
    // 作り直す前の古いペアへの投票は、合計・評価者数・回答時間のどれにも含めない
    expect(summary.votes).toBe(3);
    expect(summary.raters).toBe(3);
    expect(summary.perPair[0]).toMatchObject({ verdict: "A", a: 2, b: 1 });
    expect(summary.interRaterAgreement).toMatchObject({ pairs: 1, agree: 0 });
    expect(summary.medianSeconds).toBe(20);

    const report = aggregate({ runId: "r", samples, scores, judgments, humanVotes: votes, humanPairs: pairs });
    const cell = report.cells.find((c) => c.modelId === "m1" && c.interventionId === "textlint-fix")!;
    expect(cell.humanWinRate).toMatchObject({ wins: 1, n: 1 });
    expect(report.humanJudgeAgreement).toMatchObject({ n: 1, agree: 1, rate: 1 });
    expect(report.counts.humanVotes).toBe(3);
  });
  it("本文が変わったサンプルのペアと、その投票は集計しない", () => {
    const pairs = buildHumanPairs(samples, { schemes: ["interventions"], baselineId: "baseline", sources });
    const p = pairs.find((x) => x.aSampleId === "m1-fix")!;
    const votes: HumanVote[] = [{ pairId: p.id, choice: "A", leftWasA: true, raterId: "r1", createdAt: "" }, { pairId: "stale", choice: "B", leftWasA: true, raterId: "r1", createdAt: "" }];
    const regenerated = samples.map((s) => (s.id === "m1-fix" ? { ...s, text: "再生成された本文" } : s));
    const report = aggregate({ runId: "r", samples: regenerated, scores, judgments, humanVotes: votes, humanPairs: pairs });
    expect(report.counts.humanVotes).toBe(0);
    expect(report.cells.find((c) => c.modelId === "m1" && c.interventionId === "textlint-fix")?.humanWinRate).toBeUndefined();
    // ペア ID は本文を含むので、再生成後に pairs を作り直すと別 ID になる
    const newPairs = buildHumanPairs(regenerated, { schemes: ["interventions"], baselineId: "baseline", sources });
    expect(newPairs.find((x) => x.aSampleId === "m1-fix")?.id).not.toBe(p.id);
  });
  it("majority は同数なら tie", () => {
    expect(majority(["A", "A", "B"])).toBe("A");
    expect(majority(["A", "B"])).toBe("tie");
    expect(majority(["tie", "tie", "A"])).toBe("tie");
  });
});
