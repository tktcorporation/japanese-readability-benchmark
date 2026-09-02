import { HEADLINE_METRICS, METRIC_DIRECTION } from "../metrics/index.ts";
import type { HumanVote, Judgment, PairScheme, PairVerdict, PairwiseJudgment, RubricJudgment, Sample, ScoreRecord } from "../types.ts";
import { mean, round, stddev } from "../util/async.ts";

export interface MetricStat {
  mean: number;
  sd: number;
  n: number;
}

export interface WinRate {
  wins: number;
  losses: number;
  ties: number;
  n: number;
  /** (wins + ties/2) / n */
  rate: number;
}

export interface CellReport {
  modelId: string;
  interventionId: string;
  samples: number;
  errors: number;
  metrics: Record<string, MetricStat>;
  /**
   * baseline との差。同じ課題・モデル・サンプル番号の baseline と対にできたサンプルだけで計算する
   * （介入が一部の課題やモデルにしかないとき、構成の違いが改善に見えないように）
   */
  delta?: Record<string, number>;
  /** 改善率（%）。指標の向きを考慮し、正なら改善。delta と同じ対応サンプルで計算 */
  improvementPct?: Record<string, number>;
  /** baseline と対にできたサンプル数 */
  matched?: number;
  /** LLM の pairwise 判定: この介入 vs baseline */
  judgeWinRate?: WinRate;
  /** 人手投票: この介入 vs baseline */
  humanWinRate?: WinRate;
}

export interface ModelReport {
  modelId: string;
  samples: number;
  errors: number;
  metrics: Record<string, MetricStat>;
  /** 他モデルとの総当たり pairwise 勝率（LLM） */
  judgeWinRate?: WinRate;
  humanWinRate?: WinRate;
}

export interface Report {
  runId: string;
  generatedAt: string;
  baselineId: string;
  /** この集計に使った判定モデル */
  judgeModel?: string;
  /** run に含まれる判定モデル一覧。複数あれば judgeModel 以外は集計から除外している */
  judgeModels: string[];
  counts: { samples: number; errors: number; scores: number; rubric: number; pairwise: number; humanVotes: number };
  metricKeys: string[];
  /** baseline 介入におけるモデル比較 */
  models: ModelReport[];
  /** model × intervention */
  cells: CellReport[];
  /** モデルを問わず介入ごとにまとめたもの */
  interventions: CellReport[];
  /** 介入ごとの textlint ルール別違反数（合計） */
  ruleCounts: Record<string, Record<string, number>>;
  /** 人手評価と LLM 判定の一致率（同じペアがあるとき） */
  humanJudgeAgreement?: { n: number; agree: number; rate: number };
}

export interface AggregateInput {
  runId: string;
  samples: Sample[];
  scores: ScoreRecord[];
  judgments: Judgment[];
  humanVotes?: HumanVote[];
  /** pairId -> {a,b} の対応（人手評価用）。aText/bText は表示した本文で、現在のサンプルと一致するものだけ集計する */
  humanPairs?: { id: string; scheme: PairScheme; aSampleId: string; bSampleId: string; aText: string; bText: string }[];
  baselineId?: string;
  /** 集計に使う判定モデル。省略時は run 内で最初に見つかったもの */
  judgeModel?: string;
}

const JUDGE_METRIC_KEYS: Record<keyof RubricJudgment["scores"], string> = {
  readability: "judgeReadability",
  clarity: "judgeClarity",
  naturalness: "judgeNaturalness",
  concision: "judgeConcision",
  structure: "judgeStructure",
  overall: "judgeOverall",
};

function stat(xs: number[]): MetricStat {
  const clean = xs.filter((x) => Number.isFinite(x));
  return { mean: round(mean(clean), 4), sd: round(stddev(clean), 4), n: clean.length };
}

function statsFor(rows: Record<string, number>[], keys: string[]): Record<string, MetricStat> {
  const out: Record<string, MetricStat> = {};
  for (const k of keys) {
    const xs = rows.map((r) => r[k]).filter((v): v is number => typeof v === "number");
    if (xs.length) out[k] = stat(xs);
  }
  return out;
}

export function improvementPct(base: number, next: number, key: string): number {
  const dir = METRIC_DIRECTION[key] ?? "higher";
  if (!Number.isFinite(base) || !Number.isFinite(next)) return NaN;
  if (base === 0) return next === 0 ? 0 : dir === "lower" ? -Infinity : Infinity;
  const raw = dir === "lower" ? (base - next) / Math.abs(base) : (next - base) / Math.abs(base);
  return round(raw * 100, 1);
}

