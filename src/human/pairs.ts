import { buildPairs, type SourceInfo } from "../judge/index.ts";
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
