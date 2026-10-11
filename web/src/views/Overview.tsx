import { type ReactNode, useState } from "react";

import { ActivityList } from "../components/Activity";
import { Icon } from "../components/icons";
import { Choice, Meter, Modal, PageHeader, Panel, useRunner } from "../components/ui";
import { cluster, modelAlias } from "../config";
import { type AppData, isActive } from "../context";
import { formatUnits, parseAmount, timeLeft } from "../format";
import { useActivityFeed, useSessionUsage } from "../hooks";
import { rpc } from "../identity";
import { rememberedKey } from "../relayer";
import { deposit, withdraw } from "../tx";
import type { SessionView } from "../chain";

type Mode = "deposit" | "withdraw";

function Amount({ value, decimals, label }: { value: bigint; decimals: number; label: string }) {
  const [whole, fraction] = formatUnits(value, decimals).split(".");
  return (
    <span className="amount-display">
      {whole}
      {fraction ? <span className="fraction">.{fraction}</span> : null}
      <span className="ticker">{label}</span>
    </span>
  );
}

function TransferModal({ app, initial, onClose }: { app: AppData; initial: Mode; onClose: () => void }) {
  const { identity, mint, vault, notify, refresh } = app;
  const [mode, setMode] = useState<Mode>(initial);
  const [amount, setAmount] = useState("");
  const { busy, run } = useRunner(notify);
  const available = vault.balance - vault.reserved;
  const max = mode === "deposit" ? vault.wallet : available;

  async function submit() {
    let value: bigint;
    try {
      value = parseAmount(amount, mint.decimals);
    } catch (error) {
      return notify({ kind: "error", text: (error as Error).message });
    }
    if (value > max) return notify({ kind: "error", text: `You can ${mode} at most ${formatUnits(max, mint.decimals)} ${mint.label}.` });
    const signature = await run(
      mode,
      () => (mode === "deposit" ? deposit(identity, mint, vault, value) : withdraw(identity, mint, value)),
      (sig) => ({
        kind: "ok",
        text: `${mode === "deposit" ? "Deposited" : "Withdrew"} ${formatUnits(value, mint.decimals)} ${mint.label}`,
        signature: sig,
      }),
    );
    await refresh();
    if (signature) onClose();
  }

  return (
    <Modal title="Move funds" onClose={onClose}>
      <Choice
        options={[
          { value: "deposit", label: "Deposit" },
          { value: "withdraw", label: "Withdraw" },
        ]}
        value={mode}
        onChange={setMode}
      />
      <div className="field">
        <div className="field-label">
          <span>Amount</span>
          <button type="button" className="link small" onClick={() => setAmount(formatUnits(max, mint.decimals).replace(/,/g, ""))}>
            Max {formatUnits(max, mint.decimals)}
          </button>
        </div>
        <div className="big-input">
          <input autoFocus inputMode="decimal" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} />
          <span>{mint.label}</span>
        </div>
        <p className="hint">
          {mode === "deposit"
            ? `From your wallet, which holds ${formatUnits(vault.wallet, mint.decimals)} ${mint.label}.`
            : `Back to your wallet. Funds reserved by open sessions stay locked until they settle.`}
        </p>
      </div>
      <button className="primary block" disabled={busy !== null || !amount} onClick={submit}>
        {busy ? "Confirm in your wallet…" : mode === "deposit" ? (vault.exists ? "Deposit" : "Create vault and deposit") : "Withdraw"}
      </button>
    </Modal>
  );
}

function Step({ done, index, title, text, action }: { done: boolean; index: number; title: string; text: string; action?: ReactNode }) {
  return (
    <li className={done ? "step done" : "step"}>
      <span className="step-mark">{done ? <Icon name="check" size={15} /> : index}</span>
      <div className="step-text">
        <strong>{title}</strong>
        <span className="muted">{text}</span>
      </div>
      {!done && action ? action : null}
    </li>
  );
}

function SessionRow({ session, app }: { session: SessionView; app: AppData }) {
  const { usage } = useSessionUsage(session);
  const cap = Number(session.data.reservedAmount);
  return (
    <button className="session-row" onClick={() => app.go("sessions")}>
      <div className="session-row-main">
        <strong>Session #{String(session.data.sessionId)}</strong>
        <span className="muted small">{session.data.allowedModels.map(modelAlias).join(", ")}</span>
      </div>
      <div className="session-row-usage">
        <span className="small">
          {usage ? formatUnits(BigInt(usage.pending), app.mint.decimals) : "0"} / {formatUnits(BigInt(cap), app.mint.decimals)}{" "}
          {app.mint.label}
        </span>
        <Meter used={usage?.pending ?? 0} total={cap} />
      </div>
      <span className="muted small nowrap">{timeLeft(session.data.expiresAt)}</span>
    </button>
  );
}

