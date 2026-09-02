import { describe, expect, it } from "vitest";
import { idSchema, loadCorpus, loadInterventions, loadModels, loadTasks, parseCorpusDoc } from "../src/config.ts";
import { surfaceMetrics } from "../src/metrics/surface.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusSource, dependentsOf, needsModelForCorpus, provenanceHash, renderTemplate, reuseLevels, reusesIntervention, runCell, sampleId, sourceHash, taskSource } from "../src/pipeline/run.ts";
import type { InterventionDef, Sample } from "../src/types.ts";

const { models } = loadModels();
const interventions = loadInterventions();
const byId = (id: string) => interventions.find((i) => i.id === id)!;
const mockVerbose = models.find((m) => m.id === "mock-verbose")!;
const task = taskSource(loadTasks()[0]!);

/** run と同じく、生成済みサンプルを reuse の参照先にする */
const store = new Map<string, Sample>();
const opts = {
  runId: "t",
  allModels: models,
  lookup: (sourceId: string, modelId: string, interventionId: string, index: number) => store.get(sampleId(sourceId, modelId, interventionId, index)),
};
async function run(source: Parameters<typeof runCell>[0], model: Parameters<typeof runCell>[1], interventionId: string) {
  const s = await runCell(source, model, byId(interventionId), 0, opts);
  if (!s.error) store.set(s.id, s);
  return s;
}

describe("config", () => {
  it("リポジトリ内の定義がすべて読み込める", () => {
    expect(loadTasks().length).toBeGreaterThanOrEqual(8);
    expect(loadCorpus().length).toBeGreaterThanOrEqual(3);
    expect(models.length).toBeGreaterThan(2);
    expect(interventions.map((i) => i.id)).toContain("baseline");
    // id の重複がない
    for (const list of [loadTasks(), loadCorpus(), models, interventions]) {
      expect(new Set(list.map((x) => x.id)).size).toBe(list.length);
    }
  });
  it("frontmatter 付き Markdown を解釈する（CRLF でも）", () => {
    const doc = parseCorpusDoc("---\nid: x\ntitle: タイトル\n---\n本文。", "fallback");
    expect(doc).toMatchObject({ id: "x", title: "タイトル", text: "本文。" });
    expect(parseCorpusDoc("本文だけ", "fb")).toMatchObject({ id: "fb", text: "本文だけ" });
    const crlf = parseCorpusDoc("---\r\nid: y\r\ntitle: 題\r\naudience: 読者\r\n---\r\n本文。\r\n", "fallback");
    expect(crlf).toMatchObject({ id: "y", title: "題", audience: "読者", text: "本文。" });
  });
  it("id は英数字と _ . + - に限り、__ を含まない（サンプル id の区切りと衝突しない）", () => {
    for (const ok of ["baseline", "style-prompt+textlint", "fable-5.1", "gpt_5"]) expect(idSchema.safeParse(ok).success).toBe(true);
    for (const ng of ["日本語", "a__b", "-lead", "has space", "", "a/b"]) expect(idSchema.safeParse(ng).success).toBe(false);
    expect(() => parseCorpusDoc("---\nid: 規程\n---\n本文", "fb")).toThrow();
    // 変換なしで連結するので、+ を含む id も一意のまま
    expect(sampleId("t", "m", "style-prompt+textlint", 0)).toBe("t__m__style-prompt+textlint__0");
  });
  it("renderTemplate は {{var}} を展開する", () => {
    expect(renderTemplate("A {{ text }} B {{audience}} {{none}}", { text: "x", audience: "y" })).toBe("A x B y ");
  });
});

