import type { ChatRequest, Chunk, Provider } from "./types";

const CHARS_PER_TOKEN = 4;
const TOKENS_PER_MESSAGE = 4;

export type MockOptions = {
  /** Fixed reply; defaults to an echo of the last user message. */
  reply?: string;
  /** Overrides the reported prompt tokens, to simulate estimate divergence. */
  reportedPromptTokens?: number;
  /** Throws after this many deltas, to simulate an upstream failure. */
  failAfter?: number;
};

// One token per word keeps completion counts easy to assert in tests.
function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export function countPromptTokens(request: ChatRequest): number {
  return request.messages.reduce(
    (total, message) => total + TOKENS_PER_MESSAGE + Math.ceil(message.content.length / CHARS_PER_TOKEN),
    0,
  );
}

export class MockProvider implements Provider {
  readonly id = "mock";

  constructor(private readonly options: MockOptions = {}) {}

  countTokens(request: ChatRequest): number {
    return countPromptTokens(request);
  }

  async *chat(request: ChatRequest): AsyncIterable<Chunk> {
    const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
    const reply = this.options.reply ?? `mock reply to: ${lastUser?.content ?? ""}`;
    const tokens = words(reply).slice(0, request.maxTokens);

    for (const [index, token] of tokens.entries()) {
      if (this.options.failAfter !== undefined && index >= this.options.failAfter) {
        throw new Error("mock upstream failure");
      }
      yield { type: "delta", content: index === 0 ? token : ` ${token}` };
    }
    yield {
      type: "usage",
      usage: {
        promptTokens: this.options.reportedPromptTokens ?? countPromptTokens(request),
        completionTokens: tokens.length,
      },
    };
  }
}
