import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { CorpusDoc, InterventionDef, ModelDef, TaskDef } from "./types.ts";
import { readText, repoPath } from "./util/fs.ts";

/**
 * 設定で使う id。サンプル id は `<source>__<model>__<intervention>__<index>` と連結するので、
 * 英数字・`_` `.` `+` `-` に限り、区切りの `__` を含まないものだけ許す（変換で潰れて衝突しないように）。
 */
export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/, "id は英数字で始まり、英数字と _ . + - だけを使ってください")
  .refine((s) => !s.includes("__"), { message: "id に __ は使えません" });

// すべて strict: 綴り間違いのキー（reuse → resue など）を黙って捨てず、読み込み時にエラーにする
const taskSchema = z
  .object({
    id: idSchema,
    category: z.string(),
    title: z.string(),
    prompt: z.string(),
    audience: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

const modelSchema = z
  .object({
    id: idSchema,
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
  })
  .strict();

const modelsFileSchema = z
  .object({
    models: z.array(modelSchema),
    judge: z.object({ model: z.string() }).strict(),
  })
  .strict();

const stepSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("generate"),
      reuse: z.string().optional(),
      system: z.string().optional(),
      promptPrefix: z.string().optional(),
      promptSuffix: z.string().optional(),
    })
    .strict()
    .refine((s) => !s.reuse || (!s.system && !s.promptPrefix && !s.promptSuffix), {
      message: "generate の reuse は system / promptPrefix / promptSuffix と併用できません",
    }),
  z.object({ type: z.literal("textlint-fix"), config: z.string().optional() }).strict(),
  z
    .object({
      type: z.literal("rewrite"),
      prompt: z.string(),
      model: z.string().optional(),
      passes: z.number().int().positive().optional(),
    })
    .strict(),
]);

const interventionSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    description: z.string().optional(),
    steps: z.array(stepSchema).min(1),
  })
  .strict();

/** 同じ id が 2 つあると片方のサンプルが黙って落ちるので、読み込み時に止める */
export function assertUniqueIds<T extends { id: string }>(items: T[], kind: string): T[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`${kind}の id "${item.id}" が重複しています`);
    seen.add(item.id);
  }
  return items;
}

function listFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext) && !f.startsWith("_"))
    .sort()
    .map((f) => join(dir, f));
}

export function loadTasks(dir = repoPath("tasks")): TaskDef[] {
  return assertUniqueIds(
    listFiles(dir, ".yaml").map((file) => taskSchema.parse(parseYaml(readText(file)))),
    "タスク",
  );
}

/** コーパスの frontmatter。strict なので綴り間違い（audiense など）は読み込み時にエラーになる */
const corpusFrontmatterSchema = z
  .object({
    id: idSchema.optional(),
    title: z.string().optional(),
    note: z.string().optional(),
    audience: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

/** frontmatter 付き Markdown からコーパス文書を読む */
export function parseCorpusDoc(raw: string, fallbackId: string): CorpusDoc {
  // CRLF のファイルでも frontmatter を認識する
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/);
  const meta = corpusFrontmatterSchema.parse(m ? (parseYaml(m[1] ?? "") ?? {}) : {});
  const text = (m ? (m[2] ?? "") : raw).trim();
  return {
    id: idSchema.parse(meta.id ?? fallbackId),
    title: meta.title ?? fallbackId,
    note: meta.note,
    audience: meta.audience,
    tags: meta.tags,
    text,
  };
}

export function loadCorpus(dir = repoPath("corpus")): CorpusDoc[] {
  return assertUniqueIds(
    listFiles(dir, ".md").map((file) => parseCorpusDoc(readText(file), basename(file, ".md"))),
    "コーパス",
  );
}

export interface ModelsConfig {
  models: ModelDef[];
  judge: { model: string };
}

export function loadModels(file = repoPath("config", "models.yaml")): ModelsConfig {
  const cfg = modelsFileSchema.parse(parseYaml(readText(file)));
  assertUniqueIds(cfg.models, "モデル");
  return cfg;
}

export function loadInterventions(dir = repoPath("interventions")): InterventionDef[] {
  return assertUniqueIds(
    listFiles(dir, ".yaml").map((file) => {
      const def = interventionSchema.parse(parseYaml(readText(file)));
      return { ...def, dir: dirname(file) };
    }),
    "介入",
  );
}

/** タスクとコーパスをまとめて読む。サンプル id は source id だけで区別するので、両方にまたがって重複を禁じる */
export function loadAllSources(): { tasks: TaskDef[]; corpus: CorpusDoc[] } {
  const tasks = loadTasks();
  const corpus = loadCorpus();
  assertUniqueIds([...tasks, ...corpus], "タスク/コーパス");
  return { tasks, corpus };
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
