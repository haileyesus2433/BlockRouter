import { useEffect, useState } from "react";

import type { SessionView } from "./chain";
import { type CurrentSession, rememberedKey, sessionCurrent } from "./relayer";

/** Polls the relayer with the session's key from this browser; no wallet signature needed. */
export function useSessionUsage(session: SessionView, enabled = true) {
  const key = rememberedKey(session.address);
  const [usage, setUsage] = useState<CurrentSession | null>(null);
  useEffect(() => {
    if (!key || !enabled) return;
    let stopped = false;
    const load = () => sessionCurrent(key).then((value) => !stopped && setUsage(value)).catch(() => undefined);
    void load();
    const timer = setInterval(load, 4_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [key, enabled]);
  return { key, usage };
}
