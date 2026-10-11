import type { Chain, ModelState, SessionState } from "./chain/types";
import type { ModelAlias } from "./config";
import {
  allowanceUnavailable,
  modelNotAllowed,
  modelNotFound,
  noActiveSession,
  sessionExpired,
  sessionSettled,
} from "./errors";
import { charge, type Rates } from "./pricing";
import type { ApiKeyRecord, ModelUsageRecord, Store, UsageRecord } from "./store";

export type ActiveSession = {
  session: SessionState;
  /** On-chain state of every model the session allows that is still registered. */
  models: Map<number, ModelState>;
  usage: UsageRecord | null;
};

export type ModelChoice = { alias: ModelAlias; model: ModelState };

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
  private readonly settling = new Set<string>();

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
    if (this.settling.has(key.sessionPubkey) || (usage && usage.settledAt !== null)) throw sessionSettled();

    const session = await this.chain.getSession(key.sessionPubkey as SessionState["address"]);
    if (!session) throw noActiveSession();
    if (session.payerKind !== "vault") throw allowanceUnavailable();
    if (session.expiresAt <= (await this.chain.now())) throw sessionExpired(session.expiresAt);

    return { session, models: await this.fetchModels(session.allowedModels), usage };
  }

  async fetchModels(ids: readonly number[]): Promise<Map<number, ModelState>> {
    const states = await Promise.all(ids.map((id) => this.chain.getModel(id)));
    return new Map(states.flatMap((model) => (model ? [[model.modelId, model] as const] : [])));
  }

  /** The model a request asks for, if this session may use it. */
  choose(active: ActiveSession, requested: string): ModelChoice {
    const alias = this.models.find((model) => model.alias === requested);
    if (!alias) throw modelNotFound(requested);
    if (!active.session.allowedModels.includes(alias.id)) {
      throw modelNotAllowed(requested, this.allowedAliases(active));
    }
    const model = active.models.get(alias.id);
    if (!model || !model.isActive) throw modelNotFound(requested);
    return { alias, model };
  }

  allowedAliases(active: ActiveSession): string[] {
    return active.session.allowedModels.map((id) => this.aliasFor(id)?.alias ?? `model ${id}`);
  }

  // Each line is floored on its own, exactly as settlement prices it on-chain.
  pendingCharge(usage: UsageRecord | null, models: Map<number, ModelState>): bigint {
    if (!usage) return 0n;
    return usage.models.reduce((total, line) => total + lineCharge(line, models), 0n);
  }

  held(session: string): bigint {
    return this.holds.get(session) ?? 0n;
  }

  remaining(active: ActiveSession): bigint {
    const left = active.session.reservedAmount - this.pendingCharge(active.usage, active.models) - this.held(active.session.address);
    return left > 0n ? left : 0n;
  }

  /** Stops new requests on a session so settlement sees its final usage. */
  beginSettle(session: string): void {
    this.settling.add(session);
  }

  endSettle(session: string): void {
    this.settling.delete(session);
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

function lineCharge(line: ModelUsageRecord, models: Map<number, ModelState>): bigint {
  const model = models.get(line.modelId);
  // A used model that has since been removed still has to be paid for; treat it as unpriceable.
  if (!model) throw modelNotFound(`model ${line.modelId}`);
  return charge(line.promptTokens, line.completionTokens, worstCaseRates(model));
}
