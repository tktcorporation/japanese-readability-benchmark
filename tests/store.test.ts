import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
function rubric(sampleId: string, textHash: string | undefined, overall: number, judgeModel = "j"): Judgment {
  return { kind: "rubric", sampleId, textHash, judgeModel, promptVersion: "v", createdAt: "", rationale: "", scores: { readability: 1, clarity: 1, naturalness: 1, concision: 1, structure: 1, overall } };
}

describe("store", () => {
  const samplesFile = join(dir, "samples.jsonl");
  const scoresFile = join(dir, "scores.jsonl");
  const judgmentsFile = join(dir, "judgments.jsonl");

  // a は旧本文で採点されたあと --force で再生成された。b はそのまま
  const aOld = sample("a", "古い本文。");
  const aNew = sample("a", "新しい本文。");
  const b = sample("b", "そのまま。");
  appendJsonl(samplesFile, aOld);
  appendJsonl(samplesFile, b);
  appendJsonl(samplesFile, aNew);

  appendJsonl(scoresFile, score("a", sha256(aOld.text), 1));
  appendJsonl(scoresFile, score("b", sha256(b.text), 2));
  appendJsonl(scoresFile, score("b", sha256(b.text), 3)); // score --force の追記
  appendJsonl(scoresFile, score("gone", undefined, 9)); // サンプルが消えた記録

  appendJsonl(judgmentsFile, rubric("a", sha256(aOld.text), 1));
  appendJsonl(judgmentsFile, rubric("b", sha256(b.text), 2));
  appendJsonl(judgmentsFile, rubric("b", undefined, 4, "j2")); // 旧形式（ハッシュなし）は有効
  appendJsonl(judgmentsFile, {
    kind: "pairwise", scheme: "interventions", sourceId: "t", aSampleId: "a", bSampleId: "b",
    aTextHash: sha256(aOld.text), bTextHash: sha256(b.text), judgeModel: "j", promptVersion: "v",
    verdictAB: "A", verdictBA: "A", verdict: "A", rationale: "", createdAt: "",
  } satisfies Judgment);

  it("サンプルは同じ id なら後勝ち", () => {
    const samples = loadSamples(samplesFile);
    expect(samples.map((s) => s.id)).toEqual(["a", "b"]);
    expect(samples.find((s) => s.id === "a")?.text).toBe("新しい本文。");
  });

  it("採点は後勝ちで重複を除き、本文が変わった記録と孤立した記録を捨てる", () => {
    const scores = loadScores(scoresFile, loadSamples(samplesFile));
    expect(scores.map((s) => [s.sampleId, s.metrics.v])).toEqual([["b", 3]]);
  });

  it("判定も同様。ハッシュのない旧形式は有効扱い", () => {
    const judgments = loadJudgments(judgmentsFile, loadSamples(samplesFile));
    expect(judgments.map((j) => (j.kind === "rubric" ? `${j.judgeModel}:${j.sampleId}` : "pair"))).toEqual(["j:b", "j2:b"]);
  });
});
