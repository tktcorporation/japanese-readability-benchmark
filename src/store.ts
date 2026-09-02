import { PAIRWISE_PROMPT_VERSION, RUBRIC_PROMPT_VERSION } from "./judge/prompts.ts";
import type { Judgment, Sample, ScoreRecord } from "./types.ts";
import { readJsonl, sha256 } from "./util/fs.ts";

/**
 * results/runs/<run>/ の JSONL を読む。
 *
 * すべて追記型なので、同じキーの記録が複数あれば後勝ちにする。
 * 採点・判定はサンプル本文のハッシュを持っており、次の記録は「陳腐化」として捨てる
 * （score / judge が再計算の対象にし、report には載らない）:
 *   - 対応するサンプルがない
 *   - 本文ハッシュが現在のサンプルと一致しない（`run --force` で再生成された）
 *   - 本文ハッシュを持っていない（鮮度を確かめられない）
 *   - 判定プロンプトの版が現在と異なる
 */

/**
 * 同じ id は後勝ち。他の介入の出力を再利用したサンプルは、再利用元が作り直されて本文が変わっていたら
 * 陳腐化として捨てる（run で選択されれば作り直され、report には載らない）。
 */
export function loadSamples(path: string): Sample[] {
  const byId = new Map<string, Sample>();
  for (const s of readJsonl<Sample>(path)) byId.set(s.id, s);
  const hashes = sampleHashes(Array.from(byId.values()));
  // 再利用元が新鮮で、かつ記録したハッシュと一致するときだけ新鮮。連鎖（C→B→A）は再帰的に辿る
  const fresh = new Map<string, boolean>();
  const isFresh = (id: string, visiting = new Set<string>()): boolean => {
    const cached = fresh.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return false; // 循環は不正とみなす
    visiting.add(id);
    const s = byId.get(id);
    let result = true;
    const reuse = s?.steps.find((st) => st.type === "generate" && st.reusedFrom);
    if (s && reuse?.reusedFrom && reuse.reusedHash) {
      const current = hashes.get(reuse.reusedFrom);
      result = current === undefined || (current === reuse.reusedHash && isFresh(reuse.reusedFrom, visiting));
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
