/**
 * run id は results/runs/<id>/ のディレクトリ名になる。
 * パス区切りや `..` を含む値で results/runs の外に書き込まないよう、安全な文字だけを許す
 */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function assertRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId) || runId.includes("..")) {
    throw new Error(`--run "${runId}" は不正です。英数字で始まり、英数字と _ . - だけを使ってください（パス区切りや .. は不可）`);
  }
  return runId;
}
