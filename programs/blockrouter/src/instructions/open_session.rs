use anchor_lang::prelude::*;

use crate::{
    constants::{
        CONFIG_SEED, MAX_SESSION_SECS, MIN_SESSION_SECS, MODEL_SEED, SESSION_SEED, VAULT_SEED,
    },
    errors::BlockRouterError,
    state::{Config, Model, PayerKind, Session, Vault},
};

#[derive(Accounts)]
#[instruction(session_id: u64)]
pub struct OpenSession<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.owner.as_ref(), vault.mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = user,
        space = 8 + Session::INIT_SPACE,
        seeds = [SESSION_SEED, vault.key().as_ref(), &session_id.to_le_bytes()],
        bump
    )]
    pub session: Account<'info, Session>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
    #[account(
        seeds = [MODEL_SEED, &model.model_id.to_le_bytes()],
        bump = model.bump
    )]
    pub model: Account<'info, Model>,
}

pub fn handler(
    ctx: Context<OpenSession>,
    session_id: u64,
    reserved_amount: u64,
    relayer: Pubkey,
    duration_secs: i64,
) -> Result<()> {
    require!(
        !ctx.accounts.config.paused,
        BlockRouterError::ProtocolPaused
    );
    let vault = &mut ctx.accounts.vault;
    require_keys_eq!(
        ctx.accounts.user.key(),
        vault.owner,
        BlockRouterError::Unauthorized
    );
    require!(reserved_amount > 0, BlockRouterError::ZeroAmount);

    let available = vault
        .balance
        .checked_sub(vault.total_reserved)
        .ok_or(BlockRouterError::MathOverflow)?;
    require!(
        reserved_amount <= available,
        BlockRouterError::InsufficientUnreservedBalance
    );
    require_eq!(
        session_id,
        vault.session_counter,
        BlockRouterError::SessionIdMismatch
    );
    require!(
        (MIN_SESSION_SECS..=MAX_SESSION_SECS).contains(&duration_secs),
        BlockRouterError::InvalidDuration
    );

    let total_reserved = vault
        .total_reserved
        .checked_add(reserved_amount)
        .ok_or(BlockRouterError::MathOverflow)?;
    let session_counter = vault
        .session_counter
        .checked_add(1)
        .ok_or(BlockRouterError::MathOverflow)?;
    let expires_at = Clock::get()?
        .unix_timestamp
        .checked_add(duration_secs)
        .ok_or(BlockRouterError::MathOverflow)?;

    require!(
        ctx.accounts.model.is_active,
        BlockRouterError::ModelInactive
    );

    ctx.accounts.session.set_inner(Session {
        payer_account: vault.key(),
        payer_kind: PayerKind::Vault,
        beneficiary: vault.owner,
        relayer,
        reserved_amount,
        session_id,
        expires_at,
        bump: ctx.bumps.session,
        model_id: ctx.accounts.model.model_id,
    });
    vault.total_reserved = total_reserved;
    vault.session_counter = session_counter;

    emit!(SessionOpened {
        session: ctx.accounts.session.key(),
        payer_account: vault.key(),
        session_id,
        beneficiary: vault.owner,
        relayer,
        reserved_amount,
        expires_at,
        model_id: ctx.accounts.model.model_id,
    });
    Ok(())
}

#[event]
pub struct SessionOpened {
    pub session: Pubkey,
    pub payer_account: Pubkey,
    pub session_id: u64,
    pub beneficiary: Pubkey,
    pub relayer: Pubkey,
    pub reserved_amount: u64,
    pub expires_at: i64,
    pub model_id: u16,
}
