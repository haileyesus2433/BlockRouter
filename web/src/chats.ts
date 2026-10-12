export type ChatMessage = { role: "user" | "assistant"; content: string; model?: string; charge?: number | null };
export type Chat = { id: string; title: string; messages: ChatMessage[]; createdAt: number; updatedAt: number };

const MAX_CHATS = 50;
const storageKey = (owner: string) => `blockrouter.chats.${owner}`;

/** Chats live only in this browser, per wallet. The relayer never stores them. */
export function loadChats(owner: string): Chat[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(owner)) ?? "[]");
    return Array.isArray(parsed) ? (parsed as Chat[]) : [];
  } catch {
    return [];
  }
}

export function saveChats(owner: string, chats: Chat[]): void {
  try {
    const kept = chats
      .filter((chat) => chat.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CHATS);
    localStorage.setItem(storageKey(owner), JSON.stringify(kept));
  } catch {
    // Storage full or blocked; the chat still works for this visit.
  }
}

export function newChat(): Chat {
  const now = Date.now();
  return { id: crypto.randomUUID(), title: "New chat", messages: [], createdAt: now, updatedAt: now };
}

export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || "New chat";
}