function emptyWinRate(): WinRate {
  return { wins: 0, losses: 0, ties: 0, n: 0, rate: NaN };
}

function addVerdict(w: WinRate, v: PairVerdict): void {
  if (v === "A") w.wins += 1;
  else if (v === "B") w.losses += 1;
  else w.ties += 1;
  w.n += 1;
  w.rate = round((w.wins + w.ties / 2) / w.n, 3);
}

/** サンプル id → 指標行（表層指標 + rubric 判定） */
function metricRows(scores: ScoreRecord[], judgments: Judgment[]): Map<string, Record<string, number>> {
  const rows = new Map<string, Record<string, number>>();
  for (const s of scores) rows.set(s.sampleId, { ...s.metrics });
  const rubricBySample = new Map<string, RubricJudgment[]>();
  for (const j of judgments) {
    if (j.kind !== "rubric") continue;
    rubricBySample.set(j.sampleId, [...(rubricBySample.get(j.sampleId) ?? []), j]);
  }
  for (const [sampleId, js] of rubricBySample) {
    const row = rows.get(sampleId) ?? {};
    for (const [k, metricKey] of Object.entries(JUDGE_METRIC_KEYS) as [keyof RubricJudgment["scores"], string][]) {
      row[metricKey] = mean(js.map((j) => j.scores[k]));
    }
    rows.set(sampleId, row);
  }
  return rows;
}

