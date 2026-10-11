import { getBase58Decoder, type KeyPairSigner } from "@solana/kit";
import { WALLET_AUTH_HEADERS, walletAuthMessage } from "@blockrouter/client";

const DEFAULT_RELAYER_URL = "http://127.0.0.1:8787";

export function relayerUrl(option: string | undefined, fromDeployment: string | null): string {
  const value = option ?? process.env.BR_RELAYER_URL ?? fromDeployment ?? DEFAULT_RELAYER_URL;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) throw new Error();
  } catch {
    throw new Error("relayer URL must be an absolute HTTP(S) URL without userinfo or a fragment");
  }
  return value.replace(/\/$/, "");
}

/** Signs method, path, and the current time so the relayer can authenticate the wallet. */
export async function signedHeaders(
  signer: KeyPairSigner,
  method: string,
  path: string,
  nowSecs = Math.floor(Date.now() / 1000),
): Promise<Record<string, string>> {
  const content = new TextEncoder().encode(walletAuthMessage(signer.address, method, path, nowSecs));
  const [signatures] = await signer.signMessages([{ content, signatures: {} }]);
  const signature = signatures[signer.address];
  if (!signature) throw new Error("wallet did not produce a signature");
  return {
    [WALLET_AUTH_HEADERS.address]: signer.address,
    [WALLET_AUTH_HEADERS.timestamp]: String(nowSecs),
    [WALLET_AUTH_HEADERS.signature]: getBase58Decoder().decode(signature),
  };
}

export async function relayerRequest<T>(
  baseUrl: string,
  signer: KeyPairSigner,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers = await signedHeaders(signer, method, path);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`cannot reach the relayer at ${new URL(baseUrl).host}. Is it running? Set --relayer-url.`);
  }
  const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `relayer returned ${response.status}`);
  }
  return payload as T;
}
