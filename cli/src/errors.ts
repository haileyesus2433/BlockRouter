import { type BlockrouterError, getBlockrouterErrorMessage } from "@blockrouter/client";

const PROGRAM_ERROR_MIN = 6000;
const PROGRAM_ERROR_MAX = 6999;

// Walks the cause chain for a custom program error code and returns its message.
export function describeError(error: unknown): string {
  let current: unknown = error;
  while (current instanceof Error) {
    const code = (current as { context?: { code?: unknown } }).context?.code;
    if (typeof code === "number" && code >= PROGRAM_ERROR_MIN && code <= PROGRAM_ERROR_MAX) {
      return `${getBlockrouterErrorMessage(code as BlockrouterError)} (program error ${code})`;
    }
    current = current.cause;
  }
  return error instanceof Error ? error.message : String(error);
}
