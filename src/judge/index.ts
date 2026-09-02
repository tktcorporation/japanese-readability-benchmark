import { existsSync } from "node:fs";
import type { Provider } from "../providers/index.ts";
import type { PairScheme, PairVerdict, PairwiseJudgment, RubricJudgment, Sample } from "../types.ts";
import { readJson, sha256, writeJson } from "../util/fs.ts";
import {
  JUDGE_SYSTEM,
  PAIRWISE_PROMPT_VERSION,
  RUBRIC_PROMPT_VERSION,
  pairwisePrompt,
  pairwiseSchema,
  rubricPrompt,
  rubricSchema,
} from "./prompts.ts";

export interface SourceInfo {
  id: string;
  title: string;
  audience?: string;
}

export interface JudgeOptions {
  provider: Provider;
  /** 同じ入力の再判定を避けるためのキャッシュディレクトリ */
  cacheDir?: string;
}

export const DEFAULT_AUDIENCE = "一般的な読者";

/** 判定プロンプトに埋め込む文脈（課題名・想定読者）のハッシュ。定義を直したら判定を作り直すために記録する */
export function contextHashOf(source: SourceInfo): string {
  return sha256("context", source.title, source.audience ?? DEFAULT_AUDIENCE);
}

/** 同じキーの判定が同時に走ったとき、2 回目以降は 1 回目の Promise を共有する（ディスクキャッシュに書かれる前の重複呼び出しを防ぐ） */
const inflight = new Map<string, Promise<unknown>>();

function cached<T>(cacheDir: string | undefined, key: string, compute: () => Promise<T>): Promise<T> {
  const file = cacheDir ? `${cacheDir}/${key}.json` : undefined;
  if (file && existsSync(file)) return Promise.resolve(readJson<T>(file));
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = compute()
    .then((v) => {
      if (file) writeJson(file, v);
      return v;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export async function judgeRubric(sample: Sample, source: SourceInfo, opts: JudgeOptions): Promise<RubricJudgment> {
  const judgeModel = opts.provider.model.id;
  const audience = source.audience ?? DEFAULT_AUDIENCE;
  const key = sha256("rubric", judgeModel, RUBRIC_PROMPT_VERSION, source.title, audience, sample.text);
  const value = await cached(opts.cacheDir, key, async () => {
    const { value } = await opts.provider.generateJson(
      { system: JUDGE_SYSTEM, prompt: rubricPrompt({ text: sample.text, taskTitle: source.title, audience }), purpose: "judge" },
      rubricSchema,
      "rubric",
    );
    return value;
  });
  const { rationale, ...scores } = value;
  return {
    kind: "rubric",
    sampleId: sample.id,
    textHash: sha256(sample.text),
    contextHash: contextHashOf(source),
    judgeModel,
    promptVersion: RUBRIC_PROMPT_VERSION,
    scores,
    rationale,
    createdAt: new Date().toISOString(),
  };
}

/** 提示順を入れ替えた 2 回の判定を統合する。食い違えば tie */
export function combineVerdicts(verdictAB: PairVerdict, verdictBA: PairVerdict): PairVerdict {
  return verdictAB === verdictBA ? verdictAB : "tie";
}

/** 「先に見せた方 = A」で返ってきた判定を、本来の A/B に戻す */
export function flipVerdict(v: PairVerdict): PairVerdict {
  return v === "A" ? "B" : v === "B" ? "A" : "tie";
}

export async function judgePairwise(
  a: Sample,
  b: Sample,
  source: SourceInfo,
  scheme: PairScheme,
  opts: JudgeOptions,
): Promise<PairwiseJudgment> {
  const judgeModel = opts.provider.model.id;
  const audience = source.audience ?? DEFAULT_AUDIENCE;
  const ask = async (first: string, second: string) => {
    const key = sha256("pairwise", judgeModel, PAIRWISE_PROMPT_VERSION, source.title, audience, first, second);
    return cached(opts.cacheDir, key, async () => {
      const { value } = await opts.provider.generateJson(
        { system: JUDGE_SYSTEM, prompt: pairwisePrompt({ a: first, b: second, taskTitle: source.title, audience }), purpose: "judge" },
        pairwiseSchema,
        "pairwise",
      );
      return value;
    });
  };
  const [ab, ba] = await Promise.all([ask(a.text, b.text), ask(b.text, a.text)]);
  const verdictAB = ab.verdict;
  const verdictBA = flipVerdict(ba.verdict);
  return {
    kind: "pairwise",
    scheme,
    sourceId: source.id,
    aSampleId: a.id,
    bSampleId: b.id,
    aTextHash: sha256(a.text),
    bTextHash: sha256(b.text),
    contextHash: contextHashOf(source),
    judgeModel,
    promptVersion: PAIRWISE_PROMPT_VERSION,
    verdictAB,
    verdictBA,
    verdict: combineVerdicts(verdictAB, verdictBA),
    rationale: `[A先] ${ab.rationale}\n[B先] ${ba.rationale}`,
    createdAt: new Date().toISOString(),
  };
}

export interface SamplePair {
  scheme: PairScheme;
  sourceId: string;
  a: Sample;
  b: Sample;
}

/**
 * 比較ペアを作る。
 * - interventions: 同じ source × model × index について、各介入（A）と baseline（B）を比較
 * - models: baseline 介入について、同じ source × index のモデル同士を総当たり
 */
export function buildPairs(samples: Sample[], scheme: PairScheme, baselineId: string): SamplePair[] {
  const ok = samples.filter((s) => !s.error && s.text.length > 0);
  const pairs: SamplePair[] = [];
  if (scheme === "interventions") {
    const baselines = new Map<string, Sample>();
    for (const s of ok) if (s.interventionId === baselineId) baselines.set(`${s.sourceId}|${s.modelId}|${s.sampleIndex}`, s);
    for (const s of ok) {
      if (s.interventionId === baselineId) continue;
      const base = baselines.get(`${s.sourceId}|${s.modelId}|${s.sampleIndex}`);
      // コーパス起点で modelId が "none" の介入は、同じ source の baseline（＝原文）と比べる
      const fallback = base ?? baselines.get(`${s.sourceId}|none|${s.sampleIndex}`);
      if (fallback) pairs.push({ scheme, sourceId: s.sourceId, a: s, b: fallback });
    }
  } else {
    const groups = new Map<string, Sample[]>();
    for (const s of ok) {
      if (s.interventionId !== baselineId || s.modelId === "none") continue;
      const key = `${s.sourceId}|${s.sampleIndex}`;
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    for (const group of groups.values()) {
      const sorted = [...group].sort((x, y) => x.modelId.localeCompare(y.modelId));
      for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) {
          pairs.push({ scheme, sourceId: sorted[i]!.sourceId, a: sorted[i]!, b: sorted[j]! });
        }
      }
    }
  }
  return pairs;
}
