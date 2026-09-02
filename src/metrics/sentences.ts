/**
 * Markdown を含む日本語テキストを「文」に分割する。
 * コードブロックは除外し、見出し・箇条書きの記号は落として本文だけを残す。
 */

/**
 * コードブロックを落とす。
 * - フェンス（``` / ~~~、3 文字以上。箇条書きの中で 4 スペース以上下がっていても、引用の中でも可）: 同じ文字で同じ長さ以上の閉じフェンスまで。閉じなければ末尾まで（CommonMark と同じ）
 * - インデントコード（空行の後に 4 スペース以上またはタブで始まる行）: インデントが続く間。ネストした箇条書きは除く
 * - 引用（> ）の中のフェンス・インデントコードも同様に扱う（引用記号を外してから判定する）
 */
export function removeCodeBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: { char: string; length: number } | undefined;
  let prevBlank = true;
  // 引用記号（> ）を外した中身。フェンスやインデントの判定はこちらで行う
  const unquote = (line: string) => line.replace(/^(?: {0,3}> ?)+/, "");
  for (let i = 0; i < lines.length; i += 1) {
    const line = unquote(lines[i]!);
    if (fence) {
      const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) {
        fence = undefined;
        out.push("");
        prevBlank = true;
      }
      continue;
    }
    const open = line.match(/^\s*(`{3,}|~{3,})/);
    if (open) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      continue;
    }
    if (prevBlank && /^(?: {4,}|\t)\S/.test(line) && !/^(?: {4,}|\t)(?:[-*+]|\d+[.)])\s/.test(line)) {
      let j = i;
      while (j < lines.length && (/^(?: {4,}|\t)/.test(unquote(lines[j]!)) || unquote(lines[j]!).trim() === "")) j += 1;
      i = j - 1;
      out.push("");
      prevBlank = true;
      continue;
    }
    out.push(lines[i]!);
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
    // 表の区切り行（| --- | :-: |）は本文ではないので落とす。セルの区切りは空白にする
    .replace(/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/gm, "")
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
