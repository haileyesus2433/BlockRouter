import type { Deps } from "./app";
import { invalidRequest } from "./errors";
import { jsonInt } from "./ledger";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** A session's served requests, newest first: model, tokens, and charge, never prompt or reply content. */
export function activity(deps: Deps, session: string, limitParam: string | undefined) {
  const limit = limitParam === undefined ? DEFAULT_LIMIT : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw invalidRequest(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
  return {
    object: "list",
    session,
    data: deps.store.requestsFor(session, limit).map((entry) => ({
      id: entry.id,
      model: deps.ledger.aliasFor(entry.modelId)?.alias ?? `model ${entry.modelId}`,
      model_id: entry.modelId,
      prompt_tokens: entry.promptTokens,
      completion_tokens: entry.completionTokens,
      charge: jsonInt(entry.charge),
      client: entry.client,
      key_name: entry.keyName,
      created_at: entry.createdAt,
    })),
  };
}
