import type { Sample, ScoreRecord } from "../types.ts";
import { sha256 } from "../util/fs.ts";
import { surfaceMetrics } from "./surface.ts";
import { lintText } from "./textlint.ts";

/**
 * 指標の向き。report で「改善率」を計算するときに使う。
 * lower: 小さいほど読みやすい / higher: 大きいほど読みやすい
 */
export const METRIC_DIRECTION: Record<string, "lower" | "higher"> = {
  textlintPer1k: "lower",
  textlintCount: "lower",
  meanSentenceLength: "lower",
  maxSentenceLength: "lower",
  longSentenceRatio: "lower",
  veryLongSentenceRatio: "lower",
  tenPerSentence: "lower",
  manyTenRatio: "lower",
  maxKanjiRun: "lower",
  kanjiRatio: "lower",
  kangoRatio: "lower",
  rareruPerSentence: "lower",
  nominalizationPer1k: "lower",
  jreadability: "higher",
  judgeOverall: "higher",
  judgeReadability: "higher",
  judgeClarity: "higher",
  judgeNaturalness: "higher",
  judgeConcision: "higher",
  judgeStructure: "higher",
};

/** レポートの表に載せる主要指標（順序どおり） */
export const HEADLINE_METRICS = [
  "textlintPer1k",
  "meanSentenceLength",
  "longSentenceRatio",
  "tenPerSentence",
  "kanjiRatio",
  "jreadability",
] as const;

export async function scoreSample(sample: Sample, textlintConfig?: string): Promise<ScoreRecord> {
  const [surface, lint] = await Promise.all([surfaceMetrics(sample.text), lintText(sample.text, textlintConfig)]);
  const metrics: Record<string, number> = {
    ...surface,
    textlintCount: lint.count,
    textlintPer1k: lint.per1k,
    textlintFixable: lint.fixableCount,
  };
  return {
    sampleId: sample.id,
    textHash: sha256(sample.text),
    sourceId: sample.sourceId,
    modelId: sample.modelId,
    interventionId: sample.interventionId,
    metrics,
    textlintRules: lint.rules,
    textlintMessages: lint.messages,
  };
}
