import type { InterventionDef, ModelDef } from "../types.ts";
import { dependentsOf, needsModelForCorpus, reusedInterventions, sampleId, type Source } from "./run.ts";

export interface Job {
  source: Source;
  model: ModelDef | undefined;
  intervention: InterventionDef;
  index: number;
}

export interface PlanInput {
  sources: Source[];
  models: ModelDef[];
  /** 選択された介入 */
  interventions: InterventionDef[];
  /** 定義されている全介入（依存関係の解決用） */
  allInterventions: InterventionDef[];
  perCell: number;
  force: boolean;
  /** 新鮮で成功した既存サンプルの id（そのまま使える） */
  fresh: Set<string>;
  /** ファイルに記録されたことのある id（鮮度・成否を問わない）。--force の巻き添え判定に使う */
  persisted: Set<string>;
}

export interface Plan {
  jobs: Job[];
  /** 選択・巻き添え・前提として触れたセル（index を除く）。--samples の縮小検知に使う */
  cells: Set<string>;
  /** スキップした既存サンプル数 */
  skipped: number;
}

/**
 * 実行するセルを決める。
 * - 選択したセルのうち、新鮮な既存サンプルが無いもの（--force なら全部）
 * - --force で作り直すセルの出力を再利用している介入のセル（一度でも作ったことがあれば、選択外でも一緒に作り直す）
 * - 上記のセルが再利用する参照元のうち、新鮮な既存サンプルが無いもの（前提を揃えてから実行し、参照先不在で失敗しないようにする）
 */
export function planJobs(input: PlanInput): Plan {
  const { allInterventions, perCell, force, fresh, persisted } = input;
  const byId = new Map(allInterventions.map((i) => [i.id, i]));
  const existing = force ? new Set<string>() : fresh;
  const jobs: Job[] = [];
  const jobIds = new Set<string>();
  const cells = new Set<string>();
  const idOf = (job: Job) => sampleId(job.source.id, job.model?.id ?? "none", job.intervention.id, job.index);
  const touch = (job: Job) => cells.add(sampleId(job.source.id, job.model?.id ?? "none", job.intervention.id, 0).replace(/__0$/, ""));

  const addJob = (job: Job) => {
    touch(job);
    const id = idOf(job);
    if (existing.has(id) || jobIds.has(id)) return;
    jobIds.add(id);
    jobs.push(job);
    ensurePrerequisites(job);
  };
  // job が再利用する参照元（を再帰的に）そろえる。新鮮な既存サンプルがあればそれを使い、無ければ作る
  const ensurePrerequisites = (job: Job) => {
    for (const reuse of reusedInterventions(job.intervention)) {
      const target = byId.get(reuse);
      if (!target) continue; // 定義の整合性は config で検証済み
      // コーパス起点で参照元がモデルを持たない介入なら "none" のセル、それ以外は同じモデルのセルを参照する
      const model = job.source.type === "corpus" && !needsModelForCorpus(target, allInterventions) ? undefined : job.model;
      const prereq: Job = { source: job.source, model, intervention: target, index: job.index };
      touch(prereq);
      if (fresh.has(idOf(prereq)) || jobIds.has(idOf(prereq))) continue;
      jobIds.add(idOf(prereq));
      jobs.push(prereq);
      ensurePrerequisites(prereq);
    }
  };

  for (const source of input.sources) {
    for (const intervention of input.interventions) {
      const modelChoices: (ModelDef | undefined)[] =
        source.type === "corpus" && !needsModelForCorpus(intervention, allInterventions) ? [undefined] : input.models;
      for (const model of modelChoices) {
        for (let index = 0; index < perCell; index += 1) {
          addJob({ source, model, intervention, index });
          // --force で作り直す出力を再利用している介入は、選択されていなくても一緒に作り直す。
          // コーパス起点では baseline（原文）のモデルは "none" だが、依存側（rewrite-pass など）は各モデルを持つ
          if (force) {
            const candidates: (ModelDef | undefined)[] = source.type === "corpus" ? [undefined, ...input.models] : [model];
            for (const dependent of dependentsOf(intervention.id, allInterventions)) {
              for (const m of candidates) {
                if (persisted.has(sampleId(source.id, m?.id ?? "none", dependent.id, index))) {
                  addJob({ source, model: m, intervention: dependent, index });
                }
              }
            }
          }
        }
      }
    }
  }
  return { jobs, cells, skipped: existing.size };
}

/**
 * 触れたセルに、--samples より大きい index の（新鮮な）サンプルが残っていればその id を返す。
 * サンプルは index ごとに保存されるので、数を減らしても古い index は消えず、score / judge / report がそれを使ってしまう
 */
export function extraSamples(cells: Set<string>, perCell: number, freshIds: Iterable<string>): string[] {
  const out: string[] = [];
  for (const id of freshIds) {
    const at = id.lastIndexOf("__");
    if (at < 0) continue;
    const cell = id.slice(0, at);
    const index = Number(id.slice(at + 2));
    if (cells.has(cell) && Number.isInteger(index) && index >= perCell) out.push(id);
  }
  return out.sort();
}
