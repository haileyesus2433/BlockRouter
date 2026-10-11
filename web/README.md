# web: BlockRouter dashboard

A browser front end for everything `br` does, plus the client setup that trips people up:

- **Vault**: deposit, withdraw, and see what is reserved by sessions.
- **Sessions**: open a capped session for one or more models, watch live usage, close and settle it, or
  reclaim it after expiry. Settlement history links to each transaction.
- **API keys**: create a key for a session and copy a ready `opencode.json` (key included), the base
  URL for any OpenAI-compatible tool, or a curl command.
- **Playground**: chat with the session's models; each reply shows what it cost. Chats are saved in
  this browser per wallet and can be continued on any active session. The relayer never stores them.
- **Activity**: every request a session served (OpenCode, the playground, curl, any SDK) with its
  model, tokens, and cost, live on the overview and per session. Prompts and replies are not logged.

## Run

```sh
pnpm install --frozen-lockfile
pnpm -C web dev                       # http://127.0.0.1:5173
```

It needs a running validator with the program seeded (`deployments/<cluster>.json`) and the relayer,
whose `CORS_ORIGINS` must include the dashboard's origin (the default covers port 5173).

| Variable | Default | |
|---|---|---|
| `VITE_CLUSTER` | `localnet` | picks `deployments/<cluster>.json` |
| `VITE_RPC_URL` | the cluster's public RPC | |
| `VITE_RELAYER_URL` | the deployment's `relayerUrl`, then `http://127.0.0.1:8787` | |

## Wallets

- **Wallet Standard wallets** (Phantom, Solflare, Backpack) sign every transaction and relayer
  request. Set the wallet to the same cluster.
- **Local demo wallet**, on localnet only: load `keys/demo-user.json` or create an empty one. The key
  is kept in this browser's storage, so never load a real wallet's key.

Requests to the relayer's key and session endpoints are signed by the wallet, so each one asks for a
signature. Live usage and activity poll with the session's API key instead, which needs no signature. The page
only knows API keys created in this browser; for other sessions, activity loads with a signature.
Signed results are kept while the page is open, and the demo wallet loads them without asking.

Session expiry is judged by the chain clock, not this machine's, since local validators drift.
