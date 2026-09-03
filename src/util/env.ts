import { existsSync, readFileSync } from "node:fs";

/**
 * .env の最小限のパーサ（KEY=VALUE、# コメント、引用符付きの値に対応）。
 * Node 20.12 以降は process.loadEnvFile を使い、これはその代替。
 */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]!] = value;
  }
  return out;
}

/** .env があれば環境変数に読み込む。すでに設定済みの変数は上書きしない */
export function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(path);
    return;
  }
  for (const [k, v] of Object.entries(parseDotenv(readFileSync(path, "utf8")))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
