import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadDotenv, parseDotenv } from "../src/util/env.ts";

const dir = mkdtempSync(join(tmpdir(), "jrb-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("dotenv", () => {
  it("KEY=VALUE、コメント、引用符、export を扱う", () => {
    const parsed = parseDotenv(`# comment\nA=1\nB="two words" \nC='x=y'\nexport D=d # trailing\n\nINVALID LINE\nE=`);
    expect(parsed).toEqual({ A: "1", B: "two words", C: "x=y", D: "d", E: "" });
  });
  it("loadDotenv は既存の環境変数を上書きしない", () => {
    const file = join(dir, ".env");
    writeFileSync(file, "JRB_TEST_NEW=from-file\nJRB_TEST_EXISTING=from-file\n");
    process.env.JRB_TEST_EXISTING = "from-shell";
    delete process.env.JRB_TEST_NEW;
    loadDotenv(file);
    expect(process.env.JRB_TEST_NEW).toBe("from-file");
    expect(process.env.JRB_TEST_EXISTING).toBe("from-shell");
    loadDotenv(join(dir, "missing.env")); // 存在しなくても落ちない
  });
});
