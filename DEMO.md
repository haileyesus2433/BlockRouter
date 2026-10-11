# Demo script

About 4 minutes. The story: money stays in your vault, a session caps what the relayer can take, a
real coding agent spends against it, the charge settles on-chain at the on-chain rate, and you
withdraw the rest.

## Before recording

- [ ] Program deployed and seeded on devnet (`./scripts/deploy-devnet.sh`, `pnpm seed:devnet`).
      If devnet is unavailable, use the local validator track at the end. The steps are the same
      with `-c localnet`.
- [ ] `keys/relayer.json` funded with ~0.1 SOL for settlement fees, its address set as `relayer` in
      `deployments/devnet.json`.
- [ ] Demo wallet `keys/demo-user.json` holds SOL and mock USDT (the seed script does this).
- [ ] Relayer running in its own terminal:
      `cd relayer && node --env-file=.env --import tsx src/server.ts`.
      For real model output set `UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY`, and `UPSTREAM_MODELS` in
      `.env`. Without them the mock provider answers.
- [ ] OpenCode installed with this provider in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "blockrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "BlockRouter",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "{env:BLOCKROUTER_API_KEY}"
      },
      "models": {
        "deepseek-v3": { "name": "DeepSeek V3 via BlockRouter" }
      }
    }
  }
}
```

- [ ] Shell prepared: `export BR_KEYPAIR=keys/demo-user.json` and `alias br="pnpm -s br"`.
- [ ] Browser tab on the Solana Explorer, cluster set to devnet.
- [ ] Do a full dry run first; the vault must start from a clean state (`br vault withdraw all`,
      `br session reclaim`).

Layout: left terminal for `br`, right terminal for the relayer log, browser behind.

## 1. The vault (30s)

```sh
br wallet
br vault status
```

Say: the USDT sits in a PDA owned by my wallet. Nobody else can withdraw it.

```sh
br vault deposit 10
br vault status
```

Point at: `balance` went up by 10, `reserved` is 0, `available` is everything.

## 2. A capped session (30s)

```sh
br session open --cap 5 --model deepseek-v3 --hours 1
br vault status
```

Point at: `reserved: 5`, `available: 5`. Say: this session can spend at most 5 USDT, only on
DeepSeek V3, only through this relayer, and only for an hour. No tokens moved; the program just
reserved them.

## 3. A key that can only spend the cap (20s)

```sh
br key create --name opencode
export BLOCKROUTER_API_KEY=brk_live_...    # paste from the output
```

Say: unlike a provider API key, a leaked BlockRouter key costs at most this session's cap, never
the balance.

## 4. A real coding agent spends against it (60s)

Start OpenCode in a small project, run `/models`, pick **DeepSeek V3 via BlockRouter**, and give it
a real task, for example "Read README.md and add a one-line summary at the top." It reads files and
edits them through tool calls, all routed through the relayer. Tool calls need an upstream model
that supports them (DeepSeek V3 does); the mock provider only answers with text.

While it answers, show the relayer terminal: one `usage` line per request with token counts and
the charge. Prompt content is never logged.

```sh
curl -s http://127.0.0.1:8787/v1/session/current -H "Authorization: Bearer $BLOCKROUTER_API_KEY"
```

Point at: `pending` (what the relayer will bill), `remaining` (what is left of the cap).

## 5. Settlement on-chain (45s)

```sh
curl -s -X POST http://127.0.0.1:8787/v1/session/close -H "Authorization: Bearer $BLOCKROUTER_API_KEY"
```

Within a few seconds the relayer logs `"event":"settled"` with a transaction signature. Open it in
the explorer and point at:

- the instruction is `settle_session_usage` with **raw token counts**, not an amount
- the token transfer from the vault to the provider equals the charge the relayer showed
- the session account is closed and its rent returned to you

Say: the relayer reports token counts; the program applies the on-chain rate and can never take more
than the cap. Token counts themselves are trusted to the relayer, and the cap is what bounds that
trust.

## 6. Take the rest back (20s)

```sh
br vault status
br vault withdraw all
br vault status
```

Point at: `reserved` back to 0, the vault drained to 0, the wallet holding everything except the
charge.

Close on the thesis: the credits never left my control, the relayer was capped, and the unspent
balance came back.

## Recovery lines

| Problem | Fix |
|---|---|
| `session_cap_exhausted` | `br session open --cap 5 --model deepseek-v3`, then `br key create` |
| `session_expired` after settling | expected; open a new session and key |
| relayer cannot settle | check the relayer's SOL balance and that the session used `--relayer <its address>` |
| devnet RPC flaky | pass `-u <rpc-url>` to `br` and set `RPC_URL` for the relayer |
| session expired before settling | `br session reclaim` releases the reservation |

## Local validator track

Follow the README quickstart, then run the same steps with `-c localnet` on every `br` command. The
explorer step becomes `solana confirm -v <signature> -u localhost`.
