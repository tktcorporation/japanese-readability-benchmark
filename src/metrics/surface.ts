import { tokenize, type KuromojiToken } from "kuromojin";
import { paragraphs, splitSentences, stripMarkdown } from "./sentences.ts";

/**
 * 形態素解析（kuromoji / IPADIC）に基づく表層指標。
 *
 * jReadability は Lee & Hasebe (2016) の式:
 *   11.724 - 0.056*平均文長 - 0.126*漢語率 - 0.042*和語率 - 0.145*動詞率 - 0.044*助詞率
 * 値が大きいほど易しい（6.5-5.5 初級前半 / 4.4-3.5 中級前半 / 2.4-1.5 上級前半 / 1.4-0.5 上級後半）。
 * 一文が極端に長いと式の外挿で負の値になる。
 *
 * 本来は UniDic の「語種」を使うが、IPADIC には語種情報がないため次の近似を使う:
 *   漢語 = 漢字のみ 2 文字以上の名詞、またはサ変接続名詞
 *   外来語 = カタカナのみ / 英字のみ の語（漢語にも和語にも数えない）
 *   和語 = 記号・数を除いたそれ以外
 * 絶対値は本家と少しずれるが、同一条件での相対比較には使える。
 */

export interface SurfaceMetrics {
  chars: number;
  sentences: number;
  paragraphs: number;
  meanSentenceLength: number;
  maxSentenceLength: number;
  /** 60 文字超の文の割合 */
  longSentenceRatio: number;
  /** 100 文字超の文の割合 */
  veryLongSentenceRatio: number;
  /** 1 文あたりの読点数 */
  tenPerSentence: number;
  /** 読点が 4 つ以上ある文の割合 */
  manyTenRatio: number;
  kanjiRatio: number;
  hiraganaRatio: number;
  katakanaRatio: number;
  latinRatio: number;
  /** 最長の漢字連続 */
  maxKanjiRun: number;
  tokens: number;
  tokensPerSentence: number;
  typeTokenRatio: number;
  kangoRatio: number;
  wagoRatio: number;
  verbRatio: number;
  particleRatio: number;
  jreadability: number;
  /** 「れる/られる」（受け身・可能・尊敬）の 1 文あたり出現数 */
  rareruPerSentence: number;
  /** 「こと」「という」「もの」などの名詞化・迂言表現の 1000 文字あたり出現数 */
  nominalizationPer1k: number;
  /** 箇条書き行数 */
  listLines: number;
  headings: number;
}

const KANJI = /[一-鿿㐀-䶿々]/;
const HIRAGANA = /[぀-ゟ]/;
const KATAKANA = /[゠-ヿー]/;
const LATIN = /[A-Za-z]/;
const ALL_KANJI = /^[一-鿿㐀-䶿々]+$/;
const ALL_KATAKANA = /^[゠-ヿー]+$/;
const ALL_LATIN = /^[A-Za-z0-9]+$/;

const NOMINALIZATION = /こと(が|を|は|に|も|で)|という|というもの|ものである|ものです|ことができ|を行(う|い|っ)|において|における|に関して|に対して/g;

export function classifyGoshu(t: KuromojiToken): "kango" | "wago" | "gairaigo" | "other" {
  const pos = t.pos;
  const surface = t.surface_form;
  if (pos === "記号" || pos === "フィラー" || pos === "その他") return "other";
  if (/^[0-9０-９.,]+$/.test(surface)) return "other";
  if (ALL_KATAKANA.test(surface) || ALL_LATIN.test(surface)) return "gairaigo";
  if (pos === "名詞" && t.pos_detail_1 === "数") return ALL_KANJI.test(surface) ? "kango" : "other";
  if (pos === "名詞" || pos === "接頭詞") {
    if (t.pos_detail_1 === "サ変接続") return "kango";
    if (ALL_KANJI.test(surface) && surface.length >= 2) return "kango";
    return "wago";
  }
  return "wago";
}

