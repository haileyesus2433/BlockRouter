import { useEffect, useState } from "react";

import type { MintInfo } from "../chain";
import { formatUnits } from "../format";
import type { FeedEntry } from "../hooks";
import type { ActivityEntry } from "../relayer";

const CLIENTS: Record<string, string> = {
  opencode: "OpenCode",
  playground: "Playground",
  curl: "curl",
  "ai-sdk": "AI SDK",
  "openai-sdk": "OpenAI SDK",
  other: "API",
};

function ago(unixSecs: number, now: number): string {
  const secs = Math.max(0, now - unixSecs);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3_600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3_600)}h ago`;
  return new Date(unixSecs * 1000).toLocaleDateString();
}

function useNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function ActivityList({ entries, mint, showSession = false }: { entries: (ActivityEntry | FeedEntry)[]; mint: MintInfo; showSession?: boolean }) {
  const now = useNow();
  return (
    <ul className="activity">
      {entries.map((entry) => (
        <li key={`${"session" in entry ? entry.session.address : ""}-${entry.id}`} className="activity-row">
          <span className={`client client-${CLIENTS[entry.client] ? entry.client : "other"}`}>{CLIENTS[entry.client] ?? entry.client}</span>
          <div className="activity-main">
            <strong>{entry.model}</strong>
            <span className="muted small">
              {entry.prompt_tokens.toLocaleString()} in · {entry.completion_tokens.toLocaleString()} out
              {showSession && "session" in entry ? ` · session #${String(entry.session.data.sessionId)}` : ""}
              {entry.key_name ? ` · ${entry.key_name}` : ""}
            </span>
          </div>
          <div className="activity-side">
            <span className="activity-charge">
              {formatUnits(BigInt(entry.charge), mint.decimals)} {mint.label}
            </span>
            <span className="muted small">{ago(entry.created_at, now)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
