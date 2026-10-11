//! Vault-only settlement of relayer-reported token counts; usage is not verified on-chain.
//! Rates are in mint base units and read at settlement time.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::{CONFIG_SEED, MAX_ALLOWED_MODELS, SESSION_SEED, VAULT_SEED},
    errors::BlockRouterError,
    state::{Config, PayerKind, Session, Vault},
    utils::{calculate_charge, load_model},
};

/// Raw token counts for one model. The program prices them; the relayer never sends an amount.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ModelUsage {
    pub model_id: u16,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

#[derive(Accounts)]
pub struct SettleSessionUsage<'info> {
    pub relayer: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.owner.as_ref(), vault.mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
        token::token_program = token_program
    )]
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        close = beneficiary,
        seeds = [SESSION_SEED, session.payer_account.as_ref(), &session.session_id.to_le_bytes()],
        bump = session.bump
    )]
    pub session: Account<'info, Session>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub provider_ata: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(address = vault.mint @ BlockRouterError::MintMismatch, mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: Address is bound to the Session beneficiary and authorized Vault owner.
    #[account(
        mut,
        address = session.beneficiary @ BlockRouterError::Unauthorized,
        constraint = session.beneficiary == vault.owner @ BlockRouterError::Unauthorized
    )]
    pub beneficiary: UncheckedAccount<'info>,
}

// Remaining accounts: one Model PDA per usage line, in the same order.
pub fn handle_settle_session_usage<'info>(
    ctx: Context<'info, SettleSessionUsage<'info>>,
    usage: Vec<ModelUsage>,
) -> Result<()> {
    let session = &ctx.accounts.session;
    require_keys_eq!(
        ctx.accounts.relayer.key(),
        session.relayer,
        BlockRouterError::UnauthorizedRelayer
    );
    require!(
        session.payer_kind == PayerKind::Vault && session.payer_account == ctx.accounts.vault.key(),
        BlockRouterError::SessionVaultMismatch
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now <= session.expires_at, BlockRouterError::SessionExpired);
    require!(
        usage.len() <= MAX_ALLOWED_MODELS,
        BlockRouterError::TooManyModels
    );
    require!(
        ctx.remaining_accounts.len() == usage.len(),
        BlockRouterError::ModelNotFound
    );
    let mut charge: u64 = 0;
    let mut prompt_tokens: u64 = 0;
    let mut completion_tokens: u64 = 0;
    for (index, (line, info)) in usage.iter().zip(ctx.remaining_accounts).enumerate() {
        require!(
            !usage[..index]
                .iter()
                .any(|seen| seen.model_id == line.model_id),
            BlockRouterError::DuplicateModel
        );
        require!(
            session.allowed_models.contains(&line.model_id),
            BlockRouterError::SessionModelMismatch
        );
        let model = load_model(info, line.model_id, ctx.program_id)?;
        require!(model.is_active, BlockRouterError::ModelInactive);
        let (prompt_rate, completion_rate) = model.effective_rates(now);
        let line_charge = calculate_charge(
            line.prompt_tokens,
            line.completion_tokens,
            prompt_rate,
            completion_rate,
        )?;
        charge = charge
            .checked_add(line_charge)
            .ok_or(BlockRouterError::MathOverflow)?;
        prompt_tokens = prompt_tokens
            .checked_add(line.prompt_tokens)
            .ok_or(BlockRouterError::MathOverflow)?;
        completion_tokens = completion_tokens
            .checked_add(line.completion_tokens)
            .ok_or(BlockRouterError::MathOverflow)?;
    }
    require!(
        charge <= session.reserved_amount,
        BlockRouterError::ChargeExceedsReservation
    );

    let provider_ata = &ctx.accounts.provider_ata;
    require!(
        provider_ata.owner == ctx.accounts.config.provider
            && provider_ata.mint == ctx.accounts.vault.mint
            && *provider_ata.to_account_info().owner == ctx.accounts.token_program.key()
            && provider_ata.key()
                == get_associated_token_address_with_program_id(
                    &ctx.accounts.config.provider,
                    &ctx.accounts.vault.mint,
                    &ctx.accounts.token_program.key()
                )
            && provider_ata.key() != ctx.accounts.vault_ata.key(),
        BlockRouterError::UnauthorizedProvider
    );

    let unused_released = session
        .reserved_amount
        .checked_sub(charge)
        .ok_or(BlockRouterError::MathOverflow)?;
    let vault = &mut ctx.accounts.vault;
    require!(
        vault.balance >= vault.total_reserved,
        BlockRouterError::MathOverflow
    );
    let balance = vault
        .balance
        .checked_sub(charge)
        .ok_or(BlockRouterError::MathOverflow)?;
    let total_reserved = vault
        .total_reserved
        .checked_sub(session.reserved_amount)
        .ok_or(BlockRouterError::MathOverflow)?;
    require!(balance >= total_reserved, BlockRouterError::MathOverflow);
    vault.balance = balance;
    vault.total_reserved = total_reserved;

    // Fees are deferred: the entire charge goes to the provider. Pause does not
    // block settlement. Zero charges still release the reservation and close.
    if charge > 0 {
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
                    to: ctx.accounts.provider_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            charge,
            ctx.accounts.mint.decimals,
        )?;
    }
    emit!(UsageSettled {
        session: ctx.accounts.session.key(),
        vault: ctx.accounts.vault.key(),
        relayer: ctx.accounts.relayer.key(),
        charge,
        prompt_tokens,
        completion_tokens,
        usage,
        unused_released,
    });
    Ok(())
}

#[event]
pub struct UsageSettled {
    pub session: Pubkey,
    pub vault: Pubkey,
    pub relayer: Pubkey,
    pub charge: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    /// Per-model raw token counts that produced the charge.
    pub usage: Vec<ModelUsage>,
    pub unused_released: u64,
}
