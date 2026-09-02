import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { z } from "zod";
import type { HumanPair, HumanVote } from "../types.ts";
import { appendJsonl, readJson, readJsonl, repoPath } from "../util/fs.ts";

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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 人手評価用の小さな HTTP サーバー。
 * - GET  /api/pairs?rater=ID   まだその評価者が答えていないペアを返す（本文は含む）
 * - POST /api/vote             投票を votes.jsonl に追記（同じ評価者の同じペアへの再投票は 409）
 * - GET  /api/stats            投票数の概要
 * - それ以外                    web/ 配下の静的ファイル
 */
export function createHumanEvalServer(opts: ServeOptions) {
  const staticDir = opts.staticDir ?? repoPath("web");
  const pairs = readJson<HumanPair[]>(opts.pairsFile);
  const byId = new Map(pairs.map((p) => [p.id, p]));

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/api/pairs") {
        const rater = url.searchParams.get("rater") ?? "";
        const answered = new Set(readJsonl<HumanVote>(opts.votesFile).filter((v) => v.raterId === rater).map((v) => v.pairId));
        const remaining = pairs.filter((p) => !answered.has(p.id));
        // 上限は累積（回答済みを差し引く）。リロードしても上限を超えて出さない
        const allowance = opts.perRater ? Math.max(0, opts.perRater - answered.size) : remaining.length;
        const limited = remaining.slice(0, allowance);
        json(res, 200, { total: pairs.length, remaining: remaining.length, pairs: limited });
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
        if (readJsonl<HumanVote>(opts.votesFile).some((v) => v.raterId === raterId && v.pairId === pairId)) {
          json(res, 409, { error: "already voted" });
          return;
        }
        const vote: HumanVote = { ...parsed.data, createdAt: new Date().toISOString() };
        appendJsonl(opts.votesFile, vote);
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/stats") {
        const votes = readJsonl<HumanVote>(opts.votesFile);
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
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
