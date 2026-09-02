import { describe, expect, it } from "vitest";
import { extraSamples, planJobs, type PlanInput } from "../src/pipeline/plan.ts";
import { corpusSource, sampleId, taskSource } from "../src/pipeline/run.ts";
import type { InterventionDef, ModelDef, StepDef } from "../src/types.ts";

const def = (id: string, steps: StepDef[]): InterventionDef => ({ id, name: id, dir: "", steps });
const reuse = (id: string): StepDef => ({ type: "generate", reuse: id });
const m: ModelDef = { id: "m", provider: "mock", model: "x" };
const task = taskSource({ id: "t", category: "c", title: "題", prompt: "書いて" });
const corpus = corpusSource({ id: "c", title: "題", text: "原文。" });
// a: 単独、b: 単独、c: a と b の両方を再利用
const a = def("a", [{ type: "generate" }]);
const b = def("b", [{ type: "generate" }]);
const c = def("c", [reuse("a"), reuse("b")]);
const all = [a, b, c];
const id = (interv: string, model = "m", src = "t", index = 0) => sampleId(src, model, interv, index);
const ids = (input: Partial<PlanInput>) =>
  planJobs({ sources: [task], models: [m], interventions: [a], allInterventions: all, perCell: 1, force: false, fresh: new Set(), persisted: new Set(), ...input })
    .jobs.map((j) => sampleId(j.source.id, j.model?.id ?? "none", j.intervention.id, j.index))
    .sort();

describe("planJobs", () => {
  it("新鮮な既存サンプルがあるセルは飛ばし、--force なら作り直す", () => {
    const fresh = new Set([id("a")]);
    expect(ids({ fresh })).toEqual([]);
    expect(ids({ fresh, force: true })).toEqual([id("a")]);
  });
  it("--force の巻き添えで追加した依存セルの、もう一方の参照元が古ければ一緒に作る", () => {
    // c は a と b を再利用している。a を --force で作り直すと c も巻き添えになるが、b が古い（新鮮でない）なら b も作り直す
    const persisted = new Set([id("a"), id("b"), id("c")]);
    expect(ids({ force: true, persisted, fresh: new Set([id("b")]) })).toEqual([id("a"), id("c")]);
    expect(ids({ force: true, persisted, fresh: new Set() })).toEqual([id("a"), id("b"), id("c")]);
  });
  it("選択したセルの参照元が無ければ先にそろえる（--force でなくても）", () => {
    expect(ids({ interventions: [c], fresh: new Set([id("a"), id("b")]) })).toEqual([id("c")]);
    expect(ids({ interventions: [c], fresh: new Set([id("a")]) })).toEqual([id("b"), id("c")]);
  });
  it("コーパス起点では、モデルを持たない参照元は none のセル、持つ参照元は同じモデルのセルをそろえる", () => {
    const base = def("baseline", [{ type: "generate" }]);
    const rw = def("rewrite-pass", [{ type: "generate" }, { type: "rewrite", prompt: "p.md" }]);
    const fix = def("textlint-fix", [reuse("baseline"), { type: "textlint-fix" }]);
    const post = def("post", [reuse("rewrite-pass"), { type: "textlint-fix" }]);
    const allC = [base, rw, fix, post];
    expect(ids({ sources: [corpus], interventions: [fix], allInterventions: allC })).toEqual([id("baseline", "none", "c"), id("textlint-fix", "none", "c")]);
    expect(ids({ sources: [corpus], interventions: [post], allInterventions: allC })).toEqual([id("post", "m", "c"), id("rewrite-pass", "m", "c")]);
  });
  it("触れたセルと、--samples を超える index の既存サンプルを報告する", () => {
    const plan = planJobs({ sources: [task], models: [m], interventions: [c], allInterventions: all, perCell: 1, force: false, fresh: new Set([id("a"), id("b")]), persisted: new Set() });
    expect(Array.from(plan.cells).sort()).toEqual(["t__m__a", "t__m__b", "t__m__c"]);
    expect(extraSamples(plan.cells, 1, [id("a"), id("a", "m", "t", 1), id("b", "m", "t", 2), id("z", "m", "t", 5), "broken"])).toEqual([id("a", "m", "t", 1), id("b", "m", "t", 2)]);
    expect(extraSamples(plan.cells, 3, [id("a", "m", "t", 2)])).toEqual([]);
  });
});
