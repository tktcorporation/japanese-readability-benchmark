#!/usr/bin/env -S node --import tsx
import { existsSync } from "node:fs";
import { Command } from "commander";
import { loadCorpus, loadInterventions, loadModels, loadTasks, parseList, pick } from "./config.ts";
import { summarizeVotes } from "./human/aggregate.ts";
import { buildHumanPairs } from "./human/pairs.ts";
import { createHumanEvalServer } from "./human/server.ts";
import { buildPairs, judgePairwise, judgeRubric, type SourceInfo } from "./judge/index.ts";
import { scoreSample } from "./metrics/index.ts";
import { PAIRWISE_PROMPT_VERSION, RUBRIC_PROMPT_VERSION } from "./judge/prompts.ts";
import { corpusSource, dependentsOf, needsModelForCorpus, reuseLevels, runCell, sampleId, taskSource, type Source } from "./pipeline/run.ts";
import { createProvider } from "./providers/index.ts";
import { aggregate } from "./report/aggregate.ts";
import { renderMarkdown } from "./report/markdown.ts";
import { loadJudgments, loadSamples as loadSamplesFile, loadScores } from "./store.ts";
import type { HumanPair, HumanVote, ModelDef, PairScheme, PairwiseJudgment, RubricJudgment, Sample } from "./types.ts";
import { mapLimit } from "./util/async.ts";
import { appendJsonl, ensureDir, readJson, readJsonl, repoPath, writeJson, writeText } from "./util/fs.ts";

// .env があれば読む（すでに設定済みの環境変数は上書きしない）
try {
  process.loadEnvFile(repoPath(".env"));
} catch {
  // .env がなければ何もしない
}

const program = new Command();
program.name("bench").description("LLM が出力する日本語の読みやすさを評価するベンチマーク");

const PAIR_SCHEMES: readonly PairScheme[] = ["interventions", "models"];

function parseSchemes(value: string): PairScheme[] {
  const list = parseList(value) ?? [];
  for (const s of list) {
    if (!(PAIR_SCHEMES as readonly string[]).includes(s)) {
      throw new Error(`--schemes "${s}" は不正です。候補: ${PAIR_SCHEMES.join(", ")}`);
    }
  }
  return list as PairScheme[];
}

function runDir(runId: string): string {
  return repoPath("results", "runs", runId);
}

function files(runId: string) {
  const dir = runDir(runId);
  return {
    dir,
    samples: `${dir}/samples.jsonl`,
    scores: `${dir}/scores.jsonl`,
    judgments: `${dir}/judgments.jsonl`,
    pairs: `${dir}/pairs.json`,
    votes: `${dir}/votes.jsonl`,
    reportMd: `${dir}/report.md`,
    reportJson: `${dir}/report.json`,
    humanSummary: `${dir}/human-summary.json`,
  };
}

function loadSamples(runId: string): Sample[] {
  return loadSamplesFile(files(runId).samples);
}

/** 採点・判定を読む。再生成で本文が変わったサンプルの記録は除外される */
function loadDerived(runId: string, samples: Sample[]) {
  const f = files(runId);
  return { scores: loadScores(f.scores, samples), judgments: loadJudgments(f.judgments, samples) };
}

function sourceInfos(): Map<string, SourceInfo> {
  const map = new Map<string, SourceInfo>();
  for (const t of loadTasks()) map.set(t.id, { id: t.id, title: t.title, audience: t.audience });
  for (const c of loadCorpus()) map.set(c.id, { id: c.id, title: c.title, audience: c.audience });
  return map;
}

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

