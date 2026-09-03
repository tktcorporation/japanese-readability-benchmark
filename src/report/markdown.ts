import { HEADLINE_METRICS, METRIC_DIRECTION } from "../metrics/index.ts";
import type { CellReport, MetricStat, ModelReport, Report, WinRate } from "./aggregate.ts";

const LABELS: Record<string, string> = {
  textlintPer1k: "textlint違反/1k字",
  meanSentenceLength: "平均文長",
  longSentenceRatio: "60字超の文",
  tenPerSentence: "読点/文",
  kanjiRatio: "漢字率",
  jreadability: "jReadability",
  judgeOverall: "LLM総合",
  judgeReadability: "LLM読みやすさ",
  judgeClarity: "LLM明確さ",
  judgeNaturalness: "LLM自然さ",
  judgeConcision: "LLM簡潔さ",
  judgeStructure: "LLM構成",
};

const PCT_METRICS = new Set(["longSentenceRatio", "kanjiRatio", "veryLongSentenceRatio", "manyTenRatio"]);

function fmt(key: string, v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "-";
  if (PCT_METRICS.has(key)) return `${(v * 100).toFixed(1)}%`;
  return v.toFixed(2);
}

/** 平均値。指標が一部のサンプルでしか計算されていなければ件数を添える */
function fmtStat(key: string, stat: MetricStat | undefined, expected: number): string {
  if (!stat) return "-";
  const v = fmt(key, stat.mean);
  return stat.n < expected ? `${v} [n=${stat.n}]` : v;
}

