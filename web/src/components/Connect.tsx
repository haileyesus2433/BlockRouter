import { useConnect, useWallets, WalletReadyGate } from "@solana/kit-plugin-wallet/react";
import { useRef, useState } from "react";

import { cluster } from "../config";
import { errorMessage } from "../format";
import { demoIdentity, type Identity, newDemoSecretKey, parseKeypairFile, walletClient } from "../identity";
import { Icon, type IconName, Logo } from "./icons";

function WalletList() {
  const wallets = useWallets(walletClient);
  const { dispatch: connect, error, isRunning } = useConnect(walletClient);
  if (wallets.length === 0) {
    return <p className="muted small center">No Solana wallet found. Install Phantom, Solflare, or Backpack, then reload.</p>;
  }
  return (
    <div className="wallet-list">
      {wallets.map((wallet) => (
        <button key={wallet.name} className="wallet-option" disabled={isRunning} onClick={() => connect(wallet)}>
          {wallet.icon ? <img src={wallet.icon} alt="" width={26} height={26} /> : <Icon name="wallet" />}
          <span>{wallet.name}</span>
          <Icon name="arrow" size={16} />
        </button>
      ))}
      {error ? <p className="error-text small">{errorMessage(error)}</p> : null}
    </div>
  );
}

const POINTS: { icon: IconName; title: string; text: string }[] = [
  { icon: "shield", title: "Self-custodial", text: "Funds sit in a program account only your wallet can withdraw from." },
  { icon: "sessions", title: "Hard caps", text: "Each session locks a budget. A leaked key can never spend more." },
  { icon: "undo", title: "No lost credit", text: "Whatever a session does not spend goes straight back to you." },
];

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
      <div className="connect-copy">
        <div className="connect-brand">
          <Logo size={34} />
          <span>BlockRouter</span>
        </div>
        <h1>
          Pay for AI with money that <span className="gradient-text">stays yours</span>.
        </h1>
        <p className="lead">
          Fund a vault with USDC or USDT, give your coding agent a capped session, and withdraw whatever it does not spend.
        </p>
        <ul className="points">
          {POINTS.map((point) => (
            <li key={point.title}>
              <span className="point-icon">
                <Icon name={point.icon} />
              </span>
              <div>
                <strong>{point.title}</strong>
                <span className="muted">{point.text}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="connect-card">
        <h2>Get started</h2>
        <p className="muted small">Connect a Solana wallet set to {cluster}.</p>
        <WalletReadyGate client={walletClient} fallback={<p className="muted small center">Looking for wallets…</p>}>
          <WalletList />
        </WalletReadyGate>

        {cluster === "localnet" ? (
          <>
            <div className="divider">
              <span>or, for local development</span>
            </div>
            <div className="demo-actions">
              <button className="block" onClick={() => fileInput.current?.click()}>
                Use a keypair file
              </button>
              <button className="ghost block" onClick={async () => onDemo(await demoIdentity(await newDemoSecretKey(), true))}>
                Generate a throwaway wallet
              </button>
            </div>
            <p className="hint">Local chain only. The key is kept in this browser, so never use one that holds real funds.</p>
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
            {error ? <p className="error-text small">{error}</p> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
