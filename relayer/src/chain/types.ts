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
  /** Models this session may be billed for. */
  allowedModels: number[];
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

export type UsageLine = {
  modelId: number;
  promptTokens: bigint;
  completionTokens: bigint;
};

export type SettleInput = {
  session: SessionState;
  /** Raw token counts per model; the program prices each line. */
  lines: UsageLine[];
};

export interface Chain {
  /** This relayer's signing address; sessions must name it to be settled. */
  relayer: Address;
  getSession(address: Address): Promise<SessionState | null>;
  getModel(modelId: number): Promise<ModelState | null>;
  /** Submits raw token counts; the program computes the charge. Returns the signature. */
  settle(input: SettleInput): Promise<string>;
  /** Chain clock in unix seconds. */
  now(): Promise<bigint>;
}
