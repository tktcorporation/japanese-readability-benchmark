import { describe, expect, it } from "vitest";
import { assignPairs } from "../src/human/assign.ts";
import type { HumanPair, HumanVote } from "../src/types.ts";

const pairs: HumanPair[] = Array.from({ length: 6 }, (_, i) => ({
  id: `p${i}`,
  sourceId: "t",
  scheme: "interventions",
  aSampleId: `a${i}`,
  bSampleId: `b${i}`,
  aText: "A",
  bText: "B",
  taskTitle: "課題",
}));
const vote = (pairId: string, raterId: string): HumanVote => ({ pairId, choice: "A", leftWasA: true, raterId, createdAt: "" });

describe("assignPairs", () => {
  it("回答済みを除き、上限は回答済み件数を差し引いて適用する", () => {
    const r = assignPairs(pairs, [vote("p0", "r1"), vote("p1", "r1")], "r1", 3);
    expect(r.remaining).toHaveLength(4);
    expect(r.assigned).toHaveLength(1);
    expect(assignPairs(pairs, [vote("p0", "r1")], "r1").assigned).toHaveLength(5);
  });
  it("評価者ごとに順序が違い、同じ評価者なら決定的", () => {
    const a1 = assignPairs(pairs, [], "alice").assigned.map((p) => p.id);
    const a2 = assignPairs(pairs, [], "alice").assigned.map((p) => p.id);
    const b = assignPairs(pairs, [], "bob").assigned.map((p) => p.id);
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
    expect([...a1].sort()).toEqual([...b].sort());
  });
  it("投票が少ないペアを優先するので、上限付きでも評価者を増やせば全ペアに票が集まる", () => {
    const votes: HumanVote[] = [];
    for (let i = 0; i < 6; i += 1) {
      const rater = `r${i}`;
      for (const p of assignPairs(pairs, votes, rater, 2).assigned) votes.push(vote(p.id, rater));
    }
    const counts = new Map<string, number>();
    for (const v of votes) counts.set(v.pairId, (counts.get(v.pairId) ?? 0) + 1);
    expect(counts.size).toBe(6);
    expect(Array.from(counts.values()).every((c) => c === 2)).toBe(true);
  });
  it("作り直す前の古いペアへの投票は数えない", () => {
    const r = assignPairs(pairs, [vote("old", "r1"), vote("old2", "r1")], "r1", 2);
    expect(r.assigned).toHaveLength(2);
  });
});
