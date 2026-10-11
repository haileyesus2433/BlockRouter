import type { Address } from "@solana/kit";
import { useEffect, useState } from "react";

import type { MintInfo, SessionView, VaultView } from "../chain";
import { deployment, explorerTx } from "../config";
import { chainNow, formatUnits, parseAmount, ratePerMillion, shortAddress, timeLeft } from "../format";
import type { Identity } from "../identity";
import {
  closeSession,
  type CurrentSession,
  listRelayerSessions,
  type RelayerSession,
  rememberedKey,
  sessionCurrent,
} from "../relayer";
import { openSession, reclaim } from "../tx";
import { Card, Meter, type Notice, useRunner } from "./ui";

const DURATIONS = [
  { label: "1 hour", secs: 3_600 },
  { label: "6 hours", secs: 21_600 },
  { label: "24 hours", secs: 86_400 },
  { label: "7 days", secs: 604_800 },
  { label: "10 minutes (testing)", secs: 600 },
];

function modelName(id: number): string {
  return deployment?.models.find((model) => model.id === id)?.alias ?? `model ${id}`;
}

function LiveUsage({ session, mint }: { session: SessionView; mint: MintInfo }) {
  const [usage, setUsage] = useState<CurrentSession | null>(null);
  const key = rememberedKey(session.address);
  useEffect(() => {
    if (!key) return;
    let stopped = false;
    const load = () => sessionCurrent(key).then((value) => !stopped && setUsage(value)).catch(() => undefined);
    void load();
    const timer = setInterval(load, 4_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [key]);
  if (!key) return <p className="muted small">Create a key for this session to see live usage here.</p>;
  if (!usage) return <p className="muted small">Loading usage…</p>;
  const cap = Number(session.data.reservedAmount);
  return (
    <div className="usage">
      <div className="usage-head">
        <span>
          Spent <strong>{formatUnits(BigInt(usage.pending), mint.decimals)}</strong> of{" "}
          {formatUnits(BigInt(cap), mint.decimals)} {mint.label}
        </span>
        <span className="muted small">{usage.requests} requests</span>
      </div>
      <Meter used={usage.pending} total={cap} />
      {usage.usage.length > 0 ? (
        <table className="mini">
          <thead>
            <tr>
              <th>Model</th>
              <th>Prompt tokens</th>
              <th>Completion tokens</th>
            </tr>
          </thead>
          <tbody>
            {usage.usage.map((line) => (
              <tr key={line.model_id}>
                <td>{line.model}</td>
                <td>{line.prompt_tokens.toLocaleString()}</td>
                <td>{line.completion_tokens.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

export function Sessions(props: {
  identity: Identity;
  mint: MintInfo;
  vault: VaultView;
  sessions: SessionView[];
  relayer: Address | null;
  onChanged: () => void;
  onCreateKey: (session: Address) => void;
  notify: (notice: Notice) => void;
}) {
  const { identity, mint, vault, sessions, relayer, onChanged, onCreateKey, notify } = props;
  const { busy, run } = useRunner(notify);
  const models = deployment?.models ?? [];
  const [cap, setCap] = useState("5");
  const [duration, setDuration] = useState(DURATIONS[0]!.secs);
  const [chosen, setChosen] = useState<number[]>(models.slice(0, 1).map((model) => model.id));
  const [history, setHistory] = useState<RelayerSession[] | null>(null);
  const available = vault.balance - vault.reserved;

  async function open() {
    if (!relayer) return notify({ kind: "error", text: "The relayer is not reachable, so there is no relayer to bind the session to." });
    if (chosen.length === 0) return notify({ kind: "error", text: "Pick at least one model." });
    const amount = parseAmount(cap, mint.decimals);
    if (amount > available) {
      return notify({ kind: "error", text: `Only ${formatUnits(available, mint.decimals)} ${mint.label} is available. Deposit more first.` });
    }
    await run(
      "open",
      () => openSession(identity, vault, { cap: amount, durationSecs: duration, modelIds: chosen, relayer }),
      (signature) => ({ kind: "ok", text: "Session opened. Next, create an API key for it.", signature }),
    );
    onChanged();
  }

  const now = chainNow();

  return (
    <Card title="Sessions" subtitle="Each session locks a cap for one relayer and the models you allow.">
      <div className="open-form">
        <label>
          <span className="label">Cap</span>
          <span className="row tight">
            <input className="amount" inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} />
            <span className="unit">{mint.label}</span>
          </span>
        </label>
        <label>
          <span className="label">Duration</span>
          <select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
            {DURATIONS.map((option) => (
              <option key={option.secs} value={option.secs}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend className="label">Models (input / output per million tokens)</legend>
          {models.map((model) => (
            <label key={model.id} className="check">
              <input
                type="checkbox"
                checked={chosen.includes(model.id)}
                onChange={(event) =>
                  setChosen((current) =>
                    event.target.checked ? [...current, model.id] : current.filter((id) => id !== model.id),
                  )
                }
              />
              <span>{model.alias}</span>
              <span className="muted small">
                {ratePerMillion(model.promptRate, mint.decimals)} / {ratePerMillion(model.completionRate, mint.decimals)}
              </span>
            </label>
          ))}
        </fieldset>
        <button disabled={busy !== null || !vault.exists} onClick={open}>
          {busy === "open" ? "Opening…" : "Open session"}
        </button>
        {!vault.exists ? <p className="muted small">Deposit into your vault first.</p> : null}
      </div>

      {sessions.length === 0 ? (
        <p className="muted">No open sessions.</p>
      ) : (
        <div className="session-list">
          {sessions.map((session) => {
            const expired = Number(session.data.expiresAt) <= now;
            return (
              <article key={session.address} className="session">
                <div className="session-head">
                  <div>
                    <strong>Session #{String(session.data.sessionId)}</strong>{" "}
                    <span className="muted small">{shortAddress(session.address)}</span>
                    <div className="chips">
                      {session.data.allowedModels.map((id) => (
                        <span key={id} className="chip">
                          {modelName(id)}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="session-meta">
                    <strong>
                      {formatUnits(session.data.reservedAmount, mint.decimals)} {mint.label} cap
                    </strong>
                    <span className={expired ? "error-text small" : "muted small"}>{timeLeft(session.data.expiresAt)}</span>
                  </div>
                </div>
                {!expired ? <LiveUsage session={session} mint={mint} /> : null}
                <div className="row">
                  {!expired ? (
                    <>
                      <button className="small" onClick={() => onCreateKey(session.address)}>
                        Create API key
                      </button>
                      <button
                        className="ghost small"
                        disabled={busy !== null}
                        onClick={() =>
                          run(
                            `close-${session.address}`,
                            () => closeSession(identity, session.address),
                            () => ({ kind: "info", text: "Closing: the relayer will settle it on-chain within seconds." }),
                          ).then(() => setTimeout(onChanged, 6_000))
                        }
                      >
                        Close and settle
                      </button>
                    </>
                  ) : (
                    <button
                      className="small"
                      disabled={busy !== null}
                      onClick={() =>
                        run(
                          `reclaim-${session.address}`,
                          () => reclaim(identity, vault, session.address),
                          (signature) => ({ kind: "ok", text: "Reservation released back to your vault.", signature }),
                        ).then(onChanged)
                      }
                    >
                      Reclaim reservation
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className="history">
        <button
          className="link"
          onClick={() => run("history", () => listRelayerSessions(identity), (value) => (setHistory(value.data), null))}
        >
          {busy === "history" ? "Loading…" : history ? "Refresh settlement history" : "Show settlement history"}
        </button>
        {history ? (
          history.filter((entry) => entry.settled_at !== null).length === 0 ? (
            <p className="muted small">Nothing settled yet.</p>
          ) : (
            <table className="mini">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Models</th>
                  <th>Charged</th>
                  <th>Requests</th>
                  <th>Settlement</th>
                </tr>
              </thead>
              <tbody>
                {history
                  .filter((entry) => entry.settled_at !== null)
                  .map((entry) => (
                    <tr key={entry.session}>
                      <td>{shortAddress(entry.session)}</td>
                      <td>{entry.usage.map((line) => line.model).join(", ") || "none used"}</td>
                      <td>
                        {formatUnits(BigInt(entry.pending), mint.decimals)} {mint.label}
                      </td>
                      <td>{entry.requests}</td>
                      <td>
                        {entry.settle_signature ? (
                          <a href={explorerTx(entry.settle_signature)} target="_blank" rel="noreferrer">
                            View transaction
                          </a>
                        ) : (
                          <span className="muted small">{entry.last_error ?? "not billed"}</span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )
        ) : null}
      </div>
    </Card>
  );
}
