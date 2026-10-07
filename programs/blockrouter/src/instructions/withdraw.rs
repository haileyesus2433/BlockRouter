use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{constants::VAULT_SEED, errors::BlockRouterError, state::Vault};

// Takes no Config account on purpose: pause must never block withdrawals.
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub user: Signer<'info>,
    #[account(
        mut,
        constraint = user_ata.mint == vault.mint @ BlockRouterError::MintMismatch
    )]
    pub user_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.owner.as_ref(), vault.mint.as_ref()],
        bump = vault.bump,
        constraint = vault.owner == user.key() @ BlockRouterError::Unauthorized,
        has_one = mint @ BlockRouterError::MintMismatch
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, BlockRouterError::ZeroAmount);

    let vault = &mut ctx.accounts.vault;
    let available = vault
        .balance
        .checked_sub(vault.total_reserved)
        .ok_or(BlockRouterError::MathOverflow)?;
    require!(
        amount <= available,
        BlockRouterError::ExceedsUnreservedBalance
    );
    vault.balance = vault
        .balance
        .checked_sub(amount)
        .ok_or(BlockRouterError::MathOverflow)?;

    let owner = vault.owner;
    let mint = vault.mint;
    let bump = [vault.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, owner.as_ref(), mint.as_ref(), &bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault_ata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.user_ata.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    emit!(Withdrawn {
        vault: ctx.accounts.vault.key(),
        owner,
        mint,
        amount,
        balance: ctx.accounts.vault.balance,
    });
    Ok(())
}

#[event]
pub struct Withdrawn {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub balance: u64,
}
