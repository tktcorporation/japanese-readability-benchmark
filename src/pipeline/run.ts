import { resolve } from "node:path";
import { fixText } from "../metrics/textlint.ts";
import { createProvider } from "../providers/index.ts";
import type { CorpusDoc, InterventionDef, ModelDef, Sample, StepDef, StepTrace, TaskDef } from "../types.ts";
import { readText, repoPath, sha256 } from "../util/fs.ts";

/** 生成の起点。タスク（プロンプト）かコーパス（既存文章）のどちらか */
export type Source =
  | { type: "task"; id: string; title: string; prompt: string; audience?: string }
  | { type: "corpus"; id: string; title: string; text: string; audience?: string };

export function taskSource(t: TaskDef): Source {
  return { type: "task", id: t.id, title: t.title, prompt: t.prompt, audience: t.audience };
}

export function corpusSource(c: CorpusDoc): Source {
  return { type: "corpus", id: c.id, title: c.title, text: c.text, audience: c.audience };
}

/** 入力（タスクならプロンプト、コーパスなら原文）のハッシュ。サンプルの鮮度判定に使う */
export function sourceHash(source: Source): string {
  return sha256(source.type === "corpus" ? source.text : source.prompt);
}

export interface RunOptions {
  runId: string;
  /** 全モデル定義（rewrite ステップの model 解決用） */
  allModels: ModelDef[];
  textlintConfig?: string;
  /** generate(reuse) が参照する、同じ run の既存サンプル */
  lookup?: (sourceId: string, modelId: string, interventionId: string, index: number) => Sample | undefined;
}

/** この介入が他の介入の出力を再利用するか（実行順の決定に使う） */
export function reusesIntervention(intervention: InterventionDef): string | undefined {
  for (const s of intervention.steps) if (s.type === "generate" && s.reuse) return s.reuse;
  return undefined;
}

/** id の出力を（推移的に）再利用している介入。作り直したときに一緒に作り直す対象 */
export function dependentsOf(id: string, all: InterventionDef[]): InterventionDef[] {
  const out: InterventionDef[] = [];
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length) {
    const current = queue.shift()!;
    for (const i of all) {
      if (reusesIntervention(i) === current && !seen.has(i.id)) {
        seen.add(i.id);
        out.push(i);
        queue.push(i.id);
      }
    }
  }
  return out;
}

/**
 * reuse の依存関係で介入を段階に分ける。段階 k の介入は段階 k-1 までの出力だけを参照する。
 * 選択されていない介入を参照する場合は run 内の既存サンプルに頼るので段階 1 に置く。
 * 循環参照は例外。
 */