describe("reuseLevels", () => {
  const def = (id: string, reuse?: string): InterventionDef => ({
    id,
    name: id,
    dir: "",
    steps: [{ type: "generate", ...(reuse ? { reuse } : {}) }],
  });
  it("reuse の連鎖を深さごとの段階に分ける", () => {
    const levels = reuseLevels([def("c", "b"), def("a"), def("b", "a"), def("d", "a")]);
    expect(levels.map((l) => l.map((i) => i.id).sort())).toEqual([["a"], ["b", "d"], ["c"]]);
  });
  it("選択されていない介入を参照する場合は段階 1（既存サンプルに頼る）", () => {
    const levels = reuseLevels([def("x", "baseline")]);
    expect(levels.map((l) => l.map((i) => i.id))).toEqual([[], ["x"]]);
  });
  it("循環参照はエラー", () => {
    expect(() => reuseLevels([def("a", "b"), def("b", "a")])).toThrow("循環");
    expect(() => reuseLevels([def("a", "a")])).toThrow("循環");
  });
  it("dependentsOf は推移的に依存する介入を返す", () => {
    const all = [def("a"), def("b", "a"), def("c", "b"), def("d"), def("e", "d")];
    expect(dependentsOf("a", all).map((i) => i.id)).toEqual(["b", "c"]);
    expect(dependentsOf("d", all).map((i) => i.id)).toEqual(["e"]);
    expect(dependentsOf("c", all)).toEqual([]);
    expect(dependentsOf("baseline", interventions).map((i) => i.id).sort()).toEqual(["rewrite-pass", "textlint-fix"]);
  });
  it("同梱の介入は baseline → 後処理 の 2 段階", () => {
    const levels = reuseLevels(interventions);
    expect(levels[0]!.map((i) => i.id)).toContain("baseline");
    expect(levels[1]!.map((i) => i.id).sort()).toEqual(["rewrite-pass", "textlint-fix"]);
  });
});

