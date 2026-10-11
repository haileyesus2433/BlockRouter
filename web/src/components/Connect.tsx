import { useConnect, useWallets, WalletReadyGate } from "@solana/kit-plugin-wallet/react";
import { useRef, useState } from "react";

import { cluster } from "../config";
import { errorMessage } from "../format";
import { demoIdentity, type Identity, newDemoSecretKey, parseKeypairFile, walletClient } from "../identity";

function WalletList() {
  const wallets = useWallets(walletClient);
  const { dispatch: connect, error, isRunning } = useConnect(walletClient);
  if (wallets.length === 0) {
    return (
      <p className="muted">
        No Solana wallet found in this browser. Install Phantom, Solflare, or Backpack, then reload.
      </p>
    );
  }
  return (
    <div className="stack">
      {wallets.map((wallet) => (
        <button key={wallet.name} className="wallet-button" disabled={isRunning} onClick={() => connect(wallet)}>
          {wallet.icon ? <img src={wallet.icon} alt="" width={22} height={22} /> : null}
          <span>{wallet.name}</span>
        </button>
      ))}
      {error ? <p className="error-text">{errorMessage(error)}</p> : null}
      {cluster === "localnet" ? (
        <p className="muted small">Most wallets cannot reach a local validator. Use the demo wallet below for local runs.</p>
      ) : null}
    </div>
  );
}

export function Connect({ onDemo }: { onDemo: (identity: Identity) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function useFile(file: File) {
    try {
      onDemo(await demoIdentity(parseKeypairFile(await file.text()), true));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="connect">
      <div className="hero">
        <h1>Pay for AI with money that stays yours</h1>
        <p>
          Keep USDC or USDT in a vault only you control. Give a coding agent a capped session, and withdraw whatever it
          does not spend.
        </p>
      </div>
      <div className="connect-grid">
        <section className="card">
          <h2>Connect a wallet</h2>
          <WalletReadyGate client={walletClient} fallback={<p className="muted">Looking for wallets…</p>}>
            <WalletList />
          </WalletReadyGate>
        </section>
        {cluster === "localnet" ? (
          <section className="card demo-card">
            <h2>Local demo wallet</h2>
            <p className="muted">
              For the local chain only. The key is kept in this browser, so never use a real wallet's key here.
            </p>
            <div className="stack">
              <button onClick={() => fileInput.current?.click()}>Load keypair file</button>
              <p className="muted small">
                Pick <code>keys/demo-user.json</code>; the seed script already funded it with mock USDT.
              </p>
              <button
                className="ghost"
                onClick={async () => onDemo(await demoIdentity(await newDemoSecretKey(), true))}
              >
                Create an empty demo wallet
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void useFile(file);
                }}
              />
              {error ? <p className="error-text">{error}</p> : null}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
