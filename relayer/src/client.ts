import { readFile } from "node:fs/promises";
import { Program, web3, type Idl } from "@anchor-lang/core";
import { createSolanaRpc } from "@solana/kit";
import {
  ConfigurationError,
  validateRpcUrl,
  type RelayerConfig,
} from "./config.js";

/** Supported read-only Anchor provider; Kit RPC is a separate, compatible API boundary. */
export async function createProgramClient(
  config: Pick<RelayerConfig, "rpcUrl" | "programId" | "idlPath">,
) {
  const endpoint = validateRpcUrl(config.rpcUrl);
  let idl: Idl;
  try {
    idl = JSON.parse(await readFile(config.idlPath, "utf8"));
    if (
      !idl ||
      typeof idl !== "object" ||
      Array.isArray(idl) ||
      typeof idl.address !== "string"
    )
      throw new Error();
  } catch {
    throw new ConfigurationError(
      "Cannot load Anchor IDL. Run anchor build or set IDL_PATH to a valid generated IDL.",
    );
  }
  if (idl.address !== config.programId)
    throw new ConfigurationError(
      "IDL program address must match PROGRAM_ID and Anchor.toml.",
    );
  try {
    return {
      program: new Program(idl, {
        connection: new web3.Connection(endpoint, "confirmed"),
      }),
      rpc: createSolanaRpc(endpoint),
    };
  } catch {
    throw new ConfigurationError(
      "Cannot initialize the read-only client: invalid or unsupported Anchor IDL.",
    );
  }
}
