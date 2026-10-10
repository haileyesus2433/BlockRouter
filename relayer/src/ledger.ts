import type { Chain, ModelState, SessionState } from "./chain/types";
import type { ModelAlias } from "./config";
import {
  allowanceUnavailable,
  modelNotFound,
  noActiveSession,
  sessionExpired,
  sessionSettled,
} from "./errors";
import { charge, type Rates } from "./pricing";
import type { ApiKeyRecord, Store, UsageRecord } from "./store";

export type ActiveSession = {
  session: SessionState;
  model: ModelState;
  alias: ModelAlias;
  usage: UsageRecord | null;
};

const max = (a: bigint, b: bigint) => (a > b ? a : b);

// Settlement prices usage at whatever rate is live when it lands, so budget against the
// higher of the current and any pending (timelocked) rate.
export function worstCaseRates(model: ModelState): Rates {
  if (model.effectiveAt === 0n) {
    return { promptRate: model.promptRate, completionRate: model.completionRate };
  }
  return {
    promptRate: max(model.promptRate, model.pendingPromptRate),
    completionRate: max(model.completionRate, model.pendingCompletionRate),
  };
}

export class Ledger {
  private readonly holds = new Map<string, bigint>();

  constructor(
    private readonly store: Store,
    private readonly chain: Chain,
    private readonly models: ModelAlias[],
  ) {}

  aliasFor(modelId: number): ModelAlias | undefined {
    return this.models.find((model) => model.id === modelId);
  }

  /** Resolves the live session bound to a key, or throws the error the client should see. */
  async resolve(key: ApiKeyRecord): Promise<ActiveSession> {
    const usage = this.store.getUsage(key.sessionPubkey);
    if (usage && usage.settledAt !== null) throw sessionSettled();

    const session = await this.chain.getSession(key.sessionPubkey as SessionState["address"]);
    if (!session) throw noActiveSession();
    if (session.payerKind !== "vault") throw allowanceUnavailable();
    if (session.expiresAt <= (await this.chain.now())) throw sessionExpired(session.expiresAt);

    const alias = this.aliasFor(session.modelId);
    const model = await this.chain.getModel(session.modelId);
    if (!alias || !model || !model.isActive) throw modelNotFound(alias?.alias ?? String(session.modelId));
    return { session, model, alias, usage };
  }

  pendingCharge(usage: UsageRecord | null, model: ModelState): bigint {
    if (!usage) return 0n;
    return charge(usage.promptTokens, usage.completionTokens, worstCaseRates(model));
  }

  held(session: string): bigint {
    return this.holds.get(session) ?? 0n;
  }

  remaining(active: ActiveSession): bigint {
    const left = active.session.reservedAmount - this.pendingCharge(active.usage, active.model) - this.held(active.session.address);
    return left > 0n ? left : 0n;
  }

  hold(session: string, amount: bigint): void {
    this.holds.set(session, this.held(session) + amount);
  }

  release(session: string, amount: bigint): void {
    const left = this.held(session) - amount;
    if (left > 0n) this.holds.set(session, left);
    else this.holds.delete(session);
  }
}

/** JSON-safe integer: a number when exact, otherwise a decimal string. */
export function jsonInt(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}
