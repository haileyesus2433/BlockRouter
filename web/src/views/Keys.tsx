import { useState } from "react";

import type { SessionView } from "../chain";
import { Icon } from "../components/icons";
import { Choice, CopyButton, Empty, Modal, PageHeader, Panel, useRunner } from "../components/ui";
import { modelAlias, relayerUrl } from "../config";
import { type AppData, isActive } from "../context";
import { shortAddress } from "../format";
import { createKey, type KeyRecord, listKeys, rememberedKey, rememberKey, revokeKey, updateKey } from "../relayer";

function opencodeConfig(key: string, models: string[]): string {
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      provider: {
        blockrouter: {
          npm: "@ai-sdk/openai-compatible",
          name: "BlockRouter",
          options: { baseURL: `${relayerUrl}/v1`, apiKey: key },
          models: Object.fromEntries(models.map((model) => [model, { name: `${model} via BlockRouter` }])),
        },
      },
    },
    null,
    2,
  );
}

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

type Tab = "opencode" | "openai" | "curl";

const TABS = [
  { value: "opencode", label: "OpenCode" },
  { value: "openai", label: "OpenAI-compatible" },
  { value: "curl", label: "curl" },
] as const;

function CopyRow({ label, value, display }: { label: string; value: string; display?: string }) {
  return (
    <div className="copy-row">
      <span className="copy-label">{label}</span>
      <code>{display ?? value}</code>
      <CopyButton text={value} label="" className="icon-button" />
    </div>
  );
}

export function KeySetup({ apiKey, models }: { apiKey: string; models: string[] }) {
  const [tab, setTab] = useState<Tab>("opencode");
  const opencode = opencodeConfig(apiKey, models);
  const curl = `curl ${relayerUrl}/v1/chat/completions \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${models[0] ?? "deepseek-v3"}","messages":[{"role":"user","content":"hello"}]}'`;

  return (
    <div className="setup">
      <Choice options={TABS} value={tab} onChange={setTab} />
      {tab === "opencode" ? (
        <>
          <ol className="howto">
            <li>
              Download <code>opencode.json</code> into your project folder. The key is already inside.
            </li>
            <li>
              Run <code>opencode</code> there and pick a BlockRouter model with <code>/models</code>.
            </li>
          </ol>
          <div className="row">
            <button className="primary small" onClick={() => download("opencode.json", opencode)}>
              <Icon name="download" size={15} /> Download opencode.json
            </button>
            <CopyButton text={opencode} label="Copy JSON" />
          </div>
          <details className="code-details">
            <summary>Show the file</summary>
            <pre>{opencode}</pre>
          </details>
        </>
      ) : null}
      {tab === "openai" ? (
        <>
          <p className="muted small">Paste these into Cline, Continue, Aider, Cursor, or any OpenAI SDK.</p>
          <div className="copy-rows">
            <CopyRow label="Base URL" value={`${relayerUrl}/v1`} />
            <CopyRow label="API key" value={apiKey} display={`${apiKey.slice(0, 14)}…${apiKey.slice(-4)}`} />
            {models.map((model) => (
              <CopyRow key={model} label="Model" value={model} />
            ))}
          </div>
        </>
      ) : null}
      {tab === "curl" ? (
        <>
          <pre>{curl}</pre>
          <div className="row">
            <CopyButton text={curl} />
          </div>
        </>
      ) : null}
    </div>
  );
}

const modelsOf = (session?: SessionView) => (session?.data.allowedModels ?? []).map(modelAlias);

