import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";
import type { GenerateRequest, GenerateResponse, ModelDef } from "../types.ts";
import type { Provider } from "./index.ts";

const DEFAULT_MAX_TOKENS = 8000;

/**
 * OpenAI Chat Completions API。
 * baseUrl を指定すれば OpenAI 互換エンドポイント（Gemini の互換 API、Ollama、vLLM など）にも使える。
 */
export class OpenAIProvider implements Provider {
  private readonly client: OpenAI;

  constructor(readonly model: ModelDef) {
    const envName = model.apiKeyEnv ?? "OPENAI_API_KEY";
    const apiKey = process.env[envName];
    // 指定した変数が未設定のとき、SDK が OPENAI_API_KEY に暗黙に切り替えると、
    // 無関係な資格情報を互換エンドポイント（Gemini や Ollama など）へ送ってしまう。明示的に止める
    if (!apiKey) throw new Error(`モデル "${model.id}" の API キー（環境変数 ${envName}）が設定されていません`);
    this.client = new OpenAI({
      apiKey,
      ...(model.baseUrl ? { baseURL: model.baseUrl } : {}),
    });
  }

  private messages(req: GenerateRequest): OpenAI.ChatCompletionMessageParam[] {
    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });
    return messages;
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const started = Date.now();
    const completion = await this.client.chat.completions.create({
      model: this.model.model,
      messages: this.messages(req),
      max_completion_tokens: req.maxTokens ?? this.model.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(this.model.temperature !== undefined ? { temperature: this.model.temperature } : {}),
    });
    const choice = completion.choices[0];
    if (!choice) throw new Error("choices が空です");
    if (choice.message.refusal) throw new Error(`refusal: ${choice.message.refusal}`);
    if (choice.finish_reason === "length") throw new Error("max_tokens に達して出力が途中で切れました");
    if (choice.finish_reason === "content_filter") throw new Error("content_filter により出力が打ち切られました");
    if (choice.message.content === null || choice.message.content === undefined) throw new Error("応答に本文がありません");
    return {
      text: choice.message.content,
      servedBy: completion.model,
      usage: { inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens },
      stopReason: choice.finish_reason ?? undefined,
      latencyMs: Date.now() - started,
    };
  }

  async generateJson<T>(req: GenerateRequest, schema: z.ZodType<T>, name: string): Promise<{ value: T; raw: GenerateResponse }> {
    const started = Date.now();
    const completion = await this.client.chat.completions.parse({
      model: this.model.model,
      messages: this.messages(req),
      max_completion_tokens: req.maxTokens ?? this.model.maxTokens ?? DEFAULT_MAX_TOKENS,
      response_format: zodResponseFormat(schema, name),
    });
    const choice = completion.choices[0];
    const parsed = choice?.message.parsed;
    if (!parsed) throw new Error("structured output の解析に失敗しました");
    return {
      value: parsed as T,
      raw: {
        text: choice?.message.content ?? "",
        servedBy: completion.model,
        usage: { inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens },
        stopReason: choice?.finish_reason ?? undefined,
        latencyMs: Date.now() - started,
      },
    };
  }
}
