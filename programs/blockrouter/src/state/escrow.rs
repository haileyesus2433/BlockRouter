use anchor_lang::prelude::*;

use crate::state::PayerKind;

/// Seeded by payer and session id because the Session closes at settlement.
#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub payer_account: Pubkey,
    pub payer_kind: PayerKind,
    pub disputer: Pubkey,
    pub refund_to: Pubkey,
    pub mint: Pubkey,
    pub principal: u64,
    pub fee: u64,
    pub created_at: i64,
    pub is_disputed: bool,
    pub evidence_hash: [u8; 32],
    pub bump: u8,
}
