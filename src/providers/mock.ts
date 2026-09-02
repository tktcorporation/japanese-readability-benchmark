import { existsSync } from "node:fs";
import type { z } from "zod";
import { splitSentences } from "../metrics/sentences.ts";
import type { GenerateRequest, GenerateResponse, ModelDef } from "../types.ts";
import { readText, repoPath } from "../util/fs.ts";
import type { Provider } from "./index.ts";

/**
 * API キーなしでパイプライン全体を通すためのモック。
 *
 * - generate: fixtures/mock/<style>/<sourceId>.md を返す
 * - rewrite:  <text>...</text> の中身に決定的な整形を施して返す
 * - judge:    文の長さなどの表層指標から機械的に採点する
 *
 * テストとデモ専用で、モデルの実力を表すものではない。
 */
export class MockProvider implements Provider {
  constructor(readonly model: ModelDef) {}

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const started = Date.now();
    let text: string;
    if (req.purpose === "rewrite") {
      text = mockRewrite(extractTag(req.prompt, "text") ?? req.prompt);
    } else {
      const style = this.model.mockStyle ?? "plain";
      text = loadFixture(style).get(req.sourceId ?? "") ?? fallbackText(style, req.sourceId ?? "unknown");
    }
    return { text, servedBy: `mock:${this.model.mockStyle ?? "plain"}`, latencyMs: Date.now() - started };
  }

  async generateJson<T>(req: GenerateRequest, schema: z.ZodType<T>, _name: string): Promise<{ value: T; raw: GenerateResponse }> {
    const started = Date.now();
    const a = extractTag(req.prompt, "text_a");
    const b = extractTag(req.prompt, "text_b");
    let value: unknown;
    if (a !== undefined && b !== undefined) {
      const ha = heuristic(a);
      const hb = heuristic(b);
      const diff = ha - hb;
      value = {
        verdict: Math.abs(diff) < 3 ? "tie" : diff > 0 ? "A" : "B",
        rationale: `mock: heuristic A=${ha.toFixed(1)} B=${hb.toFixed(1)}`,
      };
    } else {
      const text = extractTag(req.prompt, "text") ?? req.prompt;
      const h = heuristic(text);
      const s = Math.max(1, Math.min(5, Math.round(1 + (h / 100) * 4)));
      value = {
        readability: s,
        clarity: s,
        naturalness: Math.min(5, s + 1),
        concision: s,
        structure: Math.max(1, s - 1),
        overall: s,
        rationale: `mock: heuristic=${h.toFixed(1)}`,
      };
    }
    const parsed = schema.parse(value);
    return { value: parsed, raw: { text: JSON.stringify(parsed), servedBy: "mock:judge", latencyMs: Date.now() - started } };
  }
}

const fixtureCache = new Map<string, Map<string, string>>();

/** fixtures/mock/<style>.md を「=== id ===」で区切られたセクションとして読む */
export function loadFixture(style: string): Map<string, string> {
  const cached = fixtureCache.get(style);
  if (cached) return cached;
  const map = new Map<string, string>();
  const file = repoPath("fixtures", "mock", `${style}.md`);
  if (existsSync(file)) {
    const re = /^=== (\S+) ===\n([\s\S]*?)(?=^=== \S+ ===\n|(?![\s\S]))/gm;
    for (const m of readText(file).matchAll(re)) map.set(m[1]!, (m[2] ?? "").trim());
  }
  fixtureCache.set(style, map);
  return map;
}

function extractTag(s: string, tag: string): string | undefined {
  const m = s.match(new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`));
  return m?.[1];
}

/** 0-100。文が短く読点が少ないほど高い。モック判定専用 */
export function heuristic(text: string): number {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return 0;
  const lens = sentences.map((s) => s.length);
  const meanLen = lens.reduce((a, b) => a + b, 0) / lens.length;
  const longRatio = lens.filter((l) => l > 60).length / lens.length;
  const ten = sentences.reduce((a, s) => a + (s.match(/、/g)?.length ?? 0), 0) / sentences.length;
  return Math.max(0, Math.min(100, 110 - meanLen - 25 * longRatio - 8 * ten));
}

/** 決定的な「書き直し」。長文分割と冗長表現の置換だけを行う */
export function mockRewrite(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(#|[-*]|\d+\.|```)/.test(line)) return line;
      let s = line;
      s = s.replace(/することができます/g, "できます").replace(/することができる/g, "できる");
      s = s.replace(/を行います/g, "します").replace(/を行う/g, "する").replace(/を実施し/g, "し");
      s = s.replace(/ということ/g, "こと").replace(/というもの/g, "もの");
      s = s.replace(/において/g, "で").replace(/における/g, "の").replace(/に関して/g, "について");
      s = s.replace(/ではないでしょうか/g, "でしょう");
      // 「〜ですが、」「〜ますが、」「〜が、」で文を切る
      s = s.replace(/(です|ます)が、/g, "$1。").replace(/(る|た|い)が、/g, "$1。");
      // 「〜ており、」「〜ものの、」で長い文を切る
      s = s.replace(/ており、/g, "ています。").replace(/ものの、/g, "ました。ただし、");
      return s;
    })
    .join("\n");
}

function fallbackText(style: string, sourceId: string): string {
  if (style === "verbose") {
    return `本件（${sourceId}）に関しましては、現時点において、関係各所との調整が必要であるということが判明しており、当該調整が完了するまでの間、一定の時間を要するということが想定されるため、ご了承いただきたく存じますが、進捗につきましては随時共有させていただく予定でございます。`;
  }
  return `この件（${sourceId}）は、関係者との調整が必要です。調整が終わるまで少し時間がかかります。進み具合は、そのつど共有します。`;
}
