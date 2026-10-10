const LAMPORTS_PER_SOL = 1_000_000_000n;

export function formatSol(lamports: bigint): string {
  return formatUnits(lamports, LAMPORTS_PER_SOL, 9);
}

export function formatUnits(amount: bigint, base: bigint, decimals: number): string {
  const whole = amount / base;
  const fraction = (amount % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
