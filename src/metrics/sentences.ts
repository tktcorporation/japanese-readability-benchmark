/**
 * Markdown を含む日本語テキストを「文」に分割する。
 * コードブロックは除外し、見出し・箇条書きの記号は落として本文だけを残す。
 */

/**
 * コードブロックを落とす。
 * - フェンス（``` / ~~~、3 文字以上。箇条書きの中で 4 スペース以上下がっていても、引用の中でも可）: 同じ文字で同じ長さ以上の閉じフェンスまで。閉じなければ末尾まで（CommonMark と同じ）
 * - インデントコード（空行の後に、囲んでいる箇条書きの本文位置から 4 スペース以上またはタブで下がった行）: インデントが続く間。
 *   箇条書きの項目の中の続きの段落（本文位置に揃えた段落）はコードではないので残す
 * - 引用（> ）の中のフェンス・インデントコードも同様に扱う（引用記号を外してから判定する）
 */
export function removeCodeBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: { char: string; length: number } | undefined;
  let prevBlank = true;
  // 囲んでいる箇条書きの本文位置（列）。ネストした分だけ積む
  const listOffsets: number[] = [];
  // 引用記号（> ）を外した中身。フェンスやインデントの判定はこちらで行う
  // 箇条書きの中の引用（"    > ```"）のように、引用記号の前に 4 スペース以上あっても外す
  const unquote = (line: string) => line.replace(/^(?:\s*> ?)+/, "");
  const indentOf = (line: string) => (line.match(/^[ \t]*/)?.[0] ?? "").replace(/\t/g, "    ").length;
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
    if (line.trim() === "") {
      out.push(lines[i]!);
      prevBlank = true;
      continue;
    }
    const indent = indentOf(line);
    // 本文位置より浅い行が来たら、その箇条書き（の入れ子）は終わり
    while (listOffsets.length && indent < listOffsets[listOffsets.length - 1]!) listOffsets.pop();
    const marker = line.match(/^([ \t]*)([-*+]|\d+[.)])([ \t]+)/);
    const codeIndent = (listOffsets[listOffsets.length - 1] ?? 0) + 4;
    if (!marker && prevBlank && indent >= codeIndent) {
      let j = i;
      while (j < lines.length && (unquote(lines[j]!).trim() === "" || indentOf(unquote(lines[j]!)) >= codeIndent)) j += 1;
      i = j - 1;
      out.push("");
      prevBlank = true;
      continue;
    }
    if (marker) {
      // 項目の本文位置 = 記号の終わり + 空白（5 つ以上なら 1 つ分。残りはインデントコードになる）
      const gap = marker[3]!.replace(/\t/g, "    ").length;
      listOffsets.push(indentOf(marker[1]!) + marker[2]!.length + (gap > 4 ? 1 : gap));
    }
    out.push(lines[i]!);
    prevBlank = false;
  }
  return out.join("\n");
}

export function stripMarkdown(text: string): string {
  return removeCodeBlocks(text)
    // インライン コード。区切りは同じ長さのバッククォート列（`` `foo` `` のような多重区切りも 1 つの X にする）
    .replace(/(`+)(?!`)((?:(?!\1)[^\n])+?)\1(?!`)/g, "X")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    // Setext 見出しの下線（===== / -----）は本文ではないので落とす
    .replace(/^\s{0,3}(=+|-+)\s*$/gm, "")
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
