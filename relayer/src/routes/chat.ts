import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { Deps } from "../app";
import { verifyApiKey } from "../auth";
import {
  invalidRequest,
  modelNotAllowed,
  modelNotFound,
  sessionCapExhausted,
  upstreamError,
} from "../errors";
import { type ActiveSession, jsonInt, worstCaseRates } from "../ledger";
import { charge, type Rates } from "../pricing";
import type { ChatMessage, ChatRequest, Usage } from "../providers/types";
import { RateLimiter } from "../rate-limit";

const DEFAULT_MAX_TOKENS = 4_096;
const RATE_DENOMINATOR = 1_000_000n;
// Prompt estimates are padded because the provider's own count is what gets billed.
const PROMPT_ESTIMATE_NUM = 5n;
const PROMPT_ESTIMATE_DEN = 4n;
const CHARS_PER_TOKEN = 4;
const ROLES = new Set(["system", "user", "assistant", "tool"]);

type Body = {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  includeUsage: boolean;
  maxTokens: number | null;
  temperature?: number;
};

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : null));
    return parts.every((part) => part !== null) ? parts.join("") : null;
  }
  return null;
}

function parseBody(raw: any): Body {
  if (!raw || typeof raw.model !== "string") throw invalidRequest("model is required");
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) throw invalidRequest("messages must be a non-empty array");
  const messages = raw.messages.map((message: any, index: number) => {
    const content = textOf(message?.content);
    if (!ROLES.has(message?.role) || content === null) {
      throw invalidRequest(`messages[${index}] must have a role and text content`);
    }
    return { role: message.role, content };
  });
  const maxTokens = raw.max_completion_tokens ?? raw.max_tokens ?? null;
  if (maxTokens !== null && (!Number.isInteger(maxTokens) || maxTokens < 1)) {
    throw invalidRequest("max_tokens must be a positive integer");
  }
  return {
    model: raw.model,
    messages,
    stream: raw.stream === true,
    includeUsage: raw.stream_options?.include_usage === true,
    maxTokens,
    temperature: typeof raw.temperature === "number" ? raw.temperature : undefined,
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

    if (body.model !== active.alias.alias) {
      if (!deps.config.models.some((model) => model.alias === body.model)) throw modelNotFound(body.model);
      throw modelNotAllowed(body.model, [active.alias.alias]);
    }

    const rates = worstCaseRates(active.model);
    const request: ChatRequest = {
      model: active.alias.upstream,
      messages: body.messages,
      maxTokens: body.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: body.temperature,
    };
    const estimatedPrompt = deps.provider.countTokens(request);
    const paddedPrompt = (BigInt(estimatedPrompt) * PROMPT_ESTIMATE_NUM + PROMPT_ESTIMATE_DEN - 1n) / PROMPT_ESTIMATE_DEN;

    // No awaits from here until the hold is placed, so concurrent requests see each other's holds.
    const sessionKey = active.session.address;
    const remaining = deps.ledger.remaining(active);
    const affordable = affordableCompletion(remaining, paddedPrompt, rates);
    if (affordable < 1n) throw sessionCapExhausted(remaining, active.session.reservedAmount);
    request.maxTokens = Number(affordable < BigInt(request.maxTokens) ? affordable : BigInt(request.maxTokens));
    const hold = maxCost(paddedPrompt, BigInt(request.maxTokens), rates);
    deps.ledger.hold(sessionKey, hold);

    const before = deps.ledger.pendingCharge(active.usage, active.model);
    let released = false;
    const settle = (usage: Usage | null) => {
      if (released) return 0n;
      released = true;
      deps.ledger.release(sessionKey, hold);
      if (!usage) return 0n;
      deps.store.addUsage(sessionKey, usage.promptTokens, usage.completionTokens, estimatedPrompt, deps.nowSecs());
      const after = deps.ledger.pendingCharge(deps.store.getUsage(sessionKey), active.model);
      log(active, usage, estimatedPrompt, after - before);
      return after - before;
    };

    c.header("X-BlockRouter-Session", sessionKey);
    c.header("X-BlockRouter-Session-Expires", String(active.session.expiresAt));
    const id = `chatcmpl-${randomBytes(12).toString("hex")}`;
    const created = deps.nowSecs();

    if (!body.stream) {
      let content = "";
      let usage: Usage | null = null;
      try {
        for await (const chunk of deps.provider.chat(request)) {
          if (chunk.type === "delta") content += chunk.content;
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
            message: { role: "assistant", content },
            finish_reason: usage.completionTokens >= request.maxTokens ? "length" : "stop",
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
      const frame = (delta: Record<string, string>, finish: string | null) => ({
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
          completionTokens: Math.ceil(streamedChars / CHARS_PER_TOKEN),
        });
      });

      try {
        await stream.writeSSE({ data: JSON.stringify(frame({ role: "assistant" }, null)) });
        for await (const chunk of deps.provider.chat(request, controller.signal)) {
          if (stream.aborted) return;
          if (chunk.type === "usage") {
            usage = chunk.usage;
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
      const finish = usage.completionTokens >= request.maxTokens ? "length" : "stop";
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
function log(active: ActiveSession, usage: Usage, estimatedPrompt: number, charged: bigint) {
  console.log(
    JSON.stringify({
      event: "usage",
      session: active.session.address,
      model: active.alias.alias,
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      estimated_prompt_tokens: estimatedPrompt,
      prompt_divergence: usage.promptTokens - estimatedPrompt,
      charge: charged.toString(),
    }),
  );
}