function maxRun(text: string, re: RegExp): number {
  let best = 0;
  let cur = 0;
  for (const ch of text) {
    if (re.test(ch)) {
      cur += 1;
      if (cur > best) best = cur;
    } else cur = 0;
  }
  return best;
}

export async function surfaceMetrics(text: string): Promise<SurfaceMetrics> {
  const plain = stripMarkdown(text);
  const sentences = splitSentences(text);
  const body = plain.replace(/\s+/g, "");
  const chars = body.length;
  const lens = sentences.map((s) => s.replace(/\s+/g, "").length);
  const n = sentences.length || 1;

  let kanji = 0;
  let hira = 0;
  let kata = 0;
  let latin = 0;
  for (const ch of body) {
    if (KANJI.test(ch)) kanji += 1;
    else if (HIRAGANA.test(ch)) hira += 1;
    else if (KATAKANA.test(ch)) kata += 1;
    else if (LATIN.test(ch)) latin += 1;
  }

  const tokens = (await tokenize(plain)).filter((t) => t.pos !== "記号" && t.surface_form.trim().length > 0);
  const total = tokens.length || 1;
  let kango = 0;
  let wago = 0;
  let verbs = 0;
  let particles = 0;
  let rareru = 0;
  const types = new Set<string>();
  for (const t of tokens) {
    types.add(t.basic_form === "*" ? t.surface_form : t.basic_form);
    const g = classifyGoshu(t);
    if (g === "kango") kango += 1;
    else if (g === "wago") wago += 1;
    if (t.pos === "動詞") verbs += 1;
    if (t.pos === "助詞") particles += 1;
    if (t.pos === "動詞" && t.pos_detail_1 === "接尾" && (t.basic_form === "れる" || t.basic_form === "られる")) rareru += 1;
  }
  const kangoPct = (kango / total) * 100;
  const wagoPct = (wago / total) * 100;
  const verbPct = (verbs / total) * 100;
  const particlePct = (particles / total) * 100;
  const meanLen = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const jreadability = 11.724 - 0.056 * meanLen - 0.126 * kangoPct - 0.042 * wagoPct - 0.145 * verbPct - 0.044 * particlePct;

  const tenCounts = sentences.map((s) => s.match(/、/g)?.length ?? 0);
  const nominalizations = (plain.match(NOMINALIZATION) ?? []).length;

  return {
    chars,
    sentences: sentences.length,
    paragraphs: paragraphs(text).length,
    meanSentenceLength: meanLen,
    maxSentenceLength: lens.length ? Math.max(...lens) : 0,
    longSentenceRatio: lens.filter((l) => l > 60).length / n,
    veryLongSentenceRatio: lens.filter((l) => l > 100).length / n,
    tenPerSentence: tenCounts.reduce((a, b) => a + b, 0) / n,
    manyTenRatio: tenCounts.filter((c) => c >= 4).length / n,
    kanjiRatio: chars ? kanji / chars : 0,
    hiraganaRatio: chars ? hira / chars : 0,
    katakanaRatio: chars ? kata / chars : 0,
    latinRatio: chars ? latin / chars : 0,
    maxKanjiRun: maxRun(body, KANJI),
    tokens: tokens.length,
    tokensPerSentence: tokens.length / n,
    typeTokenRatio: tokens.length ? types.size / tokens.length : 0,
    kangoRatio: kangoPct / 100,
    wagoRatio: wagoPct / 100,
    verbRatio: verbPct / 100,
    particleRatio: particlePct / 100,
    jreadability,
    rareruPerSentence: rareru / n,
    nominalizationPer1k: chars ? (nominalizations / chars) * 1000 : 0,
    listLines: (text.match(/^\s*([-*+]|\d+[.)])\s+/gm) ?? []).length,
    headings: (text.match(/^\s{0,3}#{1,6}\s+/gm) ?? []).length,
  };
}
