import type { Address } from "@solana/kit";
import { address } from "@solana/kit";
import { useConnectedWallet, useDisconnect } from "@solana/kit-plugin-wallet/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { listSessions, loadMint, type MintInfo, readChainTime, readVault, type SessionView, type VaultView } from "./chain";
import { Connect } from "./components/Connect";
import { Keys } from "./components/Keys";
import { Playground } from "./components/Playground";
import { Sessions } from "./components/Sessions";
import { NoticeBar, type Notice } from "./components/ui";
import { Vault } from "./components/Vault";
import { cluster, deployment, relayerUrl } from "./config";
import { errorMessage, shortAddress, syncChainClock } from "./format";
import { demoIdentity, forgetDemoKey, type Identity, rpc, storedDemoKey, walletClient, walletIdentity } from "./identity";
import { health, type Health } from "./relayer";

const REFRESH_MS = 5_000;

export function App() {
  const connected = useConnectedWallet(walletClient);
  const { dispatch: disconnectWallet } = useDisconnect(walletClient);
  const [demo, setDemo] = useState<Identity | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [relayer, setRelayer] = useState<Health | null>(null);
  const [mintChoice, setMintChoice] = useState<"usdt" | "usdc">(deployment?.mockUsdtMint ? "usdt" : "usdc");
  const [mint, setMint] = useState<MintInfo | null>(null);
  const [vault, setVault] = useState<VaultView | null>(null);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [keySession, setKeySession] = useState<Address | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Restore a demo wallet kept from an earlier visit (local chain only).
  useEffect(() => {
    const stored = cluster === "localnet" ? storedDemoKey() : null;
    if (stored) void demoIdentity(stored, false).then(setDemo).catch(() => forgetDemoKey());
  }, []);

  const identity: Identity | null = useMemo(() => {
    if (demo) return demo;
    if (connected?.signer) return walletIdentity(address(connected.account.address), connected.wallet.name, connected.signer);
    return null;
  }, [demo, connected]);

  const notify = useCallback((value: Notice) => setNotice(value), []);

  useEffect(() => {
    if (!deployment) return;
    const mintAddress = mintChoice === "usdt" ? deployment.mockUsdtMint : deployment.usdcMint;
    if (!mintAddress) return;
    setMint(null);
    loadMint(mintAddress, mintChoice.toUpperCase())
      .then((info) => {
        setMint(info);
        setLoadError(null);
      })
      .catch((error) => setLoadError(errorMessage(error)));
  }, [mintChoice]);

  const refresh = useCallback(async () => {
    health()
      .then(setRelayer)
      .catch(() => setRelayer(null));
    if (!identity || !mint) return;
    try {
      syncChainClock(await readChainTime());
      const view = await readVault(identity.address, mint);
      setVault(view);
      setSessions(view.exists ? await listSessions(view.key) : []);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [identity, mint]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  async function airdrop() {
    if (!identity) return;
    try {
      await rpc.requestAirdrop(identity.address, 2_000_000_000n as never).send();
      notify({ kind: "ok", text: "Airdropped 2 SOL for fees." });
      setTimeout(() => void refresh(), 1_500);
    } catch (error) {
      notify({ kind: "error", text: errorMessage(error) });
    }
  }

  function disconnect() {
    if (demo) {
      forgetDemoKey();
      setDemo(null);
    } else {
      disconnectWallet();
    }
    setVault(null);
    setSessions([]);
  }

  if (!deployment) {
    return (
      <main className="page">
        <div className="card">
          <h2>No deployment for {cluster}</h2>
          <p>
            Run the seed script so <code>deployments/{cluster}.json</code> exists, then reload. See the local test guide.
          </p>
        </div>
      </main>
    );
  }

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ◆
          </span>
          BlockRouter
        </div>
        <div className="topbar-right">
          <span className="pill">{cluster}</span>
          <span className={relayer ? "pill ok" : "pill bad"} title={relayerUrl}>
            {relayer ? `relayer online · ${relayer.providers.join(", ") || "mock"}` : "relayer offline"}
          </span>
          {identity ? (
            <>
              <span className="pill">
                {identity.kind === "demo" ? "demo" : identity.label} · {shortAddress(identity.address)}
              </span>
              <button className="ghost small" onClick={disconnect}>
                Disconnect
              </button>
            </>
          ) : null}
        </div>
      </header>
      <main className="page">
        <NoticeBar notice={notice} onClose={() => setNotice(null)} />
        {!identity ? (
          <Connect onDemo={setDemo} />
        ) : (
          <>
            <div className="toolbar">
              <div className="segmented" role="group" aria-label="Stablecoin">
                {deployment.mockUsdtMint ? (
                  <button className={mintChoice === "usdt" ? "active" : ""} onClick={() => setMintChoice("usdt")}>
                    USDT
                  </button>
                ) : null}
                <button className={mintChoice === "usdc" ? "active" : ""} onClick={() => setMintChoice("usdc")}>
                  USDC
                </button>
              </div>
              {cluster === "localnet" && vault && vault.sol < 1_000_000_000n ? (
                <button className="ghost small" onClick={airdrop}>
                  Airdrop SOL for fees
                </button>
              ) : null}
            </div>
            {loadError ? <p className="error-text">{loadError}</p> : null}
            {mint && vault ? (
              <div className="grid">
                <div className="col">
                  <Vault identity={identity} mint={mint} vault={vault} onChanged={refresh} notify={notify} />
                  <Sessions
                    identity={identity}
                    mint={mint}
                    vault={vault}
                    sessions={sessions}
                    relayer={relayer ? address(relayer.relayer) : null}
                    onChanged={refresh}
                    onCreateKey={(session) => {
                      setKeySession(session);
                      document.getElementById("keys")?.scrollIntoView({ behavior: "smooth" });
                    }}
                    notify={notify}
                  />
                </div>
                <div className="col">
                  <div id="keys">
                    <Keys identity={identity} sessions={sessions} preselect={keySession} notify={notify} />
                  </div>
                  <Playground sessions={sessions} mint={mint} />
                </div>
              </div>
            ) : (
              <p className="muted">Loading your vault…</p>
            )}
          </>
        )}
      </main>
    </>
  );
}
