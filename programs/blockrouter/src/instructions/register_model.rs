use anchor_lang::prelude::*;

use crate::{
    constants::{CONFIG_SEED, MODEL_SEED},
    errors::BlockRouterError,
    state::{Config, Model},
};

#[derive(Accounts)]
#[instruction(model_id: u16)]
pub struct RegisterModel<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ BlockRouterError::Unauthorized
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = authority,
        space = 8 + Model::INIT_SPACE,
        seeds = [MODEL_SEED, &model_id.to_le_bytes()],
        bump
    )]
    pub model: Account<'info, Model>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_model(
    ctx: Context<RegisterModel>,
    model_id: u16,
    prompt_rate: u64,
    completion_rate: u64,
) -> Result<()> {
    ctx.accounts.model.set_inner(Model {
        model_id,
        prompt_rate,
        completion_rate,
        pending_prompt_rate: 0,
        pending_completion_rate: 0,
        effective_at: 0,
        is_active: true,
        bump: ctx.bumps.model,
    });

    emit!(ModelRegistered {
        model: ctx.accounts.model.key(),
        model_id,
        prompt_rate,
        completion_rate,
    });
    Ok(())
}

#[event]
pub struct ModelRegistered {
    pub model: Pubkey,
    pub model_id: u16,
    pub prompt_rate: u64,
    pub completion_rate: u64,
}
