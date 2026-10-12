import { useCallback, useEffect, useState } from "react";

import type { SessionView } from "./chain";
import { useRunner } from "./components/ui";
import type { AppData } from "./context";
import { type ActivityEntry, type CurrentSession, forgetKeyIfDead, rememberedKey, sessionCurrent, sessionRequests } from "./relayer";

const POLL_MS = 4_000;

/** Polls the relayer with the session's key from this browser; no wallet signature needed. */
export function useSessionUsage(session: SessionView, enabled = true) {
  const key = rememberedKey(session.address);
  const [usage, setUsage] = useState<CurrentSession | null>(null);
  useEffect(() => {
    if (!key || !enabled) return;
    let stopped = false;
    const load = () =>
      sessionCurrent(key)
        .then((value) => !stopped && setUsage(value))
        .catch((error) => forgetKeyIfDead(session.address, error));
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [key, enabled]);
  return { key, usage };
}

export type FeedEntry = ActivityEntry & { session: SessionView };

/** Merged request log of every given session that has a key in this browser, newest first. */
export function useActivityFeed(sessions: SessionView[], limit = 50) {
  const withKeys = sessions.filter((session) => rememberedKey(session.address));
  const signature = withKeys.map((session) => session.address).join(",");
  const [entries, setEntries] = useState<FeedEntry[] | null>(null);
  useEffect(() => {
    if (withKeys.length === 0) return setEntries([]);
    let stopped = false;
    const load = async () => {
      const lists = await Promise.all(
        withKeys.map((session) =>
          sessionRequests(rememberedKey(session.address)!, limit)
            .then((list) => list.data.map((entry) => ({ ...entry, session })))
            .catch((error) => {
              forgetKeyIfDead(session.address, error);
              return [] as FeedEntry[];
            }),
        ),
      );
      if (!stopped) setEntries(lists.flat().sort((a, b) => b.created_at - a.created_at || b.id - a.id));
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // The address list stands in for the sessions array, which is a new object every refresh.
  }, [signature, limit]);
  return { entries, tracked: withKeys.length };
}

/**
 * Data behind a wallet-signed endpoint. Results are cached for the page's lifetime so revisiting a
 * page shows them at once; the demo wallet signs silently, so it loads without asking.
 */
export function useSignedData<T>(app: AppData, cacheKey: string, loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(() => (app.cache.get(cacheKey) as T | undefined) ?? null);
  const { busy, run } = useRunner(app.notify);
  const silent = app.identity.kind === "demo";
  const load = useCallback(async () => {
    const value = await run("load", loader);
    if (value === undefined) return;
    app.cache.set(cacheKey, value);
    setData(value);
  }, [cacheKey, run]);
  useEffect(() => {
    if (silent) void load();
  }, [silent, load]);
  return { data, loading: busy !== null, load, silent };
}
