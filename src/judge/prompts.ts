import { z } from "zod";
import { escapeDelimiters } from "../util/delimiters.ts";

export { escapeDelimiters };

/**
 * 判定プロンプト。文言を変えたら VERSION を上げる（キャッシュキーと結果の互換性に使う）。
 */
export const RUBRIC_PROMPT_VERSION = "rubric-v2";
export const PAIRWISE_PROMPT_VERSION = "pairwise-v2";


export const JUDGE_SYSTEM = `あなたは日本語の文章品質を評価する専門家です。
評価対象は「文章としての読みやすさ・分かりやすさ」だけです。内容の正確さ、情報量の多寡、意見への賛否は評価に含めません。
Markdown の見出しや箇条書きは、読みやすさに寄与する構成要素として扱ってください。
評価は厳密に、根拠を具体的に述べてください。長さが違うこと自体は良し悪しの根拠にしないでください。`;

export const RUBRIC_CRITERIA = `採点基準（各 1〜5 点、5 が最良）:
- readability（読みやすさ）: 一文の長さ、読点の使い方、漢字とかなのバランス、リズム。
- clarity（分かりやすさ）: 主語と述語の対応、修飾関係の明確さ、専門用語の扱い、曖昧さのなさ。
- naturalness（自然さ）: 翻訳調・冗長な言い回し・不自然な敬語がなく、日本語として自然か。
- concision（簡潔さ）: 重複や迂言（「〜することができる」「〜ということ」など）がなく、無駄がないか。
- structure（構成）: 段落・見出し・箇条書きが適切で、論理の流れを追いやすいか。
- overall（総合）: 上記を踏まえた総合評価。想定読者にとってどれだけ読みやすいか。`;

export const rubricSchema = z.object({
  readability: z.number().int().min(1).max(5),
  clarity: z.number().int().min(1).max(5),
  naturalness: z.number().int().min(1).max(5),
  concision: z.number().int().min(1).max(5),
  structure: z.number().int().min(1).max(5),
  overall: z.number().int().min(1).max(5),
  rationale: z.string().describe("採点理由。具体的な箇所を引用して 200 字程度で"),
});

export const pairwiseSchema = z.object({
  verdict: z.enum(["A", "B", "tie"]).describe("より読みやすい方。ほぼ同等なら tie"),
  rationale: z.string().describe("判定理由。具体的な箇所を引用して 200 字程度で"),
});

export function rubricPrompt(args: { text: string; taskTitle: string; audience: string }): string {
  return `次の文章を採点してください。

課題: ${args.taskTitle}
想定読者: ${args.audience}

${RUBRIC_CRITERIA}

<text>
${escapeDelimiters(args.text)}
</text>`;
}

export function pairwisePrompt(args: { a: string; b: string; taskTitle: string; audience: string }): string {
  return `同じ課題に対する 2 つの文章 A と B を比べ、想定読者にとってどちらが読みやすく分かりやすいかを判定してください。
内容の正しさや情報量ではなく、日本語の文章としての品質（一文の長さ、読点、語彙、自然さ、簡潔さ、構成）で判断します。
提示順による先入観を持たず、明確な差がなければ tie としてください。

課題: ${args.taskTitle}
想定読者: ${args.audience}

<text_a>
${escapeDelimiters(args.a)}
</text_a>

<text_b>
${escapeDelimiters(args.b)}
</text_b>`;
}
