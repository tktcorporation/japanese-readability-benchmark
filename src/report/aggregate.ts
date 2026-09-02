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
  /** baseline との差（同じモデル） */
  delta?: Record<string, number>;
  /** 改善率（%）。指標の向きを考慮し、正なら改善 */
  improvementPct?: Record<string, number>;
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
  judgeModel?: string;
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
  /** pairId -> {a,b} の対応（人手評価用） */
  humanPairs?: { id: string; scheme: PairScheme; aSampleId: string; bSampleId: string }[];
  baselineId?: string;
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
  const { samples, scores, judgments } = input;
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
  if (input.humanVotes?.length && input.humanPairs?.length) {
    const pairById = new Map(input.humanPairs.map((p) => [p.id, p]));
    const judgeByPair = new Map(pairwise.map((j) => [`${j.aSampleId}|${j.bSampleId}`, j.verdict]));
    let n = 0;
    let agree = 0;
    // ペアごとに多数決してから集計する（1 人が大量投票しても偏らないように）
    const votesByPair = new Map<string, PairVerdict[]>();
    for (const v of input.humanVotes) votesByPair.set(v.pairId, [...(votesByPair.get(v.pairId) ?? []), v.choice]);
    for (const [pairId, choices] of votesByPair) {
      const pair = pairById.get(pairId);
      if (!pair) continue;
      const a = sampleById.get(pair.aSampleId);
      const b = sampleById.get(pair.bSampleId);
      if (!a || !b) continue;
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
    const base = cells.find((c) => c.modelId === cell.modelId && c.interventionId === baselineId)
      ?? cells.find((c) => c.modelId === "none" && c.interventionId === baselineId);
    if (!base) continue;
    cell.delta = {};
    cell.improvementPct = {};
    for (const k of metricKeys) {
      const b = base.metrics[k];
      const n = cell.metrics[k];
      if (!b || !n) continue;
      cell.delta[k] = round(n.mean - b.mean, 4);
      cell.improvementPct[k] = improvementPct(b.mean, n.mean, k);
    }
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
  const baseAll = interventions.find((c) => c.interventionId === baselineId);
  if (baseAll) {
    for (const c of interventions) {
      if (c.interventionId === baselineId) continue;
      c.delta = {};
      c.improvementPct = {};
      for (const k of metricKeys) {
        const b = baseAll.metrics[k];
        const n = c.metrics[k];
        if (!b || !n) continue;
        c.delta[k] = round(n.mean - b.mean, 4);
        c.improvementPct[k] = improvementPct(b.mean, n.mean, k);
      }
    }
  }

  // --- モデル比較（baseline のみ） ------------------------------------------
  const modelIds = Array.from(new Set(samples.filter((s) => s.modelId !== "none").map((s) => s.modelId))).sort();
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

  const judgeModel = judgments[0]?.judgeModel;
  return {
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    baselineId,
    judgeModel,
    counts: {
      samples: samples.length,
      errors: samples.filter((s) => s.error).length,
      scores: scores.length,
      rubric: judgments.filter((j) => j.kind === "rubric").length,
      pairwise: pairwise.length,
      humanVotes: input.humanVotes?.length ?? 0,
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

export function majority(choices: PairVerdict[]): PairVerdict {
  const c = { A: 0, B: 0, tie: 0 };
  for (const ch of choices) c[ch] += 1;
  if (c.A > c.B && c.A > c.tie) return "A";
  if (c.B > c.A && c.B > c.tie) return "B";
  return "tie";
}
