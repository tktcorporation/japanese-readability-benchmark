import { describe, expect, it } from "vitest";
import { removeCodeBlocks, splitSentences, stripMarkdown } from "../src/metrics/sentences.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METRICS_VERSION, scoreSample, scoringHashOf } from "../src/metrics/index.ts";
import { installedVersion, sha256 } from "../src/util/fs.ts";
import { surfaceMetrics } from "../src/metrics/surface.ts";
import { fixText, lintText, textlintPackagesOf, textlintToolchain } from "../src/metrics/textlint.ts";
import { loadFixture } from "../src/providers/mock.ts";

const PLAIN = loadFixture("plain").get("oauth-explain")!;
const VERBOSE = loadFixture("verbose").get("oauth-explain")!;

describe("textlint の来歴", () => {
  it("設定から出力に影響するパッケージを求め、インストール済みの版を付ける", () => {
    const cfg = JSON.stringify({
      rules: { "preset-ja-technical-writing": { "sentence-length": { max: 100 } }, "preset-japanese": false, "no-todo": true, "@scope/rule-x": true, "textlint-rule-y": true },
      filters: { comments: true },
    });
    expect(textlintPackagesOf(cfg)).toEqual([
      "@scope/textlint-rule-rule-x",
      "textlint",
      "textlint-filter-rule-comments",
      "textlint-rule-no-todo",
      "textlint-rule-preset-ja-technical-writing",
      "textlint-rule-y",
    ]);
    expect(textlintPackagesOf("{broken")).toEqual(["textlint"]);
    const toolchain = textlintToolchain(readFileSync(join(process.cwd(), ".textlintrc.json"), "utf8"));
    expect(toolchain.find((t) => t.startsWith("textlint@"))).toMatch(/^textlint@\d+\./);
    expect(toolchain.find((t) => t.startsWith("textlint-rule-preset-ja-technical-writing@"))).toMatch(/@\d+\./);
    expect(toolchain.find((t) => t.startsWith("textlint-rule-no-todo@"))).toBeUndefined();
  });
});

describe("splitSentences", () => {
  it("句点・感嘆符・疑問符で区切る", () => {
    expect(splitSentences("これは文です。これも文です！これは？最後")).toEqual(["これは文です。", "これも文です！", "これは？", "最後"]);
  });
  it("閉じ括弧が続く場合は括弧まで含める", () => {
    expect(splitSentences("「はい。」と言った。")).toEqual(["「はい。」", "と言った。"]);
  });
  it("Markdown の見出し・箇条書き・コードブロックを除く", () => {
    const md = "# 見出し\n\n- 項目一です。\n- 項目二です。\n\n```\nconst x = 1;\n```\n\n本文です。";
    expect(stripMarkdown(md)).not.toContain("const x");
    expect(splitSentences(md)).toEqual(["見出し", "項目一です。", "項目二です。", "本文です。"]);
  });
});

describe("removeCodeBlocks", () => {
  it("``` と ~~~ のフェンス、閉じないフェンス、インデントコードを落とし、ネストした箇条書きは残す", () => {
    const md = [
      "本文一です。",
      "~~~js",
      "const x = 1;",
      "~~~",
      "本文二です。",
      "",
      "    indented code",
      "    more code",
      "",
      "- 項目です。",
      "",
      "    - ネストの項目です。",
      "````",
      "```",
      "still code",
      "````",
      "本文三です。",
      "```",
      "unclosed code",
    ].join("\n");
    const plain = removeCodeBlocks(md);
    expect(plain).not.toMatch(/const x|indented code|more code|still code|unclosed code/);
    expect(splitSentences(md)).toEqual(["本文一です。", "本文二です。", "項目です。", "ネストの項目です。", "本文三です。"]);
    // 引用の中のフェンス・インデントコードも落とす
    const quoted = "> 引用です。\n> ```js\n> const y = 2;\n> ```\n> 続きです。\n>\n>     quoted code\n> 最後です。";
    expect(removeCodeBlocks(quoted)).not.toMatch(/const y|quoted code/);
    expect(splitSentences(quoted)).toEqual(["引用です。", "続きです。", "最後です。"]);
    expect(stripMarkdown("   ```\nコード\n```\n本文。")).not.toContain("コード"); // 行頭 0〜3 スペースはフェンス
    expect(stripMarkdown("行頭 ```\nコード\n```\n本文。")).toContain("コード"); // 行の途中の ``` はフェンスではない
  });
});

