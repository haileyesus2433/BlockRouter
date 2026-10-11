import { countPromptTokens } from "./mock";
import type { ChatRequest, Chunk, Provider, Usage } from "./types";

const CHARS_PER_TOKEN = 4;

// Any OpenAI-compatible upstream (DeepSeek, Together, Groq, vLLM, ...).
export class OpenAICompatibleProvider implements Provider {
  readonly id = "openai-compatible";

  constructor(
    private readonly options: { baseUrl: string; apiKey: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  countTokens(request: ChatRequest): number {
    return countPromptTokens(request);
  }

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<Chunk> {
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!response.ok || !response.body) {
      // Status only: upstream bodies can echo request content.
      throw new Error(`upstream returned ${response.status}`);
    }

    let usage: Usage | null = null;
    let completionChars = 0;
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data);
        const content = event.choices?.[0]?.delta?.content;
        if (typeof content === "string" && content) {
          completionChars += content.length;
          yield { type: "delta", content };
        }
        if (event.usage) {
          usage = {
            promptTokens: Number(event.usage.prompt_tokens),
            completionTokens: Number(event.usage.completion_tokens),
          };
        }
      }
    }
    // Upstreams that omit usage fall back to our estimate.
    yield {
      type: "usage",
      usage: usage ?? {
        promptTokens: countPromptTokens(request),
        completionTokens: Math.ceil(completionChars / CHARS_PER_TOKEN),
      },
    };
  }
}
