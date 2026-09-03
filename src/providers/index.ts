import type { z } from "zod";
import type { GenerateRequest, GenerateResponse, ModelDef } from "../types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { MockProvider } from "./mock.ts";
import { OpenAIProvider } from "./openai.ts";

export interface Provider {
  readonly model: ModelDef;
  /** 自由文の生成 */
  generate(req: GenerateRequest): Promise<GenerateResponse>;
  /** スキーマに従う JSON 応答（LLM 判定用） */
  generateJson<T>(req: GenerateRequest, schema: z.ZodType<T>, name: string): Promise<{ value: T; raw: GenerateResponse }>;
}

const cache = new Map<string, Provider>();

export function createProvider(model: ModelDef): Provider {
  const cached = cache.get(model.id);
  if (cached) return cached;
  let provider: Provider;
  switch (model.provider) {
    case "anthropic":
      provider = new AnthropicProvider(model);
      break;
    case "openai":
      provider = new OpenAIProvider(model);
      break;
    case "mock":
      provider = new MockProvider(model);
      break;
    default: {
      const never: never = model.provider;
      throw new Error(`unknown provider: ${String(never)}`);
    }
  }
  cache.set(model.id, provider);
  return provider;
}
