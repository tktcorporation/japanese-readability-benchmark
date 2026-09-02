import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { CorpusDoc, InterventionDef, ModelDef, PairScheme, StepDef, TaskDef } from "./types.ts";
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

/** モデルなしのセル（コーパス原文など）に使う予約 id。設定ファイルのモデル id には使えない */
export const NONE_MODEL_ID = "none";

const modelSchema = z
  .object({
    id: idSchema.refine((v) => v !== NONE_MODEL_ID, { message: `"${NONE_MODEL_ID}" はモデルなしのセルに使う予約 id です` }),
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
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  // 「---」で始まるのに閉じる「---」が無いファイルは、メタデータを本文として採点してしまうので拒む
  if (!m && /^---(\r?\n|$)/.test(raw)) {
    throw new Error(`コーパス "${fallbackId}" の frontmatter が閉じていません（先頭の --- に対応する --- の行が必要です）`);
  }
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
  const defs = assertUniqueIds(
    listFiles(dir, ".yaml").map((file) => {
      const def = interventionSchema.parse(parseYaml(readText(file)));
      return { ...def, dir: dirname(file) };
    }),
    "介入",
  );
  return assertReuseTargets(defs);
}

/** rewrite ステップで明示した model が config/models.yaml に存在することを確かめる（綴り間違いで生成だけ課金されるのを防ぐ） */
export function assertRewriteModels<T extends { id: string; steps: StepDef[] }>(interventions: T[], models: { id: string }[]): T[] {
  const ids = new Set(models.map((m) => m.id));
  for (const def of interventions) {
    for (const step of def.steps) {
      if (step.type !== "rewrite" || !step.model || ids.has(step.model)) continue;
      throw new Error(`介入 "${def.id}" の rewrite ステップの model "${step.model}" が見つかりません（候補: ${Array.from(ids).sort().join(", ")}）`);
    }
  }
  return interventions;
}

/** generate ステップの reuse 先が実在する別の介入を指していることを確かめる（綴り間違いは実行前に止める） */
export function assertReuseTargets<T extends { id: string; steps: StepDef[] }>(defs: T[]): T[] {
  const ids = new Set(defs.map((d) => d.id));
  for (const def of defs) {
    for (const step of def.steps) {
      if (step.type !== "generate" || !step.reuse) continue;
      if (step.reuse === def.id) throw new Error(`介入 "${def.id}" が自分自身を reuse しています`);
      if (!ids.has(step.reuse)) {
        throw new Error(`介入 "${def.id}" の reuse 先 "${step.reuse}" が見つかりません（候補: ${Array.from(ids).sort().join(", ")}）`);
      }
    }
  }
  return defs;
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

/**
 * カンマ区切りの id リストを読む。省略時は undefined（＝全部）。
 * 明示的に渡されたのに中身が空（`','` や空白だけ）なら、「全部」と解釈せずエラーにする
 */
export const PAIR_SCHEMES: readonly PairScheme[] = ["interventions", "models"];

/** --schemes の値。不正な値はエラー、重複は 1 つにまとめる（同じペアを二重に作らない） */
export function parseSchemes(value: string): PairScheme[] {
  const list = parseList(value) ?? [];
  for (const s of list) {
    if (!(PAIR_SCHEMES as readonly string[]).includes(s)) {
      throw new Error(`--schemes "${s}" は不正です。候補: ${PAIR_SCHEMES.join(", ")}`);
    }
  }
  return Array.from(new Set(list)) as PairScheme[];
}

export function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const list = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) throw new Error(`id のリストが空です: "${value}"（全部を対象にするならオプション自体を省略してください）`);
  return list;
}
