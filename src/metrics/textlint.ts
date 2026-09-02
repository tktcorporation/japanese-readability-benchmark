import { createLinter, loadTextlintrc, type CreateLinterOptions } from "textlint";
import type { TextlintMessage } from "../types.ts";
import { installedVersion, repoPath } from "../util/fs.ts";
import { stripMarkdown } from "./sentences.ts";

type Linter = ReturnType<typeof createLinter>;

/**
 * .textlintrc の rules / filters から、出力に影響するパッケージ名を求める。
 * "preset-x" → textlint-rule-preset-x、"x" → textlint-rule-x、filters の "x" → textlint-filter-rule-x。
 * スコープ付き（@scope/…）やフルネームはそのまま。textlint 本体は常に含める
 */
export function textlintPackagesOf(configContent: string): string[] {
  let cfg: { rules?: Record<string, unknown>; filters?: Record<string, unknown> } = {};
  try {
    cfg = JSON.parse(configContent) as typeof cfg;
  } catch {
    // 壊れた設定は lint 時にエラーになる。ここでは本体だけを返す
  }
  const full = (name: string, prefix: string): string => {
    if (name.startsWith("@")) {
      // @scope/name → @scope/<prefix>name（既にプレフィックス付きならそのまま）
      const [scope, rest = ""] = name.split("/", 2);
      return rest.startsWith(prefix) ? name : `${scope}/${prefix}${rest}`;
    }
    return name.startsWith(prefix) ? name : `${prefix}${name}`;
  };
  const enabled = (entries: Record<string, unknown> | undefined) => Object.entries(entries ?? {}).filter(([, v]) => v !== false).map(([k]) => k);
  const rules = enabled(cfg.rules).map((name) => full(name, "textlint-rule-"));
  const filters = enabled(cfg.filters).map((name) => full(name, "textlint-filter-rule-"));
  return Array.from(new Set(["textlint", ...rules, ...filters])).sort();
}

/** textlint-fix の来歴に含める「実装の版」。設定が同じでも本体やルールを更新したら変わる */
export function textlintToolchain(configContent: string): string[] {
  return textlintPackagesOf(configContent).map((p) => `${p}@${installedVersion(p)}`);
}

const linters = new Map<string, Promise<Linter>>();

export function getLinter(configFilePath = repoPath(".textlintrc.json")): Promise<Linter> {
  let p = linters.get(configFilePath);
  if (!p) {
    p = loadTextlintrc({ configFilePath }).then((descriptor) => createLinter({ descriptor } satisfies CreateLinterOptions));
    linters.set(configFilePath, p);
  }
  return p;
}

export interface TextlintResult {
  messages: TextlintMessage[];
  /** ルール別件数 */
  rules: Record<string, number>;
  /** 1000 文字あたりの違反数。分母はコードブロックや Markdown 記法を除いた本文（表層指標の chars と同じ） */
  per1k: number;
  count: number;
  fixableCount: number;
}

export async function lintText(text: string, configFilePath?: string): Promise<TextlintResult> {
  const linter = await getLinter(configFilePath);
  const result = await linter.lintText(text, "sample.md");
  const messages: TextlintMessage[] = result.messages
    .filter((m) => m.severity >= 1)
    .map((m) => ({
      ruleId: m.ruleId,
      message: m.message,
      line: m.line,
      column: m.column,
      fixable: Boolean(m.fix),
    }));
  const rules: Record<string, number> = {};
  for (const m of messages) rules[m.ruleId] = (rules[m.ruleId] ?? 0) + 1;
  const chars = stripMarkdown(text).replace(/\s+/g, "").length || 1;
  return {
    messages,
    rules,
    per1k: (messages.length / chars) * 1000,
    count: messages.length,
    fixableCount: messages.filter((m) => m.fixable).length,
  };
}

export async function fixText(text: string, configFilePath?: string): Promise<{ output: string; applied: number; remaining: number }> {
  const linter = await getLinter(configFilePath);
  const result = await linter.fixText(text, "sample.md");
  return {
    output: result.output,
    applied: result.applyingMessages.length,
    remaining: result.remainingMessages.length,
  };
}
