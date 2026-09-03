# japanese-readability-benchmark

LLM が出力する日本語の「読みやすさ・分かりやすさ」を測るベンチマークです。次の 2 つの問いに答えることを目的にしています。

1. **モデル比較** — どのモデルが、何も指示しない素の状態で読みやすい日本語を書くか。
2. **介入評価** — 文章ルール（CLAUDE.md や rules）、textlint、書き直しパスなどの仕組みを入れると、同じ文章がどれだけ改善するか。改善率は何 % か。

評価は 3 層で行います。

| 層 | 手段 | コスト | コマンド |
|---|---|---|---|
| 自動指標 | textlint 違反密度、文長、読点、漢字率、jReadability など | 無料・決定的 | `bench score` |
| LLM 判定 | ルーブリック採点（1〜5 点）と、提示順を入れ替えた pairwise 比較 | API 料金 | `bench judge` |
| 人手評価 | 「どちらが読みやすい？」を Web 画面で集める | 人の時間 | `bench pairs` → `bench serve` |

詳しい設計と指標の定義は [docs/methodology.md](docs/methodology.md) を参照してください。

## クイックスタート（API キー不要）

```bash
pnpm install
pnpm demo        # mock モデルで生成 → 採点 → レポート
cat results/runs/demo/report.md
```

`pnpm demo` は `fixtures/mock/` の固定テキストを返すモックモデル 2 種類（読みやすい文体 / 冗長な文体）に対して、`baseline` と `textlint-fix` の 2 介入を回します。パイプライン全体の動作確認用で、モデルの実力を表すものではありません。

## 実モデルで回す

```bash
cp .env.example .env   # ANTHROPIC_API_KEY / OPENAI_API_KEY を設定（Anthropic は `ant auth login` でも可）
pnpm bench list        # タスク・モデル・介入の一覧

# 1. 生成: タスク × モデル × 介入
pnpm bench run --run 2026-09 --models fable-5.1,opus-5,sonnet-5 --interventions baseline,style-prompt,textlint-fix,rewrite-pass

# 2. 自動指標
pnpm bench score --run 2026-09

# 3. LLM 判定（まず --limit で件数とコストを確認してから）
pnpm bench judge --run 2026-09 --mode both --limit 20
pnpm bench judge --run 2026-09 --mode both

# 4. レポート
pnpm bench report --run 2026-09
```

`results/runs/2026-09/report.md` に次のような表が出ます（数値はイメージ）。

```
## 1. モデル比較（素の出力 = baseline）
| モデル | n | textlint違反/1k字 ↓ | 平均文長 ↓ | 60字超の文 ↓ | 読点/文 ↓ | 漢字率 ↓ | jReadability ↑ | LLM総合 ↑ | LLM対戦勝率 | 人手勝率 |
| fable-5.1 | 8 | 3.10 | 38.2 | 9.5% | 1.4 | 31.2% | 3.41 | 4.25 | 71% (10勝3敗3分) | - |
| opus-5    | 8 | 6.80 | 55.9 | 31.0% | 2.3 | 34.8% | 2.77 | 3.38 | 29% (...) | - |

## 2. 介入の効果（モデル横断）
| 介入 | n | textlint違反/1k字 ↓ | 平均文長 ↓ | ... | LLM総合 ↑ | LLM勝率 vs baseline |
| baseline     | 24 | 5.20 | 48.1 | ... | 3.7 | - |
| style-prompt | 24 | 2.90 (+44.2%) | 39.5 (+17.9%) | ... | 4.2 (+13.5%) | 79% (17勝2敗5分) |
| textlint-fix | 24 | 4.60 (+11.5%) | 48.1 (+0.0%) | ... | 3.8 (+2.7%) | 54% (...) |
```

括弧内が baseline に対する改善率です。

### 既存の文章をどれだけ改善できるか（コーパス起点）

生成を伴わず、`corpus/*.md` の読みにくい原文に介入だけをかけます。`--models` は書き直しに使うモデルの指定になります。

```bash
pnpm bench run --run corpus-2026-09 --corpus --models opus-5 --interventions baseline,textlint-fix,rewrite-pass
pnpm bench score --run corpus-2026-09
pnpm bench judge --run corpus-2026-09 --mode pairwise --schemes interventions
pnpm bench report --run corpus-2026-09
```

### 人手評価

```bash
pnpm bench pairs --run 2026-09 --max 60     # 比較ペアを作る（決定的にシャッフル）
pnpm bench serve --run 2026-09 --port 3000  # http://localhost:3000/ を評価者に共有
pnpm bench human-report --run 2026-09       # 投票数・評価者間一致率
pnpm bench report --run 2026-09             # 人手勝率と LLM 判定との一致率がレポートに載る
```

投票は `results/runs/<run>/votes.jsonl` に追記されます（既定で git 管理外）。画面は `web/` にあり、キーボードの `1` / `2` / `0` でも回答できます。

## 介入を追加する

`interventions/` に YAML を 1 つ置くだけです。ステップは `generate` / `textlint-fix` / `rewrite` を組み合わせます。

```yaml
id: my-skill
name: 自作スキルの指示 + 別モデルで推敲
steps:
  - type: generate
    system: prompts/my-skill.md        # このファイルからの相対パス
  - type: rewrite
    prompt: prompts/rewrite.md
    model: sonnet-5                    # 省略時は生成モデルと同じ
  - type: textlint-fix
    config: ../.textlintrc.json        # 別の lint 設定を試すこともできる
```

- **ルールや CLAUDE.md の効果** を測る → `generate` の `system` にその内容を置く
- **後処理だけの効果** を測る → `generate` に `reuse: baseline` を付けると、生成し直さずに baseline の出力へ後処理をかける（生成のばらつきが混ざらない）
- **textlint のルールセット** を比べる → `textlint-fix` の `config` を変えた介入を複数作る
- **スキルやプラグイン** のように多段で処理するもの → `rewrite` を複数並べる（`passes` で回数指定も可）

## モデルを追加する

`config/models.yaml` に追記します。`anthropic` / `openai`（OpenAI 互換エンドポイント含む）/ `mock` に対応しています。

## ディレクトリ構成

```
tasks/            課題プロンプト（1 ファイル 1 課題）
corpus/           介入評価用の固定文（frontmatter 付き Markdown）
interventions/    介入の定義と、そこで使うプロンプト
config/models.yaml
fixtures/mock/    モックモデルの固定出力
src/
  cli.ts          bench コマンド
  pipeline/       介入パイプラインの実行
  providers/      anthropic / openai / mock
  metrics/        表層指標・jReadability・textlint
  judge/          LLM 判定（rubric / pairwise）
  report/         集計と Markdown 出力
  human/          人手評価のペア生成・サーバー・集計
web/              人手評価の画面
results/runs/<run>/
  samples.jsonl   生成した文章（介入前の文章も含む）
  scores.jsonl    自動指標
  judgments.jsonl LLM 判定
  pairs.json      人手評価用ペア
  votes.jsonl     人手投票
  report.md/json  集計結果
```

## 開発

```bash
pnpm typecheck
pnpm test        # vitest（mock モデルで end-to-end も含む）
```

## ロードマップ

- [ ] 実モデルでのベースライン run を `results/runs/sample/` にコミットする
- [ ] Bradley–Terry / Elo による多モデル順位付け
- [ ] 人手評価画面のホスティング版（静的サイト + 投票 API）
- [ ] textlint 以外の lint（`textlint-rule-preset-japanese`、社内 prh 辞書）の介入を追加
- [ ] 日本語以外の文字混入や Markdown 崩れの検出
