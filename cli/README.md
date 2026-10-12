# br: BlockRouter CLI

Fund a vault, open capped sessions, manage API keys, and withdraw what you did not spend. Run it from
the repository root with `pnpm br <command>`; there is no build step.

| Option | Default | |
|---|---|---|
| `-c, --cluster <name>` | `devnet` | `devnet` or `localnet`; settings come from `deployments/<cluster>.json` |
| `-u, --url <url>` | the cluster's public RPC | |
| `-k, --keypair <path>` | `$BR_KEYPAIR`, then `~/.config/solana/id.json` | Solana CLI keypair file |
| `--relayer-url <url>` | `$BR_RELAYER_URL`, then the deployment's relayer | key commands only |

```sh
br wallet                                   # address, SOL balance, cluster, program

br vault init [--mint usdt|usdc|<address>]
br vault deposit 10
br vault withdraw 2.5 | all                 # all = everything not reserved by a session
br vault status

br session open --cap 5 --model deepseek-v3,llama-3.3-70b [--hours 24 | --minutes 30] [--relayer <address>]
br session status
br session reclaim [id]                     # release expired, unsettled sessions

br key create --name opencode [--session <id|address>] [--max-tokens 16000]
br key list
br key update <id> --max-tokens 32000       # or "default"
br key revoke <id>
```

- Amounts are whole tokens (`2.5` means 2.5 USDT). Program errors are decoded by name.
- `--max-tokens` is the reply length used when a client sends no `max_tokens`, still clamped to what
  the session can afford.
- The CLI only reads an existing keypair, never prints key material, and never echoes file contents
  in errors. RPC URLs are shown by host only, since they can carry API keys.

```sh
pnpm -C cli test    # offline; the wallet is the public RFC 8032 test vector
```
