import { address } from "@solana/kit";
import { useConnectedWallet, useDisconnect } from "@solana/kit-plugin-wallet/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { listSessions, loadMint, type MintInfo, readChainTime, readVault, type SessionView, type VaultView } from "./chain";
import { Connect } from "./components/Connect";
import { Icon, type IconName, Logo } from "./components/icons";
import { Choice, Toasts, useToasts } from "./components/ui";
import { cluster, deployment, relayerUrl } from "./config";
import { type AppData, isActive, type View } from "./context";
import { errorMessage, shortAddress, syncChainClock } from "./format";
import { demoIdentity, forgetDemoKey, type Identity, storedDemoKey, walletClient, walletIdentity } from "./identity";
import { health, type Health } from "./relayer";
import { Keys } from "./views/Keys";
import { Overview } from "./views/Overview";
import { Playground } from "./views/Playground";
import { Sessions } from "./views/Sessions";

const REFRESH_MS = 5_000;

const NAV: { view: View; label: string; icon: IconName }[] = [
  { view: "overview", label: "Overview", icon: "home" },
  { view: "sessions", label: "Sessions", icon: "sessions" },
  { view: "keys", label: "API keys", icon: "key" },
  { view: "playground", label: "Playground", icon: "chat" },
];

function viewFromHash(): View {
  const name = window.location.hash.replace(/^#\/?/, "");
  return NAV.some((item) => item.view === name) ? (name as View) : "overview";
}

function useView(): [View, (view: View) => void] {
  const [view, setView] = useState<View>(viewFromHash);
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = useCallback((next: View) => {
    window.location.hash = `/${next}`;
    window.scrollTo({ top: 0 });
  }, []);
  return [view, go];
}

export function App() {
  const connected = useConnectedWallet(walletClient);
  const { dispatch: disconnectWallet } = useDisconnect(walletClient);
  const { toasts, notify, dismiss } = useToasts();
  const [view, go] = useView();
  const [demo, setDemo] = useState<Identity | null>(null);
  const [relayer, setRelayer] = useState<Health | null>(null);
  // Devnet users can get USDC from Circle's faucet, while mock USDT exists only on the local chain.
  const [mintChoice, setMintChoice] = useState<"usdt" | "usdc">(cluster === "localnet" && deployment?.mockUsdtMint ? "usdt" : "usdc");
  const [mint, setMint] = useState<MintInfo | null>(null);
  const [vault, setVault] = useState<VaultView | null>(null);
  const [sessions, setSessions] = useState<SessionView[]>([]);
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

  const cache = useMemo(() => new Map<string, unknown>(), [identity?.address]);

  useEffect(() => {
    if (!deployment) return;
    const mintAddress = mintChoice === "usdt" ? deployment.mockUsdtMint : deployment.usdcMint;
    if (!mintAddress) return;
    setMint(null);
    setVault(null);
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
      const list = view.exists ? await listSessions(view.key) : [];
      // Set together so no page ever renders a vault without its sessions.
      setSessions(list);
      setVault(view);
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

  if (!deployment || !relayerUrl) {
    return (
      <div className="center-screen">
        <div className="panel narrow">
          <h2>BlockRouter is not available</h2>
          <p className="muted">
            This site is missing its {deployment ? "relayer address" : `${cluster} deployment`}. Please try again later.
          </p>
        </div>
      </div>
    );
  }

  if (!identity) {
    return (
      <>
        <Connect onDemo={setDemo} />
        <Toasts toasts={toasts} dismiss={dismiss} />
      </>
    );
  }

  const app: AppData | null =
    mint && vault ? { identity, mint, vault, sessions, relayer: relayer ? address(relayer.relayer) : null, refresh, notify, go, cache } : null;
  const activeCount = sessions.filter(isActive).length;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Logo />
          <span>BlockRouter</span>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <a key={item.view} href={`#/${item.view}`} className={view === item.view ? "nav-item active" : "nav-item"}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.view === "sessions" && activeCount > 0 ? <span className="nav-badge">{activeCount}</span> : null}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-section">
            <span className="sidebar-label">Stablecoin</span>
            <Choice
              options={[
                ...(deployment.mockUsdtMint ? [{ value: "usdt" as const, label: "USDT" }] : []),
                { value: "usdc" as const, label: "USDC" },
              ]}
              value={mintChoice}
              onChange={setMintChoice}
            />
          </div>
          <div className="account">
            <span className="account-avatar">{identity.address.slice(0, 2)}</span>
            <div className="account-text">
              <strong>{identity.kind === "demo" ? "Demo wallet" : identity.label}</strong>
              <span className="mono muted small">{shortAddress(identity.address)}</span>
            </div>
            <button className="icon-button" onClick={disconnect} aria-label="Disconnect" title="Disconnect">
              <Icon name="logout" />
            </button>
          </div>
        </div>
      </aside>

      <main className={view === "playground" ? "content full" : "content"}>
        {loadError ? <div className="banner bad">{loadError}</div> : null}
        {!app ? (
          <div className="loading">
            <span className="spinner" /> Loading your vault…
          </div>
        ) : view === "sessions" ? (
          <Sessions app={app} />
        ) : view === "keys" ? (
          <Keys app={app} />
        ) : view === "playground" ? (
          <Playground app={app} />
        ) : (
          <Overview app={app} />
        )}
      </main>
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}
