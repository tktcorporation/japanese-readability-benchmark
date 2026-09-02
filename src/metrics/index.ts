import { existsSync } from "node:fs";
import type { Sample, ScoreRecord } from "../types.ts";
import { installedVersion, readText, repoPath, sha256 } from "../util/fs.ts";
import { surfaceMetrics } from "./surface.ts";
import { lintText, textlintToolchain } from "./textlint.ts";

/**
 * 指標の実装版。表層指標や jReadability の計算方法を変えたら上げる。
 * 採点設定ハッシュに含まれ、古い版で計算した採点は陳腐化して再計算される。
 */
export const METRICS_VERSION = "metrics-v2";

/** textlint 以外で採点に影響する依存パッケージ（表層指標・jReadability の形態素解析） */
const SURFACE_PACKAGES = ["kuromojin"];


/**
 * 採点設定のハッシュ。指標の実装版・textlint 設定の内容・依存パッケージの版のどれかが変わると変わる。
 * ScoreRecord に記録し、読み込み時に現在の値と一致しない採点は捨てる
 */
export function scoringHashOf(textlintConfig = repoPath(".textlintrc.json")): string {
  const config = existsSync(textlintConfig) ? readText(textlintConfig) : "";
  // textlint 本体と、設定で有効にしているルール・フィルタすべての版を含める（設定から動的に求める）
  return sha256("scoring", METRICS_VERSION, config, ...textlintToolchain(config), ...SURFACE_PACKAGES.map((p) => `${p}@${installedVersion(p)}`));
}

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
    scoringHash: scoringHashOf(textlintConfig),
    sourceId: sample.sourceId,
    modelId: sample.modelId,
    interventionId: sample.interventionId,
    metrics,
    textlintRules: lint.rules,
    textlintMessages: lint.messages,
  };
}
