import { Hono } from "hono";

import type { Deps } from "../app";
import { verifyApiKey } from "../auth";
import { jsonInt } from "../ledger";

export function infoRoutes(deps: Deps) {
  const routes = new Hono();

  // Rates are the raw on-chain values (base units per 1,000,000 tokens), never reformatted.
  routes.get("/models", async (c) => {
    const data = [];
    for (const alias of deps.config.models) {
      const model = await deps.chain.getModel(alias.id);
      if (!model) continue;
      data.push({
        id: alias.alias,
        object: "model",
        created: 0,
        owned_by: "blockrouter",
        blockrouter: {
          model_id: model.modelId,
          prompt_rate: jsonInt(model.promptRate),
          completion_rate: jsonInt(model.completionRate),
          pending_prompt_rate: jsonInt(model.pendingPromptRate),
          pending_completion_rate: jsonInt(model.pendingCompletionRate),
          effective_at: jsonInt(model.effectiveAt),
          active: model.isActive,
        },
      });
    }
    return c.json({ object: "list", data });
  });

  routes.get("/session/current", async (c) => {
    const key = verifyApiKey(deps.store, c.req.header("Authorization"));
    const active = await deps.ledger.resolve(key);
    const { session, usage } = active;
    return c.json({
      session: session.address,
      vault: session.vault,
      relayer: session.relayer,
      models: deps.ledger.allowedAliases(active),
      model_ids: session.allowedModels,
      cap: jsonInt(session.reservedAmount),
      pending: jsonInt(deps.ledger.pendingCharge(usage, active.models)),
      held: jsonInt(deps.ledger.held(session.address)),
      remaining: jsonInt(deps.ledger.remaining(active)),
      prompt_tokens: jsonInt(usage?.promptTokens ?? 0n),
      completion_tokens: jsonInt(usage?.completionTokens ?? 0n),
      usage: (usage?.models ?? []).map((line) => ({
        model: deps.ledger.aliasFor(line.modelId)?.alias ?? `model ${line.modelId}`,
        model_id: line.modelId,
        prompt_tokens: jsonInt(line.promptTokens),
        completion_tokens: jsonInt(line.completionTokens),
      })),
      requests: usage?.requests ?? 0,
      expires_at: jsonInt(session.expiresAt),
    });
  });

  // Asks the worker to settle now and release the unused reservation. The key stops working.
  routes.post("/session/close", async (c) => {
    const key = verifyApiKey(deps.store, c.req.header("Authorization"));
    const { session } = await deps.ledger.resolve(key);
    deps.store.requestClose(session.address, deps.nowSecs());
    return c.json({ session: session.address, closing: true, settle_within_secs: deps.config.workerTickSecs }, 202);
  });

  return routes;
}
