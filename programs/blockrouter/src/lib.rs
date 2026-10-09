pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;
pub mod utils;

use anchor_lang::prelude::*;
use instructions::*;

declare_id!("7maTNWbtCpuCXeRUVCNDR2a9YU7kaeUqtvrqz4ustyyi");

#[program]
pub mod blockrouter {
    use super::*;

    pub fn open_session(
        ctx: Context<OpenSession>,
        session_id: u64,
        reserved_amount: u64,
        relayer: Pubkey,
        duration_secs: i64,
    ) -> Result<()> {
        instructions::open_session::handler(
            ctx,
            session_id,
            reserved_amount,
            relayer,
            duration_secs,
        )
    }

    pub fn reclaim_expired_session(ctx: Context<ReclaimExpiredSession>) -> Result<()> {
        instructions::reclaim_expired_session::handle_reclaim_expired_session(ctx)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handle_deposit(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handle_withdraw(ctx, amount)
    }

    pub fn register_model(
        ctx: Context<RegisterModel>,
        model_id: u16,
        prompt_rate: u64,
        completion_rate: u64,
    ) -> Result<()> {
        instructions::register_model::handle_register_model(
            ctx,
            model_id,
            prompt_rate,
            completion_rate,
        )
    }

    pub fn update_model_price(
        ctx: Context<UpdateModelPrice>,
        prompt_rate: u64,
        completion_rate: u64,
    ) -> Result<()> {
        instructions::update_model_price::handle_update_model_price(
            ctx,
            prompt_rate,
            completion_rate,
        )
    }

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        treasury: Pubkey,
        provider: Pubkey,
        fee_bps: u16,
        dispute_window_secs: i64,
        price_timelock_secs: i64,
    ) -> Result<()> {
        instructions::initialize_config::handle_initialize_config(
            ctx,
            treasury,
            provider,
            fee_bps,
            dispute_window_secs,
            price_timelock_secs,
        )
    }

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        instructions::initialize_vault::handle_initialize_vault(ctx)
    }
}
