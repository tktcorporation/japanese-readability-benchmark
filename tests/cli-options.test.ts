import { describe, expect, it } from "vitest";
import { parseList, parseSchemes } from "../src/config.ts";
import { parseFixture } from "../src/providers/mock.ts";
import { assertRunId } from "../src/util/run-id.ts";

describe("CLI オプションの検証", () => {
  it("parseList は省略なら undefined、明示的に空ならエラー", () => {
    expect(parseList(undefined)).toBeUndefined();
    expect(parseList("a, b,,c")).toEqual(["a", "b", "c"]);
    expect(() => parseList(",")).toThrow("空");
    expect(() => parseList("   ")).toThrow("空");
    expect(() => parseList("")).toThrow("空");
  });
  it("parseSchemes は不正な値を拒み、重複をまとめる", () => {
    expect(parseSchemes("interventions,models")).toEqual(["interventions", "models"]);
    expect(parseSchemes("interventions,interventions,models")).toEqual(["interventions", "models"]);
    expect(() => parseSchemes("interventions,human")).toThrow('"human"');
  });
  it("run id は results/runs の外に出られない", () => {
    for (const ok of ["demo", "2026-09", "run_1.a"]) expect(assertRunId(ok)).toBe(ok);
    for (const ng of ["../x", "/tmp/x", "a/b", "a\\b", ".hidden", "", "a..b"]) expect(() => assertRunId(ng)).toThrow();
  });
});

describe("mock フィクスチャ", () => {
  it("LF でも CRLF でもセクションを読める", () => {
    const lf = parseFixture("=== a ===\n本文A\n\n=== b ===\n本文B\n");
    const crlf = parseFixture("=== a ===\r\n本文A\r\n\r\n=== b ===\r\n本文B\r\n");
    expect(Object.fromEntries(lf)).toEqual({ a: "本文A", b: "本文B" });
    expect(Object.fromEntries(crlf)).toEqual({ a: "本文A", b: "本文B" });
  });
});