// ---------------------------------------------------------------------------
program
  .command("list")
  .description("タスク・コーパス・モデル・介入の一覧")
  .action(() => {
    const { models, judge } = loadModels();
    console.log("## tasks");
    for (const t of loadTasks()) console.log(`- ${t.id}  [${t.category}] ${t.title}`);
    console.log("\n## corpus");
    for (const c of loadCorpus()) console.log(`- ${c.id}  ${c.title} (${c.text.length}字)`);
    console.log("\n## models");
    for (const m of models) console.log(`- ${m.id}  ${m.provider}:${m.model}${m.label ? `  ${m.label}` : ""}`);
    console.log(`\n## judge\n- ${judge.model}`);
    console.log("\n## interventions");
    for (const i of loadInterventions()) console.log(`- ${i.id}  ${i.name}  [${i.steps.map((s) => s.type).join(" → ")}]`);
  });

// ---------------------------------------------------------------------------
program
  .command("run")
  .description("タスク × モデル × 介入 で文章を生成する（コーパス起点は --corpus）")
  .requiredOption("--run <id>", "run の名前（results/runs/<id>/ に保存）")
  .option("--tasks <ids>", "タスク id（カンマ区切り。既定: 全部）")
  .option("--corpus [ids]", "コーパス起点で実行（id を省略すると全部）")
  .option("--models <ids>", "モデル id（カンマ区切り。既定: 全部）")
  .option("--interventions <ids>", "介入 id（カンマ区切り。既定: 全部）")
  .option("--samples <n>", "1 セルあたりのサンプル数", "1")
  .option("--concurrency <n>", "同時実行数", "4")
  .option("--force", "既存のサンプルも作り直す", false)
  .action(async (o: { run: string; tasks?: string; corpus?: string | boolean; models?: string; interventions?: string; samples: string; concurrency: string; force: boolean }) => {
    const { models: allModels } = loadModels();
    const models = pick(allModels, parseList(o.models), "モデル");
    const allInterventions = loadInterventions();
    const interventions = pick(allInterventions, parseList(o.interventions), "介入");
    const perCell = Number(o.samples);
    const f = files(o.run);
    ensureDir(f.dir);
    // 既存サンプル。reuse ステップの参照先にもなる（--force のときも参照先として残し、再生成されたら置き換わる）
    const store = new Map<string, Sample>(loadSamples(o.run).filter((s) => !s.error).map((s) => [s.id, s]));
    const existing = new Set(o.force ? [] : store.keys());
    const lookup = (sourceId: string, modelId: string, interventionId: string, index: number) =>
      store.get(sampleId(sourceId, modelId, interventionId, index));

    let sources: Source[];
    if (o.corpus !== undefined && o.corpus !== false) {
      const ids = typeof o.corpus === "string" ? parseList(o.corpus) : undefined;
      sources = pick(loadCorpus(), ids, "コーパス").map(corpusSource);
    } else {
      sources = pick(loadTasks(), parseList(o.tasks), "タスク").map(taskSource);
    }

    type Job = { source: Source; model: ModelDef | undefined; intervention: (typeof interventions)[number]; index: number };
    const jobs: Job[] = [];
    const jobIds = new Set<string>();
    const addJob = (job: Job) => {
      const id = sampleId(job.source.id, job.model?.id ?? "none", job.intervention.id, job.index);
      if (existing.has(id) || jobIds.has(id)) return;
      jobIds.add(id);
      jobs.push(job);
    };
    for (const source of sources) {
      for (const intervention of interventions) {
        const modelChoices: (ModelDef | undefined)[] =
          source.type === "corpus" && !needsModelForCorpus(intervention) ? [undefined] : models;
        for (const model of modelChoices) {
          for (let index = 0; index < perCell; index += 1) {
            addJob({ source, model, intervention, index });
            // --force で作り直す出力を再利用している介入は、選択されていなくても一緒に作り直す
            if (o.force && source.type === "task") {
              for (const dependent of dependentsOf(intervention.id, allInterventions)) {
                if (store.has(sampleId(source.id, model?.id ?? "none", dependent.id, index))) {
                  addJob({ source, model, intervention: dependent, index });
                }
              }
            }
          }
        }
      }
    }
    log(`${jobs.length} セルを実行します（スキップ ${existing.size}）`);
    let done = 0;
    let errors = 0;
    // 他の介入の出力を再利用する介入は、参照先の段階がすべて終わってから実行する
    const involved = Array.from(new Set(jobs.map((j) => j.intervention)));
    for (const level of reuseLevels(involved)) {
      const ids = new Set(level.map((i) => i.id));
      const phase = jobs.filter((j) => ids.has(j.intervention.id));
      await mapLimit(phase, Number(o.concurrency), async (job) => {
        const sample = await runCell(job.source, job.model, job.intervention, job.index, { runId: o.run, allModels, lookup });
        appendJsonl(f.samples, sample);
        // 失敗したら古い成功サンプルも参照先から外す（依存側が古い本文で成功扱いにならないように）
        if (sample.error) store.delete(sample.id);
        else store.set(sample.id, sample);
        done += 1;
        if (sample.error) {
          errors += 1;
          log(`  [${done}/${jobs.length}] ERROR ${sample.id}: ${sample.error}`);
        } else {
          log(`  [${done}/${jobs.length}] ${sample.id} (${sample.text.length}字)`);
        }
      });
    }
    log(`完了: ${done} 件（エラー ${errors}）→ ${f.samples}`);
  });

