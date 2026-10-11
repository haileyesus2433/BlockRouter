import { rateLimited } from "./errors";

const WINDOW_SECS = 60;

// Fixed one-minute windows, in memory. Enough for one relayer process.
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly limitPerMinute: number) {}

  /** Throws a 429 if any of the keys is over its limit; counts the request otherwise. */
  check(keys: string[], nowSecs: number): void {
    for (const key of keys) {
      const window = this.windows.get(key);
      if (window && nowSecs - window.start < WINDOW_SECS && window.count >= this.limitPerMinute) {
        throw rateLimited(WINDOW_SECS - (nowSecs - window.start));
      }
    }
    for (const key of keys) {
      const window = this.windows.get(key);
      if (!window || nowSecs - window.start >= WINDOW_SECS) {
        this.windows.set(key, { start: nowSecs, count: 1 });
      } else {
        window.count += 1;
      }
    }
  }
}
