import { readFile } from "node:fs/promises";
import { Program, web3, type Idl } from "@anchor-lang/core";
import { createSolanaRpc, type Address, type KeyPairSigner } from "@solana/kit";
import { defaultIdlPath, validateRpcUrl } from "./config.js";

/** Offline initialization: Anchor uses Web3.js internally; Kit's signer stays separate. */
export async function createProgramClient(options: {
  endpoint: string;
  programAddress: Address;
  wallet: KeyPairSigner;
  idlPath?: string;
}) {
  const endpoint = validateRpcUrl(options.endpoint);
  let idl: Idl;
  try {
    idl = JSON.parse(await readFile(options.idlPath ?? defaultIdlPath, "utf8"));
  } catch {
    throw new Error(
      "Cannot load program IDL. Run anchor build or select a generated IDL with --idl.",
    );
  }
  if (
    !idl ||
    typeof idl !== "object" ||
    Array.isArray(idl) ||
    typeof idl.address !== "string"
  ) {
    throw new Error(
      "Cannot initialize program client: invalid or unsupported Anchor IDL.",
    );
  }
  if (idl.address !== options.programAddress) {
    throw new Error("IDL program address does not match Anchor.toml.");
  }
  let program: Program;
  try {
    program = new Program(idl, {
      connection: new web3.Connection(endpoint, "confirmed"),
    });
  } catch {
    throw new Error(
      "Cannot initialize program client: invalid or unsupported Anchor IDL.",
    );
  }
  return {
    program,
    rpc: createSolanaRpc(endpoint),
    wallet: options.wallet,
    programAddress: options.programAddress,
  };
}