function fmtPct(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "-";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function fmtWin(w: WinRate | undefined): string {
  if (!w || !w.n) return "-";
  return `${(w.rate * 100).toFixed(0)}% (${w.wins}勝${w.losses}敗${w.ties}分)`;
}

function arrow(key: string): string {
  return (METRIC_DIRECTION[key] ?? "higher") === "lower" ? "↓" : "↑";
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

function reportKeys(report: Report): string[] {
  const keys: string[] = [...HEADLINE_METRICS];
  for (const k of ["judgeOverall", "judgeReadability", "judgeClarity", "judgeNaturalness", "judgeConcision", "judgeStructure"]) {
    if (report.metricKeys.includes(k) && report.cells.some((c) => c.metrics[k])) keys.push(k);
  }
  return keys;
}

function metricHeader(keys: string[]): string[] {
  return keys.map((k) => `${LABELS[k] ?? k} ${arrow(k)}`);
}

function modelRows(models: ModelReport[], keys: string[]): string[][] {
  return models.map((m) => [
    m.modelId,
    String(m.samples - m.errors),
    ...keys.map((k) => fmtStat(k, m.metrics[k], m.samples - m.errors)),
    fmtWin(m.judgeWinRate),
    fmtWin(m.humanWinRate),
  ]);
}

function cellRows(cells: CellReport[], keys: string[], withModel: boolean): string[][] {
  return cells.map((c) => [
    ...(withModel ? [c.modelId] : []),
    c.interventionId,
    String(c.samples - c.errors),
    ...keys.map((k) => {
      const v = fmtStat(k, c.metrics[k], c.samples - c.errors);
      const imp = c.improvementPct?.[k];
      const delta = c.delta?.[k];
      if (imp === undefined && delta === undefined) return v;
      // 改善率は、その指標が両方にある baseline との対だけで計算している。一部しか対にできなければ件数を添える
      const pairsUsed = c.matchedN?.[k] ?? c.matched;
      const partial = pairsUsed !== undefined && pairsUsed < c.samples - c.errors ? `, 対 ${pairsUsed} 件` : "";
      // 基準が 0 で率が出せないときは差分と「基準 0」を示す
      const change = imp === undefined ? `${delta !== undefined && delta > 0 ? "+" : ""}${fmt(k, delta)}, 基準 0` : fmtPct(imp);
      return `${v} (${change}${partial})`;
    }),
    fmtWin(c.judgeWinRate),
    fmtWin(c.humanWinRate),
  ]);
}

export function renderMarkdown(report: Report): string {
  const keys = reportKeys(report);
  const out: string[] = [];
  out.push(`# 日本語読みやすさベンチマーク レポート: ${report.runId}`);
  out.push("");
  out.push(`生成日時: ${report.generatedAt}  `);
  out.push(`サンプル: ${report.counts.samples}（エラー ${report.counts.errors}） / 自動指標: ${report.counts.scores} / LLM採点: ${report.counts.rubric} / LLM比較: ${report.counts.pairwise} / 人手投票: ${report.counts.humanVotes}`);
  if (report.judgeModel) {
    const others = report.judgeModels.filter((m) => m !== report.judgeModel);
    out.push(`判定モデル: ${report.judgeModel}${others.length ? `（他に ${others.join(", ")} の判定あり。\`--judge\` で切り替え）` : ""}`);
  }
  out.push("");
  out.push(`矢印は望ましい方向（↓ 小さいほど良い / ↑ 大きいほど良い）。介入の表の括弧内は基準の介入 ${report.baselineId} に対する改善率で、同じ課題・モデル・サンプル番号の ${report.baselineId} と対にできたサンプルだけで計算する（対が一部なら件数を添える）。`);
  out.push("`[n=k]` は、その指標が n 列の件数より少ない k 件だけで計算されていることを示す（`judge --limit` や中断した `score` のあと）。");
  out.push("");

  if (report.models.length) {
    out.push(`## 1. モデル比較（基準の介入 = ${report.baselineId}）`);
    out.push("");
    out.push(table(["モデル", "n", ...metricHeader(keys), "LLM対戦勝率", "人手勝率"], modelRows(report.models, keys)));
    out.push("");
  }

  const interventionsOnly = report.interventions.filter((c) => c.interventionId !== report.baselineId);
  if (interventionsOnly.length) {
    out.push("## 2. 介入の効果（モデル横断）");
    out.push("");
    const base = report.interventions.find((c) => c.interventionId === report.baselineId);
    const rows = [...(base ? cellRows([base], keys, false) : []), ...cellRows(interventionsOnly, keys, false)];
    out.push(table(["介入", "n", ...metricHeader(keys), `LLM勝率 vs ${report.baselineId}`, `人手勝率 vs ${report.baselineId}`], rows));
    out.push("");

    out.push("## 3. モデル × 介入");
    out.push("");
    out.push(table(["モデル", "介入", "n", ...metricHeader(keys), `LLM勝率 vs ${report.baselineId}`, `人手勝率 vs ${report.baselineId}`], cellRows(report.cells, keys, true)));
    out.push("");
  }

  const ruleEntries = Object.entries(report.ruleCounts);
  if (ruleEntries.length) {
    out.push("## 4. textlint ルール別違反数（介入ごとの合計）");
    out.push("");
    const rules = Array.from(new Set(ruleEntries.flatMap(([, r]) => Object.keys(r)))).sort();
    const ids = ruleEntries.map(([id]) => id).sort();
    out.push(
      table(
        ["ルール", ...ids],
        rules.map((rule) => [rule.replace("ja-technical-writing/", ""), ...ids.map((id) => String(report.ruleCounts[id]?.[rule] ?? 0))]),
      ),
    );
    out.push("");
  }

  if (report.humanJudgeAgreement) {
    const a = report.humanJudgeAgreement;
    out.push("## 5. 人手評価と LLM 判定の一致");
    out.push("");
    out.push(`同じペアに両方の判定がある ${a.n} 件のうち ${a.agree} 件が一致（${(a.rate * 100).toFixed(0)}%）。`);
    out.push("");
  }

  out.push("## 指標の説明");
  out.push("");
  out.push("- textlint違反/1k字: `.textlintrc.json`（preset-ja-technical-writing）の違反数を 1000 文字あたりに正規化");
  out.push("- 平均文長 / 60字超の文 / 読点/文: 句点で区切った文の表層統計（Markdown 記法は除去）");
  out.push("- 漢字率: 空白を除く本文中の漢字の割合");
  out.push("- jReadability: Lee & Hasebe (2016) の日本語リーダビリティ式。大きいほど易しい（IPADIC による近似、docs/methodology.md 参照）");
  out.push("- LLM総合ほか: 判定モデルによる 1〜5 点のルーブリック採点");
  out.push("- 勝率: pairwise 比較で (勝ち + 引き分け/2) / 比較数。提示順を入れ替えた 2 回の判定が一致したときだけ勝敗、食い違えば引き分け");
  out.push("");
  return out.join("\n");
}
