import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PAIRWISE_PROMPT_VERSION, RUBRIC_PROMPT_VERSION } from "../src/judge/prompts.ts";
import { loadJudgments, loadSamples, loadScores } from "../src/store.ts";
import type { Judgment, Sample, ScoreRecord } from "../src/types.ts";
import { appendJsonl, sha256 } from "../src/util/fs.ts";

const dir = mkdtempSync(join(tmpdir(), "jrb-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function sample(id: string, text: string): Sample {
  return { id, runId: "r", sourceType: "task", sourceId: "t", modelId: "m", interventionId: "baseline", sampleIndex: 0, text, steps: [], createdAt: "" };
}
function score(sampleId: string, textHash: string | undefined, v: number): ScoreRecord {
  return { sampleId, textHash, sourceId: "t", modelId: "m", interventionId: "baseline", metrics: { v }, textlintRules: {}, textlintMessages: [] };
}
function rubric(sampleId: string, textHash: string | undefined, overall: number, judgeModel = "j", promptVersion = RUBRIC_PROMPT_VERSION): Judgment {
  return { kind: "rubric", sampleId, textHash, judgeModel, promptVersion, createdAt: "", rationale: "", scores: { readability: 1, clarity: 1, naturalness: 1, concision: 1, structure: 1, overall } };
}
function pairwise(a: Sample, b: Sample, promptVersion = PAIRWISE_PROMPT_VERSION): Judgment {
  return {
    kind: "pairwise", scheme: "interventions", sourceId: "t", aSampleId: a.id, bSampleId: b.id,
    aTextHash: sha256(a.text), bTextHash: sha256(b.text), judgeModel: "j", promptVersion,
    verdictAB: "A", verdictBA: "A", verdict: "A", rationale: "", createdAt: "",
  };
}

describe("store", () => {
  const samplesFile = join(dir, "samples.jsonl");
  const scoresFile = join(dir, "scores.jsonl");
  const judgmentsFile = join(dir, "judgments.jsonl");

  // a は旧本文で採点されたあと --force で再生成された。b と c はそのまま
  const aOld = sample("a", "古い本文。");
  const aNew = sample("a", "新しい本文。");
  const b = sample("b", "そのまま。");
  const c = sample("c", "もう一つ。");
  for (const s of [aOld, b, c, aNew]) appendJsonl(samplesFile, s);

  appendJsonl(scoresFile, score("a", sha256(aOld.text), 1));
  appendJsonl(scoresFile, score("b", sha256(b.text), 2));
  appendJsonl(scoresFile, score("b", sha256(b.text), 3)); // score --force の追記
  appendJsonl(scoresFile, score("c", undefined, 4)); // ハッシュなし（鮮度不明）
  appendJsonl(scoresFile, score("gone", sha256("x"), 9)); // サンプルが消えた記録

  appendJsonl(judgmentsFile, rubric("a", sha256(aOld.text), 1));
  appendJsonl(judgmentsFile, rubric("b", sha256(b.text), 2));
  appendJsonl(judgmentsFile, rubric("b", sha256(b.text), 4, "j2"));
  appendJsonl(judgmentsFile, rubric("c", sha256(c.text), 5, "j", "rubric-v0")); // 旧プロンプト版
  appendJsonl(judgmentsFile, pairwise(aOld, b)); // a の本文が変わった
  appendJsonl(judgmentsFile, pairwise(b, c, "pairwise-v0")); // 旧プロンプト版
  appendJsonl(judgmentsFile, pairwise(c, b));

  it("サンプルは同じ id なら後勝ち", () => {
    const samples = loadSamples(samplesFile);
    expect(samples.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(samples.find((s) => s.id === "a")?.text).toBe("新しい本文。");
  });

  it("再利用元が作り直されて本文が変わった依存サンプルは捨てる", () => {
    const file = join(dir, "reuse.jsonl");
    const base = sample("base", "古い本文。");
    const dep = { ...sample("dep", "古い本文。修正済み。"), steps: [{ type: "generate" as const, ms: 0, reusedFrom: "base", reusedHash: sha256(base.text) }] };
    const fresh = { ...sample("fresh", "そのまま。修正済み。"), steps: [{ type: "generate" as const, ms: 0, reusedFrom: "b", reusedHash: sha256("そのまま。") }] };
    appendJsonl(file, base);
    appendJsonl(file, sample("b", "そのまま。"));
    appendJsonl(file, dep);
    appendJsonl(file, fresh);
    expect(loadSamples(file).map((s) => s.id)).toEqual(["base", "b", "dep", "fresh"]);
    appendJsonl(file, sample("base", "作り直した本文。")); // run --force
    expect(loadSamples(file).map((s) => s.id)).toEqual(["base", "b", "fresh"]);
  });

  it("再利用の連鎖（C→B→A）は A が変わったら B も C も捨てる", () => {
    const file = join(dir, "chain.jsonl");
    const a = sample("a", "A の本文。");
    const b = { ...sample("b", "B の本文。"), steps: [{ type: "generate" as const, ms: 0, reusedFrom: "a", reusedHash: sha256(a.text) }] };
    const c = { ...sample("c", "C の本文。"), steps: [{ type: "generate" as const, ms: 0, reusedFrom: "b", reusedHash: sha256(b.text) }] };
    for (const s of [a, b, c]) appendJsonl(file, s);
    expect(loadSamples(file).map((s) => s.id)).toEqual(["a", "b", "c"]);
    appendJsonl(file, sample("a", "A を作り直した。")); // B を作り直す前に中断した状態
    expect(loadSamples(file).map((s) => s.id)).toEqual(["a"]);
  });

  it("採点は後勝ちで重複を除き、本文が変わった記録・ハッシュのない記録・孤立した記録を捨てる", () => {
    const scores = loadScores(scoresFile, loadSamples(samplesFile));
    expect(scores.map((s) => [s.sampleId, s.metrics.v])).toEqual([["b", 3]]);
  });

  it("判定も同様に捨て、さらに現在のプロンプト版だけを残す", () => {
    const judgments = loadJudgments(judgmentsFile, loadSamples(samplesFile));
    const keys = judgments.map((j) => (j.kind === "rubric" ? `${j.judgeModel}:${j.sampleId}` : `pair:${j.aSampleId}${j.bSampleId}`));
    expect(keys).toEqual(["j:b", "j2:b", "pair:cb"]);
  });
});
