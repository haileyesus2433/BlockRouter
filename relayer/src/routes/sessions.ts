import { type Address, address, isAddress } from "@solana/kit";
import { Hono } from "hono";

import type { Deps } from "../app";
import { ApiError, invalidRequest } from "../errors";
import { jsonInt } from "../ledger";
import { walletAuth, type WalletEnv } from "../wallet-auth";

const clampZero = (value: bigint) => (value > 0n ? value : 0n);

const notYours = () =>
  new ApiError(404, "not_found_error", "session_not_found", "no session of yours with that address on this relayer");

// Wallet-signed views for the dashboard, so it never has to hold an API key.
export function sessionRoutes(deps: Deps) {
  const routes = new Hono<WalletEnv>();
  routes.use("*", walletAuth(deps));

  async function describe(session: Address) {
    const usage = deps.store.getUsage(session);
    const onChain = await deps.chain.getSession(session);
    const ids = onChain?.allowedModels ?? usage?.models.map((line) => line.modelId) ?? [];
    const models = await deps.ledger.fetchModels([...new Set([...ids, ...(usage?.models.map((line) => line.modelId) ?? [])])]);
    const priced = usage ? { ...usage, models: usage.models.filter((line) => models.has(line.modelId)) } : null;
    const pending = deps.ledger.pendingCharge(priced, models);
    return {
      session,
      open: onChain !== null,
      models: ids.map((id) => deps.ledger.aliasFor(id)?.alias ?? `model ${id}`),
      cap: onChain ? jsonInt(onChain.reservedAmount) : null,
      expires_at: onChain ? jsonInt(onChain.expiresAt) : null,
      pending: jsonInt(pending),
      held: jsonInt(deps.ledger.held(session)),
      remaining: onChain ? jsonInt(clampZero(onChain.reservedAmount - pending - deps.ledger.held(session))) : null,
      requests: usage?.requests ?? 0,
      usage: (usage?.models ?? []).map((line) => ({
        model: deps.ledger.aliasFor(line.modelId)?.alias ?? `model ${line.modelId}`,
        model_id: line.modelId,
        prompt_tokens: jsonInt(line.promptTokens),
        completion_tokens: jsonInt(line.completionTokens),
      })),
      close_requested: usage?.closeRequested ?? false,
      settled_at: usage?.settledAt ?? null,
      settle_signature: usage?.settleSignature ?? null,
      last_error: usage?.lastError ?? null,
    };
  }

  routes.get("/", async (c) => {
    const sessions = deps.store.sessionsForOwner(c.get("wallet"));
    const data = [];
    for (const session of sessions) data.push(await describe(address(session)));
    return c.json({ object: "list", data });
  });

  routes.post("/:address/close", async (c) => {
    const raw = c.req.param("address");
    if (!isAddress(raw)) throw invalidRequest("not a session address");
    const session = await deps.chain.getSession(address(raw));
    if (!session || session.beneficiary !== c.get("wallet")) throw notYours();
    deps.store.requestClose(session.address, deps.nowSecs());
    return c.json({ session: session.address, closing: true, settle_within_secs: deps.config.workerTickSecs }, 202);
  });

  return routes;
}
