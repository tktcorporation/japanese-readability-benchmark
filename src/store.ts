import type { Judgment, Sample, ScoreRecord } from "./types.ts";
import { readJsonl, sha256 } from "./util/fs.ts";

/**
 * results/runs/<run>/ の JSONL を読む。
 *
 * すべて追記型なので、同じキーの記録が複数あれば後勝ちにする。
 * 採点・判定はサンプル本文のハッシュを持っており、`run --force` で
 * 本文が変わった記録は「陳腐化」として捨てる（再計算の対象になる）。
 */

export function loadSamples(path: string): Sample[] {
  const byId = new Map<string, Sample>();
  for (const s of readJsonl<Sample>(path)) byId.set(s.id, s);
  return Array.from(byId.values());
}

export function sampleHashes(samples: Sample[]): Map<string, string> {
  return new Map(samples.map((s) => [s.id, sha256(s.text)]));
}

function isCurrent(hashes: Map<string, string>, sampleId: string, recordHash: string | undefined): boolean {
  const current = hashes.get(sampleId);
  if (current === undefined) return false; // サンプル自体がない
  if (recordHash === undefined) return true; // 旧形式の記録は互換のため有効とみなす
  return current === recordHash;
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
      ? isCurrent(hashes, j.sampleId, j.textHash)
      : isCurrent(hashes, j.aSampleId, j.aTextHash) && isCurrent(hashes, j.bSampleId, j.bTextHash),
  );
}
