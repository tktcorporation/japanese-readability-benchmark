/**
 * Markdown を含む日本語テキストを「文」に分割する。
 * コードブロックは除外し、見出し・箇条書きの記号は落として本文だけを残す。
 */

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/`[^`\n]*`/g, "X")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\|/g, " ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[ \t]+/g, " ");
}

export function splitSentences(text: string): string[] {
  const plain = stripMarkdown(text);
  const out: string[] = [];
  for (const line of plain.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 句点・感嘆符・疑問符（全角/半角）で切る。閉じ括弧が続く場合はそちらまで含める
    const parts = trimmed.split(/(?<=[。！？!?])(?=[^」』）)])|(?<=[。！？!?][」』）)])/);
    for (const p of parts) {
      const s = p.trim();
      if (s.length > 0) out.push(s);
    }
  }
  return out;
}

export function paragraphs(text: string): string[] {
  return stripMarkdown(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}
