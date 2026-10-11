import { BN, utils, web3, type Program } from "@anchor-lang/core";

export interface RegistryModel {
  id: string;
  object: "model";
  owned_by: "blockrouter";
  blockrouter: {
    model_id: number;
    prompt_rate: string;
    completion_rate: string;
    active: boolean;
  };
}

export interface ModelRegistry {
  list(): Promise<RegistryModel[]>;
}

function integer(value: unknown, bits: number, signed = false): bigint {
  if (!BN.isBN(value)) throw new Error("Invalid registry integer");
  const result = BigInt((value as BN).toString(10));
  const bound = 1n << BigInt(signed ? bits - 1 : bits);
  if (result < (signed ? -bound : 0n) || result >= bound)
    throw new Error("Invalid registry integer");
  return result;
}

/** Rates are lossless decimal strings in base units per 1,000,000 tokens. */
export function createModelRegistry(program: Program): ModelRegistry {
  const connection = program.provider.connection;
  const discriminator = program.idl.accounts?.find(
    (account) => account.name === "model",
  )?.discriminator;
  if (!discriminator || discriminator.length !== 8)
    throw new Error("Model account missing from IDL");

  return {
    async list() {
      // Discover addresses only. Re-read Models alongside Clock in batches so
      // effective pricing uses the timestamp from the same bank as each Model.
      const discovered = await connection.getProgramAccounts(
        program.programId,
        {
          commitment: "confirmed",
          withContext: true,
          dataSlice: { offset: 0, length: 0 },
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: utils.bytes.bs58.encode(Buffer.from(discriminator)),
              },
            },
          ],
        },
      );
      const result: RegistryModel[] = [];
      for (let offset = 0; offset < discovered.value.length; offset += 99) {
        const addresses = discovered.value
          .slice(offset, offset + 99)
          .map((account) => account.pubkey);
        const snapshot = await connection.getMultipleAccountsInfoAndContext(
          [...addresses, web3.SYSVAR_CLOCK_PUBKEY],
          { commitment: "confirmed", minContextSlot: discovered.context.slot },
        );
        if (snapshot.value.length !== addresses.length + 1)
          throw new Error("Incomplete registry snapshot");
        const clock = snapshot.value[addresses.length];
        if (
          !clock ||
          clock.data.length !== 40 ||
          clock.executable ||
          !clock.owner.equals(
            new web3.PublicKey("Sysvar1111111111111111111111111111111111111"),
          )
        )
          throw new Error("Invalid Clock");
        const now = clock.data.readBigInt64LE(32);
        for (const [index, address] of addresses.entries()) {
          const account = snapshot.value[index];
          if (
            !account ||
            account.executable ||
            !account.owner.equals(program.programId) ||
            account.data.length !== 52
          )
            throw new Error("Invalid Model account");
          const model = program.coder.accounts.decode("model", account.data);
          if (
            !Number.isInteger(model.modelId) ||
            model.modelId < 0 ||
            model.modelId > 65535 ||
            !Number.isInteger(model.bump) ||
            model.bump < 0 ||
            model.bump > 255 ||
            typeof model.isActive !== "boolean"
          )
            throw new Error("Invalid Model fields");
          const seed = Buffer.alloc(2);
          seed.writeUInt16LE(model.modelId);
          const [pda, bump] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("model"), seed],
            program.programId,
          );
          if (!address.equals(pda) || model.bump !== bump)
            throw new Error("Invalid Model PDA");
          const prompt = integer(model.promptRate, 64);
          const completion = integer(model.completionRate, 64);
          const pendingPrompt = integer(model.pendingPromptRate, 64);
          const pendingCompletion = integer(model.pendingCompletionRate, 64);
          const effectiveAt = integer(model.effectiveAt, 64, true);
          const pendingEffective = effectiveAt !== 0n && now >= effectiveAt;
          result.push({
            id: String(model.modelId),
            object: "model",
            owned_by: "blockrouter",
            blockrouter: {
              model_id: model.modelId,
              prompt_rate: (pendingEffective
                ? pendingPrompt
                : prompt
              ).toString(),
              completion_rate: (pendingEffective
                ? pendingCompletion
                : completion
              ).toString(),
              active: model.isActive,
            },
          });
        }
      }
      result.sort((a, b) => a.blockrouter.model_id - b.blockrouter.model_id);
      if (new Set(result.map((model) => model.id)).size !== result.length)
        throw new Error("Duplicate Model");
      return result;
    },
  };
}
