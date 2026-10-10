import type { Address } from "@solana/kit";

export type SessionState = {
  address: Address;
  vault: Address;
  payerKind: "vault" | "allowance";
  beneficiary: Address;
  relayer: Address;
  reservedAmount: bigint;
  sessionId: bigint;
  expiresAt: bigint;
  modelId: number;
};

export type ModelState = {
  modelId: number;
  promptRate: bigint;
  completionRate: bigint;
  pendingPromptRate: bigint;
  pendingCompletionRate: bigint;
  effectiveAt: bigint;
  isActive: boolean;
};

export type SettleInput = {
  session: SessionState;
  promptTokens: bigint;
  completionTokens: bigint;
};

export interface Chain {
  getSession(address: Address): Promise<SessionState | null>;
  getModel(modelId: number): Promise<ModelState | null>;
  /** Submits raw token counts; the program computes the charge. Returns the signature. */
  settle(input: SettleInput): Promise<string>;
  /** Chain clock in unix seconds. */
  now(): Promise<bigint>;
}
