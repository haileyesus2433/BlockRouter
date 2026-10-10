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
