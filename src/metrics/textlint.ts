import { createLinter, loadTextlintrc, type CreateLinterOptions } from "textlint";
import type { TextlintMessage } from "../types.ts";
import { repoPath } from "../util/fs.ts";
import { stripMarkdown } from "./sentences.ts";

type Linter = ReturnType<typeof createLinter>;

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
