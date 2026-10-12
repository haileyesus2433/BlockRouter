import type { Address } from "@solana/kit";
import { WALLET_AUTH_HEADERS } from "@blockrouter/client";
import type { MiddlewareHandler } from "hono";

import type { Deps } from "./app";
import { verifyWalletRequest } from "./auth";

export type WalletEnv = { Variables: { wallet: Address } };

/** Requires a fresh wallet signature over method, path, and timestamp. */
export function walletAuth(deps: Deps): MiddlewareHandler<WalletEnv> {
  return async (c, next) => {
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
  };
}
