# br: BlockRouter CLI

Fund a self-custodial vault, open capped sessions for a relayer, and reclaim or withdraw what you
did not spend.

## Setup

Node.js 22+ and the repository-pinned pnpm. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm br --help
```

`pnpm br ...` runs `cli/bin/br.js`, which loads the TypeScript sources through `tsx`. There is no
build step.

## Global options

| Option | Default | |
|---|---|---|
| `-c, --cluster <name>` | `devnet` | `devnet` or `localnet` |
| `-u, --url <url>` | the cluster's public RPC | absolute HTTP(S) URL, no userinfo or fragment |
| `-k, --keypair <path>` | `$BR_KEYPAIR`, then `~/.config/solana/id.json` | existing Solana CLI keypair |

Cluster settings (program id, mints, models, relayer) come from `deployments/<cluster>.json`.

## Commands

```sh
br wallet                                   # address, SOL balance, cluster, program

br vault init [--mint usdt|usdc|<address>]
br vault deposit 10
br vault withdraw 2.5
br vault withdraw all                       # everything not reserved by a session
br vault status                             # balance, reserved, available

br session open --cap 5 --model deepseek-v3,llama-3.3-70b [--hours 24 | --minutes 30] [--relayer <address>]
br session status                           # open sessions on your vault
br session reclaim [id]                     # release expired, unsettled sessions

br key create --name opencode [--session <id|address>] [--max-tokens 16000]
br key list
br key update <id> --max-tokens 32000       # or "default"
br key revoke <id>
```

`--max-tokens` is the response length the relayer uses when a client does not send `max_tokens`
(OpenCode does not). Raise it if long file writes get cut off. It is still clamped to what the
session can afford.

A session can allow up to 8 models. One cap is shared across them, and clients can switch between
them freely; each model is billed at its own on-chain rate.

Amounts are whole tokens (`2.5` means 2.5 USDT). `--mint` defaults to the cluster's mock USDT.
Program errors are decoded, for example `Session has not expired yet (program error 6015)`.

## Wallet handling

- The CLI only reads an existing keypair. It never generates, writes, or prints key material.
- The file must be a JSON array of 64 bytes. Byte values and the match between the private and
  public halves are checked, and the loaded private key is non-extractable.
- Error messages never include file contents, so a malformed key does not leak through a parser
  error.
- Keep keypairs out of git (`keys/` is ignored) with restrictive file permissions.

RPC URLs can carry API keys, so `br` prints only the host of a custom `--url`, never its path or
query string.

## Client

Instructions, accounts, PDAs, and errors come from `@blockrouter/client`, the Codama-generated
`@solana/kit` client in `client/`. After changing the program, regenerate it:

```sh
anchor build --arch v2 && pnpm -C client generate
```

## Tests

```sh
pnpm -C cli test
```

Tests run offline and use the public RFC 8032 test vector as a wallet, never a funded key.
