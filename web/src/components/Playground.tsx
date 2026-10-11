import { useRef, useState } from "react";

import type { MintInfo, SessionView } from "../chain";
import { deployment } from "../config";
import { errorMessage, formatUnits } from "../format";
import { rememberedKey, streamChat } from "../relayer";
import { Card } from "./ui";

type Message = { role: "user" | "assistant"; content: string; charge?: number | null };

export function Playground({ sessions, mint }: { sessions: SessionView[]; mint: MintInfo }) {
  const usable = sessions.filter((session) => rememberedKey(session.address));
  const [sessionAddress, setSessionAddress] = useState<string>("");
  const session = usable.find((entry) => entry.address === sessionAddress) ?? usable[0];
  const modelIds = session?.data.allowedModels ?? [];
  const aliases = modelIds.map((id) => deployment?.models.find((model) => model.id === id)?.alias ?? `model-${id}`);
  const [model, setModel] = useState<string>("");
  const activeModel = aliases.includes(model) ? model : aliases[0] ?? "";
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  async function send() {
    const key = session ? rememberedKey(session.address) : null;
    if (!key || !input.trim()) return;
    setError(null);
    const history: Message[] = [...messages, { role: "user", content: input.trim() }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);
    abort.current = new AbortController();
    try {
      for await (const event of streamChat(
        key,
        activeModel,
        history.map(({ role, content }) => ({ role, content })),
        abort.current.signal,
      )) {
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1]!;
          next[next.length - 1] =
            event.kind === "delta" ? { ...last, content: last.content + event.text } : { ...last, charge: event.charge };
          return next;
        });
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(errorMessage(e));
      setMessages((current) => (current.at(-1)?.content === "" ? current.slice(0, -1) : current));
    } finally {
      setStreaming(false);
    }
  }

  return (
    <Card title="Playground" subtitle="Talk to the models through the relayer, billed to a session.">
      {usable.length === 0 ? (
        <p className="muted">Create an API key in this browser first; the playground uses it.</p>
      ) : (
        <div className="playground">
          <div className="row">
            <select value={session?.address} onChange={(event) => setSessionAddress(event.target.value)} aria-label="Session">
              {usable.map((entry) => (
                <option key={entry.address} value={entry.address}>
                  Session #{String(entry.data.sessionId)}
                </option>
              ))}
            </select>
            <select value={activeModel} onChange={(event) => setModel(event.target.value)} aria-label="Model">
              {aliases.map((alias) => (
                <option key={alias}>{alias}</option>
              ))}
            </select>
            {messages.length > 0 ? (
              <button className="ghost small" onClick={() => setMessages([])} disabled={streaming}>
                Clear
              </button>
            ) : null}
          </div>
          <div className="chat" aria-live="polite">
            {messages.length === 0 ? <p className="muted small">Ask anything. Each reply shows what it cost.</p> : null}
            {messages.map((message, index) => (
              <div key={index} className={`bubble ${message.role}`}>
                <div className="bubble-text">{message.content || (streaming ? "…" : "")}</div>
                {message.role === "assistant" && message.charge != null ? (
                  <div className="bubble-cost">
                    {formatUnits(BigInt(message.charge), mint.decimals)} {mint.label}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {error ? <p className="error-text">{error}</p> : null}
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <input
              className="grow"
              placeholder={`Message ${activeModel}`}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={streaming}
            />
            {streaming ? (
              <button type="button" className="ghost" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            ) : (
              <button type="submit" disabled={!input.trim()}>
                Send
              </button>
            )}
          </form>
        </div>
      )}
    </Card>
  );
}
