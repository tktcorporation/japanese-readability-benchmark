/**
 * 本文を <text> などの区切りタグに入れる前に、区切りと同じタグを無害化する。
 * 本文に </text> が含まれると区切りが閉じ、残りがモデルへの指示として読まれてしまう
 * （XML の例やプロンプトインジェクション）。判定プロンプトと rewrite テンプレートの両方で使う
 */
export function escapeDelimiters(text: string, tags: readonly string[] = DEFAULT_DELIMITER_TAGS): string {
  if (tags.length === 0) return text;
  const alternatives = Array.from(new Set(tags.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).join("|");
  return text.replace(new RegExp(`<(\\/?)(${alternatives})(\\s*)>`, "gi"), "&lt;$1$2$3&gt;");
}

/** 判定プロンプトと同梱の rewrite テンプレートが使う区切りタグ */
export const DEFAULT_DELIMITER_TAGS: readonly string[] = ["text", "text_a", "text_b"];

/**
 * テンプレートが閉じタグとして使っているタグ名（</document> なら document）。
 * 独自の rewrite テンプレートが別の区切りで本文を囲んでいても、その区切りを本文で閉じられないようにするため
 */
export function delimiterTagsOf(template: string): string[] {
  const tags = new Set(DEFAULT_DELIMITER_TAGS);
  for (const m of template.matchAll(/<\/([A-Za-z_][\w-]*)\s*>/g)) tags.add(m[1]!);
  return Array.from(tags);
}