describe("removeCodeBlocks（箇条書きの中のフェンス）", () => {
  it("箇条書きの直後に 4 スペース以上下がったフェンスもコードとして落とす", () => {
    const md = "- 説明です。\n    ```js\n    const x = 1;\n    ```\n- 次の項目です。\n\t~~~\n\tcode\n\t~~~\n本文です。";
    expect(removeCodeBlocks(md)).not.toMatch(/const x|code/);
    expect(splitSentences(md)).toEqual(["説明です。", "次の項目です。", "本文です。"]);
  });
});

describe("removeCodeBlocks（箇条書きの続きの段落）", () => {
  it("項目の本文位置に揃えた続きの段落は残し、そこから 4 スペース以上下がった行はコードとして落とす", () => {
    const md = [
      "- 手順です。",
      "",
      "  続きの段落です。",
      "",
      "    詳しい説明です。",
      "",
      "        code here",
      "",
      "1. 番号付きです。",
      "",
      "   番号付きの続きです。",
      "",
      "       more code",
      "本文です。",
      "",
      "    top level code",
      "終わりです。",
    ].join("\n");
    expect(removeCodeBlocks(md)).not.toMatch(/code here|more code|top level code/);
    expect(splitSentences(md)).toEqual(["手順です。", "続きの段落です。", "詳しい説明です。", "番号付きです。", "番号付きの続きです。", "本文です。", "終わりです。"]);
  });
});

describe("stripMarkdown のインライン コード", () => {
  it("同じ長さのバッククォート列で区切られたコードを 1 つの X にする", () => {
    expect(stripMarkdown("これは `x` です。")).toBe("これは X です。");
    expect(stripMarkdown("これは ``a`b`` です。")).toBe("これは X です。");
    expect(stripMarkdown("`a` と ``b``。")).toBe("X と X。");
    expect(stripMarkdown("閉じない `code です。")).toBe("閉じない `code です。");
  });
});

describe("stripMarkdown の表", () => {
  it("表の区切り行は落とし、セルの本文は残す", () => {
    const md = "| 項目 | 説明です。 |\n| --- | :---: |\n|:-|-:|\n| A | 本文です。 |";
    expect(stripMarkdown(md)).not.toMatch(/-{2,}|:-|-:/);
    expect(splitSentences(md)).toEqual(["項目 説明です。", "A 本文です。"]);
    expect(splitSentences("--- ではない文です。")).toEqual(["--- ではない文です。"]); // 区切り行に見えない行はそのまま
  });
});

describe("surfaceMetrics", () => {
  it("冗長な文章は平均文長が長く jReadability が低い", async () => {
    const plain = await surfaceMetrics(PLAIN);
    const verbose = await surfaceMetrics(VERBOSE);
    expect(plain.sentences).toBeGreaterThan(5);
    expect(verbose.meanSentenceLength).toBeGreaterThan(plain.meanSentenceLength * 2);
    expect(verbose.longSentenceRatio).toBeGreaterThan(plain.longSentenceRatio);
    expect(verbose.jreadability!).toBeLessThan(plain.jreadability!);
    expect(verbose.nominalizationPer1k).toBeGreaterThan(plain.nominalizationPer1k);
  });
  it("文字種の割合は合計 1 以下で、漢字率は妥当な範囲", async () => {
    const m = await surfaceMetrics(PLAIN);
    expect(m.kanjiRatio + m.hiraganaRatio + m.katakanaRatio + m.latinRatio).toBeLessThanOrEqual(1);
    expect(m.kanjiRatio).toBeGreaterThan(0.15);
    expect(m.kanjiRatio).toBeLessThan(0.5);
    expect(m.listLines).toBeGreaterThan(0);
    expect(m.headings).toBe(1);
  });
  it("語種の割合は 0-1 で、和語 + 漢語は 1 以下", async () => {
    const m = await surfaceMetrics("私は東京で会議に出席した。データベースを確認する。");
    expect(m.kangoRatio).toBeGreaterThan(0);
    expect(m.wagoRatio).toBeGreaterThan(0);
    expect(m.kangoRatio + m.wagoRatio).toBeLessThanOrEqual(1);
    expect(m.particleRatio).toBeGreaterThan(0);
    expect(m.verbRatio).toBeGreaterThan(0);
  });
  it("空文字でも落ちない", async () => {
    const m = await surfaceMetrics("");
    expect(m.sentences).toBe(0);
    expect(m.meanSentenceLength).toBe(0);
  });
});

