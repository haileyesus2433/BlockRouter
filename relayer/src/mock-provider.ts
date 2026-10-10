import type { ChatChunk, ChatRequest, Provider } from "./provider.js";

/** Mock tokens are whitespace-separated words; empty/whitespace-only text is zero. */
function countWords(text: string): number {
  return text.match(/\S+/gu)?.length ?? 0;
}

/** Offline deterministic echo adapter. Model and role add no mock token overhead. */
export class MockProvider implements Provider {
  readonly id = "mock";

  countTokens(req: ChatRequest): number {
    return req.messages.reduce(
      (sum, message) => sum + countWords(message.content),
      0,
    );
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    // Snapshot the response and usage before yielding, so caller mutations cannot
    // change a stream midway through consumption.
    const response = req.messages.map((message) => message.content).join("\n");
    const promptTokens = this.countTokens(req);
    if (response.length > 0) yield { type: "text", delta: response };
    yield {
      type: "done",
      finishReason: "stop",
      usage: { promptTokens, completionTokens: countWords(response) },
    };
  }
}
