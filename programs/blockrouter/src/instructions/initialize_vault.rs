use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::spl_token_2022::{
        extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
        state::Mint as MintState,
    },
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{constants::VAULT_SEED, errors::BlockRouterError, state::Vault};

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init,
        payer = user,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, user.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    // init_if_needed: anyone can create this ATA first, which must not block vault creation.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
    reject_transfer_fee(&ctx.accounts.mint.to_account_info())?;

    let owner = ctx.accounts.user.key();
    let mint = ctx.accounts.mint.key();
    ctx.accounts.vault.set_inner(Vault {
        owner,
        mint,
        balance: 0,
        total_reserved: 0,
        session_counter: 0,
        bump: ctx.bumps.vault,
    });

    emit!(VaultInitialized {
        vault: ctx.accounts.vault.key(),
        owner,
        mint,
        vault_ata: ctx.accounts.vault_ata.key(),
    });
    Ok(())
}

// A transfer fee means the vault receives less than it records.
fn reject_transfer_fee(mint: &AccountInfo) -> Result<()> {
    if *mint.owner != anchor_spl::token_2022::ID {
        return Ok(());
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data)?;
    require!(
        !state
            .get_extension_types()?
            .contains(&ExtensionType::TransferFeeConfig),
        BlockRouterError::UnsupportedMint
    );
    Ok(())
}

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub vault_ata: Pubkey,
}
