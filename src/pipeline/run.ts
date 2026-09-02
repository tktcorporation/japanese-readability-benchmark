import { resolve } from "node:path";
import { fixText } from "../metrics/textlint.ts";
import { createProvider } from "../providers/index.ts";
import type { CorpusDoc, InterventionDef, ModelDef, Sample, StepDef, StepTrace, TaskDef } from "../types.ts";
import { readText, repoPath, slug } from "../util/fs.ts";

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

export interface RunOptions {
  runId: string;
  /** 全モデル定義（rewrite ステップの model 解決用） */
  allModels: ModelDef[];
  textlintConfig?: string;
}

export function sampleId(sourceId: string, modelId: string, interventionId: string, index: number): string {
  return [slug(sourceId), slug(modelId), slug(interventionId), String(index)].join("__");
}

/**
 * コーパス起点のとき、この介入にモデルが必要か。
 * generate ステップは飛ばされるので、モデル未指定の rewrite があるときだけ必要。
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
    return { ...base, text, inputText: inputText === text ? undefined : inputText };
  } catch (err) {
    return { ...base, text: text ?? "", inputText, error: err instanceof Error ? err.message : String(err) };
  }
}

interface StepContext {
  text: string | undefined;
  source: Source;
  model: ModelDef | undefined;
  audience: string;
  intervention: InterventionDef;
  opts: RunOptions;
}

async function executeStep(step: StepDef, ctx: StepContext): Promise<{ trace: StepTrace; text?: string }> {
  switch (step.type) {
    case "generate": {
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
