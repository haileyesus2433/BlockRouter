import type { Address } from "@solana/kit";
import { useEffect, useState } from "react";

import type { SessionView } from "../chain";
import { deployment, relayerUrl } from "../config";
import { shortAddress } from "../format";
import type { Identity } from "../identity";
import { createKey, type KeyRecord, listKeys, rememberKey, revokeKey, updateKey } from "../relayer";
import { Card, CopyButton, type Notice, useRunner } from "./ui";

function modelsFor(session: SessionView | undefined): string[] {
  const ids = session?.data.allowedModels ?? [];
  return ids.map((id) => deployment?.models.find((model) => model.id === id)?.alias ?? `model-${id}`);
}

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

function Setup({ apiKey, models }: { apiKey: string; models: string[] }) {
  const [tab, setTab] = useState<Tab>("opencode");
  const first = models[0] ?? "deepseek-v3";
  const opencode = opencodeConfig(apiKey, models);
  const curl = `curl ${relayerUrl}/v1/chat/completions \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${first}","messages":[{"role":"user","content":"hello"}]}'`;
  return (
    <div className="setup">
      <div className="tabs" role="tablist">
        {(
          [
            ["opencode", "OpenCode"],
            ["openai", "Any OpenAI-compatible tool"],
            ["curl", "curl"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "opencode" ? (
        <div className="stack">
          <p className="small">
            Save this as <code>opencode.json</code> in your project folder, then run <code>opencode</code> there and pick a
            BlockRouter model with <code>/models</code>. The key is already inside, so there is nothing to export.
          </p>
          <pre>{opencode}</pre>
          <div className="row">
            <button className="small" onClick={() => download("opencode.json", opencode)}>
              Download opencode.json
            </button>
            <CopyButton text={opencode} />
          </div>
        </div>
      ) : null}
      {tab === "openai" ? (
        <table className="mini">
          <tbody>
            <tr>
              <th>Base URL</th>
              <td>
                <code>{relayerUrl}/v1</code> <CopyButton text={`${relayerUrl}/v1`} />
              </td>
            </tr>
            <tr>
              <th>API key</th>
              <td>
                <code>{apiKey.slice(0, 16)}…</code> <CopyButton text={apiKey} />
              </td>
            </tr>
            <tr>
              <th>Model</th>
              <td>{models.map((model) => <code key={model}>{model} </code>)}</td>
            </tr>
          </tbody>
        </table>
      ) : null}
      {tab === "curl" ? (
        <div className="stack">
          <pre>{curl}</pre>
          <CopyButton text={curl} />
        </div>
      ) : null}
    </div>
  );
}

export function Keys(props: {
  identity: Identity;
  sessions: SessionView[];
  preselect: Address | null;
  notify: (notice: Notice) => void;
}) {
  const { identity, sessions, preselect, notify } = props;
  const { busy, run } = useRunner(notify);
  const [session, setSession] = useState<string>(preselect ?? sessions[0]?.address ?? "");
  const [name, setName] = useState("opencode");
  const [maxTokens, setMaxTokens] = useState("8000");
  const [created, setCreated] = useState<{ key: string; session: string } | null>(null);
  const [keys, setKeys] = useState<KeyRecord[] | null>(null);

  useEffect(() => {
    if (preselect) setSession(preselect);
    else if (!sessions.some((entry) => entry.address === session)) setSession(sessions[0]?.address ?? "");
  }, [preselect, sessions, session]);

  async function create() {
    const limit = Number(maxTokens);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200_000) {
      return notify({ kind: "error", text: "Max reply length must be a whole number from 1 to 200000." });
    }
    const result = await run("create", () => createKey(identity, { name, session, max_tokens: limit }));
    if (result) {
      rememberKey(result.session, result.key);
      setCreated({ key: result.key, session: result.session });
      notify({ kind: "ok", text: "Key created. Copy it now: it is shown only once." });
    }
  }

  const selected = sessions.find((entry) => entry.address === (created?.session ?? session));

  return (
    <Card
      title="API keys"
      subtitle="A key can only spend its session's cap, never your vault."
      actions={
        <button className="link" onClick={() => run("list", () => listKeys(identity), (value) => (setKeys(value.data), null))}>
          {busy === "list" ? "Loading…" : keys ? "Refresh keys" : "Show my keys"}
        </button>
      }
    >
      {sessions.length === 0 ? (
        <p className="muted">Open a session first; every key belongs to one session.</p>
      ) : (
        <div className="open-form">
          <label>
            <span className="label">Session</span>
            <select value={session} onChange={(event) => setSession(event.target.value)}>
              {sessions.map((entry) => (
                <option key={entry.address} value={entry.address}>
                  #{String(entry.data.sessionId)} ({modelsFor(entry).join(", ")})
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} />
          </label>
          <label>
            <span className="label">Max reply length (tokens)</span>
            <input inputMode="numeric" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} />
          </label>
          <button disabled={busy !== null || !session} onClick={create}>
            {busy === "create" ? "Waiting for signature…" : "Create key"}
          </button>
        </div>
      )}

      {created ? (
        <div className="reveal">
          <div className="reveal-key">
            <code>{created.key}</code>
            <CopyButton text={created.key} label="Copy key" />
          </div>
          <Setup apiKey={created.key} models={modelsFor(selected)} />
        </div>
      ) : null}

      {keys ? (
        keys.length === 0 ? (
          <p className="muted small">No keys yet.</p>
        ) : (
          <table className="mini">
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
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td>{shortAddress(key.session)}</td>
                  <td>{key.max_tokens ?? "default"}</td>
                  <td>{key.revoked_at ? "revoked" : "active"}</td>
                  <td className="row tight">
                    {key.revoked_at ? null : (
                      <>
                        <button
                          className="ghost small"
                          onClick={() => {
                            const value = prompt("New max reply length in tokens (blank for default)", String(key.max_tokens ?? ""));
                            if (value === null) return;
                            void run("update", () => updateKey(identity, key.id, value.trim() ? Number(value) : null), () => ({
                              kind: "ok",
                              text: "Updated.",
                            })).then(() => run("list", () => listKeys(identity), (list) => (setKeys(list.data), null)));
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="ghost small danger"
                          onClick={() =>
                            void run("revoke", () => revokeKey(identity, key.id), () => ({ kind: "ok", text: "Key revoked." })).then(() =>
                              run("list", () => listKeys(identity), (list) => (setKeys(list.data), null)),
                            )
                          }
                        >
                          Revoke
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
    </Card>
  );
}
