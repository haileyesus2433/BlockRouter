use anchor_lang::prelude::*;

use crate::state::PayerKind;

#[account]
#[derive(InitSpace)]
pub struct Session {
    /// Vault PDA or Allowance PDA, per payer_kind.
    pub payer_account: Pubkey,
    pub payer_kind: PayerKind,
    pub beneficiary: Pubkey,
    /// Only key allowed to settle.
    pub relayer: Pubkey,
    pub reserved_amount: u64,
    pub session_id: u64,
    pub expires_at: i64,
    pub bump: u8,
}
