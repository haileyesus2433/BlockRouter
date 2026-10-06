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

impl Model {
    pub fn effective_rates(&self, now: i64) -> (u64, u64) {
        if self.effective_at != 0 && now >= self.effective_at {
            (self.pending_prompt_rate, self.pending_completion_rate)
        } else {
            (self.prompt_rate, self.completion_rate)
        }
    }
}
