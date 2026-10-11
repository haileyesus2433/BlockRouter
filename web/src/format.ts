export function formatUnits(amount: bigint, decimals: number, maxFraction = decimals): string {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  let fraction = (amount % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

export function parseAmount(input: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!match) throw new Error("Enter an amount like 10 or 2.5");
  const [, whole, fraction = ""] = match;
  if (fraction.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (amount === 0n) throw new Error("Amount must be greater than zero");
  return amount;
}

export function shortAddress(value: string): string {
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

let clockSkewSecs = 0;

// Expiry is judged by the chain clock, which can drift from this machine's (Surfpool often does).
export function syncChainClock(chainSecs: number) {
  clockSkewSecs = chainSecs - Math.floor(Date.now() / 1000);
}

export function chainNow(): number {
  return Math.floor(Date.now() / 1000) + clockSkewSecs;
}

export function timeLeft(expiresAtSecs: bigint | number): string {
  const remaining = Number(expiresAtSecs) - chainNow();
  if (remaining <= 0) return "expired";
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h left`;
  return h > 0 ? `${h}h ${m}m left` : `${m}m ${remaining % 60}s left`;
}

/** Per-million rate in base units to a dollar string for a 6-decimal stablecoin. */
export function ratePerMillion(rate: number, decimals = 6): string {
  return `$${(rate / 10 ** decimals).toFixed(2)}`;
}

export function errorMessage(error: unknown): string {
  let current: unknown = error;
  while (current instanceof Error) {
    const code = (current as { context?: { code?: unknown } }).context?.code;
    if (typeof code === "number" && code >= 6000 && code < 7000) return `Program error ${code}: ${current.message}`;
    if (!current.cause) break;
    current = current.cause;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/rejected|denied|cancel/i.test(message)) return "You cancelled the request in your wallet.";
  return message;
}
