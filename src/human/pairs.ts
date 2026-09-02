import { buildPairs, DEFAULT_AUDIENCE, type SourceInfo } from "../judge/index.ts";
import type { HumanPair, PairScheme, Sample } from "../types.ts";
import { seededRandom } from "../util/async.ts";
import { sha256 } from "../util/fs.ts";

export interface BuildHumanPairsOptions {
  schemes: PairScheme[];
  baselineId: string;
  sources: Map<string, SourceInfo>;
  /** 出力する最大ペア数（決定的にシャッフルしてから切る） */
  max?: number;
  seed?: number;
}

/** 人手評価ペアの検証に必要な項目（HumanPair の部分集合） */
export type PairForValidation = Pick<HumanPair, "sourceId" | "aSampleId" | "bSampleId" | "aText" | "bText" | "taskTitle" | "audience">;

/**
 * ペアが現在のサンプル・定義と一致しているか。
 * 評価者に見せた本文が現在のサンプルと同じで、課題名・想定読者も現在の定義と同じときだけ、そのペアへの投票を使う
 * （作り直した後の古いペア、題名や読者を直す前に集めた投票を捨てる）。sources を渡さなければ文脈は検査しない
 */
export function isCurrentPair(p: PairForValidation, sampleById: Map<string, Sample>, sources?: Map<string, SourceInfo>): boolean {
  const a = sampleById.get(p.aSampleId);
  const b = sampleById.get(p.bSampleId);
  // 失敗した再実行は中間結果の本文を残すことがあるので、本文が同じでも成功していないサンプルのペアは使わない
  if (a === undefined || b === undefined || a.error || b.error) return false;
  if (a.text !== p.aText || b.text !== p.bText) return false;
  if (sources) {
    const src = sources.get(p.sourceId);
    if (!src || p.taskTitle !== src.title || (p.audience ?? DEFAULT_AUDIENCE) !== (src.audience ?? DEFAULT_AUDIENCE)) return false;
  }
  return true;
}

export function buildHumanPairs(samples: Sample[], opts: BuildHumanPairsOptions): HumanPair[] {
  const pairs: HumanPair[] = [];
  for (const scheme of opts.schemes) {
    for (const p of buildPairs(samples, scheme, opts.baselineId)) {
      const src = opts.sources.get(p.sourceId);
      const taskTitle = src?.title ?? p.sourceId;
      const audience = src?.audience ?? "";
      pairs.push({
        // 本文と、評価者に見せる課題名・想定読者もキーに含める。
        // サンプルを再生成したり文脈を直したりすると別のペアになり、古い投票は集計から外れる
        id: sha256(scheme, p.a.id, p.b.id, p.a.text, p.b.text, taskTitle, audience).slice(0, 16),
        sourceId: p.sourceId,
        scheme,
        aSampleId: p.a.id,
        bSampleId: p.b.id,
        aText: p.a.text,
        bText: p.b.text,
        taskTitle,
        audience: src?.audience,
      });
    }
  }
  const rand = seededRandom(opts.seed ?? 42);
  for (let i = pairs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j]!, pairs[i]!];
  }
  return opts.max ? pairs.slice(0, opts.max) : pairs;
}
