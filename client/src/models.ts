import { AccountRole, type Instruction } from "@solana/kit";

import { findModelPda } from "./generated";

// open_session and settle_session_usage read one Model PDA per id from remaining accounts, in order.
// Codama does not model remaining accounts, so they are appended here.
export async function withModelAccounts<T extends Instruction>(instruction: T, modelIds: readonly number[]): Promise<T> {
  const models = await Promise.all(modelIds.map(async (modelId) => (await findModelPda({ modelId }))[0]));
  return {
    ...instruction,
    accounts: [...(instruction.accounts ?? []), ...models.map((address) => ({ address, role: AccountRole.READONLY }))],
  };
}
