import { PAIRWISE_PROMPT_VERSION, RUBRIC_PROMPT_VERSION } from "./judge/prompts.ts";
import type { Judgment, Sample, ScoreRecord } from "./types.ts";
import { readJsonl, sha256 } from "./util/fs.ts";

/**
 * results/runs/<run>/ の JSONL を読む。
 *
 * すべて追記型なので、同じキーの記録が複数あれば後勝ちにする。
 * 採点・判定はサンプル本文のハッシュを持っており、次の記録は「陳腐化」として捨てる
 * （score / judge が再計算の対象にし、report には載らない）:
 *   - 対応するサンプルがない、または失敗している
 *   - 本文ハッシュが現在のサンプルと一致しない（`run --force` で再生成された）
 *   - 本文ハッシュを持っていない（鮮度を確かめられない）
 *   - 判定プロンプトの版が現在と異なる
 */

export interface LoadSamplesOptions {
  /** コーパス id → 現在の原文ハッシュ。渡すと、原文が変わった（または消えた）コーパス起点のサンプルを捨てる */
  corpusHashes?: Map<string, string>;
}

/**
 * 同じ id は後勝ち。次のサンプルは陳腐化として捨てる（run で選択されれば作り直され、report には載らない）:
 *   - 他の介入の出力を再利用したが、再利用元が失敗して存在しない、または本文が変わっている（連鎖は再帰的に辿る）
 *   - コーパス起点で、原文が編集された・削除された（corpusHashes を渡したとき）
 */
export function loadSamples(path: string, opts: LoadSamplesOptions = {}): Sample[] {
  const byId = new Map<string, Sample>();
  for (const s of readJsonl<Sample>(path)) byId.set(s.id, s);
  const hashes = sampleHashes(Array.from(byId.values()));
  const fresh = new Map<string, boolean>();
  const isFresh = (id: string, visiting = new Set<string>()): boolean => {
    const cached = fresh.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return false; // 循環は不正とみなす
    visiting.add(id);
    const s = byId.get(id);
    let result = true;
    if (s?.sourceType === "corpus" && opts.corpusHashes) {
      result = s.inputHash !== undefined && opts.corpusHashes.get(s.sourceId) === s.inputHash;
    }
    const reuse = s?.steps.find((st) => st.type === "generate" && st.reusedFrom);
    if (result && s && reuse?.reusedFrom && reuse.reusedHash) {
      // 再利用元が成功して存在し、記録したハッシュと一致し、かつ再利用元自身も新鮮なときだけ新鮮
      const current = hashes.get(reuse.reusedFrom);
      result = current !== undefined && current === reuse.reusedHash && isFresh(reuse.reusedFrom, visiting);
    }
    visiting.delete(id);
    fresh.set(id, result);
    return result;
  };
  return Array.from(byId.values()).filter((s) => isFresh(s.id));
}

/** 成功したサンプルだけが「現在の本文」を持つ。失敗した記録の本文（中間結果や空）は鮮度の根拠にしない */
export function sampleHashes(samples: Sample[]): Map<string, string> {
  return new Map(samples.filter((s) => !s.error).map((s) => [s.id, sha256(s.text)]));
}

function isCurrent(hashes: Map<string, string>, sampleId: string, recordHash: string | undefined): boolean {
  const current = hashes.get(sampleId);
  return current !== undefined && recordHash !== undefined && current === recordHash;
}

export function loadScores(path: string, samples: Sample[]): ScoreRecord[] {
  const hashes = sampleHashes(samples);
  const byId = new Map<string, ScoreRecord>();
  for (const r of readJsonl<ScoreRecord>(path)) byId.set(r.sampleId, r);
  return Array.from(byId.values()).filter((r) => isCurrent(hashes, r.sampleId, r.textHash));
}

export function judgmentKey(j: Judgment): string {
  return j.kind === "rubric"
    ? `rubric|${j.judgeModel}|${j.sampleId}`
    : `pairwise|${j.judgeModel}|${j.scheme}|${j.aSampleId}|${j.bSampleId}`;
}

export function loadJudgments(path: string, samples: Sample[]): Judgment[] {
  const hashes = sampleHashes(samples);
  const byKey = new Map<string, Judgment>();
  for (const j of readJsonl<Judgment>(path)) byKey.set(judgmentKey(j), j);
  return Array.from(byKey.values()).filter((j) =>
    j.kind === "rubric"
      ? j.promptVersion === RUBRIC_PROMPT_VERSION && isCurrent(hashes, j.sampleId, j.textHash)
      : j.promptVersion === PAIRWISE_PROMPT_VERSION &&
        isCurrent(hashes, j.aSampleId, j.aTextHash) &&
        isCurrent(hashes, j.bSampleId, j.bTextHash),
  );
}
