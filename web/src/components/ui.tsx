import { type ReactNode, useCallback, useEffect, useState } from "react";

import { explorerTx } from "../config";
import { errorMessage } from "../format";
import { Icon, type IconName } from "./icons";

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title ? (
        <header className="panel-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p className="muted">{subtitle}</p> : null}
          </div>
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle: string; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Empty({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export type Notice = { kind: "ok" | "error" | "info"; text: string; signature?: string };
type Toast = Notice & { id: number };

let toastId = 0;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const notify = useCallback(
    (notice: Notice) => {
      const id = ++toastId;
      setToasts((current) => [...current.slice(-3), { ...notice, id }]);
      if (notice.kind !== "error") setTimeout(() => dismiss(id), 7_000);
    },
    [dismiss],
  );
  return { toasts, notify, dismiss };
}

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <span className="toast-dot" />
          <div className="toast-body">
            <span>{toast.text}</span>
            {toast.signature ? (
              <a href={explorerTx(toast.signature)} target="_blank" rel="noreferrer">
                View transaction <Icon name="external" size={13} />
              </a>
            ) : null}
          </div>
          <button className="icon-button" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
            <Icon name="close" size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Runs an async action with a busy flag and turns the outcome into a toast. */
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

export function CopyButton({ text, label = "Copy", className = "ghost small" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={className}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <Icon name={copied ? "check" : "copy"} size={15} />
      {copied ? "Copied" : label}
    </button>
  );
}

export function Meter({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="meter" aria-label={`${pct.toFixed(1)}% used`}>
      <div className="meter-fill" style={{ width: `${Math.max(pct, used > 0 ? 1.5 : 0)}%` }} />
    </div>
  );
}

export function Choice<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="choices">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          className={option.value === value ? "choice active" : "choice"}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
