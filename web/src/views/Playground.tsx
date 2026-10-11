import { useEffect, useRef, useState } from "react";

import { Icon } from "../components/icons";
import { Markdown } from "../components/Markdown";
import { Choice, Empty, PageHeader, Panel } from "../components/ui";
import { modelAlias } from "../config";
import { type AppData, isActive } from "../context";
import { errorMessage, formatUnits } from "../format";
import { rememberedKey, streamChat } from "../relayer";

type Message = { role: "user" | "assistant"; content: string; model?: string; charge?: number | null };

const SUGGESTIONS = [
  "Explain what a Solana PDA is in two sentences.",
  "Write a TypeScript function that debounces another function.",
  "Give me three names for a payments startup.",
];

export function Playground({ app }: { app: AppData }) {
  const { mint } = app;
  const usable = app.sessions.filter((session) => isActive(session) && rememberedKey(session.address));
  const [sessionAddress, setSessionAddress] = useState("");
  const session = usable.find((entry) => entry.address === sessionAddress) ?? usable[0];
  const aliases = (session?.data.allowedModels ?? []).map(modelAlias);
  const [model, setModel] = useState("");
  const activeModel = aliases.includes(model) ? model : (aliases[0] ?? "");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const spent = messages.reduce((total, message) => total + (message.charge ?? 0), 0);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);

  async function send(text = input) {
    const key = session ? rememberedKey(session.address) : null;
    if (!key || !text.trim() || streaming) return;
    setError(null);
    const history: Message[] = [...messages, { role: "user", content: text.trim() }];
    setMessages([...history, { role: "assistant", content: "", model: activeModel }]);
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

  if (!session) {
    return (
      <>
        <PageHeader title="Playground" subtitle="Talk to the models through the relayer, billed to a session." />
        <Panel>
          <Empty icon="chat" title="No session key in this browser">
            <span className="muted">The playground uses a key you created here. Create one for an active session.</span>
            <button className="primary" onClick={() => app.go("keys")}>
              <Icon name="key" size={16} /> Create a key
            </button>
          </Empty>
        </Panel>
      </>
    );
  }

  return (
    <div className="playground">
      <PageHeader
        title="Playground"
        subtitle="Talk to the models through the relayer. Every reply is billed to the session at on-chain rates."
      />
      <section className="chat-panel">
        <header className="chat-toolbar">
          {usable.length > 1 ? (
            <select value={session.address} onChange={(event) => setSessionAddress(event.target.value)} aria-label="Session">
              {usable.map((entry) => (
                <option key={entry.address} value={entry.address}>
                  Session #{String(entry.data.sessionId)}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted small">Session #{String(session.data.sessionId)}</span>
          )}
          <Choice options={aliases.map((alias) => ({ value: alias, label: alias }))} value={activeModel} onChange={setModel} />
          <span className="grow" />
          {messages.length > 0 ? (
            <>
              <span className="muted small nowrap">
                This chat: {formatUnits(BigInt(spent), mint.decimals)} {mint.label}
              </span>
              <button className="ghost small" onClick={() => setMessages([])} disabled={streaming}>
                Clear
              </button>
            </>
          ) : null}
        </header>

        <div className="chat" ref={scroller} aria-live="polite">
          {messages.length === 0 ? (
            <div className="chat-empty">
              <span className="empty-icon">
                <Icon name="chat" size={22} />
              </span>
              <strong>Ask {activeModel} anything</strong>
              <span className="muted">Each reply shows exactly what it cost.</span>
              <div className="suggestions">
                {SUGGESTIONS.map((text) => (
                  <button key={text} className="suggestion" onClick={() => void send(text)}>
                    {text}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message, index) => (
              <div key={index} className={`message ${message.role}`}>
                {message.role === "assistant" ? <span className="avatar">{(message.model ?? "ai").slice(0, 2)}</span> : null}
                <div className="bubble">
                  <div className="bubble-text">
                    {message.content ? (
                      message.role === "assistant" ? <Markdown text={message.content} /> : message.content
                    ) : streaming ? (
                      <span className="typing" />
                    ) : null}
                  </div>
                  {message.role === "assistant" && message.charge != null ? (
                    <div className="bubble-meta">
                      {message.model} · {formatUnits(BigInt(message.charge), mint.decimals)} {mint.label}
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>

        {error ? <p className="chat-error">{error}</p> : null}

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            rows={1}
            placeholder={`Message ${activeModel}`}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            disabled={streaming}
          />
          {streaming ? (
            <button type="button" className="ghost" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="primary send" disabled={!input.trim()} aria-label="Send">
              <Icon name="send" size={17} />
            </button>
          )}
        </form>
      </section>
    </div>
  );
}
