import { describe, expect, it } from "vitest";
import { loadModels } from "../src/config.ts";
import { buildPairs, combineVerdicts, contextHashOf, flipVerdict, judgeConfigHashOf, judgePairwise, judgeRubric } from "../src/judge/index.ts";
import { createProvider } from "../src/providers/index.ts";
import { loadFixture } from "../src/providers/mock.ts";
import type { Sample } from "../src/types.ts";

const { models } = loadModels();
const judge = createProvider(models.find((m) => m.id === "mock-plain")!);

function sample(over: Partial<Sample>): Sample {
  return {
    id: "s",
    runId: "t",
    sourceType: "task",
    sourceId: "oauth-explain",
    modelId: "m",
    interventionId: "baseline",
    sampleIndex: 0,
    text: "本文です。",
    steps: [],
    createdAt: "",
    ...over,
  };
}

describe("verdict の統合", () => {
  it("両順序で一致すればその判定、食い違えば tie", () => {
    expect(combineVerdicts("A", "A")).toBe("A");
    expect(combineVerdicts("B", "B")).toBe("B");
    expect(combineVerdicts("A", "B")).toBe("tie");
    expect(combineVerdicts("A", "tie")).toBe("tie");
    expect(combineVerdicts("tie", "tie")).toBe("tie");
  });
  it("flipVerdict は A/B を入れ替える", () => {
    expect(flipVerdict("A")).toBe("B");
    expect(flipVerdict("B")).toBe("A");
    expect(flipVerdict("tie")).toBe("tie");
  });
});

describe("buildPairs", () => {
  const samples: Sample[] = [
    sample({ id: "a-base", modelId: "m1", interventionId: "baseline" }),
    sample({ id: "a-x", modelId: "m1", interventionId: "x" }),
    sample({ id: "a-y", modelId: "m1", interventionId: "y" }),
    sample({ id: "b-base", modelId: "m2", interventionId: "baseline" }),
    sample({ id: "b-x", modelId: "m2", interventionId: "x", error: "boom" }),
    sample({ id: "c-base", modelId: "m3", interventionId: "baseline", sourceId: "other" }),
  ];
  it("interventions: 同じモデルの baseline と組む（エラーは除外）", () => {
    const pairs = buildPairs(samples, "interventions", "baseline");
    expect(pairs.map((p) => [p.a.id, p.b.id])).toEqual([
      ["a-x", "a-base"],
      ["a-y", "a-base"],
    ]);
  });
  it("models: 同じ source の baseline 同士を総当たり", () => {
    const pairs = buildPairs(samples, "models", "baseline");
    expect(pairs.map((p) => [p.a.id, p.b.id])).toEqual([["a-base", "b-base"]]);
  });
  it("コーパス起点（modelId=none の baseline）とも組める", () => {
    const corpus: Sample[] = [
      sample({ id: "orig", modelId: "none", interventionId: "baseline", sourceType: "corpus" }),
      sample({ id: "lint", modelId: "none", interventionId: "textlint-fix", sourceType: "corpus" }),
      sample({ id: "rw", modelId: "m1", interventionId: "rewrite-pass", sourceType: "corpus" }),
    ];
    const pairs = buildPairs(corpus, "interventions", "baseline");
    expect(pairs.map((p) => [p.a.id, p.b.id])).toEqual([
      ["lint", "orig"],
      ["rw", "orig"],
    ]);
  });
});

describe("mock judge", () => {
  const plain = sample({ id: "p", text: loadFixture("plain").get("oauth-explain")! });
  const verbose = sample({ id: "v", text: loadFixture("verbose").get("oauth-explain")! });
  const src = { id: "oauth-explain", title: "OAuth" };

  it("rubric は 1-5 の整数を返す", async () => {
    const j = await judgeRubric(plain, src, { provider: judge });
    expect(j.kind).toBe("rubric");
    expect(j.contextHash).toBe(contextHashOf(src));
    expect(contextHashOf(src)).not.toBe(contextHashOf({ ...src, audience: "新人" }));
    expect(j.judgeConfigHash).toBe(judgeConfigHashOf(judge.model));
    // id とラベルは同じでも、具体的な設定が変われば別の判定者
    expect(judgeConfigHashOf({ ...judge.model, model: "other" })).not.toBe(judgeConfigHashOf(judge.model));
    expect(judgeConfigHashOf({ ...judge.model, label: "別名" })).toBe(judgeConfigHashOf(judge.model));
    for (const v of Object.values(j.scores)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(5);
    }
  });
  it("同じ入力の判定が同時に走っても判定モデルは 1 回しか呼ばれない", async () => {
    let calls = 0;
    const counting = {
      model: judge.model,
      generate: judge.generate.bind(judge),
      generateJson: async <T,>(...args: Parameters<typeof judge.generateJson<T>>) => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return judge.generateJson<T>(...args);
      },
    };
    const twin = { ...plain, id: "p2" }; // 本文が同じ別サンプル
    const j = await judgePairwise(plain, twin, { id: "same", title: "同一" }, "interventions", { provider: counting });
    expect(j.verdict).toBe("tie");
    expect(calls).toBe(1); // A先・B先のキーが同じなので 1 回に束ねられる
    calls = 0;
    await Promise.all([judgeRubric(plain, { id: "same", title: "同一" }, { provider: counting }), judgeRubric(twin, { id: "same", title: "同一" }, { provider: counting })]);
    expect(calls).toBe(1);
  });
  it("pairwise は順序を入れ替えても同じ勝者を返す", async () => {
    const j = await judgePairwise(plain, verbose, src, "models", { provider: judge });
    expect(j.verdict).toBe("A");
    expect(j.verdictAB).toBe("A");
    expect(j.verdictBA).toBe("A");
    const r = await judgePairwise(verbose, plain, src, "models", { provider: judge });
    expect(r.verdict).toBe("B");
  });
});
