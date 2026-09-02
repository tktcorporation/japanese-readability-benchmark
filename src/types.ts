/**
 * ベンチマーク全体で共有する型定義。
 *
 * データの流れ:
 *   Task / Corpus --(Intervention pipeline x Model)--> Sample
 *   Sample --(metrics)--> ScoreRecord
 *   Sample --(LLM judge)--> Judgment
 *   Sample --(human web)--> HumanVote
 *   すべて --(report)--> Report
 */

// ---------------------------------------------------------------------------
// 入力定義
// ---------------------------------------------------------------------------

/** モデルに日本語文章を書かせる課題 */
export interface TaskDef {
  id: string;
  /** 例: tech-explain, business, summary, howto */
  category: string;
  title: string;
  /** モデルに渡すユーザープロンプト（そのまま渡す＝素の出力） */
  prompt: string;
  /** 想定読者。判定プロンプトにも渡す */
  audience?: string;
  tags?: string[];
}

/** 介入評価用の固定コーパス（生成を伴わず「元の文章」を改善させる） */
export interface CorpusDoc {
  id: string;
  title: string;
  /** 出典や作成方法のメモ */
  note?: string;
  audience?: string;
  tags?: string[];
  text: string;
}

export type ProviderKind = "anthropic" | "openai" | "mock";

export interface ModelDef {
  /** 設定・結果で使う識別子（例: fable-5.1） */
  id: string;
  provider: ProviderKind;
  /** API に渡すモデル名（例: claude-fable-5-1） */
  model: string;
  label?: string;
  /** API キーの環境変数名（既定: ANTHROPIC_API_KEY / OPENAI_API_KEY） */
  apiKeyEnv?: string;
  /** OpenAI 互換エンドポイント用 */
  baseUrl?: string;
  maxTokens?: number;
  /** Claude 4.7 以降はサンプリング系パラメータを受け付けないので通常は未指定 */
  temperature?: number;
  /** Anthropic: adaptive（既定）/ none */
  thinking?: "adaptive" | "none";
  /** Anthropic: low / medium / high / xhigh / max */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Anthropic: 安全分類器による refusal 時にサーバー側で別モデルへフォールバックする。
   * ベンチマークでは「どのモデルの出力か」が曖昧になるため既定は false。
   */
  fallbacks?: boolean;
  /** mock プロバイダ用: fixtures/mock/<style>/ を参照 */
  mockStyle?: string;
}

/** 介入パイプラインの 1 ステップ */
export type StepDef =
  | {
      type: "generate";
      /**
       * 生成せず、同じ source × model × index の別の介入（通常は baseline）の出力を再利用する。
       * 後処理だけの介入（textlint-fix、rewrite-pass）で使うと、生成のばらつきが介入効果に混ざらない。
       * system / promptPrefix / promptSuffix とは併用できない。
       */
      reuse?: string;
      /** システムプロンプトのファイル（介入ディレクトリからの相対パス） */
      system?: string;
      /** タスクプロンプトの前後に付け足す文字列 */
      promptPrefix?: string;
      promptSuffix?: string;
    }
  | {
      type: "textlint-fix";
      /** .textlintrc の場所（既定: リポジトリ直下） */
      config?: string;
    }
  | {
      type: "rewrite";
      /** 書き直し指示のファイル。{{text}} と {{audience}} を展開する */
      prompt: string;
      /** 書き直しに使うモデル id。省略時は生成モデルと同じ */
      model?: string;
      passes?: number;
    };

export interface InterventionDef {
  id: string;
  name: string;
  description?: string;
  steps: StepDef[];
  /** 定義ファイルのあるディレクトリ（相対パス解決用） */
  dir: string;
}

// ---------------------------------------------------------------------------
// 生成結果
// ---------------------------------------------------------------------------

