import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";

import {
  allowanceUnavailable,
  type ApiError,
  errorResponse,
  modelNotAllowed,
  modelNotFound,
  noActiveSession,
  sessionCapExhausted,
  sessionExpired,
  sessionSettled,
  upstreamError,
} from "../src/errors";
import { RateLimiter } from "../src/rate-limit";

async function render(error: ApiError) {
  const app = new Hono();
  app.get("/", (c) => errorResponse(c, error));
  const response = await app.request("/");
  return { status: response.status, body: (await response.json()) as { error: Record<string, string> } };
}

const cases: [string, ApiError, number, string, RegExp][] = [
  ["no session", noActiveSession(), 402, "no_active_session", /br session open/],
  ["expired", sessionExpired(1_800_000_000n), 402, "session_expired", /2027-01-15T08:00:00.000Z.*br session open/],
  ["settled", sessionSettled(), 402, "session_expired", /br session open/],
  ["cap", sessionCapExhausted(10n, 5_000_000n), 402, "session_cap_exhausted", /10 of 5000000.*br session open/],
  ["allowance", allowanceUnavailable(), 402, "allowance_unavailable", /sponsor/],
  ["not allowed", modelNotAllowed("gpt", ["deepseek-v3"]), 403, "model_not_allowed", /deepseek-v3/],
  ["not found", modelNotFound("gpt"), 404, "model_not_found", /gpt/],
  ["upstream", upstreamError(), 502, "upstream_error", /no charge/],
];

for (const [name, error, status, code, message] of cases) {
  test(`${name} uses the OpenAI envelope with an actionable message`, async () => {
    const rendered = await render(error);
    assert.equal(rendered.status, status);
    assert.equal(rendered.body.error.code, code);
    assert.match(rendered.body.error.message, message);
    assert.ok(rendered.body.error.type);
  });
}

test("rate limiter blocks past the limit and resets after a minute", () => {
  const limiter = new RateLimiter(2);
  limiter.check(["key:a", "session:s"], 100);
  limiter.check(["key:a", "session:s"], 101);
  assert.throws(() => limiter.check(["key:a", "session:s"], 102), (e: ApiError) => e.status === 429);
  limiter.check(["key:b"], 102);
  limiter.check(["key:a", "session:s"], 160);
});

test("a key over its limit does not consume the session budget", () => {
  const limiter = new RateLimiter(1);
  limiter.check(["key:a"], 100);
  assert.throws(() => limiter.check(["key:a", "session:s"], 101));
  limiter.check(["key:b", "session:s"], 101);
});
