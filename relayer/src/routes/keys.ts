import { type Address, address, isAddress } from "@solana/kit";
import { WALLET_AUTH_HEADERS } from "@blockrouter/client";
import { Hono } from "hono";

import { generateKey, hashKey, verifyWalletRequest } from "../auth";
import { ApiError, invalidRequest } from "../errors";
import type { Deps } from "../app";

const MAX_NAME_LENGTH = 64;

type Env = { Variables: { wallet: Address } };

export function keyRoutes(deps: Deps) {
  const routes = new Hono<Env>();

  routes.use("*", async (c, next) => {
    const wallet = await verifyWalletRequest(
      {
        address: c.req.header(WALLET_AUTH_HEADERS.address),
        signature: c.req.header(WALLET_AUTH_HEADERS.signature),
        timestamp: c.req.header(WALLET_AUTH_HEADERS.timestamp),
      },
      c.req.method,
      new URL(c.req.url).pathname,
      deps.nowSecs(),
    );
    c.set("wallet", wallet);
    await next();
  });

  routes.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) {
      throw invalidRequest(`name is required and must be at most ${MAX_NAME_LENGTH} characters`);
    }
    if (typeof body?.session !== "string" || !isAddress(body.session)) {
      throw invalidRequest("session must be the address of an open session. Open one with `br session open`");
    }

    const wallet = c.get("wallet");
    const session = await deps.chain.getSession(address(body.session));
    if (!session) {
      throw invalidRequest("session not found on-chain. Open one with `br session open`", "invalid_session");
    }
    if (session.beneficiary !== wallet) {
      throw new ApiError(403, "permission_error", "not_session_owner", "only the session's beneficiary can create keys for it");
    }
    if (session.relayer !== deps.chain.relayer) {
      throw invalidRequest(
        `session is bound to relayer ${session.relayer}, not this relayer (${deps.chain.relayer}). Open a session with \`--relayer ${deps.chain.relayer}\``,
        "wrong_relayer",
      );
    }
    if (session.expiresAt <= (await deps.chain.now())) {
      throw invalidRequest("session has expired. Open a new one with `br session open`", "session_expired");
    }

    const { id, key } = generateKey();
    const createdAt = deps.nowSecs();
    deps.store.insertKey({
      id,
      name,
      hash: hashKey(key),
      sessionPubkey: session.address,
      ownerPubkey: wallet,
      createdAt,
      revokedAt: null,
    });
    return c.json({ id, name, key, session: session.address, created_at: createdAt }, 201);
  });

  routes.get("/", (c) => {
    const keys = deps.store.listKeys(c.get("wallet")).map((key) => ({
      id: key.id,
      name: key.name,
      session: key.sessionPubkey,
      created_at: key.createdAt,
      revoked_at: key.revokedAt,
    }));
    return c.json({ object: "list", data: keys });
  });

  routes.delete("/:id", (c) => {
    if (!deps.store.revokeKey(c.req.param("id"), c.get("wallet"), deps.nowSecs())) {
      throw new ApiError(404, "not_found_error", "key_not_found", "no active key with that id for this wallet");
    }
    return c.json({ id: c.req.param("id"), revoked: true });
  });

  return routes;
}