describe("runCell (mock)", () => {
  it("baseline はフィクスチャをそのまま返す", async () => {
    const s = await run(task, mockVerbose, "baseline");
    expect(s.error).toBeUndefined();
    expect(s.id).toBe(sampleId(task.id, "mock-verbose", "baseline", 0));
    expect(s.text.length).toBeGreaterThan(100);
    expect(s.steps.map((x) => x.type)).toEqual(["generate"]);
    expect(s.inputText).toBeUndefined();
  });
  it("後処理だけの介入は baseline の出力を再利用する（生成し直さない）", async () => {
    const base = await run(task, mockVerbose, "baseline");
    const s = await run(task, mockVerbose, "textlint-fix");
    expect(s.error).toBeUndefined();
    expect(s.steps[0]).toMatchObject({ type: "generate", reusedFrom: base.id });
    expect(s.steps[0]!.reusedHash).toHaveLength(64);
    expect(reusesIntervention(byId("textlint-fix"))).toBe("baseline");
    expect(reusesIntervention(byId("baseline"))).toBeUndefined();
    expect(reusesIntervention(byId("style-prompt"))).toBeUndefined();
  });
  it("再利用先の baseline がなければエラーとして記録する", async () => {
    const s = await runCell(task, mockVerbose, byId("textlint-fix"), 7, opts);
    expect(s.error).toContain("baseline");
  });
  it("rewrite-pass は文を短くし、介入前の文章を inputText に残す", async () => {
    const base = await run(task, mockVerbose, "baseline");
    const s = await run(task, mockVerbose, "rewrite-pass");
    expect(s.error).toBeUndefined();
    expect(s.inputText).toBe(base.text);
    const [b, a] = await Promise.all([surfaceMetrics(base.text), surfaceMetrics(s.text)]);
    expect(a.meanSentenceLength).toBeLessThan(b.meanSentenceLength);
  });
  it("textlint-fix は applied/remaining を記録する", async () => {
    await run(task, mockVerbose, "baseline");
    const s = await run(task, mockVerbose, "textlint-fix");
    expect(s.error).toBeUndefined();
    const fix = s.steps.find((x) => x.type === "textlint-fix")!;
    expect(fix.applied).toBeGreaterThanOrEqual(0);
    expect(fix.remaining).toBeGreaterThanOrEqual(0);
  });
  it("コーパス起点では generate を飛ばし、原文から始める", async () => {
    const doc = loadCorpus()[0]!;
    const corpus = corpusSource(doc);
    const base = await run(corpus, undefined, "baseline");
    expect(base.error).toBeUndefined();
    expect(base.text).toBe(doc.text);
    expect(base.modelId).toBe("none");
    expect(base.steps[0]).toMatchObject({ type: "generate", skipped: true });
    expect(base.inputHash).toHaveLength(64);

    const rewritten = await run(corpus, mockVerbose, "rewrite-pass");
    expect(rewritten.error).toBeUndefined();
    expect(rewritten.text).not.toBe(doc.text);
    expect(rewritten.inputText).toBe(doc.text);
    // reuse: baseline は原文（"none" のセル）を参照し、その本文ハッシュを記録する
    expect(rewritten.steps[0]).toMatchObject({ type: "generate", reusedFrom: base.id });
  });
  it("コーパス起点でも reuse は原文ではなく参照先の出力から始める", async () => {
    const doc = loadCorpus()[0]!;
    const corpus = corpusSource(doc);
    await run(corpus, undefined, "baseline");
    const fixed = await run(corpus, undefined, "textlint-fix");
    const chained: InterventionDef = {
      id: "after-fix",
      name: "textlint-fix の出力を書き直す",
      dir: byId("rewrite-pass").dir,
      steps: [{ type: "generate", reuse: "textlint-fix" }, { type: "rewrite", prompt: "prompts/rewrite.md" }],
    };
    const s = await runCell(corpus, mockVerbose, chained, 0, opts);
    expect(s.error).toBeUndefined();
    expect(s.steps[0]).toMatchObject({ type: "generate", reusedFrom: fixed.id });
    expect(s.inputText).toBe(fixed.text);
  });
  it("サンプルは生成来歴のハッシュを持ち、入力・モデル設定・介入定義・参照プロンプトのどれを変えても変わる", async () => {
    const s = await run(task, mockVerbose, "baseline");
    const base = provenanceHash(task, mockVerbose, byId("baseline"), models);
    expect(s.inputHash).toBe(base);
    // 入力
    expect(provenanceHash(taskSource({ ...loadTasks()[0]!, prompt: "別の指示" }), mockVerbose, byId("baseline"), models)).not.toBe(base);
    expect(sourceHash(task)).not.toBe(sourceHash(taskSource({ ...loadTasks()[0]!, prompt: "別の指示" })));
    // 想定読者（rewrite テンプレートに入る）
    expect(provenanceHash({ ...task, audience: "別の読者" }, mockVerbose, byId("baseline"), models)).not.toBe(base);
    // モデル設定（id は同じ）
    expect(provenanceHash(task, { ...mockVerbose, mockStyle: "plain" }, byId("baseline"), models)).not.toBe(base);
    // 介入定義
    expect(provenanceHash(task, mockVerbose, byId("style-prompt"), models)).not.toBe(base);
    // 参照プロンプトファイルの内容
    const sp = byId("style-prompt");
    const withPrompt = provenanceHash(task, mockVerbose, sp, models);
    const tmp = mkdtempSync(join(tmpdir(), "jrb-prov-"));
    try {
      mkdirSync(join(tmp, "prompts"));
      writeFileSync(join(tmp, "prompts", "style-guide.md"), "別のルール");
      expect(provenanceHash(task, mockVerbose, { ...sp, dir: tmp }, models)).not.toBe(withPrompt);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    // textlint-fix が config 省略時に使う既定の .textlintrc.json の内容
    const tf = byId("textlint-fix");
    const withDefault = provenanceHash(task, mockVerbose, tf, models);
    const tmp2 = mkdtempSync(join(tmpdir(), "jrb-prov2-"));
    try {
      writeFileSync(join(tmp2, "custom.textlintrc.json"), JSON.stringify({ rules: {} }));
      const explicit: InterventionDef = { ...tf, dir: tmp2, steps: tf.steps.map((st) => (st.type === "textlint-fix" ? { ...st, config: "custom.textlintrc.json" } : st)) };
      expect(provenanceHash(task, mockVerbose, explicit, models)).not.toBe(withDefault);
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
    // rewrite ステップが明示するモデルの設定
    const rp = byId("rewrite-pass");
    const pinned: InterventionDef = { ...rp, steps: rp.steps.map((st) => (st.type === "rewrite" ? { ...st, model: "mock-plain" } : st)) };
    const h1 = provenanceHash(task, mockVerbose, pinned, models);
    const h2 = provenanceHash(task, mockVerbose, pinned, models.map((m) => (m.id === "mock-plain" ? { ...m, mockStyle: "verbose" } : m)));
    expect(h1).not.toBe(h2);
  });
  it("needsModelForCorpus はモデル未指定の rewrite があるときだけ true", () => {
    expect(needsModelForCorpus(byId("baseline"))).toBe(false);
    expect(needsModelForCorpus(byId("textlint-fix"))).toBe(false);
    expect(needsModelForCorpus(byId("rewrite-pass"))).toBe(true);
  });
  it("本文が空なら成功サンプルにせずエラーとして記録する", async () => {
    const empty = corpusSource({ id: "empty", title: "空", text: "   \n" });
    const s = await run(empty, undefined, "baseline");
    expect(s.error).toContain("空");
  });
  it("モデルなしでタスクを実行するとエラーとして記録する", async () => {
    const s = await runCell(task, undefined, byId("baseline"), 0, opts);
    expect(s.error).toContain("モデル");
  });
});