export function aggregate(input: AggregateInput): Report {
  const baselineId = input.baselineId ?? "baseline";
  const { samples, scores } = input;
  // 判定モデルが複数混在する run では 1 つに絞る（異なる判定者の票を合算しない）
  const judgeModels = Array.from(new Set(input.judgments.map((j) => j.judgeModel))).sort();
  const judgeModel = input.judgeModel ?? judgeModels[0];
  if (input.judgeModel && !judgeModels.includes(input.judgeModel)) {
    throw new Error(`判定モデル "${input.judgeModel}" の判定がありません。候補: ${judgeModels.join(", ") || "(なし)"}`);
  }
  const judgments = input.judgments.filter((j) => j.judgeModel === judgeModel);
  const sampleById = new Map(samples.map((s) => [s.id, s]));
  const rows = metricRows(scores, judgments);
  const metricKeys = Array.from(new Set([...HEADLINE_METRICS, ...Array.from(rows.values()).flatMap((r) => Object.keys(r))]));

  // --- pairwise 集計 -------------------------------------------------------
  const pairwise = judgments.filter((j): j is PairwiseJudgment => j.kind === "pairwise");
  const judgeCellWin = new Map<string, WinRate>(); // model|intervention → vs baseline
  const judgeModelWin = new Map<string, WinRate>(); // model → vs others
  for (const j of pairwise) {
    const a = sampleById.get(j.aSampleId);
    const b = sampleById.get(j.bSampleId);
    if (!a || !b) continue;
    if (j.scheme === "interventions") {
      const key = `${a.modelId}|${a.interventionId}`;
      const w = judgeCellWin.get(key) ?? emptyWinRate();
      addVerdict(w, j.verdict);
      judgeCellWin.set(key, w);
    } else {
      const wa = judgeModelWin.get(a.modelId) ?? emptyWinRate();
      addVerdict(wa, j.verdict);
      judgeModelWin.set(a.modelId, wa);
      const wb = judgeModelWin.get(b.modelId) ?? emptyWinRate();
      addVerdict(wb, flip(j.verdict));
      judgeModelWin.set(b.modelId, wb);
    }
  }

  // --- 人手投票 -------------------------------------------------------------
  const humanCellWin = new Map<string, WinRate>();
  const humanModelWin = new Map<string, WinRate>();
  let agreement: Report["humanJudgeAgreement"];
  // 表示した本文が現在のサンプルと一致するペアだけを有効とする（再生成後の古いペア・投票は捨てる）
  const validPairs = (input.humanPairs ?? []).filter((p) => {
    const a = sampleById.get(p.aSampleId);
    const b = sampleById.get(p.bSampleId);
    return a !== undefined && b !== undefined && a.text === p.aText && b.text === p.bText;
  });
  const pairById = new Map(validPairs.map((p) => [p.id, p]));
  const humanVotes = (input.humanVotes ?? []).filter((v) => pairById.has(v.pairId));
  if (humanVotes.length) {
    const judgeByPair = new Map(pairwise.map((j) => [`${j.aSampleId}|${j.bSampleId}`, j.verdict]));
    let n = 0;
    let agree = 0;
    // ペアごとに多数決してから集計する（1 人が大量投票しても偏らないように）
    const votesByPair = new Map<string, PairVerdict[]>();
    for (const v of humanVotes) votesByPair.set(v.pairId, [...(votesByPair.get(v.pairId) ?? []), v.choice]);
    for (const [pairId, choices] of votesByPair) {
      const pair = pairById.get(pairId)!;
      const a = sampleById.get(pair.aSampleId)!;
      const b = sampleById.get(pair.bSampleId)!;
      const verdict = majority(choices);
      if (pair.scheme === "interventions") {
        const key = `${a.modelId}|${a.interventionId}`;
        const w = humanCellWin.get(key) ?? emptyWinRate();
        addVerdict(w, verdict);
        humanCellWin.set(key, w);
      } else {
        const wa = humanModelWin.get(a.modelId) ?? emptyWinRate();
        addVerdict(wa, verdict);
        humanModelWin.set(a.modelId, wa);
        const wb = humanModelWin.get(b.modelId) ?? emptyWinRate();
        addVerdict(wb, flip(verdict));
        humanModelWin.set(b.modelId, wb);
      }
      const jv = judgeByPair.get(`${pair.aSampleId}|${pair.bSampleId}`);
      if (jv) {
        n += 1;
        if (jv === verdict) agree += 1;
      }
    }
    if (n > 0) agreement = { n, agree, rate: round(agree / n, 3) };
  }

  // --- baseline との対応付け ------------------------------------------------
  const baselineByKey = new Map<string, Sample>();
  for (const s of samples) {
    if (s.interventionId === baselineId && !s.error) baselineByKey.set(`${s.sourceId}|${s.modelId}|${s.sampleIndex}`, s);
  }
  // コーパス起点で modelId が "none" の baseline（原文）にもフォールバックする
  const baselineOf = (s: Sample) =>
    baselineByKey.get(`${s.sourceId}|${s.modelId}|${s.sampleIndex}`) ?? baselineByKey.get(`${s.sourceId}|none|${s.sampleIndex}`);

  // --- セル集計 -------------------------------------------------------------
  const cellSamples = new Map<string, Sample[]>();
  for (const s of samples) {
    const key = `${s.modelId}|${s.interventionId}`;
    cellSamples.set(key, [...(cellSamples.get(key) ?? []), s]);
  }
  const cells: CellReport[] = [];
  for (const [key, ss] of cellSamples) {
    const [modelId, interventionId] = key.split("|") as [string, string];
    const okRows = ss.filter((s) => !s.error).map((s) => rows.get(s.id) ?? {});
    cells.push({
      modelId,
      interventionId,
      samples: ss.length,
      errors: ss.filter((s) => s.error).length,
      metrics: statsFor(okRows, metricKeys),
      judgeWinRate: judgeCellWin.get(key),
      humanWinRate: humanCellWin.get(key),
    });
  }
  for (const cell of cells) {
    if (cell.interventionId === baselineId) continue;
    Object.assign(cell, matchedComparison(cellSamples.get(`${cell.modelId}|${cell.interventionId}`) ?? [], baselineOf, rows, metricKeys));
  }
  cells.sort((x, y) => x.modelId.localeCompare(y.modelId) || x.interventionId.localeCompare(y.interventionId));

  // --- 介入ごと（モデル横断） ------------------------------------------------
  const interventionIds = Array.from(new Set(samples.map((s) => s.interventionId))).sort();
  const interventions: CellReport[] = interventionIds.map((interventionId) => {
    const ss = samples.filter((s) => s.interventionId === interventionId);
    const okRows = ss.filter((s) => !s.error).map((s) => rows.get(s.id) ?? {});
    const win = emptyWinRate();
    const hwin = emptyWinRate();
    for (const c of cells) {
      if (c.interventionId !== interventionId) continue;
      if (c.judgeWinRate) mergeWin(win, c.judgeWinRate);
      if (c.humanWinRate) mergeWin(hwin, c.humanWinRate);
    }
    return {
      modelId: "*",
      interventionId,
      samples: ss.length,
      errors: ss.filter((s) => s.error).length,
      metrics: statsFor(okRows, metricKeys),
      judgeWinRate: win.n ? win : undefined,
      humanWinRate: hwin.n ? hwin : undefined,
    };
  });
  for (const c of interventions) {
    if (c.interventionId === baselineId) continue;
    Object.assign(c, matchedComparison(samples.filter((s) => s.interventionId === c.interventionId), baselineOf, rows, metricKeys));
  }

  // --- モデル比較（baseline のみ） ------------------------------------------
  // baseline のサンプルを持つモデルだけを並べる（コーパス run では baseline が原文なのでモデル比較は成立しない）
  const modelIds = Array.from(
    new Set(samples.filter((s) => s.modelId !== "none" && s.interventionId === baselineId && !s.error).map((s) => s.modelId)),
  ).sort();
  const models: ModelReport[] = modelIds.map((modelId) => {
    const ss = samples.filter((s) => s.modelId === modelId && s.interventionId === baselineId);
    const okRows = ss.filter((s) => !s.error).map((s) => rows.get(s.id) ?? {});
    return {
      modelId,
      samples: ss.length,
      errors: ss.filter((s) => s.error).length,
      metrics: statsFor(okRows, metricKeys),
      judgeWinRate: judgeModelWin.get(modelId),
      humanWinRate: humanModelWin.get(modelId),
    };
  });

  // --- ルール別違反 ---------------------------------------------------------
  const ruleCounts: Record<string, Record<string, number>> = {};
  for (const sc of scores) {
    const bucket = (ruleCounts[sc.interventionId] ??= {});
    for (const [rule, n] of Object.entries(sc.textlintRules)) bucket[rule] = (bucket[rule] ?? 0) + n;
  }

  return {
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    baselineId,
    judgeModel,
    judgeModels,
    counts: {
      samples: samples.length,
      errors: samples.filter((s) => s.error).length,
      scores: scores.length,
      rubric: judgments.filter((j) => j.kind === "rubric").length,
      pairwise: pairwise.length,
      humanVotes: humanVotes.length,
    },
    metricKeys,
    models,
    cells,
    interventions,
    ruleCounts,
    humanJudgeAgreement: agreement,
  };
}

