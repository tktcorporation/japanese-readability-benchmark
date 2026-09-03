import type { HumanPair, HumanVote } from "../types.ts";
import { seededRandom } from "../util/async.ts";
import { sha256 } from "../util/fs.ts";

/**
 * 評価者に出すペアを決める。
 * - その評価者が回答済みのペアは除く
 * - 投票が少ないペアを優先する（評価者を増やせば末尾のペアにも票が集まる）
 * - 同じ投票数の中では評価者ごとに決定的にシャッフルする（全員が同じ先頭を見ない）
 * - perRater があれば、回答済み件数を差し引いた残りの割り当てだけ返す
 */
export function assignPairs(pairs: HumanPair[], votes: HumanVote[], raterId: string, perRater?: number): { remaining: HumanPair[]; assigned: HumanPair[] } {
  const ids = new Set(pairs.map((p) => p.id));
  const current = votes.filter((v) => ids.has(v.pairId));
  const answered = new Set(current.filter((v) => v.raterId === raterId).map((v) => v.pairId));
  const counts = new Map<string, number>();
  for (const v of current) counts.set(v.pairId, (counts.get(v.pairId) ?? 0) + 1);

  const rand = seededRandom(Number.parseInt(sha256("rater", raterId).slice(0, 8), 16));
  const order = new Map(pairs.map((p) => [p.id, rand()]));
  const remaining = pairs
    .filter((p) => !answered.has(p.id))
    .sort((a, b) => (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const allowance = perRater === undefined ? remaining.length : Math.max(0, perRater - answered.size);
  return { remaining, assigned: remaining.slice(0, allowance) };
}
