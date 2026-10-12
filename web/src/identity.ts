import {
  type Address,
  createClient,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  type Instruction,
  type KeyPairSigner,
  type SignatureBytes,
  type TransactionSigner,
} from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer } from "@solana/kit-plugin-signer";
import { walletSigner } from "@solana/kit-plugin-wallet";

import { rpcUrl, walletChain } from "./config";

/** Read-only RPC shared by every view. */
export const rpc = createSolanaRpc(rpcUrl);

/** Wallet Standard client: the connected wallet signs and pays. */
export const walletClient = createClient()
  .use(walletSigner({ chain: walletChain, autoConnect: true }))
  .use(solanaRpc({ rpcUrl }));

export type WalletClient = typeof walletClient;

/** Whoever is acting: a real wallet or the local demo keypair. */
export type Identity = {
  kind: "wallet" | "demo";
  address: Address;
  label: string;
  /** Signs the instructions that name this identity as their user. */
  signer: TransactionSigner;
  send(instructions: Instruction[]): Promise<string>;
  signMessage(message: Uint8Array): Promise<SignatureBytes>;
};

export function walletIdentity(address: Address, label: string, signer: TransactionSigner): Identity {
  return {
    kind: "wallet",
    address,
    label,
    signer,
    async send(instructions) {
      const result = await walletClient.sendTransaction(instructions);
      return String(result.context.signature);
    },
    signMessage: (message) => walletClient.wallet.signMessage(message),
  };
}

const DEMO_STORAGE_KEY = "blockrouter.demoKeypair";

export async function demoIdentity(secretKey: Uint8Array, remember: boolean): Promise<Identity> {
  const keypair: KeyPairSigner = await createKeyPairSignerFromBytes(secretKey);
  const client = createClient().use(signer(keypair)).use(solanaRpc({ rpcUrl }));
  if (remember) {
    // Local demo only: the page refuses to offer this mode outside localnet.
    try {
      localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify([...secretKey]));
    } catch {
      // Storage unavailable; the demo wallet just won't survive a reload.
    }
  }
  return {
    kind: "demo",
    address: keypair.address,
    label: "Local demo wallet",
    signer: keypair,
    async send(instructions) {
      const result = await client.sendTransaction(instructions);
      return String(result.context.signature);
    },
    async signMessage(message) {
      const [signatures] = await keypair.signMessages([{ content: message, signatures: {} }]);
      return signatures[keypair.address]!;
    },
  };
}

export function storedDemoKey(): Uint8Array | null {
  try {
    const raw = localStorage.getItem(DEMO_STORAGE_KEY);
    return raw ? Uint8Array.from(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function forgetDemoKey(): void {
  try {
    localStorage.removeItem(DEMO_STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}

/** Parses a Solana CLI keypair file: a JSON array of 64 bytes. */
export function parseKeypairFile(text: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file is not a Solana keypair (expected a JSON array of 64 numbers).");
  }
  if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new Error("That file is not a Solana keypair (expected a JSON array of 64 numbers).");
  }
  return Uint8Array.from(parsed);
}

export async function newDemoSecretKey(): Promise<Uint8Array> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const secret = new Uint8Array(64);
  secret.set(pkcs8.slice(-32), 0);
  secret.set(publicKey, 32);
  return secret;
}
