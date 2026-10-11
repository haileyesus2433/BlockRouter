import type { Chain, ModelState, SessionState, UsageLine } from "./chain/types";
import type { Config } from "./config";
import { type Ledger, worstCaseRates } from "./ledger";
import { charge, type Rates } from "./pricing";
import type { Redactor } from "./redact";
import type { ModelUsageRecord, Store, UsageRecord } from "./store";

const BPS = 10_000n;
const RATE_DENOMINATOR = 1_000_000n;

export type SettleOutcome =
  | { status: "settled"; signature: string; lines: UsageLine[] }
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
    const hasUsage = usage.models.some((line) => line.promptTokens > 0n || line.completionTokens > 0n);
    if (!hasUsage && !usage.closeRequested) return { status: "skipped" };

    const session = await chain.getSession(key as SessionState["address"]);
    if (!session) {
      return this.unbillable(key, "session closed on-chain before settlement (reclaimed or settled elsewhere)");
    }
    const now = await chain.now();
    if (session.expiresAt < now) {
      return this.unbillable(key, "session expired before settlement; the user can reclaim it");
    }
    const models = await ledger.fetchModels(usage.models.map((line) => line.modelId));
    const priceable = { ...usage, models: usage.models.filter((line) => models.has(line.modelId)) };
    const pending = ledger.pendingCharge(priceable, models);
    const trigger = this.trigger(usage, session, pending, now);
    if (!trigger) return { status: "skipped" };

    ledger.beginSettle(key);
    // Let in-flight requests record their usage first, unless expiry is close.
    if (ledger.held(key) > 0n && trigger !== "expiry") return { status: "waiting" };

    const final = store.getUsage(key) ?? usage;
    const finalModels = await ledger.fetchModels(final.models.map((line) => line.modelId));
    const unbillableLines = final.models.filter((line) => !finalModels.get(line.modelId)?.isActive);
    if (unbillableLines.length > 0) {
      // The program rejects inactive or removed models; settle the rest rather than nothing.
      console.error(
        JSON.stringify({ event: "lines_dropped", session: key, model_ids: unbillableLines.map((line) => line.modelId) }),
      );
    }
    const lines = fitToReservation(
      final.models.filter((line) => finalModels.get(line.modelId)?.isActive),
      session.reservedAmount,
      finalModels,
    );
    try {
      const signature = await chain.settle({ session, lines });
      store.markSettled(key, signature, this.deps.nowSecs());
      ledger.endSettle(key);
      console.log(
        JSON.stringify({
          event: "settled",
          session: key,
          trigger,
          signature,
          lines: lines.map((line) => ({
            model_id: line.modelId,
            prompt_tokens: line.promptTokens.toString(),
            completion_tokens: line.completionTokens.toString(),
          })),
        }),
      );
      return { status: "settled", signature, lines };
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
// If usage overran (the provider counted more prompt tokens than estimated), bill lines in order
// until the reservation is used up and absorb the rest. Never more than was used.
export function fitToReservation(
  lines: ModelUsageRecord[],
  reservedAmount: bigint,
  models: Map<number, ModelState>,
): UsageLine[] {
  let budget = reservedAmount;
  const fitted: UsageLine[] = [];
  for (const line of lines) {
    const model = models.get(line.modelId);
    if (!model) continue;
    const rates = worstCaseRates(model);
    const fit = fitLine(line.promptTokens, line.completionTokens, rates, budget);
    budget -= charge(fit.promptTokens, fit.completionTokens, rates);
    fitted.push({ modelId: line.modelId, ...fit });
  }
  return fitted;
}

function fitLine(
  promptTokens: bigint,
  completionTokens: bigint,
  rates: Rates,
  budget: bigint,
): { promptTokens: bigint; completionTokens: bigint } {
  if (charge(promptTokens, completionTokens, rates) <= budget) return { promptTokens, completionTokens };
  // Largest raw value whose floored charge still fits the budget.
  const limit = (budget + 1n) * RATE_DENOMINATOR - 1n;
  const promptCost = promptTokens * rates.promptRate;
  if (promptCost > limit) {
    return { promptTokens: rates.promptRate === 0n ? promptTokens : limit / rates.promptRate, completionTokens: 0n };
  }
  const fit = rates.completionRate === 0n ? completionTokens : (limit - promptCost) / rates.completionRate;
  return { promptTokens, completionTokens: fit < completionTokens ? fit : completionTokens };
}
