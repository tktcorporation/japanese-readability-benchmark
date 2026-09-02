import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { CorpusDoc, InterventionDef, ModelDef, TaskDef } from "./types.ts";
import { readText, repoPath } from "./util/fs.ts";

const taskSchema = z.object({
  id: z.string(),
  category: z.string(),
  title: z.string(),
  prompt: z.string(),
  audience: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const modelSchema = z.object({
  id: z.string(),
  provider: z.enum(["anthropic", "openai", "mock"]),
  model: z.string(),
  label: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  baseUrl: z.string().optional(),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  thinking: z.enum(["adaptive", "none"]).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  fallbacks: z.boolean().optional(),
  mockStyle: z.string().optional(),
});

const modelsFileSchema = z.object({
  models: z.array(modelSchema),
  judge: z.object({ model: z.string() }),
});

const stepSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("generate"),
      reuse: z.string().optional(),
      system: z.string().optional(),
      promptPrefix: z.string().optional(),
      promptSuffix: z.string().optional(),
    })
    .refine((s) => !s.reuse || (!s.system && !s.promptPrefix && !s.promptSuffix), {
      message: "generate の reuse は system / promptPrefix / promptSuffix と併用できません",
    }),
  z.object({ type: z.literal("textlint-fix"), config: z.string().optional() }),
  z.object({
    type: z.literal("rewrite"),
    prompt: z.string(),
    model: z.string().optional(),
    passes: z.number().int().positive().optional(),
  }),
]);

const interventionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(stepSchema).min(1),
});

function listFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext) && !f.startsWith("_"))
    .sort()
    .map((f) => join(dir, f));
}

export function loadTasks(dir = repoPath("tasks")): TaskDef[] {
  return listFiles(dir, ".yaml").map((file) => taskSchema.parse(parseYaml(readText(file))));
}

/** frontmatter 付き Markdown からコーパス文書を読む */
export function parseCorpusDoc(raw: string, fallbackId: string): CorpusDoc {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = m ? ((parseYaml(m[1] ?? "") as Record<string, unknown> | null) ?? {}) : {};
  const text = (m ? (m[2] ?? "") : raw).trim();
  return {
    id: typeof meta.id === "string" ? meta.id : fallbackId,
    title: typeof meta.title === "string" ? meta.title : fallbackId,
    note: typeof meta.note === "string" ? meta.note : undefined,
    audience: typeof meta.audience === "string" ? meta.audience : undefined,
    tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : undefined,
    text,
  };
}

export function loadCorpus(dir = repoPath("corpus")): CorpusDoc[] {
  return listFiles(dir, ".md").map((file) => parseCorpusDoc(readText(file), basename(file, ".md")));
}

export interface ModelsConfig {
  models: ModelDef[];
  judge: { model: string };
}

export function loadModels(file = repoPath("config", "models.yaml")): ModelsConfig {
  return modelsFileSchema.parse(parseYaml(readText(file)));
}

export function loadInterventions(dir = repoPath("interventions")): InterventionDef[] {
  return listFiles(dir, ".yaml").map((file) => {
    const def = interventionSchema.parse(parseYaml(readText(file)));
    return { ...def, dir: dirname(file) };
  });
}

export function pick<T extends { id: string }>(all: T[], ids: string[] | undefined, kind: string): T[] {
  if (!ids || ids.length === 0) return all;
  return ids.map((id) => {
    const found = all.find((x) => x.id === id);
    if (!found) {
      throw new Error(`${kind} "${id}" が見つかりません。候補: ${all.map((x) => x.id).join(", ")}`);
    }
    return found;
  });
}

export function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