export interface GenerateRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
  /** mock プロバイダが挙動を切り替えるためのヒント */
  purpose: "generate" | "rewrite" | "judge";
  /** mock 用: どのタスク/コーパスの出力か */
  sourceId?: string;
}

export interface GenerateResponse {
  text: string;
  /** 実際に応答したモデル名（フォールバック時は元と異なる） */
  servedBy?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  stopReason?: string;
  latencyMs: number;
}

export interface StepTrace {
  type: StepDef["type"];
  skipped?: boolean;
  ms: number;
  modelId?: string;
  servedBy?: string;
  /** generate(reuse): 再利用したサンプルの id と、そのときの本文ハッシュ（再利用元が作り直されたら不一致になる） */
  reusedFrom?: string;
  reusedHash?: string;
  /** textlint-fix: 適用された修正数 / 残った違反数 */
  applied?: number;
  remaining?: number;
  usage?: GenerateResponse["usage"];
}

export interface Sample {
  id: string;
  runId: string;
  sourceType: "task" | "corpus";
  sourceId: string;
  /** コーパス由来の場合は "corpus" */
  modelId: string;
  interventionId: string;
  sampleIndex: number;
  /** 最終的な文章 */
  text: string;
  /** コーパス/生成直後の文章（介入前）。差分表示用 */
  inputText?: string;
  steps: StepTrace[];
  createdAt: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// 評価結果
// ---------------------------------------------------------------------------

export interface TextlintMessage {
  ruleId: string;
  message: string;
  line: number;
  column: number;
  fixable: boolean;
}

export interface ScoreRecord {
  sampleId: string;
  /** 採点時点の本文ハッシュ。サンプルが再生成されたら不一致になり、記録は捨てられる */
  textHash?: string;
  sourceId: string;
  modelId: string;
  interventionId: string;
  metrics: Record<string, number>;
  /** ルール別の違反数 */
  textlintRules: Record<string, number>;
  textlintMessages: TextlintMessage[];
}

export interface RubricScores {
  readability: number;
  clarity: number;
  naturalness: number;
  concision: number;
  structure: number;
  overall: number;
}

export interface RubricJudgment {
  kind: "rubric";
  sampleId: string;
  /** 判定時点の本文ハッシュ */
  textHash?: string;
  judgeModel: string;
  promptVersion: string;
  scores: RubricScores;
  rationale: string;
  createdAt: string;
}

export type PairVerdict = "A" | "B" | "tie";

export type PairScheme = "interventions" | "models";

export interface PairwiseJudgment {
  kind: "pairwise";
  /** 比較の名前空間（interventions / models） */
  scheme: PairScheme;
  sourceId: string;
  aSampleId: string;
  bSampleId: string;
  /** 判定時点の本文ハッシュ */
  aTextHash?: string;
  bTextHash?: string;
  judgeModel: string;
  promptVersion: string;
  /** A を先に見せたときの判定 */
  verdictAB: PairVerdict;
  /** B を先に見せたときの判定（位置バイアス対策） */
  verdictBA: PairVerdict;
  /** 両順序を統合した最終判定。食い違えば tie */
  verdict: PairVerdict;
  rationale: string;
  createdAt: string;
}

export type Judgment = RubricJudgment | PairwiseJudgment;

// ---------------------------------------------------------------------------
// 人手評価
// ---------------------------------------------------------------------------

export interface HumanPair {
  id: string;
  sourceId: string;
  scheme: PairScheme;
  aSampleId: string;
  bSampleId: string;
  aText: string;
  bText: string;
  /** 表示用の課題説明 */
  taskTitle: string;
  audience?: string;
}

export interface HumanVote {
  pairId: string;
  /** 内部的には A/B で記録。左右は毎回ランダム */
  choice: PairVerdict;
  /** 画面左に出したのが A だったか */
  leftWasA: boolean;
  raterId: string;
  comment?: string;
  /** 回答にかかった秒数 */
  seconds?: number;
  createdAt: string;
}
