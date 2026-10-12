import { getBase58Decoder } from "@solana/kit";
import { WALLET_AUTH_HEADERS, walletAuthMessage } from "@blockrouter/client";

import { relayerUrl } from "./config";
import type { Identity } from "./identity";

export type Health = { status: string; cluster: string; relayer: string; providers: string[] };

export type KeyRecord = {
  id: string;
  name: string;
  session: string;
  created_at: number;
  revoked_at: number | null;
  max_tokens: number | null;
};

export type UsageLine = { model: string; model_id: number; prompt_tokens: number; completion_tokens: number };

export type ActivityEntry = {
  id: number;
  model: string;
  model_id: number;
  prompt_tokens: number;
  completion_tokens: number;
  charge: number;
  client: string;
  key_name: string | null;
  created_at: number;
};

export type RelayerSession = {
  session: string;
  open: boolean;
  models: string[];
  cap: number | null;
  expires_at: number | null;
  pending: number;
  remaining: number | null;
  requests: number;
  usage: UsageLine[];
  close_requested: boolean;
  settled_at: number | null;
  settle_signature: string | null;
  last_error: string | null;
};

export class RelayerError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

async function parse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
  if (!response.ok) throw new RelayerError(body?.error?.message ?? `Relayer returned ${response.status}`, body?.error?.code ?? null);
  return body as T;
}

const DEAD_KEY = new Set(["key_revoked", "invalid_api_key"]);

/** Drops a remembered key the relayer no longer accepts, so the page offers a new one instead. */
export function forgetKeyIfDead(session: string, error: unknown): void {
  if (!(error instanceof RelayerError) || !error.code || !DEAD_KEY.has(error.code)) return;
  try {
    const all = JSON.parse(localStorage.getItem(KEY_STORAGE) ?? "{}");
    delete all[session];
    localStorage.setItem(KEY_STORAGE, JSON.stringify(all));
  } catch {
    // Storage unavailable; nothing to forget.
  }
}

export async function health(): Promise<Health> {
  return parse(await fetch(`${relayerUrl}/health`));
}

/** Signs method + path + time with the identity, as the relayer's key endpoints require. */
async function signed<T>(identity: Identity, method: string, path: string, body?: unknown): Promise<T> {
  const timestamp = Math.floor(Date.now() / 1000);
  const message = new TextEncoder().encode(walletAuthMessage(identity.address, method, path, timestamp));
  const signature = await identity.signMessage(message);
  const response = await fetch(`${relayerUrl}${path}`, {
    method,
    headers: {
      [WALLET_AUTH_HEADERS.address]: identity.address,
      [WALLET_AUTH_HEADERS.timestamp]: String(timestamp),
      [WALLET_AUTH_HEADERS.signature]: getBase58Decoder().decode(signature),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parse(response);
}

export const createKey = (identity: Identity, input: { name: string; session: string; max_tokens?: number }) =>
  signed<{ id: string; key: string; session: string; max_tokens: number | null }>(identity, "POST", "/v1/keys", input);
export const listKeys = (identity: Identity) => signed<{ data: KeyRecord[] }>(identity, "GET", "/v1/keys");
export const revokeKey = (identity: Identity, id: string) => signed(identity, "DELETE", `/v1/keys/${id}`);
export const updateKey = (identity: Identity, id: string, maxTokens: number | null) =>
  signed(identity, "PATCH", `/v1/keys/${id}`, { max_tokens: maxTokens });
export const listRelayerSessions = (identity: Identity) =>
  signed<{ data: RelayerSession[] }>(identity, "GET", "/v1/sessions");
export const sessionRequestsSigned = (identity: Identity, session: string) =>
  signed<{ data: ActivityEntry[] }>(identity, "GET", `/v1/sessions/${session}/requests`);
export const closeSession = (identity: Identity, session: string) =>
  signed(identity, "POST", `/v1/sessions/${session}/close`);

export type ChatEvent = { kind: "delta"; text: string } | { kind: "done"; charge: number | null; usage: { prompt: number; completion: number } | null };

/** Streams a chat completion through the relayer with an API key. */
// Chat replies are short; this also keeps a thin upstream balance from rejecting the request.
const PLAYGROUND_MAX_TOKENS = 1024;

export async function* streamChat(
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const response = await fetch(`${relayerUrl}/v1/chat/completions`, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-BlockRouter-Source": "playground" },
    body: JSON.stringify({ model, messages, max_tokens: PLAYGROUND_MAX_TOKENS, stream: true, stream_options: { include_usage: true } }),
  });
  if (!response.ok || !response.body) await parse(response);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let done: ChatEvent = { kind: "done", charge: null, usage: null };
  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data);
      if (event.error) throw new RelayerError(event.error.message, event.error.code ?? null);
      const text = event.choices?.[0]?.delta?.content;
      if (typeof text === "string" && text) yield { kind: "delta", text };
      if (event.usage) {
        done = {
          kind: "done",
          charge: event.blockrouter?.charge ?? null,
          usage: { prompt: event.usage.prompt_tokens, completion: event.usage.completion_tokens },
        };
      }
    }
  }
  yield done;
}

const KEY_STORAGE = "blockrouter.keys";

/** Keys created in this browser, kept for the playground and the setup snippets. */
export function rememberKey(session: string, key: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY_STORAGE) ?? "{}");
    all[session] = key;
    localStorage.setItem(KEY_STORAGE, JSON.stringify(all));
  } catch {
    // Storage unavailable; the key is still shown once.
  }
}

export function rememberedKey(session: string): string | null {
  try {
    return JSON.parse(localStorage.getItem(KEY_STORAGE) ?? "{}")[session] ?? null;
  } catch {
    return null;
  }
}

export type CurrentSession = {
  models: string[];
  cap: number;
  pending: number;
  remaining: number;
  requests: number;
  usage: UsageLine[];
  expires_at: number;
};

/** Live usage through an API key: no wallet signature needed, so it can poll. */
export async function sessionCurrent(apiKey: string): Promise<CurrentSession> {
  return parse(await fetch(`${relayerUrl}/v1/session/current`, { headers: { Authorization: `Bearer ${apiKey}` } }));
}

/** A session's request log through its API key; works after settlement too. */
export async function sessionRequests(apiKey: string, limit = 50): Promise<{ data: ActivityEntry[] }> {
  return parse(await fetch(`${relayerUrl}/v1/session/requests?limit=${limit}`, { headers: { Authorization: `Bearer ${apiKey}` } }));
}
