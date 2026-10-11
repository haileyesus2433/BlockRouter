use anchor_lang::prelude::*;

use crate::{constants::MAX_ALLOWED_MODELS, state::PayerKind};

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
    /// Models the beneficiary allowed this session to be billed for.
    #[max_len(MAX_ALLOWED_MODELS)]
    pub allowed_models: Vec<u16>,
}
