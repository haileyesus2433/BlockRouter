# BlockRouter

Self-custodial stablecoin payments for AI inference on Solana.

Inference providers usually sell non-refundable credits behind an international card. BlockRouter
keeps your money in a vault PDA you control, caps what a relayer can take per session, and lets you
withdraw everything you did not spend.

```
  you                         Solana program                         relayer
   |  deposit USDT  --------->  Vault PDA  (balance)                     |
   |  open session (cap 5)  ->  Session PDA (reserves 5, binds model,    |
   |                            binds relayer, expires)                  |
   |  br key create  -------------------------------------------------> key bound to session
   |  OpenAI-compatible requests ---------------------------------------> upstream model
   |                            settle(prompt, completion tokens) <-----  |
   |                            charge = tokens x on-chain rate           |
   |                            provider paid, rest of the cap released   |
   |  withdraw what is left <-  Vault PDA                                 |
```

## How it works

1. **Deposit** USDC or USDT into your vault. Only you can withdraw from it.
2. **Open a session** that reserves a cap (say 5 USDT) for one relayer and up to 8 models, for a
   fixed time. Reserved funds cannot be withdrawn while the session is open, and nothing else can touch
   them.
3. **Create an API key** bound to that session and point any OpenAI-compatible client at the
   relayer. A leaked key can spend at most the session's cap, never your balance.
4. **The relayer settles** by submitting raw token counts per model. The program prices each model
   at its on-chain rate, pays the provider, and releases the rest of the reservation back to your vault.
5. **Withdraw** anything left. If the relayer never settles, reclaim the session after it expires.

## Trust boundary

The program enforces:

- the most a session can spend (its reservation)
- the rate charged per token, from the on-chain model registry (increases are timelocked)
- which models a session can be billed for
- which relayer may settle a session
- that the payout goes only to the configured provider
- that unspent reservations return to the payer, and that withdraw and reclaim keep working while
  the protocol is paused

The relayer is trusted for:

- the token counts it reports
- which model physically served the request

Neither is verified on-chain. The cap bounds the damage: a dishonest relayer can overstate usage only
up to the session's reservation.

Settlement pays the provider directly and the protocol fee is not taken yet. Escrow with a dispute
window is planned but not built.

## Repository

| Path | |
|---|---|
| `programs/blockrouter` | Anchor 1.2 program |
| `tests` | LiteSVM integration tests for the program |
| `client` | `@solana/kit` client generated from the IDL with Codama |
| `cli` | `br`, the command-line wallet ([README](cli/README.md)) |
| `relayer` | OpenAI-compatible gateway and settlement worker ([README](relayer/README.md)) |
| `web` | browser dashboard: vault, sessions, keys, playground ([README](web/README.md)) |
| `scripts` | devnet deploy and seed |
| `deployments` | per-cluster program id, mints, models, relayer |

## Requirements

Anchor 1.2.0, Solana CLI 3.1.x, Rust 1.98.1, Node.js 22+, pnpm 11.

## Quickstart (local validator)

```sh
pnpm install --frozen-lockfile
anchor build --arch v2

# 1. Validator with the program, deploy key as upgrade authority
solana-test-validator --reset --upgradeable-program \
  7maTNWbtCpuCXeRUVCNDR2a9YU7kaeUqtvrqz4ustyyi target/deploy/blockrouter.so keys/devnet-deployer.json

# 2. Fund the deploy and relayer keys, then seed config, models, mock USDT, and a demo vault
solana airdrop 10 $(solana-keygen pubkey keys/devnet-deployer.json) -u localhost
solana airdrop 10 $(solana-keygen pubkey keys/relayer.json) -u localhost
DEPLOYMENT=deployments/localnet.json RPC_URL=http://127.0.0.1:8899 pnpm seed:devnet

# 3. Relayer (mock provider unless UPSTREAM_* is set)
cd relayer && CLUSTER=localnet RELAYER_KEYPAIR=../keys/relayer.json node --import tsx src/server.ts

# 4. As the demo user
export BR_KEYPAIR=keys/demo-user.json
pnpm br -c localnet vault status
pnpm br -c localnet session open --cap 5 --model deepseek-v3 --relayer $(solana-keygen pubkey keys/relayer.json)
pnpm br -c localnet key create --name opencode
```

`key create` prints the two lines your client needs:

```sh
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
export OPENAI_API_KEY="brk_live_..."
```

Then use OpenCode, Cline, Continue, Aider, or any OpenAI SDK with model `deepseek-v3`. When you are
done:

```sh
curl -X POST $OPENAI_BASE_URL/session/close -H "Authorization: Bearer $OPENAI_API_KEY"
pnpm br -c localnet vault withdraw all
```

Or do all of step 4 in the browser: `pnpm -C web dev`, open http://127.0.0.1:5173, and load
`keys/demo-user.json` as the demo wallet.

Key files under `keys/` are created locally and are git-ignored. Generate them with
`solana-keygen new -o keys/<name>.json`.

## Devnet

```sh
./scripts/deploy-devnet.sh       # needs about 4 devnet SOL in keys/devnet-deployer.json
pnpm seed:devnet
```

Devnet supports SBPF v1 and v2, not v3, so the program is built with `--arch v2`. Program id:
`7maTNWbtCpuCXeRUVCNDR2a9YU7kaeUqtvrqz4ustyyi`. Mints: Circle devnet USDC
(`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) and a mock USDT created by the seed script.

## Pricing

Model rates are stored on-chain as base units per 1,000,000 tokens. For a 6-decimal stablecoin,
`270000` means $0.27 per million tokens. The charge is computed on-chain in `u128` and rounded down:

```
charge = (prompt_tokens * prompt_rate + completion_tokens * completion_rate) / 1_000_000
```

Price decreases apply immediately. Increases wait out a timelock, and the relayer budgets against
the higher rate so a pending increase can never push a settlement over its reservation.

## Tests

```sh
anchor build --arch v2 && cargo test     # program, LiteSVM
pnpm typecheck && pnpm test              # CLI and relayer
```

CI runs both on every pull request.
