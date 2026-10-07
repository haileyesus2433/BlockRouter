use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{constants::VAULT_SEED, errors::BlockRouterError, state::Vault};

#[derive(Accounts)]
pub struct Deposit<'info> {
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

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, BlockRouterError::ZeroAmount);

    let vault = &mut ctx.accounts.vault;
    vault.balance = vault
        .balance
        .checked_add(amount)
        .ok_or(BlockRouterError::MathOverflow)?;

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.user_ata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    emit!(Deposited {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.vault.owner,
        mint: ctx.accounts.vault.mint,
        amount,
        balance: ctx.accounts.vault.balance,
    });
    Ok(())
}

#[event]
pub struct Deposited {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub balance: u64,
}