describe("本文の無いサンプル", () => {
  it("コードブロックだけの本文には jReadability を付けない（採点記録からも落ちる）", async () => {
    const codeOnly = "```js\nconst x = 1;\n```";
    const m = await surfaceMetrics(codeOnly);
    expect(m.sentences).toBe(0);
    expect(m.jreadability).toBeUndefined();
    const rec = await scoreSample({ id: "s", runId: "r", sourceType: "task", sourceId: "t", modelId: "m", interventionId: "baseline", sampleIndex: 0, text: codeOnly, steps: [], createdAt: "" });
    expect(rec.metrics.jreadability).toBeUndefined();
    expect(rec.metrics.chars).toBe(0);
    expect((await surfaceMetrics(PLAIN)).jreadability).toBeGreaterThan(0);
  });
});

describe("採点設定のハッシュ", () => {
  it("textlint 設定の内容が変わると変わり、採点記録に付く", async () => {
    const base = scoringHashOf();
    expect(base).toHaveLength(64);
    expect(METRICS_VERSION).toMatch(/^metrics-v\d+$/);
    const tmp = mkdtempSync(join(tmpdir(), "jrb-scoring-"));
    try {
      const other = join(tmp, ".textlintrc.json");
      writeFileSync(other, JSON.stringify({ rules: { "preset-ja-technical-writing": { "sentence-length": { max: 50 } } } }));
      expect(scoringHashOf(other)).not.toBe(base);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    const rec = await scoreSample({ id: "s", runId: "r", sourceType: "task", sourceId: "t", modelId: "m", interventionId: "baseline", sampleIndex: 0, text: PLAIN, steps: [], createdAt: "" });
    expect(rec.scoringHash).toBe(base);
    // 設定で有効にしている textlint パッケージすべての版と kuromojin の版を含む
    const config = readFileSync(join(process.cwd(), ".textlintrc.json"), "utf8");
    expect(base).toBe(sha256("scoring", METRICS_VERSION, config, ...textlintToolchain(config), `kuromojin@${installedVersion("kuromojin")}`));
  });
});

describe("textlint", () => {
  it("読点が多い・助詞が重なる文を検出する", async () => {
    const r = await lintText("本システムにおいては、ユーザーがログインした際に、セッションが生成されるが、この際に、トークンの検証が行われないケースが存在するため、注意が必要である。");
    expect(r.count).toBeGreaterThan(0);
    expect(Object.keys(r.rules).some((k) => k.includes("max-ten"))).toBe(true);
    expect(r.per1k).toBeGreaterThan(0);
  });
  it("冗長な文章のほうが違反密度が高い", async () => {
    const [p, v] = await Promise.all([lintText(PLAIN), lintText(VERBOSE)]);
    expect(v.per1k).toBeGreaterThan(p.per1k);
  });
  it("違反密度の分母はコードブロックを含めない", async () => {
    const prose = "本システムにおいては、ユーザーがログインした際に、セッションが生成されるが、この際に、トークンの検証が行われないケースが存在するため、注意が必要である。";
    const withCode = `${prose}\n\n\`\`\`\n${"const x = 1;\n".repeat(50)}\`\`\`\n`;
    const [a, b] = await Promise.all([lintText(prose), lintText(withCode)]);
    expect(b.count).toBe(a.count);
    expect(b.per1k).toBeCloseTo(a.per1k, 5);
  });
  it("fixText は文字列を返し、適用数を報告する", async () => {
    const r = await fixText("これはテストです。これもテストです。");
    expect(typeof r.output).toBe("string");
    expect(r.applied).toBeGreaterThanOrEqual(0);
  });
});