function LiveActivity({ app, sessions }: { app: AppData; sessions: SessionView[] }) {
  const { entries, tracked } = useActivityFeed(sessions, 20);
  return (
    <Panel
      title="Live activity"
      subtitle="Requests from OpenCode, the playground, or any tool using your keys. Prompts and replies are never stored."
      actions={tracked > 0 ? <span className="live-pill">Live</span> : null}
    >
      {tracked === 0 ? (
        <p className="muted small">Create a key in this browser and requests show up here as they happen.</p>
      ) : entries === null ? (
        <div className="loading compact">
          <span className="spinner" /> Loading activity…
        </div>
      ) : entries.length === 0 ? (
        <p className="muted small">No requests yet. Point a tool at your key and they appear here within seconds.</p>
      ) : (
        <ActivityList entries={entries.slice(0, 12)} mint={app.mint} showSession />
      )}
    </Panel>
  );
}

export function Overview({ app }: { app: AppData }) {
  const { identity, mint, vault, sessions, notify, refresh, go } = app;
  const [transfer, setTransfer] = useState<Mode | null>(null);
  const available = vault.balance - vault.reserved;
  const active = sessions.filter(isActive);
  const funded = vault.balance > 0n;
  const hasKey = active.some((session) => rememberedKey(session.address));
  const lowSol = vault.sol < 5_000_000n;

  async function airdrop() {
    try {
      await rpc.requestAirdrop(identity.address, 2_000_000_000n as never).send();
      notify({ kind: "ok", text: "Airdropped 2 SOL for fees." });
      setTimeout(() => void refresh(), 1_500);
    } catch (error) {
      notify({ kind: "error", text: (error as Error).message });
    }
  }

  return (
    <>
      <PageHeader title="Overview" subtitle="Your vault, your sessions, and what to do next." />

      {lowSol ? (
        <div className="banner warn">
          <Icon name="wallet" />
          <span>This wallet has almost no SOL, which it needs for transaction fees.</span>
          {cluster === "localnet" ? (
            <button className="small" onClick={airdrop}>
              Airdrop 2 SOL
            </button>
          ) : null}
        </div>
      ) : null}

      <section className="hero-card">
        <div className="hero-top">
          <span className="hero-label">
            <Icon name="shield" size={16} /> Vault balance
          </span>
          <span className="hero-chip">Only you can withdraw</span>
        </div>
        <Amount value={vault.balance} decimals={mint.decimals} label={mint.label} />
        <div className="hero-split">
          <div>
            <span>Available</span>
            <strong>
              {formatUnits(available, mint.decimals)} {mint.label}
            </strong>
          </div>
          <div>
            <span>Reserved by sessions</span>
            <strong>
              {formatUnits(vault.reserved, mint.decimals)} {mint.label}
            </strong>
          </div>
          <div>
            <span>In your wallet</span>
            <strong>
              {formatUnits(vault.wallet, mint.decimals)} {mint.label}
            </strong>
          </div>
        </div>
        <div className="hero-actions">
          <button className="on-hero primary" onClick={() => setTransfer("deposit")}>
            <Icon name="down" size={16} /> Deposit
          </button>
          <button className="on-hero" disabled={!vault.exists || available === 0n} onClick={() => setTransfer("withdraw")}>
            <Icon name="up" size={16} /> Withdraw
          </button>
        </div>
      </section>

      <div className="two-col">
        <Panel title="Get started" subtitle="Four steps from deposit to a working coding agent.">
          <ol className="steps">
            <Step
              done={funded}
              index={1}
              title="Fund your vault"
              text="Deposit stablecoins into a program account only you control."
              action={
                <button className="small" onClick={() => setTransfer("deposit")}>
                  Deposit
                </button>
              }
            />
            <Step
              done={active.length > 0}
              index={2}
              title="Open a session"
              text="Lock a spending cap for the models you want. The rest stays withdrawable."
              action={
                <button className="small" disabled={!funded} onClick={() => go("sessions")}>
                  Open
                </button>
              }
            />
            <Step
              done={hasKey}
              index={3}
              title="Create an API key"
              text="The key can spend only that session's cap, never your vault."
              action={
                <button className="small" disabled={active.length === 0} onClick={() => go("keys")}>
                  Create
                </button>
              }
            />
            <Step
              done={false}
              index={4}
              title="Use it"
              text="Chat in the playground, or drop the generated config into OpenCode or any OpenAI tool."
              action={
                <button className="small" disabled={!hasKey} onClick={() => go("playground")}>
                  Try it
                </button>
              }
            />
          </ol>
        </Panel>

        <Panel
          title="Active sessions"
          subtitle={active.length ? `${active.length} open` : "Nothing running right now."}
          actions={
            <button className="ghost small" onClick={() => go("sessions")}>
              View all <Icon name="arrow" size={14} />
            </button>
          }
        >
          {active.length === 0 ? (
            <div className="empty compact">
              <span className="muted">Open a session to give a tool a capped budget.</span>
              <button className="small" disabled={!funded} onClick={() => go("sessions")}>
                <Icon name="plus" size={15} /> New session
              </button>
            </div>
          ) : (
            <div className="session-rows">
              {active.slice(0, 4).map((session) => (
                <SessionRow key={session.address} session={session} app={app} />
              ))}
            </div>
          )}
        </Panel>
      </div>

      <LiveActivity app={app} sessions={active} />

      {transfer ? <TransferModal app={app} initial={transfer} onClose={() => setTransfer(null)} /> : null}
    </>
  );
}
