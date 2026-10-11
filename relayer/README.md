# BlockRouter relayer scaffold

Issue #24 adds a Hono HTTP server, validated environment configuration, a
read-only Solana client and the Provider contract. It implements no upstream AI
requests, signing, settlement, mock provider, chat-completions routes or SSE.

## Setup and execution

Use Node.js 22+ and the repository-pinned pnpm. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @blockrouter/relayer build
# Generate the existing Anchor IDL if target/idl/blockrouter.json is absent.
anchor build
pnpm --filter @blockrouter/relayer start
curl http://127.0.0.1:3000/health
```

Startup validates configuration and initializes the client offline before
listening. It requires the generated IDL, but no RPC service, wallet, funds or
upstream credentials. `/health` returns HTTP 200:

```json
{ "status": "ok", "service": "blockrouter-relayer" }
```

This is process liveness, not RPC, deployment or provider readiness. Unknown
routes return JSON 404; request exceptions return a generic JSON 500 without
logging or returning the original error.

For development, use two terminals:

```sh
pnpm --filter @blockrouter/relayer dev
pnpm --filter @blockrouter/relayer watch
```

`dev` builds and watches the compiled server; `watch` recompiles TypeScript on
changes. SIGINT/SIGTERM close the HTTP listener.

## Environment

| Variable         | Default / policy                                                     |
| ---------------- | -------------------------------------------------------------------- |
| `HOST`           | `127.0.0.1`; an IP address or `localhost`                            |
| `PORT`           | `3000`; integer 1–65535                                              |
| `SOLANA_CLUSTER` | Anchor.toml provider cluster; localnet, devnet or mainnet-beta       |
| `RPC_URL`        | Standard endpoint for the selected cluster; HTTP(S) override allowed |
| `PROGRAM_ID`     | Anchor.toml program ID; explicit values must match it                |
| `IDL_PATH`       | Checkout's `target/idl/blockrouter.json`                             |
| `OPENAI_API_KEY` | Optional, environment only; reserved for a future provider           |

No environment variables are mandatory with the current development defaults.
No `.env` file is loaded automatically. Supply variables through the process
environment. Alternatively, copy `.env.example` to a local ignored `.env` and
use Node's explicit env-file support from `relayer/`:

```sh
node --env-file=.env dist/src/server.js
```

Relative IDL paths resolve from the process working directory (the relayer
directory when using its pnpm scripts). RPC URLs cannot contain userinfo or a
fragment. Their query parameters may contain private credentials and are never
logged. Startup logs never print configuration, API keys, SDK exceptions or
stack traces. Upstream keys have no file or hardcoded fallback; the safe example
contains no credential values. Local `.env` files remain ignored by Git.

## Client and Provider API

`src/app.ts` constructs the app without reading environment variables, files or
contacting services. `src/server.ts` performs configuration, client initialization
and listening. `src/config.ts`, `src/client.ts` and `src/provider.ts` are reusable
modules for later features.

The client uses `@anchor-lang/core` 1.2.1 and `@solana/kit` 8.4.0. Anchor still uses
Web3.js Connection/provider types internally: `{ connection }` is its supported
read-only provider. Kit RPC stays separate. No signer or Anchor wallet adapter is
needed here. The relayer does not depend on the CLI package or its unmerged PR.
It follows the same verified SDK boundary without importing the wallet loader.

Program identity is read from Anchor.toml and must agree with the IDL and any
environment value. Mainnet selection uses this configured address offline and
does not assert that a mainnet deployment exists. The known deployment-keypair
and program-ID mismatch remains unresolved; payment-mint denomination policy and
legacy Session migration also remain deployment prerequisites.

`Provider` exposes `id`, `chat(request): AsyncIterable<ChatChunk>` and
`countTokens(request): number`. `ChatRequest` contains a model name and text
messages with system/user/assistant roles. `ChatChunk` contains either a text
delta or a terminal event with finish reason and optional token usage.
`countTokens` estimates prompt usage; reported usage belongs to the terminal
event. Adapters must produce nonnegative integer token counts. The transport
layer will handle SSE framing and error mapping separately. Tool calls,
multimodal input and actual provider implementations are outside this scaffold.

## Validation

```sh
pnpm -r test
pnpm --filter @blockrouter/relayer typecheck
pnpm --filter @blockrouter/relayer build
pnpm -r --if-present run build
pnpm --filter @blockrouter/relayer format:check
git diff --check
```

Tests use temporary IDLs and nonsecret sentinel values, Hono's in-memory request
API and one ephemeral local HTTP listener. They use no external RPC, AI service,
real wallet or credentials. Rust/Anchor source is unchanged.
