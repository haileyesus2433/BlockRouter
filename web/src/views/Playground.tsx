import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../components/icons";
import { Markdown } from "../components/Markdown";
import { Choice, Empty, PageHeader, Panel } from "../components/ui";
import { type Chat, type ChatMessage, loadChats, newChat, saveChats, titleFrom } from "../chats";
import { modelAlias } from "../config";
import { type AppData, isActive } from "../context";
import { errorMessage, formatUnits } from "../format";
import { rememberedKey, streamChat } from "../relayer";

const SUGGESTIONS = [
  "Explain what a Solana PDA is in two sentences.",
  "Write a TypeScript function that debounces another function.",
  "Give me three names for a payments startup.",
];

function when(ms: number): string {
  const date = new Date(ms);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function Playground({ app }: { app: AppData }) {
  const { mint, identity } = app;
  const owner = identity.address;
  const usable = app.sessions.filter((session) => isActive(session) && rememberedKey(session.address));
  const [sessionAddress, setSessionAddress] = useState("");
  const session = usable.find((entry) => entry.address === sessionAddress) ?? usable[0];
  const aliases = (session?.data.allowedModels ?? []).map(modelAlias);
  const [model, setModel] = useState("");
  const activeModel = aliases.includes(model) ? model : (aliases[0] ?? "");

  const [chats, setChats] = useState<Chat[]>(() => loadChats(owner));
  const [draft, setDraft] = useState<Chat>(newChat);
  const [activeId, setActiveId] = useState<string | null>(() => loadChats(owner)[0]?.id ?? null);
  const active = chats.find((chat) => chat.id === activeId) ?? draft;
  const messages = active.messages;

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const spent = messages.reduce((total, message) => total + (message.charge ?? 0), 0);
  const sorted = useMemo(() => [...chats].sort((a, b) => b.updatedAt - a.updatedAt), [chats]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    if (!streaming) saveChats(owner, chats);
  }, [owner, chats, streaming]);

  function update(id: string, change: (messages: ChatMessage[]) => ChatMessage[]) {
    setChats((current) =>
      current.map((chat) => (chat.id === id ? { ...chat, messages: change(chat.messages), updatedAt: Date.now() } : chat)),
    );
  }

  function startNew() {
    if (streaming) return;
    setDraft(newChat());
    setActiveId(null);
    setError(null);
  }

  function remove(id: string) {
    setChats((current) => current.filter((chat) => chat.id !== id));
    if (id === activeId) setActiveId(null);
  }

  async function send(text = input) {
    const key = session ? rememberedKey(session.address) : null;
    if (!key || !text.trim() || streaming) return;
    setError(null);
    const history: ChatMessage[] = [...messages, { role: "user", content: text.trim() }];
    const id = active.id;
    const pending: ChatMessage[] = [...history, { role: "assistant", content: "", model: activeModel }];
    if (chats.some((chat) => chat.id === id)) update(id, () => pending);
    else {
      setChats((current) => [{ ...active, title: titleFrom(text), messages: pending, updatedAt: Date.now() }, ...current]);
      setActiveId(id);
    }
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
        update(id, (current) => {
          const next = [...current];
          const last = next[next.length - 1]!;
          next[next.length - 1] =
            event.kind === "delta" ? { ...last, content: last.content + event.text } : { ...last, charge: event.charge };
          return next;
        });
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(errorMessage(e));
      update(id, (current) => (current.at(-1)?.content === "" ? current.slice(0, -1) : current));
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
        subtitle="Talk to the models through the relayer. Chats are saved in this browser only; the relayer never stores them."
      />
      <div className="playground-grid">
        <aside className="chat-list">
          <button className="primary block" onClick={startNew} disabled={streaming}>
            <Icon name="plus" size={16} /> New chat
          </button>
          <div className="chat-list-items">
            {sorted.length === 0 ? <p className="muted small">Your chats show up here.</p> : null}
            {sorted.map((chat) => (
              <div key={chat.id} className={chat.id === activeId ? "chat-item active" : "chat-item"}>
                <button className="chat-item-open" disabled={streaming} onClick={() => setActiveId(chat.id)}>
                  <span className="chat-item-title">{chat.title}</span>
                  <span className="muted small">
                    {when(chat.updatedAt)} · {chat.messages.filter((message) => message.role === "user").length} messages
                  </span>
                </button>
                <button className="icon-button chat-item-delete" onClick={() => remove(chat.id)} aria-label="Delete chat" disabled={streaming}>
                  <Icon name="close" size={14} />
                </button>
              </div>
            ))}
          </div>
        </aside>

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
              <span className="muted small nowrap">
                This chat: {formatUnits(BigInt(spent), mint.decimals)} {mint.label}
              </span>
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
    </div>
  );
}
