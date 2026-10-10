export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type ChatRequest = {
  /** Upstream model name, already mapped from the BlockRouter alias. */
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
};

export type Usage = {
  promptTokens: number;
  completionTokens: number;
};

export type Chunk = { type: "delta"; content: string } | { type: "usage"; usage: Usage };

export interface Provider {
  id: string;
  /** Yields content deltas, then exactly one usage chunk last. */
  chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<Chunk>;
  /** Conservative pre-flight estimate of prompt tokens. */
  countTokens(request: ChatRequest): number;
}
