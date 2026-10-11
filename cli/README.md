# BlockRouter CLI

Issue #21 provides the `br` scaffold, existing-wallet loading and offline client
initialization. Vault, Session and key-management commands will follow separately.

From the repository root, using Node.js 22+ and the pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm --filter @blockrouter/cli build
pnpm --filter @blockrouter/cli br --help
pnpm --filter @blockrouter/cli br --version
```

The package declares the `br` binary at `dist/src/index.js`. To invoke the
executable directly after building:

```sh
./cli/dist/src/index.js --help
```

Initialization needs the generated project IDL. Generate it with the project's
existing Anchor build workflow, then select an **existing** Solana CLI wallet:

```sh
anchor build
pnpm --filter @blockrouter/cli br --wallet ~/.config/solana/id.json --cluster localnet
pnpm --filter @blockrouter/cli br --wallet /absolute/path/wallet.json --cluster devnet
pnpm --filter @blockrouter/cli br --cluster mainnet-beta --rpc-url https://api.mainnet-beta.solana.com --idl /absolute/path/blockrouter.json
```

Relative wallet and IDL paths resolve from the invocation's working directory
(the package directory when using the pnpm script). `~/` wallet paths expand to
the user's home directory. Defaults come from the checkout's `Anchor.toml`:
currently localnet and `~/.config/solana/id.json`. The generated IDL defaults to
`target/idl/blockrouter.json` in this checkout. Keep the CLI in the checkout; this
private workspace package is not a standalone published distribution.

Wallets must be 64-byte Solana keypair JSON arrays. Byte values and the consistency
of the private/public halves are validated. Missing or invalid wallets fail with
exit code 1. The CLI never generates or overwrites wallets, and reports only the
public address. Keep wallet files outside source control and use restrictive file
permissions. Secrets are not included in parser or cryptographic error messages.

Clusters are `localnet`, `devnet`, and `mainnet-beta`, with their standard public
RPC endpoints. `--rpc-url` accepts an absolute HTTP(S) URL without userinfo or a
fragment. An override changes the endpoint only; it does not prove which cluster
the endpoint serves. RPC URLs (including possible query-string credentials) are
not printed by initialization.

## Client API and SDK boundary

`src/wallet.ts` loads a nonextractable Solana Kit `KeyPairSigner`.
`src/config.ts` reads Anchor configuration and selects the endpoint.
`src/client.ts` returns an Anchor `Program`, a Kit RPC client, the Kit signer and
the configured program address. `src/index.ts` is the Commander entry point.

The selected `@anchor-lang/core` 1.2.1 still uses Web3.js `Connection` and provider
types internally; it does **not** accept a Kit signer as an Anchor wallet. The
scaffold uses Anchor's supported read-only provider (`{ connection }`) and keeps
the Kit signer separate. Future commands must explicitly construct and sign
transactions using the appropriate SDK, rather than passing incompatible types
or relying on an implicit global provider. No signing adapter or transaction
submission is implemented here.

The program address comes from `Anchor.toml` and must match the IDL. Its current
localnet and devnet declarations agree. Mainnet selection initializes that same
address offline; it does not imply a verified mainnet deployment. No deployment
is verified or RPC called during initialization, help or version handling.

Deployment remains blocked by the known local deployment-keypair/program-ID
mismatch, the unresolved payment-mint denomination policy and legacy Session
layout migration. This CLI does not alter IDs, keys or legacy accounts. Resolve
these separately before using transaction commands or deploying the program.

## Validation

```sh
pnpm --filter @blockrouter/cli typecheck
pnpm --filter @blockrouter/cli test
pnpm --filter @blockrouter/cli format:check
pnpm -r --if-present run build
git diff --check
```

Tests use temporary wallet files containing a public RFC 8032 test vector, an
offline fixture IDL and child processes for the actual executable. They require
no real wallets, RPC service or funds. There is no existing JavaScript lint setup;
TypeScript's strict checks and Prettier cover the scaffold. Optional native
websocket install scripts are disabled through the workspace configuration;
websocket dependencies support JavaScript fallbacks.
