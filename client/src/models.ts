import { AccountRole, type Instruction } from "@solana/kit";

import { findModelPda } from "./generated";

/**
 * open_session and settle_session_usage read one Model PDA per model id from their remaining
 * accounts, in the same order as the ids. Codama does not model remaining accounts.
 */
export async function withModelAccounts<T extends Instruction>(instruction: T, modelIds: readonly number[]): Promise<T> {
  const models = await Promise.all(modelIds.map(async (modelId) => (await findModelPda({ modelId }))[0]));
  return {
    ...instruction,
    accounts: [...(instruction.accounts ?? []), ...models.map((address) => ({ address, role: AccountRole.READONLY }))],
  };
}
