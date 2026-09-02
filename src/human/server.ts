import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { z } from "zod";
import type { HumanPair, HumanVote } from "../types.ts";
import { appendJsonl, readJson, readJsonl, repoPath } from "../util/fs.ts";
import { assignPairs } from "./assign.ts";

const voteSchema = z.object({
  pairId: z.string().min(1),
  choice: z.enum(["A", "B", "tie"]),
  leftWasA: z.boolean(),
  raterId: z.string().min(1).max(64),
  comment: z.string().max(2000).optional(),
  seconds: z.number().nonnegative().optional(),
});

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface ServeOptions {
  pairsFile: string;
  /** 渡すと pairsFile を読まずにこのペアを配信する（呼び出し側で現在のサンプル・定義と一致するものに絞ったとき） */
  pairs?: HumanPair[];
  votesFile: string;
  port: number;
  staticDir?: string;
  /** 1 人の評価者に出す最大ペア数 */
  perRater?: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** 投票のリクエスト本文の上限。pairId・rater・choice などしか入らないので十分に小さい */
const MAX_BODY_BYTES = 16 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super(`リクエスト本文が大きすぎます（上限 ${MAX_BODY_BYTES} バイト）`);
  }
}

/**
 * 本文を読む。上限を超えたら読み込みを打ち切る（巨大な本文でメモリを使い切らないため）。
 * 呼び出し側は 413 を返してから接続を閉じる
 */
async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > limit) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 人手評価用の小さな HTTP サーバー。
 * - GET  /api/pairs?rater=ID   その評価者に出すペアを返す（投票が少ないペア優先、評価者ごとに決定的な順、上限は累積）
 * - POST /api/vote             投票を votes.jsonl に追記（同じ評価者の同じペアへの再投票は 409、--per-rater の上限超過は 403）
 * - GET  /api/stats            投票数の概要
 * - それ以外                    web/ 配下の静的ファイル
 */
export function createHumanEvalServer(opts: ServeOptions) {
  const staticDir = opts.staticDir ?? repoPath("web");
  const pairs = opts.pairs ?? readJson<HumanPair[]>(opts.pairsFile);
  const byId = new Map(pairs.map((p) => [p.id, p]));

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/api/pairs") {
        const rater = url.searchParams.get("rater") ?? "";
        // 投票が少ないペアを優先し、評価者ごとに決定的にシャッフルし、上限は累積で適用する
        const { remaining, assigned } = assignPairs(pairs, readJsonl<HumanVote>(opts.votesFile), rater, opts.perRater);
        json(res, 200, { total: pairs.length, remaining: remaining.length, pairs: assigned });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/vote") {
        const parsed = voteSchema.safeParse(JSON.parse(await readBody(req)));
        if (!parsed.success) {
          json(res, 400, { error: parsed.error.message });
          return;
        }
        if (!byId.has(parsed.data.pairId)) {
          json(res, 404, { error: "unknown pair" });
          return;
        }
        const { pairId, raterId } = parsed.data;
        const mine = readJsonl<HumanVote>(opts.votesFile).filter((v) => v.raterId === raterId && byId.has(v.pairId));
        if (mine.some((v) => v.pairId === pairId)) {
          json(res, 409, { error: "already voted" });
          return;
        }
        // 上限は受け付け側でも数える（複数タブや直接の API 呼び出しで GET の割り当てを超えないように）
        if (opts.perRater && mine.length >= opts.perRater) {
          json(res, 403, { error: "per-rater limit reached" });
          return;
        }
        const vote: HumanVote = { ...parsed.data, createdAt: new Date().toISOString() };
        appendJsonl(opts.votesFile, vote);
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/stats") {
        // 現在のペアへの投票だけを数える（作り直す前の古いペアへの投票は含めない）
        const votes = readJsonl<HumanVote>(opts.votesFile).filter((v) => byId.has(v.pairId));
        json(res, 200, { pairs: pairs.length, votes: votes.length, raters: new Set(votes.map((v) => v.raterId)).size });
        return;
      }
      // 静的ファイル
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = normalize(join(staticDir, rel));
      if (!file.startsWith(staticDir) || !existsSync(file) || !statSync(file).isFile()) {
        json(res, 404, { error: "not found" });
        return;
      }
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        // 残りの本文は読まずに応答し、応答後に接続を閉じる
        res.setHeader("connection", "close");
        res.once("finish", () => req.destroy());
        json(res, 413, { error: err.message });
        return;
      }
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
