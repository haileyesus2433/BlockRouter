use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub balance: u64,
    pub total_reserved: u64,
    /// Monotonic; session ids are never reused.
    pub session_counter: u64,
    pub bump: u8,
}