function flip(v: PairVerdict): PairVerdict {
  return v === "A" ? "B" : v === "B" ? "A" : "tie";
}

function mergeWin(into: WinRate, from: WinRate): void {
  into.wins += from.wins;
  into.losses += from.losses;
  into.ties += from.ties;
  into.n += from.n;
  into.rate = into.n ? round((into.wins + into.ties / 2) / into.n, 3) : NaN;
}

/**
 * 介入サンプルを同じ課題・モデル・サンプル番号の baseline と対にして、対のある観測だけで差と改善率を出す。
 * 対が 1 つもなければ undefined。
 */
function matchedComparison(
  targets: Sample[],
  baselineOf: (s: Sample) => Sample | undefined,
  rows: Map<string, Record<string, number>>,
  keys: string[],
): Pick<CellReport, "delta" | "improvementPct" | "matched"> | undefined {
  const pairs: [Sample, Sample][] = [];
  for (const s of targets) {
    if (s.error) continue;
    const base = baselineOf(s);
    if (base && !base.error && base.id !== s.id) pairs.push([s, base]);
  }
  if (!pairs.length) return undefined;
  const delta: Record<string, number> = {};
  const pct: Record<string, number> = {};
  for (const k of keys) {
    const next: number[] = [];
    const base: number[] = [];
    for (const [s, b] of pairs) {
      const nv = rows.get(s.id)?.[k];
      const bv = rows.get(b.id)?.[k];
      if (typeof nv === "number" && typeof bv === "number" && Number.isFinite(nv) && Number.isFinite(bv)) {
        next.push(nv);
        base.push(bv);
      }
    }
    if (!next.length) continue;
    delta[k] = round(mean(next) - mean(base), 4);
    pct[k] = improvementPct(mean(base), mean(next), k);
  }
  return { delta, improvementPct: pct, matched: pairs.length };
}

export function majority(choices: PairVerdict[]): PairVerdict {
  const c = { A: 0, B: 0, tie: 0 };
  for (const ch of choices) c[ch] += 1;
  if (c.A > c.B && c.A > c.tie) return "A";
  if (c.B > c.A && c.B > c.tie) return "B";
  return "tie";
}