export function reuseLevels(interventions: InterventionDef[]): InterventionDef[][] {
  const byId = new Map(interventions.map((i) => [i.id, i]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const resolve = (i: InterventionDef): number => {
    const cached = depth.get(i.id);
    if (cached !== undefined) return cached;
    const dep = reusesIntervention(i);
    let d = 0;
    if (dep) {
      if (visiting.has(i.id)) throw new Error(`介入の reuse が循環しています: ${i.id}`);
      visiting.add(i.id);
      const target = byId.get(dep);
      d = target ? resolve(target) + 1 : 1;
      visiting.delete(i.id);
    }
    depth.set(i.id, d);
    return d;
  };
  const levels: InterventionDef[][] = [];
  for (const i of interventions) {
    const d = resolve(i);
    (levels[d] ??= []).push(i);
  }
  return Array.from({ length: levels.length }, (_, k) => levels[k] ?? []);
}

/** id は config で検証済み（英数字と _ . + -、`__` を含まない）なので、変換せずに `__` で連結する */
export function sampleId(sourceId: string, modelId: string, interventionId: string, index: number): string {
  return [sourceId, modelId, interventionId, String(index)].join("__");
}

/**
 * コーパス起点のとき、この介入にモデルが必要か。
 * generate ステップは飛ばされる（reuse は参照先を使う）ので、モデル未指定の rewrite があるときだけ必要。
 */
export function needsModelForCorpus(intervention: InterventionDef): boolean {
  return intervention.steps.some((s) => s.type === "rewrite" && !s.model);
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
}

function resolveModel(id: string, all: ModelDef[]): ModelDef {
  const m = all.find((x) => x.id === id);
  if (!m) throw new Error(`モデル "${id}" が config/models.yaml にありません`);
  return m;
}

/**
 * 1 セル（source × model × intervention × index）を実行して Sample を返す。
 * 失敗しても例外は投げず、error に記録する（再実行で埋められる）。
 */
export async function runCell(
  source: Source,
  model: ModelDef | undefined,
  intervention: InterventionDef,
  index: number,
  opts: RunOptions,
): Promise<Sample> {
  const modelId = model?.id ?? "none";
  const base: Sample = {
    id: sampleId(source.id, modelId, intervention.id, index),
    runId: opts.runId,
    sourceType: source.type,
    sourceId: source.id,
    modelId,
    interventionId: intervention.id,
    sampleIndex: index,
    text: "",
    steps: [],
    createdAt: new Date().toISOString(),
    inputHash: sourceHash(source),
  };
  const audience = source.audience ?? "一般的な読者";
  let text: string | undefined = source.type === "corpus" ? source.text : undefined;
  let inputText: string | undefined = text;

  try {
    for (const step of intervention.steps) {
      const started = Date.now();
      const trace = await executeStep(step, {
        text,
        source,
        model,
        index,
        audience,
        intervention,
        opts,
      });
      trace.trace.ms = Date.now() - started;
      base.steps.push(trace.trace);
      if (trace.text !== undefined) {
        if (inputText === undefined) inputText = trace.text;
        text = trace.text;
      }
    }
    if (text === undefined) throw new Error("パイプラインが文章を生成しませんでした（generate ステップがない？）");
    // 空の本文を成功として残すと、以後スキップされ続けるうえに指標なしのサンプルとして数えられる
    if (text.trim().length === 0) throw new Error("生成された文章が空です");
    return { ...base, text, inputText: inputText === text ? undefined : inputText };
  } catch (err) {
    return { ...base, text: text ?? "", inputText, error: err instanceof Error ? err.message : String(err) };
  }
}

interface StepContext {
  text: string | undefined;
  source: Source;
  model: ModelDef | undefined;
  index: number;
  audience: string;
  intervention: InterventionDef;
  opts: RunOptions;
}

async function executeStep(step: StepDef, ctx: StepContext): Promise<{ trace: StepTrace; text?: string }> {
  switch (step.type) {
    case "generate": {
      if (step.reuse) {
        // 同じセルの別介入（通常は baseline）の出力をそのまま使う。生成のばらつきを介入効果に混ぜない。
        // コーパス起点で参照先がモデルを持たない介入（textlint-fix など）なら "none" のセルも探す
        const modelId = ctx.model?.id ?? "none";
        const prior =
          ctx.opts.lookup?.(ctx.source.id, modelId, step.reuse, ctx.index) ??
          (ctx.source.type === "corpus" && modelId !== "none" ? ctx.opts.lookup?.(ctx.source.id, "none", step.reuse, ctx.index) : undefined);
        if (!prior || prior.error || !prior.text) {
          throw new Error(`再利用する介入 "${step.reuse}" のサンプルがありません。先に ${step.reuse} を同じ run で実行してください`);
        }
        return {
          trace: { type: "generate", ms: 0, modelId: ctx.model?.id, reusedFrom: prior.id, reusedHash: sha256(prior.text) },
          text: prior.text,
        };
      }
      if (ctx.source.type === "corpus") return { trace: { type: "generate", skipped: true, ms: 0 } };
      if (!ctx.model) throw new Error("generate ステップにはモデルが必要です");
      const provider = createProvider(ctx.model);
      const system = step.system ? readText(resolve(ctx.intervention.dir, step.system)) : undefined;
      const prompt = [step.promptPrefix, ctx.source.prompt, step.promptSuffix].filter(Boolean).join("\n\n");
      const res = await provider.generate({ system, prompt, purpose: "generate", sourceId: ctx.source.id });
      return {
        trace: { type: "generate", ms: 0, modelId: ctx.model.id, servedBy: res.servedBy, usage: res.usage },
        text: res.text.trim(),
      };
    }
    case "textlint-fix": {
      if (ctx.text === undefined) throw new Error("textlint-fix の前に文章がありません");
      const config = step.config ? resolve(ctx.intervention.dir, step.config) : (ctx.opts.textlintConfig ?? repoPath(".textlintrc.json"));
      const fixed = await fixText(ctx.text, config);
      return { trace: { type: "textlint-fix", ms: 0, applied: fixed.applied, remaining: fixed.remaining }, text: fixed.output };
    }
    case "rewrite": {
      if (ctx.text === undefined) throw new Error("rewrite の前に文章がありません");
      const model = step.model ? resolveModel(step.model, ctx.opts.allModels) : ctx.model;
      if (!model) throw new Error("rewrite ステップに使うモデルがありません（--models か steps[].model を指定）");
      const provider = createProvider(model);
      const template = readText(resolve(ctx.intervention.dir, step.prompt));
      let text = ctx.text;
      let usage: StepTrace["usage"];
      let servedBy: string | undefined;
      for (let i = 0; i < (step.passes ?? 1); i += 1) {
        const prompt = renderTemplate(template, { text, audience: ctx.audience, title: ctx.source.title });
        const res = await provider.generate({ prompt, purpose: "rewrite", sourceId: ctx.source.id });
        text = res.text.trim();
        usage = res.usage;
        servedBy = res.servedBy;
      }
      return { trace: { type: "rewrite", ms: 0, modelId: model.id, servedBy, usage }, text };
    }
    default: {
      const never: never = step;
      throw new Error(`unknown step: ${JSON.stringify(never)}`);
    }
  }
}
