import { useState } from "react";

import type { MintInfo, VaultView } from "../chain";
import { formatUnits, parseAmount } from "../format";
import type { Identity } from "../identity";
import { deposit, withdraw } from "../tx";
import { Card, type Notice, useRunner } from "./ui";

export function Vault(props: {
  identity: Identity;
  mint: MintInfo;
  vault: VaultView;
  onChanged: () => void;
  notify: (notice: Notice) => void;
}) {
  const { identity, mint, vault, onChanged, notify } = props;
  const [amount, setAmount] = useState("10");
  const { busy, run } = useRunner(notify);
  const available = vault.balance - vault.reserved;
  const show = (value: bigint) => `${formatUnits(value, mint.decimals)} ${mint.label}`;

  async function act(kind: "deposit" | "withdraw", all = false) {
    const value = all ? available : parseAmount(amount, mint.decimals);
    await run(
      kind,
      () => (kind === "deposit" ? deposit(identity, mint, vault, value) : withdraw(identity, mint, value)),
      (signature) => ({
        kind: "ok",
        text: `${kind === "deposit" ? "Deposited" : "Withdrew"} ${show(value)}`,
        signature,
      }),
    );
    onChanged();
  }

  return (
    <Card title="Vault" subtitle="A program account only your wallet can withdraw from.">
      <div className="stats">
        <div>
          <span className="label">In vault</span>
          <strong>{show(vault.balance)}</strong>
        </div>
        <div>
          <span className="label">Reserved by sessions</span>
          <strong>{show(vault.reserved)}</strong>
        </div>
        <div>
          <span className="label">Available to withdraw</span>
          <strong className="accent">{show(available)}</strong>
        </div>
        <div>
          <span className="label">In your wallet</span>
          <strong>{show(vault.wallet)}</strong>
        </div>
      </div>
      <div className="row">
        <input
          className="amount"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          aria-label={`Amount in ${mint.label}`}
        />
        <span className="unit">{mint.label}</span>
        <button disabled={busy !== null} onClick={() => act("deposit")}>
          {busy === "deposit" ? "Depositing…" : vault.exists ? "Deposit" : "Create vault and deposit"}
        </button>
        <button className="ghost" disabled={busy !== null || !vault.exists} onClick={() => act("withdraw")}>
          {busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
        </button>
        <button className="ghost" disabled={busy !== null || available === 0n} onClick={() => act("withdraw", true)}>
          Withdraw all available
        </button>
      </div>
      {vault.sol < 5_000_000n ? (
        <p className="warning-text">This wallet has almost no SOL, which it needs for transaction fees.</p>
      ) : null}
    </Card>
  );
}
