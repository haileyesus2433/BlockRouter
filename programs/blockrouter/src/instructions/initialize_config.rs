use anchor_lang::prelude::*;

use crate::{
    constants::{CONFIG_SEED, MAX_FEE_BPS},
    errors::BlockRouterError,
    program::Blockrouter,
    state::Config,
};

// Only the program's upgrade authority can initialize, so nobody can front-run the deploy.
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, Blockrouter>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ BlockRouterError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(
    ctx: Context<InitializeConfig>,
    treasury: Pubkey,
    provider: Pubkey,
    fee_bps: u16,
    dispute_window_secs: i64,
    price_timelock_secs: i64,
) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, BlockRouterError::FeeTooHigh);

    let authority = ctx.accounts.authority.key();
    ctx.accounts.config.set_inner(Config {
        authority,
        treasury,
        provider,
        fee_bps,
        dispute_window_secs,
        price_timelock_secs,
        paused: false,
        bump: ctx.bumps.config,
    });

    emit!(ConfigInitialized {
        config: ctx.accounts.config.key(),
        authority,
        treasury,
        provider,
        fee_bps,
        dispute_window_secs,
        price_timelock_secs,
    });
    Ok(())
}

#[event]
pub struct ConfigInitialized {
    pub config: Pubkey,
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub provider: Pubkey,
    pub fee_bps: u16,
    pub dispute_window_secs: i64,
    pub price_timelock_secs: i64,
}
