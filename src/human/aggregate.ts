import type { HumanPair, HumanVote, PairVerdict } from "../types.ts";
import { round } from "../util/async.ts";
import { majority } from "../report/aggregate.ts";

export interface HumanSummary {
  pairs: number;
  votes: number;
  raters: number;
  /** 2 人以上が答えたペアのうち、全員の判定が一致した割合 */
  interRaterAgreement?: { pairs: number; agree: number; rate: number };
  perPair: { pairId: string; votes: number; verdict: PairVerdict; a: number; b: number; tie: number }[];
  medianSeconds?: number;
}

export function summarizeVotes(pairs: HumanPair[], allVotes: HumanVote[]): HumanSummary {
  // 現在の pairs にあるペアへの投票だけを数える（作り直す前の古いペア ID は無視）
  const pairIds = new Set(pairs.map((p) => p.id));
  const votes = allVotes.filter((v) => pairIds.has(v.pairId));
  const byPair = new Map<string, HumanVote[]>();
  for (const v of votes) byPair.set(v.pairId, [...(byPair.get(v.pairId) ?? []), v]);
  const perPair: HumanSummary["perPair"] = [];
  let multi = 0;
  let agree = 0;
  for (const p of pairs) {
    const vs = byPair.get(p.id) ?? [];
    if (!vs.length) continue;
    const choices = vs.map((v) => v.choice);
    const count = { A: 0, B: 0, tie: 0 };
    for (const c of choices) count[c] += 1;
    perPair.push({ pairId: p.id, votes: vs.length, verdict: majority(choices), a: count.A, b: count.B, tie: count.tie });
    if (vs.length >= 2) {
      multi += 1;
      if (new Set(choices).size === 1) agree += 1;
    }
  }
  const secs = votes.map((v) => v.seconds).filter((s): s is number => typeof s === "number").sort((a, b) => a - b);
  return {
    pairs: pairs.length,
    votes: votes.length,
    raters: new Set(votes.map((v) => v.raterId)).size,
    interRaterAgreement: multi ? { pairs: multi, agree, rate: round(agree / multi, 3) } : undefined,
    perPair,
    medianSeconds: secs.length ? secs[Math.floor(secs.length / 2)] : undefined,
  };
}
