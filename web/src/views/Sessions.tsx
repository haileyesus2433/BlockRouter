import { useState } from "react";

import type { SessionView } from "../chain";
import { ActivityList } from "../components/Activity";
import { Icon } from "../components/icons";
import { Choice, Empty, Meter, Modal, PageHeader, Panel, useRunner } from "../components/ui";
import { deployment, explorerTx, modelAlias } from "../config";
import { type AppData, isActive } from "../context";
import { formatUnits, parseAmount, ratePerMillion, shortAddress, timeLeft } from "../format";
import { useActivityFeed, useSessionUsage, useSignedData } from "../hooks";
import { closeSession, listRelayerSessions, rememberedKey, sessionRequestsSigned } from "../relayer";
import { openSession, reclaim } from "../tx";
import { NewKeyModal } from "./Keys";

const DURATIONS = [
  { value: 600, label: "10 min" },
  { value: 3_600, label: "1 hour" },
  { value: 21_600, label: "6 hours" },
  { value: 86_400, label: "1 day" },
  { value: 604_800, label: "7 days" },
] as const;

const CAPS = ["1", "5", "10", "25"];

function NewSessionModal({ app, onClose }: { app: AppData; onClose: () => void }) {
  const { identity, mint, vault, relayer, notify, refresh } = app;
  const models = deployment?.models ?? [];
  const { busy, run } = useRunner(notify);
  const [cap, setCap] = useState("5");
  const [duration, setDuration] = useState<number>(3_600);
  const [chosen, setChosen] = useState<number[]>(models.map((model) => model.id));
  const available = vault.balance - vault.reserved;

  async function open() {
    if (!relayer) return notify({ kind: "error", text: "The relayer is offline, so there is no relayer to bind the session to." });
    if (chosen.length === 0) return notify({ kind: "error", text: "Pick at least one model." });
    let amount: bigint;
    try {
      amount = parseAmount(cap, mint.decimals);
    } catch (error) {
      return notify({ kind: "error", text: (error as Error).message });
    }
    if (amount > available) {
      return notify({ kind: "error", text: `Only ${formatUnits(available, mint.decimals)} ${mint.label} is available. Deposit more first.` });
    }
    const signature = await run(
      "open",
      () => openSession(identity, vault, { cap: amount, durationSecs: duration, modelIds: chosen, relayer }),
      (sig) => ({ kind: "ok", text: "Session opened. Create an API key for it next.", signature: sig }),
    );
    await refresh();
    if (signature) onClose();
  }

  return (
    <Modal title="New session" onClose={onClose}>
      <div className="field">
        <div className="field-label">
          <span>Spending cap</span>
          <span className="muted small">
            {formatUnits(available, mint.decimals)} {mint.label} available
          </span>
        </div>
        <div className="big-input">
          <input autoFocus inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} />
          <span>{mint.label}</span>
        </div>
        <Choice options={CAPS.map((value) => ({ value, label: value }))} value={cap} onChange={setCap} />
      </div>
      <div className="field">
        <div className="field-label">
          <span>Duration</span>
        </div>
        <Choice options={DURATIONS} value={duration} onChange={setDuration} />
      </div>
      <div className="field">
        <div className="field-label">
          <span>Models</span>
          <span className="muted small">per million tokens, input / output</span>
        </div>
        <div className="model-grid">
          {models.map((model) => {
            const on = chosen.includes(model.id);
            return (
              <button
                key={model.id}
                type="button"
                className={on ? "model-card active" : "model-card"}
                onClick={() => setChosen((current) => (on ? current.filter((id) => id !== model.id) : [...current, model.id]))}
              >
                <span className="model-check">{on ? <Icon name="check" size={13} /> : null}</span>
                <strong>{model.alias}</strong>
                <span className="muted small">
                  {ratePerMillion(model.promptRate, mint.decimals)} / {ratePerMillion(model.completionRate, mint.decimals)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <p className="hint">
        The cap is locked for this session only. Whatever it does not spend comes back to your vault when it settles.
      </p>
      <button className="primary block" disabled={busy !== null || !vault.exists} onClick={open}>
        {busy ? "Confirm in your wallet…" : `Lock ${cap || "0"} ${mint.label} and open`}
      </button>
    </Modal>
  );
}

function SignedActivity({ app, session }: { app: AppData; session: SessionView }) {
  const { data, loading, load } = useSignedData(app, `requests:${session.address}`, () => sessionRequestsSigned(app.identity, session.address));
  if (!data) {
    return (
      <div className="empty compact">
        <span className="muted">This browser has no key for the session, so loading asks your wallet to sign a message.</span>
        <button className="small" disabled={loading} onClick={load}>
          {loading ? "Loading…" : "Load activity"}
        </button>
      </div>
    );
  }
  return data.data.length ? <ActivityList entries={data.data} mint={app.mint} /> : <p className="muted small">No requests yet.</p>;
}

function KeyActivity({ app, session }: { app: AppData; session: SessionView }) {
  const { entries } = useActivityFeed([session]);
  if (entries === null) {
    return (
      <div className="loading compact">
        <span className="spinner" /> Loading activity…
      </div>
    );
  }
  return entries.length ? (
    <ActivityList entries={entries} mint={app.mint} />
  ) : (
    <p className="muted small">No requests yet. They appear here within seconds of being served.</p>
  );
}

function ActivityModal({ app, session, onClose }: { app: AppData; session: SessionView; onClose: () => void }) {
  return (
    <Modal title={`Session #${String(session.data.sessionId)} activity`} onClose={onClose}>
      <p className="hint">Every request this session served: model, tokens, and cost. Prompts and replies are never stored.</p>
      <div className="activity-scroll">
        {rememberedKey(session.address) ? <KeyActivity app={app} session={session} /> : <SignedActivity app={app} session={session} />}
      </div>
    </Modal>
  );
}

function SessionCard({ session, app, onKey }: { session: SessionView; app: AppData; onKey: () => void }) {
  const { identity, mint, vault, notify, refresh } = app;
  const active = isActive(session);
  const { key, usage } = useSessionUsage(session, active);
  const { busy, run } = useRunner(notify);
  const [showActivity, setShowActivity] = useState(false);
  const cap = Number(session.data.reservedAmount);
  const spent = usage?.pending ?? 0;

  return (
    <article className={active ? "session-card" : "session-card expired"}>
      <header className="session-card-head">
        <div>
          <strong>Session #{String(session.data.sessionId)}</strong>
          <span className="muted small mono">{shortAddress(session.address)}</span>
        </div>
        <span className={active ? "status live" : "status warn"}>{active ? "Active" : "Expired"}</span>
      </header>

      <div className="spend">
        <div className="spend-figures">
          <span className="spend-value">{formatUnits(BigInt(spent), mint.decimals)}</span>
          <span className="muted">
            of {formatUnits(BigInt(cap), mint.decimals)} {mint.label}
          </span>
        </div>
        <Meter used={spent} total={cap} />
        <div className="spend-meta muted small">
          <span>
            <Icon name="clock" size={14} /> {timeLeft(session.data.expiresAt)}
          </span>
          <span>{usage ? `${usage.requests} requests` : key ? "" : "no key in this browser"}</span>
        </div>
      </div>

      <div className="chips">
        {session.data.allowedModels.map((id) => {
          const line = usage?.usage.find((entry) => entry.model_id === id);
          return (
            <span key={id} className="chip" title={line ? `${line.prompt_tokens} in / ${line.completion_tokens} out` : undefined}>
              {modelAlias(id)}
              {line ? <span className="chip-count">{(line.prompt_tokens + line.completion_tokens).toLocaleString()} tok</span> : null}
            </span>
          );
        })}
      </div>

      {showActivity ? <ActivityModal app={app} session={session} onClose={() => setShowActivity(false)} /> : null}
      <footer className="session-card-actions">
        <button className="ghost small" onClick={() => setShowActivity(true)}>
          Activity
        </button>
        {active ? (
          <>
            {key ? (
              <button className="small" onClick={() => app.go("playground")}>
                <Icon name="chat" size={15} /> Playground
              </button>
            ) : (
              <button className="small" onClick={onKey}>
                <Icon name="key" size={15} /> Create key
              </button>
            )}
            <button
              className="ghost small"
              disabled={busy !== null}
              onClick={() =>
                run(
                  "close",
                  () => closeSession(identity, session.address),
                  () => ({ kind: "info", text: "Closing. The relayer settles it on-chain within seconds." }),
                ).then(() => setTimeout(() => void refresh(), 6_000))
              }
            >
              {busy === "close" ? "Closing…" : "Close and settle"}
            </button>
          </>
        ) : (
          <button
            className="small"
            disabled={busy !== null}
            onClick={() =>
              run(
                "reclaim",
                () => reclaim(identity, vault, session.address),
                (signature) => ({ kind: "ok", text: "Reservation released back to your vault.", signature }),
              ).then(refresh)
            }
          >
            <Icon name="undo" size={15} /> {busy === "reclaim" ? "Reclaiming…" : "Reclaim reservation"}
          </button>
        )}
      </footer>
    </article>
  );
}

function History({ app }: { app: AppData }) {
  const { identity, mint } = app;
  const { data, loading, load, silent } = useSignedData(app, "history", () => listRelayerSessions(identity));
  const settled = data?.data.filter((entry) => entry.settled_at !== null) ?? [];

  return (
    <Panel
      title="Settlement history"
      subtitle="What each closed session actually cost, as settled on-chain."
      actions={
        <button className="ghost small" disabled={loading} onClick={load}>
          <Icon name="refresh" size={15} /> {loading ? "Loading…" : data ? "Refresh" : "Load"}
        </button>
      }
    >
      {!data ? (
        loading || silent ? (
          <div className="loading compact">
            <span className="spinner" /> Loading history…
          </div>
        ) : (
          <p className="muted small">Loading asks your wallet to sign a message, so it only runs when you ask.</p>
        )
      ) : settled.length === 0 ? (
        <p className="muted small">Nothing settled yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Models used</th>
                <th>Requests</th>
                <th className="num">Charged</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {settled.map((entry) => (
                <tr key={entry.session}>
                  <td className="mono">{shortAddress(entry.session)}</td>
                  <td>{entry.usage.map((line) => line.model).join(", ") || <span className="muted">none</span>}</td>
                  <td>{entry.requests}</td>
                  <td className="num">
                    {formatUnits(BigInt(entry.pending), mint.decimals)} {mint.label}
                  </td>
                  <td className="num">
                    {entry.settle_signature ? (
                      <a href={explorerTx(entry.settle_signature)} target="_blank" rel="noreferrer" className="icon-link">
                        Transaction <Icon name="external" size={13} />
                      </a>
                    ) : (
                      <span className="muted small">{entry.last_error ?? "not billed"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function Sessions({ app }: { app: AppData }) {
  const [creating, setCreating] = useState(false);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const canOpen = app.vault.balance - app.vault.reserved > 0n;

  return (
    <>
      <PageHeader
        title="Sessions"
        subtitle="Each session locks a capped budget for chosen models. Unspent funds return to your vault."
        actions={
          <button className="primary" disabled={!canOpen} onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> New session
          </button>
        }
      />
      {app.sessions.length === 0 ? (
        <Panel>
          <Empty icon="sessions" title="No open sessions">
            <span className="muted">{canOpen ? "Open one to give a tool a capped budget." : "Deposit into your vault first."}</span>
            {canOpen ? (
              <button className="primary" onClick={() => setCreating(true)}>
                <Icon name="plus" size={16} /> New session
              </button>
            ) : (
              <button onClick={() => app.go("overview")}>Go to overview</button>
            )}
          </Empty>
        </Panel>
      ) : (
        <div className="card-grid">
          {app.sessions.map((session) => (
            <SessionCard key={session.address} session={session} app={app} onKey={() => setKeyFor(session.address)} />
          ))}
        </div>
      )}
      <History app={app} />
      {creating ? <NewSessionModal app={app} onClose={() => setCreating(false)} /> : null}
      {keyFor ? <NewKeyModal app={app} session={keyFor} onClose={() => setKeyFor(null)} /> : null}
    </>
  );
}
