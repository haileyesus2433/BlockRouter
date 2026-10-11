export function parseAmount(input: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!match) {
    throw new Error(`invalid amount "${input}". Use a number like 10 or 2.5`);
  }
  const [, whole, fraction = ""] = match;
  if (fraction.length > decimals) {
    throw new Error(`amount "${input}" has more than ${decimals} decimal places`);
  }
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (amount === 0n) {
    throw new Error("amount must be greater than zero");
  }
  return amount;
}
