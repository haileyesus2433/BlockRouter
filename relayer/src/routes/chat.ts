import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { Deps } from "../app";
import { verifyApiKey } from "../auth";
import {
  invalidRequest,
  sessionCapExhausted,
  upstreamError,
} from "../errors";
import { type ActiveSession, jsonInt, type ModelChoice, worstCaseRates } from "../ledger";
import { charge, type Rates } from "../pricing";
import {
  type ChatMessage,
  type ChatRequest,
  PASSTHROUGH_OPTIONS,
  type ToolCall,
  type ToolCallDelta,
  type Usage,
} from "../providers/types";
import { RateLimiter } from "../rate-limit";

const DEFAULT_MAX_TOKENS = 4_096;
const RATE_DENOMINATOR = 1_000_000n;
// Prompt estimates are padded because the provider's own count is what gets billed.
const PROMPT_ESTIMATE_NUM = 5n;
const PROMPT_ESTIMATE_DEN = 4n;
const CHARS_PER_TOKEN = 4;
const ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const MAX_TOOLS = 128;

type Body = {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  includeUsage: boolean;
  maxTokens: number | null;
  tools?: unknown[];
  toolChoice?: unknown;
  options: ChatRequest["options"];
};

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : null));
    return parts.every((part) => part !== null) ? parts.join("") : null;
  }
  return null;
}

function parseToolCalls(raw: unknown, index: number): ToolCall[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw invalidRequest(`messages[${index}].tool_calls must be an array`);
  return raw.map((call: any) => {
    if (typeof call?.id !== "string" || typeof call?.function?.name !== "string" || typeof call?.function?.arguments !== "string") {
      throw invalidRequest(`messages[${index}].tool_calls entries need id, function.name, and function.arguments`);
    }
    return { id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } };
  });
}

function parseMessage(message: any, index: number): ChatMessage {
  if (!ROLES.has(message?.role)) throw invalidRequest(`messages[${index}] has an unsupported role`);
  const toolCalls = message.role === "assistant" ? parseToolCalls(message.tool_calls, index) : undefined;
  const content = message.content === null || message.content === undefined ? null : textOf(message.content);
  if (content === null && !(toolCalls && toolCalls.length > 0)) {
    throw invalidRequest(`messages[${index}] must have text content`);
  }
  if (message.role === "tool" && typeof message.tool_call_id !== "string") {
    throw invalidRequest(`messages[${index}] is a tool result and needs tool_call_id`);
  }
  return {
    role: message.role,
    content,
    ...(typeof message.name === "string" ? { name: message.name } : {}),
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
    ...(message.role === "tool" ? { tool_call_id: message.tool_call_id } : {}),
  };
}

function parseBody(raw: any): Body {
  if (!raw || typeof raw.model !== "string") throw invalidRequest("model is required");
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) throw invalidRequest("messages must be a non-empty array");
  const messages = raw.messages.map(parseMessage);
  const maxTokens = raw.max_completion_tokens ?? raw.max_tokens ?? null;
  if (maxTokens !== null && (!Number.isInteger(maxTokens) || maxTokens < 1)) {
    throw invalidRequest("max_tokens must be a positive integer");
  }
  if (raw.tools !== undefined && (!Array.isArray(raw.tools) || raw.tools.length > MAX_TOOLS)) {
    throw invalidRequest(`tools must be an array of at most ${MAX_TOOLS} tool definitions`);
  }
  const options: NonNullable<ChatRequest["options"]> = {};
  for (const name of PASSTHROUGH_OPTIONS) {
    if (raw[name] !== undefined) options[name] = raw[name];
  }
  return {
    model: raw.model,
    messages,
    stream: raw.stream === true,
    includeUsage: raw.stream_options?.include_usage === true,
    maxTokens,
    tools: raw.tools?.length ? raw.tools : undefined,
    toolChoice: raw.tool_choice,
    options,
  };
}

/** Assembles streamed tool-call deltas into complete OpenAI tool calls. */
class ToolCallBuffer {
  private readonly calls = new Map<number, ToolCall>();
  chars = 0;

