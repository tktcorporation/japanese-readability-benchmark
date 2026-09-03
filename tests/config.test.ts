import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertRewriteModels, assertRewriteTemplates, assertUniqueIds, loadAllSources, loadCorpus, loadInterventions, loadModels, loadTasks } from "../src/config.ts";

const root = mkdtempSync(join(tmpdir(), "jrb-config-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function dirWith(name: string, files: Record<string, string>): string {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  for (const [f, content] of Object.entries(files)) writeFileSync(join(d, f), content);
  return d;
}

const TASK = "id: t1\ncategory: c\ntitle: 題\nprompt: 書いて\n";

describe("設定の検証", () => {
  it("同じ id のタスクが 2 ファイルあれば読み込み時にエラー", () => {
    expect(() => loadTasks(dirWith("dup-tasks", { "a.yaml": TASK, "b.yaml": TASK }))).toThrow("重複");
    expect(() => assertUniqueIds([{ id: "x" }, { id: "x" }], "モデル")).toThrow('モデルの id "x"');
    expect(assertUniqueIds([{ id: "x" }, { id: "y" }], "モデル")).toHaveLength(2);
  });
  it("同じ id のコーパスが 2 ファイルあれば読み込み時にエラー", () => {
    const d = dirWith("dup-corpus", {
      "a.md": "---\nid: same\ntitle: A\n---\n本文A",
      "b.md": "---\nid: same\ntitle: B\n---\n本文B",
    });
    expect(() => loadCorpus(d)).toThrow("重複");
  });
  it("介入定義に知らないキー（綴り間違い）があれば読み込み時にエラー", () => {
    expect(() => loadInterventions(dirWith("typo-step", { "x.yaml": "id: x\nname: t\nsteps:\n  - type: generate\n    resue: baseline\n" }))).toThrow();
    expect(() => loadInterventions(dirWith("typo-top", { "x.yaml": "id: x\nname: t\nextra: 1\nsteps:\n  - type: generate\n" }))).toThrow();
    const base = "id: baseline\nname: b\nsteps:\n  - type: generate\n";
    expect(loadInterventions(dirWith("ok", { "baseline.yaml": base, "x.yaml": "id: x\nname: t\nsteps:\n  - type: generate\n    reuse: baseline\n" }))).toHaveLength(2);
  });
  it("reuse 先の介入が存在しない（綴り間違い）・自分自身なら読み込み時にエラー", () => {
    const base = "id: baseline\nname: b\nsteps:\n  - type: generate\n";
    expect(() => loadInterventions(dirWith("reuse-typo", { "baseline.yaml": base, "x.yaml": "id: x\nname: t\nsteps:\n  - type: generate\n    reuse: basline\n" }))).toThrow('reuse 先 "basline"');
    expect(() => loadInterventions(dirWith("reuse-self", { "x.yaml": "id: x\nname: t\nsteps:\n  - type: generate\n    reuse: x\n" }))).toThrow("自分自身");
    expect(loadInterventions().length).toBeGreaterThan(0); // 同梱の定義は整合している
  });
  it('モデル id に予約語 "none" は使えない', () => {
    const models = (id: string) => `models:\n  - id: ${id}\n    provider: mock\n    model: x\njudge:\n  model: ${id}\n`;
    const d = dirWith("reserved-model", { "none.yaml": models("none"), "ok.yaml": models("mock-x") });
    expect(() => loadModels(join(d, "none.yaml"))).toThrow("予約");
    expect(loadModels(join(d, "ok.yaml")).models.map((m) => m.id)).toEqual(["mock-x"]);
  });
  it("rewrite ステップの model が models.yaml に無ければ実行前にエラー", () => {
    const rewrite = (model?: string) => [{ id: "rw", steps: [{ type: "rewrite" as const, prompt: "p.md", ...(model ? { model } : {}) }] }];
    const models = [{ id: "mock-plain" }];
    expect(() => assertRewriteModels(rewrite("opus-5x"), models)).toThrow('model "opus-5x"');
    expect(assertRewriteModels(rewrite("mock-plain"), models)).toHaveLength(1);
    expect(assertRewriteModels(rewrite(), models)).toHaveLength(1); // 省略時はセルのモデルを使う
    expect(assertRewriteModels(loadInterventions(), loadModels().models).length).toBeGreaterThan(0); // 同梱の定義は整合している
  });
  it("rewrite テンプレートは存在し {{text}} を含まなければ読み込み時にエラー", () => {
    const d = dirWith("rewrite-templates", { "ok.md": "書き直して:\n{{ text }}", "no-text.md": "書き直して: {{txet}}" });
    const def = (prompt: string) => [{ id: "rw", dir: d, steps: [{ type: "rewrite" as const, prompt }] }];
    expect(assertRewriteTemplates(def("ok.md"))).toHaveLength(1);
    expect(() => assertRewriteTemplates(def("no-text.md"))).toThrow("{{text}} がありません");
    expect(() => assertRewriteTemplates(def("missing.md"))).toThrow("見つかりません");
    expect(loadInterventions().length).toBeGreaterThan(0); // 同梱のテンプレートは {{text}} を含む
  });
  it("同梱のタスクとコーパスは id がまたがって重複しない", () => {
    const { tasks, corpus } = loadAllSources();
    expect(tasks.length + corpus.length).toBeGreaterThan(0);
    expect(() => assertUniqueIds([{ id: "shared" }, { id: "shared" }], "タスク/コーパス")).toThrow("タスク/コーパス");
  });
  it("タスク定義に知らないキーがあれば読み込み時にエラー", () => {
    expect(() => loadTasks(dirWith("typo-task", { "a.yaml": `${TASK}audiense: 読者\n` }))).toThrow();
  });
});
