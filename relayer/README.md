# BlockRouter relayer

OpenAI-compatible gateway in front of on-chain sessions. Any OpenAI client works with a base URL and
a key.

```sh
cp relayer/.env.example relayer/.env       # every setting is documented there
cd relayer && node --env-file=.env --import tsx src/server.ts
```

## Upstream providers

`PROVIDERS_FILE` routes each model to an OpenAI-compatible provider (see `providers.example.json`);
the file names the environment variable holding each key, never the key itself. For one provider,
`UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY`, and `UPSTREAM_MODELS` work instead. Every model must be
registered on-chain, where its price lives. With no provider, a mock answers on localnet only;
elsewhere the relayer refuses to start unless `ALLOW_MOCK_PROVIDER=1`.

## API

| Route | Auth | |
|---|---|---|
| `GET /health` | none | liveness and the relayer's signer address |
| `GET /v1/models` | none | registered models with raw on-chain rates |
| `POST /v1/chat/completions` | API key | OpenAI chat, `stream: true` for SSE, tool calls passed through |
| `GET /v1/session/current` | API key | cap, pending usage, remaining, expiry |
| `GET /v1/session/requests` | API key | served requests, newest first (`?limit=`, max 200) |
| `POST /v1/session/close` | API key | settle now and release the unused reservation |
| `POST /v1/keys` | wallet | create a key bound to one session; shown once |
| `GET /v1/keys` | wallet | list your keys |
| `PATCH /v1/keys/:id` | wallet | set the default `max_tokens` |
| `DELETE /v1/keys/:id` | wallet | revoke |
| `GET /v1/sessions` | wallet | your sessions with per-model usage and settlement status |
| `GET /v1/sessions/:address/requests` | wallet | a session's request log |
| `POST /v1/sessions/:address/close` | wallet | settle a session without its key |

API keys are sent as `Authorization: Bearer brk_live_...`. Wallet routes take `X-BlockRouter-Address`,
`X-BlockRouter-Timestamp` (within 5 minutes), and `X-BlockRouter-Signature`, a base58 Ed25519
signature over:

```
BlockRouter API request
Address: <address>
Method: <METHOD>
Path: <path>
Timestamp: <timestamp>
```

Errors use the OpenAI envelope `{ "error": { "message", "type", "code" } }`. Responses carry
`X-BlockRouter-Charge` and `X-BlockRouter-Remaining`; for streams the final usage chunk has the charge.

## Billing

- A key is bound to one session, so a leaked key can spend at most that session's cap.
- Each request's `max_tokens` is clamped to what the session can still afford, priced at the higher
  of the current and any pending rate, and that maximum is held while the request is in flight.
- Usage is written to SQLite before the response ends. An aborted stream bills what was delivered.
- The worker submits raw token counts only. A session settles once: when closed, at
  `SETTLE_THRESHOLD_BPS` of its cap, or within `SETTLE_BEFORE_EXPIRY_SECS` of expiry.

## Security

- Prompts and replies are never logged or stored; the request log keeps model, tokens, charge, key
  name, and a coarse client label.
- Exception text is never returned. RPC URLs and upstream keys are redacted from logged errors, and
  configuration errors never echo the supplied values.

```sh
pnpm -C relayer test    # offline, against the mock provider and an in-memory chain
```
