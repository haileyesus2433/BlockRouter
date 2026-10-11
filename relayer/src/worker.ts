import type { Chain, SessionState } from "./chain/types";
import type { Config } from "./config";
import { type Ledger, worstCaseRates } from "./ledger";
import { charge } from "./pricing";
import type { Redactor } from "./redact";
import type { Store, UsageRecord } from "./store";

const BPS = 10_000n;
const RATE_DENOMINATOR = 1_000_000n;

export type SettleOutcome =
  | { status: "settled"; signature: string; promptTokens: bigint; completionTokens: bigint }
  | { status: "unbillable"; reason: string }
  | { status: "waiting" | "skipped" }
  | { status: "failed"; error: string };

type Trigger = "close" | "threshold" | "expiry" | "interval";

// Settlement closes the session on-chain, so each session settles exactly once.
export class SettlementWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly deps: {
      config: Config;
      chain: Chain;
      store: Store;
      ledger: Ledger;
      nowSecs: () => number;
      redact?: Redactor;
    },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.deps.config.workerTickSecs * 1_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<Map<string, SettleOutcome>> {
    const outcomes = new Map<string, SettleOutcome>();
    if (this.running) return outcomes;
    this.running = true;
    try {
      for (const usage of this.deps.store.unsettled()) {
        outcomes.set(usage.sessionPubkey, await this.process(usage));
      }
    } finally {
      this.running = false;
    }
    return outcomes;
  }

  private trigger(usage: UsageRecord, session: SessionState, pending: bigint, now: bigint): Trigger | null {
    const { config } = this.deps;
    if (session.expiresAt - now <= BigInt(config.settleBeforeExpirySecs)) return "expiry";
    if (usage.closeRequested) return "close";
    if (pending * BPS >= session.reservedAmount * BigInt(config.settleThresholdBps)) return "threshold";
    if (config.settleIntervalSecs > 0 && this.deps.nowSecs() - usage.firstUsageAt >= config.settleIntervalSecs) {
      return "interval";
    }
    return null;
  }

  private async process(usage: UsageRecord): Promise<SettleOutcome> {
    const { chain, store, ledger } = this.deps;
    const key = usage.sessionPubkey;
    const hasUsage = usage.promptTokens > 0n || usage.completionTokens > 0n;
    if (!hasUsage && !usage.closeRequested) return { status: "skipped" };

    const session = await chain.getSession(key as SessionState["address"]);
    if (!session) {
      return this.unbillable(key, "session closed on-chain before settlement (reclaimed or settled elsewhere)");
    }
    const now = await chain.now();
    if (session.expiresAt < now) {
      return this.unbillable(key, "session expired before settlement; the user can reclaim it");
    }
    const model = await chain.getModel(session.modelId);
    if (!model) return { status: "failed", error: `model ${session.modelId} not found` };

    const pending = ledger.pendingCharge(usage, model);
    const trigger = this.trigger(usage, session, pending, now);
    if (!trigger) return { status: "skipped" };

    ledger.beginSettle(key);
    // Let in-flight requests record their usage first, unless expiry is close.
    if (ledger.held(key) > 0n && trigger !== "expiry") return { status: "waiting" };

    const final = store.getUsage(key) ?? usage;
    const { promptTokens, completionTokens } = fitToReservation(final, session, model);
    try {
      const signature = await chain.settle({ session, promptTokens, completionTokens });
      store.markSettled(key, signature, this.deps.nowSecs());
      ledger.endSettle(key);
      console.log(
        JSON.stringify({
          event: "settled",
          session: key,
          trigger,
          signature,
          prompt_tokens: promptTokens.toString(),
          completion_tokens: completionTokens.toString(),
        }),
      );
      return { status: "settled", signature, promptTokens, completionTokens };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = this.deps.redact ? this.deps.redact(raw) : raw;
      store.recordSettleError(key, message);
      ledger.endSettle(key);
      console.error(JSON.stringify({ event: "settle_failed", session: key, trigger, error: message }));
      return { status: "failed", error: message };
    }
  }

  private unbillable(key: string, reason: string): SettleOutcome {
    this.deps.store.markUnbillable(key, reason, this.deps.nowSecs());
    console.error(JSON.stringify({ event: "unbillable", session: key, reason }));
    return { status: "unbillable", reason };
  }
}

// The program rejects a charge above the reservation, which would leave the session unbillable.
// If usage overran (the provider counted more prompt tokens than estimated), bill the most that
// fits and absorb the rest. Never more than was used.
export function fitToReservation(
  usage: UsageRecord,
  session: SessionState,
  model: Parameters<typeof worstCaseRates>[0],
): { promptTokens: bigint; completionTokens: bigint } {
  const rates = worstCaseRates(model);
  const { promptTokens, completionTokens } = usage;
  if (charge(promptTokens, completionTokens, rates) <= session.reservedAmount) {
    return { promptTokens, completionTokens };
  }
  const budget = (session.reservedAmount + 1n) * RATE_DENOMINATOR - 1n;
  const promptCost = promptTokens * rates.promptRate;
  if (promptCost > budget) {
    return { promptTokens: rates.promptRate === 0n ? promptTokens : budget / rates.promptRate, completionTokens: 0n };
  }
  const fit = rates.completionRate === 0n ? completionTokens : (budget - promptCost) / rates.completionRate;
  return { promptTokens, completionTokens: fit < completionTokens ? fit : completionTokens };
}