// ---------------------------------------------------------------------------
program
  .command("score")
  .description("自動指標（textlint・表層統計・jReadability）を計算する")
  .requiredOption("--run <id>")
  .option("--concurrency <n>", "同時実行数", "4")
  .option("--force", "計算済みも再計算", false)
  .action(async (o: { run: string; concurrency: string; force: boolean }) => {
    const f = files(o.run);
    const all = loadSamples(o.run);
    const samples = all.filter((s) => !s.error && s.text.length > 0);
    // 本文が変わったサンプルの古い採点は loadScores が除外するので、自動的に再採点される
    const done = new Set(o.force ? [] : loadDerived(o.run, all).scores.map((s) => s.sampleId));
    const todo = samples.filter((s) => !done.has(s.id));
    log(`${todo.length} 件を採点します（スキップ ${done.size}）`);
    await mapLimit(todo, Number(o.concurrency), async (s) => {
      const rec = await scoreSample(s);
      appendJsonl(f.scores, rec);
      log(`  ${s.id}: textlint ${rec.metrics.textlintCount} 件, 平均文長 ${rec.metrics.meanSentenceLength?.toFixed(1)}`);
    });
    log(`→ ${f.scores}`);
  });

// ---------------------------------------------------------------------------
program
  .command("judge")
  .description("LLM による採点（rubric）と比較（pairwise）")
  .requiredOption("--run <id>")
  .option("--mode <mode>", "rubric | pairwise | both", "both")
  .option("--schemes <list>", "pairwise の比較軸: interventions,models", "interventions,models")
  .option("--judge <modelId>", "判定モデル id（既定: config/models.yaml の judge）")
  .option("--baseline <id>", "基準となる介入 id", "baseline")
  .option("--limit <n>", "判定する最大件数（コスト確認用）")
  .option("--concurrency <n>", "同時実行数", "3")
  .option("--no-cache", "判定キャッシュを使わない")
  .action(async (o: { run: string; mode: string; schemes: string; judge?: string; baseline: string; limit?: string; concurrency: string; cache: boolean }) => {
    const f = files(o.run);
    const cfg = loadModels();
    const judgeModel = pick(cfg.models, [o.judge ?? cfg.judge.model], "モデル")[0]!;
    const provider = createProvider(judgeModel);
    const cacheDir = o.cache ? repoPath("results", "cache", "judge") : undefined;
    if (cacheDir) ensureDir(cacheDir);
    const sources = sourceInfos();
    const all = loadSamples(o.run);
    const samples = all.filter((s) => !s.error && s.text.length > 0);
    // 本文が変わったサンプルの古い判定は除外済み。プロンプトの版が変わった判定も未完了として扱う
    const existing = loadDerived(o.run, all).judgments;
    const limit = o.limit ? Number(o.limit) : Infinity;
    const concurrency = Number(o.concurrency);
    let budget = limit;

    if (o.mode === "rubric" || o.mode === "both") {
      const done = new Set(
        existing
          .filter(
            (j): j is RubricJudgment => j.kind === "rubric" && j.judgeModel === judgeModel.id && j.promptVersion === RUBRIC_PROMPT_VERSION,
          )
          .map((j) => j.sampleId),
      );
      const todo = samples.filter((s) => !done.has(s.id)).slice(0, budget);
      budget -= todo.length;
      log(`rubric: ${todo.length} 件（判定モデル ${judgeModel.id}）`);
      await mapLimit(todo, concurrency, async (s) => {
        const src = sources.get(s.sourceId) ?? { id: s.sourceId, title: s.sourceId };
        try {
          const j = await judgeRubric(s, src, { provider, cacheDir });
          appendJsonl(f.judgments, j);
          log(`  ${s.id}: overall ${j.scores.overall}`);
        } catch (err) {
          log(`  ERROR ${s.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }
    if (o.mode === "pairwise" || o.mode === "both") {
      const schemes = parseSchemes(o.schemes);
      const done = new Set(
        existing
          .filter(
            (j): j is PairwiseJudgment =>
              j.kind === "pairwise" && j.judgeModel === judgeModel.id && j.promptVersion === PAIRWISE_PROMPT_VERSION,
          )
          .map((j) => `${j.scheme}|${j.aSampleId}|${j.bSampleId}`),
      );
      const pairs = schemes.flatMap((scheme) => buildPairs(samples, scheme, o.baseline)).filter((p) => !done.has(`${p.scheme}|${p.a.id}|${p.b.id}`)).slice(0, Math.max(0, budget));
      log(`pairwise: ${pairs.length} ペア × 2 回（提示順入れ替え）`);
      await mapLimit(pairs, concurrency, async (p) => {
        const src = sources.get(p.sourceId) ?? { id: p.sourceId, title: p.sourceId };
        try {
          const j = await judgePairwise(p.a, p.b, src, p.scheme, { provider, cacheDir });
          appendJsonl(f.judgments, j);
          log(`  ${p.a.id} vs ${p.b.id}: ${j.verdict}`);
        } catch (err) {
          log(`  ERROR ${p.a.id} vs ${p.b.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }
    log(`→ ${f.judgments}`);
  });

// ---------------------------------------------------------------------------
program
  .command("report")
  .description("集計して report.md / report.json を書き出す")
  .requiredOption("--run <id>")
  .option("--baseline <id>", "基準となる介入 id", "baseline")
  .option("--judge <modelId>", "集計に使う判定モデル id（複数の判定モデルで judge したとき）")
  .action((o: { run: string; baseline: string; judge?: string }) => {
    const f = files(o.run);
    const samples = loadSamples(o.run);
    const { scores, judgments } = loadDerived(o.run, samples);
    const humanVotes = readJsonl<HumanVote>(f.votes);
    const humanPairs = existsSync(f.pairs) ? readJson<HumanPair[]>(f.pairs) : undefined;
    const report = aggregate({ runId: o.run, samples, scores, judgments, humanVotes, humanPairs, baselineId: o.baseline, judgeModel: o.judge });
    if (report.judgeModels.length > 1 && !o.judge) {
      log(`注意: 判定モデルが複数あります（${report.judgeModels.join(", ")}）。${report.judgeModel} で集計しました。--judge で切り替えられます`);
    }
    writeJson(f.reportJson, report);
    const md = renderMarkdown(report);
    writeText(f.reportMd, md);
    console.log(md);
    log(`→ ${f.reportMd}`);
  });

// ---------------------------------------------------------------------------
program
  .command("pairs")
  .description("人手評価用のペア（pairs.json）を作る")
  .requiredOption("--run <id>")
  .option("--schemes <list>", "interventions,models", "interventions,models")
  .option("--baseline <id>", "基準となる介入 id", "baseline")
  .option("--max <n>", "最大ペア数")
  .option("--seed <n>", "シャッフルのシード", "42")
  .action((o: { run: string; schemes: string; baseline: string; max?: string; seed: string }) => {
    const f = files(o.run);
    const samples = loadSamples(o.run);
    const pairs = buildHumanPairs(samples, {
      schemes: parseSchemes(o.schemes),
      baselineId: o.baseline,
      sources: sourceInfos(),
      max: o.max ? Number(o.max) : undefined,
      seed: Number(o.seed),
    });
    writeJson(f.pairs, pairs);
    log(`${pairs.length} ペア → ${f.pairs}`);
  });

// ---------------------------------------------------------------------------
program
  .command("serve")
  .description("人手評価の Web 画面を起動する（投票は votes.jsonl に追記）")
  .requiredOption("--run <id>")
  .option("--port <n>", "ポート", "3000")
  .option("--per-rater <n>", "1 人あたりの最大ペア数")
  .action((o: { run: string; port: string; perRater?: string }) => {
    const f = files(o.run);
    if (!existsSync(f.pairs)) {
      log(`pairs.json がありません。先に \`bench pairs --run ${o.run}\` を実行してください`);
      process.exitCode = 1;
      return;
    }
    const server = createHumanEvalServer({
      pairsFile: f.pairs,
      votesFile: f.votes,
      port: Number(o.port),
      perRater: o.perRater ? Number(o.perRater) : undefined,
    });
    server.listen(Number(o.port), () => log(`http://localhost:${o.port}/  （Ctrl+C で終了）`));
  });

// ---------------------------------------------------------------------------
program
  .command("human-report")
  .description("人手投票を集計する（詳細は report にも反映される）")
  .requiredOption("--run <id>")
  .action((o: { run: string }) => {
    const f = files(o.run);
    const pairs = existsSync(f.pairs) ? readJson<HumanPair[]>(f.pairs) : [];
    const votes = readJsonl<HumanVote>(f.votes);
    const summary = summarizeVotes(pairs, votes);
    writeJson(f.humanSummary, summary);
    console.log(`ペア ${summary.pairs} / 投票 ${summary.votes} / 評価者 ${summary.raters}`);
    if (summary.interRaterAgreement) {
      const a = summary.interRaterAgreement;
      console.log(`評価者間一致: ${a.agree}/${a.pairs} (${(a.rate * 100).toFixed(0)}%)`);
    }
    if (summary.medianSeconds !== undefined) console.log(`回答時間の中央値: ${summary.medianSeconds}s`);
    log(`→ ${f.humanSummary}`);
  });

// ---------------------------------------------------------------------------
program
  .command("show")
  .description("サンプルの本文と指標を表示する")
  .requiredOption("--run <id>")
  .requiredOption("--sample <sampleId>")
  .action((o: { run: string; sample: string }) => {
    const all = loadSamples(o.run);
    const s = all.find((x) => x.id === o.sample);
    if (!s) {
      log("サンプルが見つかりません");
      process.exitCode = 1;
      return;
    }
    const derived = loadDerived(o.run, all);
    const score = derived.scores.find((x) => x.sampleId === s.id);
    console.log(`# ${s.id}\n`);
    if (s.inputText) console.log(`## 介入前\n\n${s.inputText}\n`);
    console.log(`## 本文\n\n${s.text}\n`);
    if (score) {
      console.log("## 指標\n");
      for (const [k, v] of Object.entries(score.metrics)) console.log(`- ${k}: ${Number.isInteger(v) ? v : v.toFixed(3)}`);
      if (score.textlintMessages.length) {
        console.log("\n## textlint\n");
        for (const m of score.textlintMessages) console.log(`- L${m.line}:${m.column} ${m.ruleId}: ${m.message.split("\n")[0]}`);
      }
    }
    const judgments = derived.judgments.filter((j) => j.kind === "rubric" && j.sampleId === s.id);
    for (const j of judgments) {
      if (j.kind !== "rubric") continue;
      console.log(`\n## LLM 採点 (${j.judgeModel})\n`);
      console.log(JSON.stringify(j.scores));
      console.log(j.rationale);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  log(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
