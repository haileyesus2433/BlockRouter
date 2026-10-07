use anchor_lang::prelude::*;

use crate::{
    constants::{CONFIG_SEED, MODEL_SEED},
    errors::BlockRouterError,
    state::{Config, Model},
};

#[derive(Accounts)]
pub struct UpdateModelPrice<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ BlockRouterError::Unauthorized
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [MODEL_SEED, &model.model_id.to_le_bytes()],
        bump = model.bump
    )]
    pub model: Account<'info, Model>,
}

pub fn handle_update_model_price(
    ctx: Context<UpdateModelPrice>,
    prompt_rate: u64,
    completion_rate: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let timelock = ctx.accounts.config.price_timelock_secs;
    let model = &mut ctx.accounts.model;

    // Promote a matured pending change before comparing against it.
    let (current_prompt, current_completion) = model.effective_rates(now);
    model.prompt_rate = current_prompt;
    model.completion_rate = current_completion;

    let immediate = prompt_rate <= current_prompt && completion_rate <= current_completion;
    if immediate {
        model.prompt_rate = prompt_rate;
        model.completion_rate = completion_rate;
        model.pending_prompt_rate = 0;
        model.pending_completion_rate = 0;
        model.effective_at = 0;
    } else {
        model.pending_prompt_rate = prompt_rate;
        model.pending_completion_rate = completion_rate;
        model.effective_at = now
            .checked_add(timelock)
            .ok_or(BlockRouterError::MathOverflow)?;
    }

    emit!(ModelPriceUpdated {
        model: model.key(),
        model_id: model.model_id,
        prompt_rate,
        completion_rate,
        immediate,
        effective_at: model.effective_at,
    });
    Ok(())
}

#[event]
pub struct ModelPriceUpdated {
    pub model: Pubkey,
    pub model_id: u16,
    pub prompt_rate: u64,
    pub completion_rate: u64,
    pub immediate: bool,
    /// 0 when the change applied immediately.
    pub effective_at: i64,
}
