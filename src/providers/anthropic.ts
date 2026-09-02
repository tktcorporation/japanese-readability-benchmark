import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { GenerateRequest, GenerateResponse, ModelDef } from "../types.ts";
import type { Provider } from "./index.ts";

const DEFAULT_MAX_TOKENS = 8000;

/**
 * Anthropic Messages API。
 *
 * - thinking は既定で adaptive。`thinking: none` のときはパラメータ自体を省略する
 *   （Fable / Opus 5 では `disabled` を送ると 400 になるため）。
 * - temperature は明示されたときだけ送る（Claude 4.7 以降はサンプリング系を受け付けない）。
 * - fallbacks を有効にすると refusal 時に別モデルへ切り替わる。応答した実モデルは servedBy に記録する。
 */
export class AnthropicProvider implements Provider {
  private readonly client: Anthropic;

  constructor(readonly model: ModelDef) {
    if (model.apiKeyEnv) {
      // 指定した変数が未設定なら、既定の資格情報に暗黙に切り替えず止める
      const apiKey = process.env[model.apiKeyEnv];
      if (!apiKey) throw new Error(`モデル "${model.id}" の API キー（環境変数 ${model.apiKeyEnv}）が設定されていません`);
      this.client = new Anthropic({ apiKey });
    } else {
      // ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` のプロファイルの順に解決される
      this.client = new Anthropic();
    }
  }

  private baseParams(req: GenerateRequest): Anthropic.MessageCreateParamsNonStreaming {
    const m = this.model;
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: m.model,
      max_tokens: req.maxTokens ?? m.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: "user", content: req.prompt }],
    };
    if (req.system) params.system = req.system;
    if ((m.thinking ?? "adaptive") === "adaptive") params.thinking = { type: "adaptive" };
    if (m.effort) params.output_config = { effort: m.effort };
    if (m.temperature !== undefined) params.temperature = m.temperature;
    return params;
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const started = Date.now();
    const params = this.baseParams(req);
    const response = this.model.fallbacks
      ? await this.client.beta.messages.create({
          ...params,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        })
      : await this.client.messages.create(params);

    if (response.stop_reason === "refusal") {
      const details = "stop_details" in response ? response.stop_details : undefined;
      const category = details && typeof details === "object" && "category" in details ? String(details.category) : "unknown";
      throw new Error(`refusal (${category})`);
    }
    if (response.stop_reason === "max_tokens") throw new Error("max_tokens に達して出力が途中で切れました");
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      text,
      servedBy: response.model,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      stopReason: response.stop_reason ?? undefined,
      latencyMs: Date.now() - started,
    };
  }

  async generateJson<T>(req: GenerateRequest, schema: z.ZodType<T>, _name: string): Promise<{ value: T; raw: GenerateResponse }> {
    const started = Date.now();
    const response = await this.client.messages.parse({
      ...this.baseParams(req),
      output_config: {
        ...(this.model.effort ? { effort: this.model.effort } : {}),
        format: zodOutputFormat(schema),
      },
    });
    if (response.stop_reason === "refusal") throw new Error("refusal");
    if (!response.parsed_output) throw new Error("structured output の解析に失敗しました");
    return {
      value: response.parsed_output,
      raw: {
        text: JSON.stringify(response.parsed_output),
        servedBy: response.model,
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
        stopReason: response.stop_reason ?? undefined,
        latencyMs: Date.now() - started,
      },
    };
  }
}
