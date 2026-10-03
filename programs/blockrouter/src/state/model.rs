use anchor_lang::prelude::*;

/// Rates are base units per 1,000,000 tokens.
#[account]
#[derive(InitSpace)]
pub struct Model {
    pub model_id: u16,
    pub prompt_rate: u64,
    pub completion_rate: u64,
    pub pending_prompt_rate: u64,
    pub pending_completion_rate: u64,
    /// 0 means no pending price change.
    pub effective_at: i64,
    pub is_active: bool,
    pub bump: u8,
}
