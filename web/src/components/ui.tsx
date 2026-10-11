import { type ReactNode, useCallback, useState } from "react";

import { explorerTx } from "../config";
import { errorMessage } from "../format";

export function Card({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p className="muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="card-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export type Notice = { kind: "ok" | "error" | "info"; text: string; signature?: string };

/** Runs an async action with a busy flag and turns the outcome into a notice. */
export function useRunner(notify: (notice: Notice) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(label: string, action: () => Promise<T>, success?: (value: T) => Notice | null) => {
      setBusy(label);
      try {
        const value = await action();
        const notice = success?.(value);
        if (notice) notify(notice);
        return value;
      } catch (error) {
        notify({ kind: "error", text: errorMessage(error) });
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [notify],
  );
  return { busy, run };
}

export function NoticeBar({ notice, onClose }: { notice: Notice | null; onClose: () => void }) {
  if (!notice) return null;
  return (
    <div className={`notice notice-${notice.kind}`} role="status">
      <span>{notice.text}</span>
      {notice.signature ? (
        <a href={explorerTx(notice.signature)} target="_blank" rel="noreferrer">
          View transaction
        </a>
      ) : null}
      <button className="link" onClick={onClose} aria-label="Dismiss">
        Dismiss
      </button>
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="ghost small"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function Meter({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="meter" aria-label={`${pct.toFixed(1)}% used`}>
      <div className="meter-fill" style={{ width: `${Math.max(pct, used > 0 ? 1 : 0)}%` }} />
    </div>
  );
}
