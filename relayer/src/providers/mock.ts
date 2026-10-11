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
  /** Answers with this tool call instead of text, unless the last message is a tool result. */
  toolCall?: { name: string; arguments: string };
};

// One token per word keeps completion counts easy to assert in tests.
function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

const tokensFor = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

// Tool definitions and tool-call arguments are prompt tokens too.
export function countPromptTokens(request: ChatRequest): number {
  const messages = request.messages.reduce((total, message) => {
    const calls = (message.tool_calls ?? []).reduce(
      (sum, call) => sum + tokensFor(call.function.name) + tokensFor(call.function.arguments),
      0,
    );
    return total + TOKENS_PER_MESSAGE + tokensFor(message.content ?? "") + calls;
  }, 0);
  return messages + (request.tools ? tokensFor(JSON.stringify(request.tools)) : 0);
}

export class MockProvider implements Provider {
  readonly id = "mock";

  constructor(private readonly options: MockOptions = {}) {}

  countTokens(request: ChatRequest): number {
    return countPromptTokens(request);
  }

  async *chat(request: ChatRequest): AsyncIterable<Chunk> {
    const last = request.messages.at(-1);
    const promptTokens = this.options.reportedPromptTokens ?? countPromptTokens(request);

    if (this.options.toolCall && last?.role !== "tool") {
      const { name, arguments: args } = this.options.toolCall;
      const half = Math.ceil(args.length / 2);
      yield { type: "tool_call", delta: { index: 0, id: "call_mock_0", name, arguments: "" } };
      yield { type: "tool_call", delta: { index: 0, arguments: args.slice(0, half) } };
      yield { type: "tool_call", delta: { index: 0, arguments: args.slice(half) } };
      yield { type: "usage", usage: { promptTokens, completionTokens: tokensFor(name) + tokensFor(args) } };
      return;
    }

    const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
    const reply =
      this.options.reply ??
      (last?.role === "tool" ? `mock reply to tool result: ${last.content}` : `mock reply to: ${lastUser?.content ?? ""}`);
    const tokens = words(reply).slice(0, request.maxTokens);
    for (const [index, token] of tokens.entries()) {
      if (this.options.failAfter !== undefined && index >= this.options.failAfter) {
        throw new Error("mock upstream failure");
      }
      yield { type: "delta", content: index === 0 ? token : ` ${token}` };
    }
    yield { type: "usage", usage: { promptTokens, completionTokens: tokens.length } };
  }
}