  add(delta: ToolCallDelta): void {
    const call = this.calls.get(delta.index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
    if (delta.id) call.id = delta.id;
    if (delta.name) call.function.name += delta.name;
    if (delta.arguments) call.function.arguments += delta.arguments;
    this.chars += (delta.name?.length ?? 0) + (delta.arguments?.length ?? 0);
    this.calls.set(delta.index, call);
  }

  list(): ToolCall[] {
    return [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  }

  get size(): number {
    return this.calls.size;
  }
}

function finishReason(usage: Usage, maxTokens: number, toolCalls: number): "tool_calls" | "length" | "stop" {
  if (toolCalls > 0) return "tool_calls";
  return usage.completionTokens >= maxTokens ? "length" : "stop";
}

// SSE delta for one tool-call piece, in OpenAI's shape.
function toolCallFrameDelta(delta: ToolCallDelta) {
  return {
    tool_calls: [
      {
        index: delta.index,
        ...(delta.id ? { id: delta.id, type: "function" } : {}),
        function: {
          ...(delta.name !== undefined ? { name: delta.name } : {}),
          ...(delta.arguments !== undefined ? { arguments: delta.arguments } : {}),
        },
      },
    ],
  };
}

// Upper bound on what adding these tokens can add to the floored on-chain total.
function maxCost(promptTokens: bigint, completionTokens: bigint, rates: Rates): bigint {
  const raw = promptTokens * rates.promptRate + completionTokens * rates.completionRate;
  return (raw + RATE_DENOMINATOR - 1n) / RATE_DENOMINATOR;
}

function affordableCompletion(remaining: bigint, promptTokens: bigint, rates: Rates): bigint {
  const budget = remaining * RATE_DENOMINATOR - promptTokens * rates.promptRate;
  if (budget < 0n) return 0n;
  if (rates.completionRate === 0n) return BigInt(Number.MAX_SAFE_INTEGER);
  return budget / rates.completionRate;
}

export function chatRoutes(deps: Deps) {
  const routes = new Hono();
  const limiter = new RateLimiter(deps.config.rateLimitPerMinute);

  routes.post("/chat/completions", async (c) => {
    const key = verifyApiKey(deps.store, c.req.header("Authorization"));
    limiter.check([`key:${key.id}`, `session:${key.sessionPubkey}`], deps.nowSecs());
    const body = parseBody(await c.req.json().catch(() => null));
    const active = await deps.ledger.resolve(key);
    const choice = deps.ledger.choose(active, body.model);

    const rates = worstCaseRates(choice.model);
    const request: ChatRequest = {
      model: choice.alias.upstream,
      messages: body.messages,
      maxTokens: body.maxTokens ?? key.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
      tools: body.tools,
      toolChoice: body.toolChoice,
      options: body.options,
    };
    const provider = (choice.alias.provider && deps.providers.get(choice.alias.provider)) || deps.provider;
    const estimatedPrompt = provider.countTokens(request);
    const paddedPrompt = (BigInt(estimatedPrompt) * PROMPT_ESTIMATE_NUM + PROMPT_ESTIMATE_DEN - 1n) / PROMPT_ESTIMATE_DEN;

    // No awaits from here until the hold is placed, so concurrent requests see each other's holds.
    const sessionKey = active.session.address;
    const remaining = deps.ledger.remaining(active);
    const affordable = affordableCompletion(remaining, paddedPrompt, rates);
    if (affordable < 1n) throw sessionCapExhausted(remaining, active.session.reservedAmount);
    request.maxTokens = Number(affordable < BigInt(request.maxTokens) ? affordable : BigInt(request.maxTokens));
    const hold = maxCost(paddedPrompt, BigInt(request.maxTokens), rates);
    deps.ledger.hold(sessionKey, hold);

    const before = deps.ledger.pendingCharge(active.usage, active.models);
    let released = false;
    const settle = (usage: Usage | null) => {
      if (released) return 0n;
      released = true;
      deps.ledger.release(sessionKey, hold);
      if (!usage) return 0n;
      deps.store.addUsage(
        sessionKey,
        choice.alias.id,
        usage.promptTokens,
        usage.completionTokens,
        estimatedPrompt,
        deps.nowSecs(),
      );
      const after = deps.ledger.pendingCharge(deps.store.getUsage(sessionKey), active.models);
      log(active, choice, usage, estimatedPrompt, after - before);
      return after - before;
    };

    c.header("X-BlockRouter-Session", sessionKey);
    c.header("X-BlockRouter-Session-Expires", String(active.session.expiresAt));
    const id = `chatcmpl-${randomBytes(12).toString("hex")}`;
    const created = deps.nowSecs();

    if (!body.stream) {
      let content = "";
      let usage: Usage | null = null;
      const toolCalls = new ToolCallBuffer();
      try {
        for await (const chunk of provider.chat(request)) {
          if (chunk.type === "delta") content += chunk.content;
          else if (chunk.type === "tool_call") toolCalls.add(chunk.delta);
          else usage = chunk.usage;
        }
      } catch {
        settle(null);
        throw upstreamError();
      }
      if (!usage) {
        settle(null);
        throw upstreamError();
      }
      const charged = settle(usage);
      c.header("X-BlockRouter-Charge", String(charged));
      c.header("X-BlockRouter-Remaining", String(deps.ledger.remaining({ ...active, usage: deps.store.getUsage(sessionKey) })));
      return c.json({
        id,
        object: "chat.completion",
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: content || (toolCalls.size > 0 ? null : ""),
              ...(toolCalls.size > 0 ? { tool_calls: toolCalls.list() } : {}),
            },
            finish_reason: finishReason(usage, request.maxTokens, toolCalls.size),
          },
        ],
        usage: {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.promptTokens + usage.completionTokens,
        },
      });
    }

    // Streaming headers go out before usage is known, so the charge header is the held maximum.
    c.header("X-BlockRouter-Charge", String(hold));
    c.header("X-BlockRouter-Remaining", String(remaining - hold));
    const controller = new AbortController();
    return streamSSE(c, async (stream) => {
      let streamedChars = 0;
      let usage: Usage | null = null;
      const toolCalls = new ToolCallBuffer();
      const frame = (delta: Record<string, unknown>, finish: string | null) => ({
        id,
        object: "chat.completion.chunk",
        created,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      stream.onAbort(() => {
        controller.abort();
        // Bill what was already delivered so aborting early is not free inference.
        settle({
          promptTokens: estimatedPrompt,
          completionTokens: Math.ceil((streamedChars + toolCalls.chars) / CHARS_PER_TOKEN),
        });
      });

      try {
        await stream.writeSSE({ data: JSON.stringify(frame({ role: "assistant" }, null)) });
        for await (const chunk of provider.chat(request, controller.signal)) {
          if (stream.aborted) return;
          if (chunk.type === "usage") {
            usage = chunk.usage;
            continue;
          }
          if (chunk.type === "tool_call") {
            toolCalls.add(chunk.delta);
            await stream.writeSSE({ data: JSON.stringify(frame(toolCallFrameDelta(chunk.delta), null)) });
            continue;
          }
          streamedChars += chunk.content.length;
          await stream.writeSSE({ data: JSON.stringify(frame({ content: chunk.content }, null)) });
        }
      } catch {
        if (stream.aborted) return;
        settle(null);
        const error = upstreamError();
        await stream.writeSSE({ data: JSON.stringify({ error: { message: error.message, type: error.type, code: error.code } }) });
        await stream.writeSSE({ data: "[DONE]" });
        return;
      }
      if (!usage) {
        settle(null);
        await stream.writeSSE({ data: "[DONE]" });
        return;
      }

      const charged = settle(usage);
      const finish = finishReason(usage, request.maxTokens, toolCalls.size);
      await stream.writeSSE({ data: JSON.stringify(frame({}, finish)) });
      if (body.includeUsage) {
        await stream.writeSSE({
          data: JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: body.model,
            choices: [],
            usage: {
              prompt_tokens: usage.promptTokens,
              completion_tokens: usage.completionTokens,
              total_tokens: usage.promptTokens + usage.completionTokens,
            },
            blockrouter: { charge: jsonInt(charged) },
          }),
        });
      }
      await stream.writeSSE({ data: "[DONE]" });
    });
  });

  return routes;
}

// Metadata and token counts only. Prompt and completion content is never logged.
function log(active: ActiveSession, choice: ModelChoice, usage: Usage, estimatedPrompt: number, charged: bigint) {
  console.log(
    JSON.stringify({
      event: "usage",
      session: active.session.address,
      model: choice.alias.alias,
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      estimated_prompt_tokens: estimatedPrompt,
      prompt_divergence: usage.promptTokens - estimatedPrompt,
      charge: charged.toString(),
    }),
  );
}

