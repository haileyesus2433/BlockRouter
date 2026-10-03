use anchor_lang::prelude::*;

use crate::constants::MAX_ALLOWED_MODELS;

#[account]
#[derive(InitSpace)]
pub struct Allowance {
    pub sponsor_vault: Pubkey,
    pub beneficiary: Pubkey,
    pub cap: u64,
    pub spent: u64,
    pub reserved: u64,
    #[max_len(MAX_ALLOWED_MODELS)]
    pub allowed_models: Vec<u16>,
    pub expires_at: i64,
    pub session_counter: u64,
    pub active_sessions: u16,
    pub is_active: bool,
    pub bump: u8,
}
