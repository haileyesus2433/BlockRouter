import type { ModelState } from "./chain/types";

const RATE_DENOMINATOR = 1_000_000n;

export type Rates = { promptRate: bigint; completionRate: bigint };

// Mirrors Model::effective_rates: pending rates apply once effective_at has passed.
export function effectiveRates(model: ModelState, now: bigint): Rates {
  if (model.effectiveAt !== 0n && now >= model.effectiveAt) {
    return { promptRate: model.pendingPromptRate, completionRate: model.pendingCompletionRate };
  }
  return { promptRate: model.promptRate, completionRate: model.completionRate };
}

// Mirrors the on-chain charge: rates are base units per 1,000,000 tokens, rounded down.
export function charge(promptTokens: bigint, completionTokens: bigint, rates: Rates): bigint {
  return (promptTokens * rates.promptRate + completionTokens * rates.completionRate) / RATE_DENOMINATOR;
}
