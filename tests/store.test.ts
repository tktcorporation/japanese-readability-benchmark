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
    // 再利用元が失敗したら、依存サンプル（fresh）は捨てる。失敗の記録そのものは残る（エラーとして数える）
    appendJsonl(file, { ...sample("b", "そのまま。"), error: "API error" });
    expect(loadSamples(file).map((s) => s.id)).toEqual(["base", "b"]);
    expect(loadSamples(file).find((s) => s.id === "b")?.error).toBe("API error");
  });

  it("タスクのプロンプトやコーパスの原文が編集・削除されたらサンプルを捨てる", () => {
    const file = join(dir, "sources.jsonl");
    const doc = "原文。";
    const prompt = "書いて。";
    const orig = { ...sample("c__none__baseline__0", doc), sourceType: "corpus" as const, sourceId: "c", inputHash: sha256(doc) };
    const rw = { ...sample("c__m__rewrite-pass__0", "書き直し。"), sourceType: "corpus" as const, sourceId: "c", inputHash: sha256(doc) };
    const legacy = { ...sample("c__none__textlint-fix__0", "修正。"), sourceType: "corpus" as const, sourceId: "c" }; // inputHash なし
    const task = { ...sample("t__m__baseline__0", "生成。"), sourceId: "t", inputHash: sha256(prompt) };
    for (const s of [orig, rw, legacy, task]) appendJsonl(file, s);
    expect(loadSamples(file)).toHaveLength(4); // sourceHashes を渡さなければ検査しない
    const current = new Map([["c", sha256(doc)], ["t", sha256(prompt)]]);
    expect(loadSamples(file, { sourceHashes: current }).map((s) => s.id)).toEqual([orig.id, rw.id, task.id]);
    // プロンプトを編集
    expect(loadSamples(file, { sourceHashes: new Map([["c", sha256(doc)], ["t", sha256("別の指示。")]]) }).map((s) => s.id)).toEqual([orig.id, rw.id]);
    // 原文を編集
    expect(loadSamples(file, { sourceHashes: new Map([["c", sha256("編集した原文。")], ["t", sha256(prompt)]]) }).map((s) => s.id)).toEqual([task.id]);
    // 定義が消えた
    expect(loadSamples(file, { sourceHashes: new Map() })).toEqual([]);
  });

  it("課題名・想定読者が変わった判定は捨てる（contextHashes を渡したとき）", () => {
    const sFile = join(dir, "ctx-samples.jsonl");
    const jFile = join(dir, "ctx-judgments.jsonl");
    const a = sample("a", "本文A。");
    const b = sample("b", "本文B。");
    appendJsonl(sFile, a);
    appendJsonl(sFile, b);
    appendJsonl(jFile, { ...rubric("a", sha256(a.text), 3), contextHash: "ctx-v1" });
    appendJsonl(jFile, { ...pairwise(a, b), contextHash: "ctx-v1" });
    appendJsonl(jFile, rubric("b", sha256(b.text), 2)); // contextHash なし
    const samples = loadSamples(sFile);
    expect(loadJudgments(jFile, samples)).toHaveLength(3);
    expect(loadJudgments(jFile, samples, { contextHashes: new Map([["t", "ctx-v1"]]) })).toHaveLength(2);
    expect(loadJudgments(jFile, samples, { contextHashes: new Map([["t", "ctx-v2"]]) })).toHaveLength(0);
  });

  it("失敗した再実行は、同じ本文でも採点・判定の鮮度の根拠にならない", () => {
    const sFile = join(dir, "failed-samples.jsonl");
    const scFile = join(dir, "failed-scores.jsonl");
    const jFile = join(dir, "failed-judgments.jsonl");
    const ok = sample("x", "本文。");
    appendJsonl(sFile, ok);
    appendJsonl(sFile, sample("y", "別の本文。"));
    appendJsonl(scFile, score("x", sha256(ok.text), 1));
    appendJsonl(scFile, score("y", sha256("別の本文。"), 2));
    appendJsonl(jFile, rubric("x", sha256(ok.text), 3));
    appendJsonl(jFile, pairwise(ok, sample("y", "別の本文。")));
    expect(loadScores(scFile, loadSamples(sFile)).map((s) => s.sampleId)).toEqual(["x", "y"]);
    expect(loadJudgments(jFile, loadSamples(sFile))).toHaveLength(2);
    // --force で作り直したが、中間結果が同じ本文のまま失敗した
    appendJsonl(sFile, { ...ok, error: "API error" });
    expect(loadScores(scFile, loadSamples(sFile)).map((s) => s.sampleId)).toEqual(["y"]);
    expect(loadJudgments(jFile, loadSamples(sFile))).toHaveLength(0);
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
