import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertUniqueIds, loadAllSources, loadCorpus, loadInterventions, loadTasks } from "../src/config.ts";

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
    expect(loadInterventions(dirWith("ok", { "x.yaml": "id: x\nname: t\nsteps:\n  - type: generate\n    reuse: baseline\n" }))).toHaveLength(1);
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
