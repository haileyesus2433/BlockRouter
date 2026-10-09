use anchor_lang::prelude::*;

use crate::{
    constants::{SESSION_SEED, VAULT_SEED},
    errors::BlockRouterError,
    state::{PayerKind, Session, Vault},
};

// Reclaim is an exit path: it deliberately has no Config or token accounts.
#[derive(Accounts)]
pub struct ReclaimExpiredSession<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.owner.as_ref(), vault.mint.as_ref()],
        bump = vault.bump,
        constraint = vault.owner == user.key() @ BlockRouterError::Unauthorized
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        close = user,
        seeds = [SESSION_SEED, session.payer_account.as_ref(), &session.session_id.to_le_bytes()],
        bump = session.bump
    )]
    pub session: Account<'info, Session>,
}

pub fn handle_reclaim_expired_session(ctx: Context<ReclaimExpiredSession>) -> Result<()> {
    let session = &ctx.accounts.session;
    require!(
        session.payer_kind == PayerKind::Vault && session.payer_account == ctx.accounts.vault.key(),
        BlockRouterError::SessionVaultMismatch
    );
    require_keys_eq!(
        session.beneficiary,
        ctx.accounts.user.key(),
        BlockRouterError::Unauthorized
    );
    require!(
        Clock::get()?.unix_timestamp > session.expires_at,
        BlockRouterError::SessionNotExpired
    );

    let total_reserved = ctx
        .accounts
        .vault
        .total_reserved
        .checked_sub(session.reserved_amount)
        .ok_or(BlockRouterError::MathOverflow)?;
    ctx.accounts.vault.total_reserved = total_reserved;

    emit!(SessionReclaimed {
        session: session.key(),
        vault: ctx.accounts.vault.key(),
        session_id: session.session_id,
        owner: ctx.accounts.user.key(),
        reserved_amount: session.reserved_amount,
    });
    Ok(())
}

#[event]
pub struct SessionReclaimed {
    pub session: Pubkey,
    pub vault: Pubkey,
    pub session_id: u64,
    pub owner: Pubkey,
    pub reserved_amount: u64,
}
