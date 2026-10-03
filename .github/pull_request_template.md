Closes #

## What

One or two sentences. What changed and why.

## Program checklist *(delete if this PR doesn't touch `programs/`)*

- [ ] All arithmetic uses `checked_*`; no bare `+`/`-`/`*` on balances
- [ ] State mutated **before** the CPI transfer
- [ ] Every signer explicitly constrained
- [ ] Token account `mint` and authority validated
- [ ] Payout destination validated against stored config, not just passed in
- [ ] Invariants hold on every path, including error paths:
  - [ ] `vault.balance >= vault.total_reserved`
  - [ ] `allowance.cap >= allowance.spent + allowance.reserved`
  - [ ] `sponsor_vault.balance >= sponsor_vault.total_committed`
- [ ] Pause blocks entry only, never `withdraw`, `withdraw_sponsor`, `reclaim`, `dispute`, or `release`
- [ ] No `unwrap()` / `expect()` in program code
- [ ] Event emitted
- [ ] Account space via `#[derive(InitSpace)]`, not hand-counted
- [ ] Account layout change? `tests/state_layout.rs` updated
- [ ] New error variants appended at the end of the enum

## Tests

- [ ] Happy path
- [ ] **Every** error path for the touched handler(s)
- [ ] Unauthorized-signer test using `attacker`
- [ ] Invariant assertion
- [ ] `anchor build && cargo test` green
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all --check` green

## Dependencies

New dependency, pinned version, and why:

## Notes for the reviewer

Judgment calls, anything you're unsure about.
