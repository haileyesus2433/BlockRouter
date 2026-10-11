import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorType = "invalid_request_error" | "authentication_error" | "insufficient_quota" | "permission_error" | "not_found_error" | "rate_limit_error" | "api_error";

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly type: ErrorType,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// OpenAI error envelope, so OpenAI-compatible clients parse it.
export function errorResponse(c: Context, error: ApiError) {
  return c.json({ error: { message: error.message, type: error.type, code: error.code } }, error.status);
}

export const invalidRequest = (message: string, code = "invalid_request") =>
  new ApiError(400, "invalid_request_error", code, message);

const RENEW = "Open a new session with `br session open --cap <amount> --model <model>` and create a key for it with `br key create`";

function iso(unixSecs: bigint): string {
  return new Date(Number(unixSecs) * 1000).toISOString();
}

export const noActiveSession = () =>
  new ApiError(402, "insufficient_quota", "no_active_session", `no open session for this key. ${RENEW}.`);

export const sessionExpired = (expiresAt: bigint) =>
  new ApiError(402, "insufficient_quota", "session_expired", `session expired at ${iso(expiresAt)}. ${RENEW}.`);

export const sessionSettled = () =>
  new ApiError(
    402,
    "insufficient_quota",
    "session_expired",
    `session was settled and closed, so this key no longer works. ${RENEW}.`,
  );

export const sessionCapExhausted = (remaining: bigint, cap: bigint) =>
  new ApiError(
    402,
    "insufficient_quota",
    "session_cap_exhausted",
    `request could cost more than the session has left: ${remaining} of ${cap} base units remaining. ${RENEW}.`,
  );

export const allowanceUnavailable = () =>
  new ApiError(
    402,
    "insufficient_quota",
    "allowance_unavailable",
    "the allowance funding this session has expired or was revoked. Contact your sponsor.",
  );

export const modelNotAllowed = (requested: string, allowed: string[]) =>
  new ApiError(
    403,
    "permission_error",
    "model_not_allowed",
    `model "${requested}" is not allowed for this session. Allowed: ${allowed.join(", ")}`,
  );

export const modelNotFound = (requested: string) =>
  new ApiError(404, "not_found_error", "model_not_found", `model "${requested}" is unknown or inactive. See GET /v1/models`);

const UPSTREAM_HINTS: Record<number, string> = {
  402: "the upstream account cannot cover this request; a smaller max_tokens may fit (br key update <id> --max-tokens <n>)",
  429: "the upstream provider is rate limiting; retry shortly",
};

export const upstreamError = (status?: number) =>
  new ApiError(
    502,
    "api_error",
    "upstream_error",
    `the upstream provider failed${status ? ` (${status})` : ""}; no charge was recorded for this request${
      status && UPSTREAM_HINTS[status] ? `. ${UPSTREAM_HINTS[status]}` : ""
    }`,
  );

export const rateLimited = (retryAfterSecs: number) =>
  new ApiError(429, "rate_limit_error", "rate_limit_exceeded", `too many requests. Retry in ${retryAfterSecs}s`);
