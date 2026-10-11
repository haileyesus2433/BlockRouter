# BlockRouter relayer

An OpenAI-compatible gateway in front of on-chain sessions. Any OpenAI client (OpenCode, Cline,
Continue, Aider, the OpenAI SDKs) works with a base URL and a key.

## Run

Node.js 22+ and the repository-pinned pnpm. From the repository root:

```sh
pnpm install --frozen-lockfile
cp relayer/.env.example relayer/.env       # then edit
cd relayer && node --env-file=.env --import tsx src/server.ts
curl http://127.0.0.1:8787/health
```

See `.env.example` for every setting.

## Upstream providers

Each model can be served by a different OpenAI-compatible provider. Copy `providers.example.json`
to `providers.json`, set `PROVIDERS_FILE=providers.json`, and export the key variable each provider
names:

```json
{
  "providers": {
    "deepseek": { "baseUrl": "https://api.deepseek.com/v1", "apiKeyEnv": "DEEPSEEK_API_KEY" },
    "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" }
  },
  "models": {
    "deepseek-v3": { "provider": "deepseek", "upstream": "deepseek-chat" },
    "llama-3.3-70b": { "provider": "openrouter", "upstream": "meta-llama/llama-3.3-70b-instruct" }
  }
}
```

Keys never go in the file. Every alias must be registered on-chain in the deployment, because that
is where its price lives; models with no provider are hidden from `/v1/models` and refused. For a
single provider, `UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY`, and `UPSTREAM_MODELS` still work. With no
upstream configured, the deterministic mock provider answers every model.

The relayer keypair (`RELAYER_KEYPAIR`) signs settlements only. Sessions must be opened with
`--relayer <its address>`, which is printed at startup.

## API

| Route | Auth | |
|---|---|---|
| `GET /health` | none | liveness |
| `GET /v1/models` | none | registered models with raw on-chain rates |
| `POST /v1/keys` | wallet signature | create a key bound to one session; plaintext returned once |
| `GET /v1/keys` | wallet signature | list your keys |
| `PATCH /v1/keys/:id` | wallet signature | set `max_tokens`, the default when a request omits it |
| `GET /v1/sessions` | wallet signature | your sessions with per-model usage and settlement status |
| `POST /v1/sessions/:address/close` | wallet signature | settle a session of yours now, without its API key |
| `DELETE /v1/keys/:id` | wallet signature | revoke immediately |
| `POST /v1/chat/completions` | `Bearer brk_live_...` | OpenAI chat, `stream: true` for SSE |
| `GET /v1/session/current` | `Bearer` | cap, pending usage, remaining, expiry |
| `POST /v1/session/close` | `Bearer` | settle now and release the unused reservation |

Rates are base units per 1,000,000 tokens, exactly as stored on-chain.

**Tool calling** is passed through end to end, so coding agents can read and edit files: `tools`,
`tool_choice`, assistant messages with `tool_calls`, and `tool` result messages go to the upstream
unchanged, and tool calls come back as `message.tool_calls` or streamed `delta.tool_calls` with
`finish_reason: "tool_calls"`. Tool definitions and arguments count toward the prompt estimate.
`temperature`, `top_p`, `stop`, `seed`, `presence_penalty`, `frequency_penalty`, `response_format`,
and `parallel_tool_calls` are forwarded as well.

**Wallet signature.** Key endpoints take `X-BlockRouter-Address`, `X-BlockRouter-Timestamp` (unix
seconds, within 5 minutes), and `X-BlockRouter-Signature` (base58 Ed25519) over:

```
BlockRouter API request
Address: <address>
Method: <METHOD>
Path: <path>
Timestamp: <timestamp>
```

**Responses** carry `X-BlockRouter-Session`, `X-BlockRouter-Charge`, `X-BlockRouter-Remaining`,
and `X-BlockRouter-Session-Expires`. For streams the charge header is the held maximum; the actual
charge is in the final usage chunk.

**Errors** use the OpenAI envelope `{ "error": { "message", "type", "code" } }` with actionable
messages: 401 `invalid_api_key` / `key_revoked`, 402 `no_active_session` / `session_expired` /
`session_cap_exhausted`, 403 `model_not_allowed`, 404 `model_not_found`, 429
`rate_limit_exceeded`, 502 `upstream_error` (nothing is charged).

## Billing

- A key is bound to one session, so a leaked key costs at most that session's cap. A session allows
  up to 8 models; requests for any of them draw on the same cap, each at its own rate.
- Pre-flight clamps `max_tokens` to what the session can still afford, priced at the higher of the
  current and any pending (timelocked) rate. The maximum is held while the request is in flight, so
  concurrent requests cannot overspend.
- The provider's reported usage is billed and written to SQLite before the response ends, so a
  crash does not lose it. An aborted stream bills what was already delivered.
- The settlement worker submits raw token counts only; the program computes the charge. Settling
  closes the session, so each session settles once: on `/v1/session/close`, at
  `SETTLE_THRESHOLD_BPS` of the cap, or within `SETTLE_BEFORE_EXPIRY_SECS` of expiry.

## What is trusted

The program enforces the cap, the rate, which model is billed, and which relayer may settle. The
relayer is trusted for the token counts it reports and for which model actually served the request.
Neither is verified on-chain.

## Security

- Logs hold metadata and token counts only, never prompt or completion content.
- Exception text is never returned or logged. RPC URLs and upstream keys are redacted from
  settlement errors before they are logged or stored.
- Configuration errors are fixed messages that never echo the supplied values.
- Upstream API keys come from the environment only.

## Tests

```sh
pnpm -C relayer test
```

Tests run offline against the mock provider and an in-memory chain.
