use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    /// Only authorized payout recipient.
    pub provider: Pubkey,
    pub fee_bps: u16,
    pub dispute_window_secs: i64,
    pub price_timelock_secs: i64,
    pub paused: bool,
    pub bump: u8,
}
