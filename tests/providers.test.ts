import { afterEach, describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { OpenAIProvider } from "../src/providers/openai.ts";

const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, CUSTOM_KEY: process.env.CUSTOM_KEY };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("API キーの解決", () => {
  it("OpenAI: apiKeyEnv の変数が未設定なら、OPENAI_API_KEY があっても使わずに止める", () => {
    process.env.OPENAI_API_KEY = "sk-unrelated";
    delete process.env.CUSTOM_KEY;
    expect(() => new OpenAIProvider({ id: "gem", provider: "openai", model: "gemini", baseUrl: "https://example.invalid/v1", apiKeyEnv: "CUSTOM_KEY" })).toThrow(
      "CUSTOM_KEY",
    );
    process.env.CUSTOM_KEY = "custom";
    expect(() => new OpenAIProvider({ id: "gem", provider: "openai", model: "gemini", baseUrl: "https://example.invalid/v1", apiKeyEnv: "CUSTOM_KEY" })).not.toThrow();
  });
  it("OpenAI: 既定の OPENAI_API_KEY もなければ止める", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => new OpenAIProvider({ id: "gpt", provider: "openai", model: "gpt" })).toThrow("OPENAI_API_KEY");
  });
  it("Anthropic: apiKeyEnv の変数が未設定なら既定の資格情報に切り替えずに止める", () => {
    delete process.env.CUSTOM_KEY;
    expect(() => new AnthropicProvider({ id: "c", provider: "anthropic", model: "claude-opus-5", apiKeyEnv: "CUSTOM_KEY" })).toThrow("CUSTOM_KEY");
  });
});
