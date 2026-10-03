use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct SponsorVault {
    pub sponsor: Pubkey,
    pub mint: Pubkey,
    pub balance: u64,
    /// Sum of outstanding allowance headroom (cap - spent).
    pub total_committed: u64,
    pub bump: u8,
}