export function NewKeyModal({ app, session: initial, onClose }: { app: AppData; session?: string; onClose: () => void }) {
  const { identity, notify, refresh } = app;
  const sessions = app.sessions.filter(isActive);
  const { busy, run } = useRunner(notify);
  const [session, setSession] = useState(initial ?? sessions[0]?.address ?? "");
  const [name, setName] = useState("opencode");
  const [maxTokens, setMaxTokens] = useState("8000");
  const [created, setCreated] = useState<string | null>(null);
  const selected = sessions.find((entry) => entry.address === session);

  async function create() {
    const limit = Number(maxTokens);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200_000) {
      return notify({ kind: "error", text: "Max reply length must be a whole number from 1 to 200000." });
    }
    const result = await run("create", () => createKey(identity, { name, session, max_tokens: limit }));
    if (!result) return;
    rememberKey(result.session, result.key);
    setCreated(result.key);
    void refresh();
  }

  if (created) {
    return (
      <Modal title="Your API key" onClose={onClose}>
        <div className="key-reveal">
          <code>{created}</code>
          <CopyButton text={created} label="Copy" />
        </div>
        <p className="hint warn-text">Copy it now. The relayer shows it only once; this browser keeps a copy for the playground.</p>
        <KeySetup apiKey={created} models={modelsOf(selected)} />
        <button className="block" onClick={onClose}>
          Done
        </button>
      </Modal>
    );
  }

  return (
    <Modal title="New API key" onClose={onClose}>
      {sessions.length === 0 ? (
        <p className="muted">Open a session first; every key belongs to one session.</p>
      ) : (
        <>
          <label className="field">
            <span className="field-label">Session</span>
            <select value={session} onChange={(event) => setSession(event.target.value)}>
              {sessions.map((entry) => (
                <option key={entry.address} value={entry.address}>
                  Session #{String(entry.data.sessionId)} · {modelsOf(entry).join(", ")}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} />
          </label>
          <details className="advanced">
            <summary>Advanced</summary>
            <label className="field">
              <span className="field-label">Max reply length (tokens)</span>
              <input inputMode="numeric" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} />
              <span className="hint">Used when a client does not send max_tokens. Raise it if long file writes get cut off.</span>
            </label>
          </details>
          <p className="hint">A key can spend only this session's cap. Your wallet signs a message to prove the session is yours.</p>
          <button className="primary block" disabled={busy !== null || !session} onClick={create}>
            {busy ? "Confirm in your wallet…" : "Create key"}
          </button>
        </>
      )}
    </Modal>
  );
}

function EditKeyModal({ app, record, onClose, onSaved }: { app: AppData; record: KeyRecord; onClose: () => void; onSaved: () => void }) {
  const { busy, run } = useRunner(app.notify);
  const [value, setValue] = useState(record.max_tokens ? String(record.max_tokens) : "");
  return (
    <Modal title={`Edit ${record.name}`} onClose={onClose}>
      <label className="field">
        <span className="field-label">Max reply length (tokens)</span>
        <input autoFocus inputMode="numeric" placeholder="relayer default" value={value} onChange={(event) => setValue(event.target.value)} />
        <span className="hint">Leave empty to use the relayer default.</span>
      </label>
      <button
        className="primary block"
        disabled={busy !== null}
        onClick={async () => {
          const ok = await run("save", () => updateKey(app.identity, record.id, value.trim() ? Number(value) : null), () => ({
            kind: "ok",
            text: "Key updated.",
          }));
          if (ok !== undefined) onSaved();
        }}
      >
        {busy ? "Confirm in your wallet…" : "Save"}
      </button>
    </Modal>
  );
}

function AllKeys({ app }: { app: AppData }) {
  const { identity, notify } = app;
  const { busy, run } = useRunner(notify);
  const [keys, setKeys] = useState<KeyRecord[] | null>(null);
  const [editing, setEditing] = useState<KeyRecord | null>(null);
  const load = () => run("list", () => listKeys(identity), (value) => (setKeys(value.data), null));

  return (
    <Panel
      title="All keys"
      subtitle="Every key the relayer holds for this wallet."
      actions={
        <button className="ghost small" disabled={busy !== null} onClick={load}>
          <Icon name="refresh" size={15} /> {busy === "list" ? "Loading…" : keys ? "Refresh" : "Load"}
        </button>
      }
    >
      {!keys ? (
        <p className="muted small">Loading asks your wallet to sign a message, so it only runs when you ask.</p>
      ) : keys.length === 0 ? (
        <p className="muted small">No keys yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Session</th>
                <th>Max reply</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => {
                const live = !key.revoked_at && app.sessions.some((entry) => entry.address === key.session && isActive(entry));
                return (
                <tr key={key.id}>
                  <td>
                    <strong>{key.name}</strong>
                  </td>
                  <td className="mono">{shortAddress(key.session)}</td>
                  <td>{key.max_tokens?.toLocaleString() ?? <span className="muted">default</span>}</td>
                  <td>
                    <span className={live ? "status live" : "status off"}>{key.revoked_at ? "Revoked" : live ? "Active" : "Session ended"}</span>
                  </td>
                  <td className="num">
                    {!live ? null : (
                      <span className="row tight end">
                        <button className="ghost small" onClick={() => setEditing(key)}>
                          Edit
                        </button>
                        <button
                          className="ghost small danger"
                          disabled={busy !== null}
                          onClick={() =>
                            void run("revoke", () => revokeKey(identity, key.id), () => ({ kind: "ok", text: "Key revoked." })).then(load)
                          }
                        >
                          Revoke
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing ? (
        <EditKeyModal
          app={app}
          record={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </Panel>
  );
}

export function Keys({ app }: { app: AppData }) {
  const [creating, setCreating] = useState(false);
  const active = app.sessions.filter(isActive);
  const ready = active.filter((session) => rememberedKey(session.address));

  return (
    <>
      <PageHeader
        title="API keys"
        subtitle="Point any OpenAI-compatible tool at BlockRouter. A key can spend only its session's cap."
        actions={
          <button className="primary" disabled={active.length === 0} onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> New key
          </button>
        }
      />
      {ready.length === 0 ? (
        <Panel>
          <Empty icon="key" title={active.length ? "No key in this browser yet" : "Open a session first"}>
            <span className="muted">
              {active.length ? "Create one and you get a ready-made config for your tool." : "Every key belongs to one session."}
            </span>
            {active.length ? (
              <button className="primary" onClick={() => setCreating(true)}>
                <Icon name="plus" size={16} /> New key
              </button>
            ) : (
              <button onClick={() => app.go("sessions")}>Go to sessions</button>
            )}
          </Empty>
        </Panel>
      ) : (
        ready.map((session) => (
          <Panel
            key={session.address}
            title={`Connect a tool to session #${String(session.data.sessionId)}`}
            subtitle={modelsOf(session).join(" · ")}
          >
            <KeySetup apiKey={rememberedKey(session.address)!} models={modelsOf(session)} />
          </Panel>
        ))
      )}
      <AllKeys app={app} />
      {creating ? <NewKeyModal app={app} onClose={() => setCreating(false)} /> : null}
    </>
  );
}
