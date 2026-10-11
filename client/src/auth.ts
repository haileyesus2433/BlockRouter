// Shared by the relayer (verifies) and the CLI (signs); keep the format in one place.

export const WALLET_AUTH_HEADERS = {
  address: "X-BlockRouter-Address",
  timestamp: "X-BlockRouter-Timestamp",
  signature: "X-BlockRouter-Signature",
} as const;

/** The exact message a wallet signs to call the relayer's key endpoints. */
export function walletAuthMessage(wallet: string, method: string, path: string, timestamp: number): string {
  return [
    "BlockRouter API request",
    `Address: ${wallet}`,
    `Method: ${method.toUpperCase()}`,
    `Path: ${path}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");
}
