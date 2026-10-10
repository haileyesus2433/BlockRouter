export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: readonly ChatMessage[];
}

/** Domain-level stream events. HTTP/SSE framing belongs to future routes. */
export type ChatChunk =
  | { type: "text"; delta: string }
  | {
      type: "done";
      finishReason: "stop" | "length";
      usage?: { promptTokens: number; completionTokens: number };
    };

export interface Provider {
  readonly id: string;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
  /** Return the estimated prompt-token count for this request. */
  countTokens(req: ChatRequest): number;
}
