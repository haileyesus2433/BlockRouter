export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  /** Null only for assistant turns that consist of tool calls. */
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

/** OpenAI sampling options forwarded to the upstream unchanged. */
export const PASSTHROUGH_OPTIONS = [
  "temperature",
  "top_p",
  "stop",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "response_format",
  "parallel_tool_calls",
] as const;

export type ChatRequest = {
  /** Upstream model name, already mapped from the BlockRouter alias. */
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  /** OpenAI tool definitions, forwarded as-is. */
  tools?: unknown[];
  toolChoice?: unknown;
  options?: Partial<Record<(typeof PASSTHROUGH_OPTIONS)[number], unknown>>;
};

export type Usage = {
  promptTokens: number;
  completionTokens: number;
};

/** Streamed piece of a tool call, keyed by index. The first piece for an index carries id and name. */
export type ToolCallDelta = {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
};

export type Chunk =
  | { type: "delta"; content: string }
  | { type: "tool_call"; delta: ToolCallDelta }
  | { type: "usage"; usage: Usage };

/** An upstream answered with an error status. Carries the status only: bodies can echo requests. */
export class UpstreamStatusError extends Error {
  constructor(readonly status: number) {
    super(`upstream returned ${status}`);
    this.name = "UpstreamStatusError";
  }
}

export interface Provider {
  id: string;
  /** Yields content and tool-call deltas, then exactly one usage chunk last. */
  chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<Chunk>;
  /** Conservative pre-flight estimate of prompt tokens. */
  countTokens(request: ChatRequest): number;
}
