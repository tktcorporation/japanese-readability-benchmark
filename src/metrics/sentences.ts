/**
 * Markdown を含む日本語テキストを「文」に分割する。
 * コードブロックは除外し、見出し・箇条書きの記号は落として本文だけを残す。
 */

/**
 * コードブロックを落とす。
 * - フェンス（``` / ~~~、3 文字以上、行頭 0〜3 スペース）: 同じ文字で同じ長さ以上の閉じフェンスまで。閉じなければ末尾まで（CommonMark と同じ）
 * - インデントコード（空行の後に 4 スペース以上またはタブで始まる行）: インデントが続く間。ネストした箇条書きは除く
 */
export function removeCodeBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: { char: string; length: number } | undefined;
  let prevBlank = true;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) {
        fence = undefined;
        out.push("");
        prevBlank = true;
      }
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      continue;
    }
    if (prevBlank && /^(?: {4,}|\t)\S/.test(line) && !/^(?: {4,}|\t)(?:[-*+]|\d+[.)])\s/.test(line)) {
      let j = i;
      while (j < lines.length && (/^(?: {4,}|\t)/.test(lines[j]!) || lines[j]!.trim() === "")) j += 1;
      i = j - 1;
      out.push("");
      prevBlank = true;
      continue;
    }
    out.push(line);
    prevBlank = line.trim() === "";
  }
  return out.join("\n");
}

export function stripMarkdown(text: string): string {
  return removeCodeBlocks(text)
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
