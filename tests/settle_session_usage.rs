use crate::common::{self, address, pubkey, read, seed_account, Actor, TestEnv};
use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::program_pack::Pack,
    InstructionData, ToAccountMetas,
};
use blockrouter::{
    errors::BlockRouterError,
    instructions::UsageSettled,
    state::{Config, Model, PayerKind, Session, Vault},
};
use litesvm::types::TransactionMetadata;
use litesvm_token::{
    get_spl_account, spl_token::state::Account as TokenAccount, CreateAssociatedTokenAccount,
    CreateMint,
};
use solana_keypair::Signer;
use solana_transaction::{Instruction, InstructionError, TransactionError};

const MODEL_ID: u16 = 42;
const RESERVATION: u64 = 300;

struct Fixture {
    env: TestEnv,
    vault: Pubkey,
    session: Pubkey,
}
impl Fixture {
    fn new() -> Self {
        Self::with_program(address(anchor_spl::token::ID))
    }
    fn with_program(token_program: solana_keypair::Address) -> Self {
        let mut env = common::setup_with_token_program(token_program);
        common::init_config(&mut env);
        let mut config = read::<Config>(&env.svm, common::config_pda());
        config.provider = env.key(Actor::Bob);
        config.price_timelock_secs = 100;
        seed_account(&mut env.svm, common::config_pda(), &config);
        common::seed_model(&mut env.svm, MODEL_ID);
        let mut model = read::<Model>(&env.svm, common::model_pda(MODEL_ID));
        model.prompt_rate = 100;
        model.completion_rate = 200;
        seed_account(&mut env.svm, common::model_pda(MODEL_ID), &model);
        let vault = common::funded_vault(&mut env, Actor::Alice, 1_000);
        let session = common::open_session(&mut env, Actor::Alice, RESERVATION, 3_600, MODEL_ID);
        Self {
            env,
            vault,
            session,
        }
    }
    fn ix(&self, prompt_tokens: u64, completion_tokens: u64) -> Instruction {
        Instruction {
            program_id: address(blockrouter::id()),
            accounts: blockrouter::accounts::SettleSessionUsage {
                relayer: self.env.key(Actor::Relayer),
                vault: self.vault,
                vault_ata: pubkey(self.env.vault_ata(self.vault)),
                session: self.session,
                model: common::model_pda(MODEL_ID),
                config: common::config_pda(),
                provider_ata: pubkey(self.env.ata(Actor::Bob)),
                token_program: pubkey(self.env.token_program),
                mint: pubkey(self.env.mint),
                beneficiary: self.env.key(Actor::Alice),
            }
            .to_account_metas(None),
            data: blockrouter::instruction::SettleSessionUsage {
                prompt_tokens,
                completion_tokens,
            }
            .data(),
        }
    }
    fn failure(
        &mut self,
        actor: Actor,
        ix: Instruction,
        expected: InstructionError,
    ) -> TransactionMetadata {
        let mut watched: Vec<_> = ix
            .accounts
            .iter()
            .filter(|a| a.pubkey != address(self.env.key(actor)))
            .map(|a| a.pubkey)
            .collect();
        // Also watch the original accounts when an adversarial account is substituted.
        watched.extend([
            address(self.vault),
            address(self.session),
            self.env.vault_ata(self.vault),
            self.env.ata(Actor::Bob),
            self.env.ata(Actor::Alice),
        ]);
        let before: Vec<_> = watched
            .iter()
            .map(|k| self.env.svm.get_account(k))
            .collect();
        let failure = self.env.send(actor, ix).unwrap_err();
        assert_eq!(
            failure.err,
            TransactionError::InstructionError(0, expected),
            "{}",
            failure.meta.pretty_logs()
        );
        let after: Vec<_> = watched
            .iter()
            .map(|k| self.env.svm.get_account(k))
            .collect();
        assert_eq!(before, after, "failed settlement changed an account");
        failure.meta
    }
    fn error(&mut self, ix: Instruction, error: BlockRouterError) {
        self.failure(
            Actor::Relayer,
            ix,
            InstructionError::Custom(u32::from(error)),
        );
    }
    fn anchor_error(&mut self, ix: Instruction, error: anchor_lang::error::ErrorCode) {
        self.failure(
            Actor::Relayer,
            ix,
            InstructionError::Custom(u32::from(error)),
        );
    }
    fn time(&mut self, now: i64) {
        let mut clock = self.env.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = now;
        self.env.svm.set_sysvar(&clock);
    }
    fn model(&mut self, change: impl FnOnce(&mut Model)) {
        let mut m = read::<Model>(&self.env.svm, common::model_pda(MODEL_ID));
        change(&mut m);
        seed_account(&mut self.env.svm, common::model_pda(MODEL_ID), &m);
    }
    fn vault(&mut self, change: impl FnOnce(&mut Vault)) {
        let mut v = read::<Vault>(&self.env.svm, self.vault);
        change(&mut v);
        seed_account(&mut self.env.svm, self.vault, &v);
    }
    fn session(&mut self, change: impl FnOnce(&mut Session)) {
        let mut s = read::<Session>(&self.env.svm, self.session);
        change(&mut s);
        seed_account(&mut self.env.svm, self.session, &s);
    }
    fn token(&mut self, key: solana_keypair::Address, change: impl FnOnce(&mut TokenAccount)) {
        let mut state = get_spl_account::<TokenAccount>(&self.env.svm, &key).unwrap();
        change(&mut state);
        let mut account = self.env.svm.get_account(&key).unwrap();
        TokenAccount::pack(state, &mut account.data).unwrap();
        self.env.svm.set_account(key, account).unwrap();
    }
    fn success(&mut self, prompt: u64, completion: u64, expected: u64) -> TransactionMetadata {
        common::assert_vault_invariant(&self.env, self.vault);
        common::assert_vault_matches_ata(&self.env, self.vault);
        let before = read::<Vault>(&self.env.svm, self.vault);
        let session = read::<Session>(&self.env.svm, self.session);
        let provider = common::token_balance(&self.env.svm, &self.env.ata(Actor::Bob));
        let user_tokens = common::token_balance(&self.env.svm, &self.env.ata(Actor::Alice));
        let rent = self
            .env
            .svm
            .get_account(&address(self.session))
            .unwrap()
            .lamports;
        let user_lamports = self
            .env
            .svm
            .get_account(&address(self.env.key(Actor::Alice)))
            .unwrap()
            .lamports;
        let relayer_lamports = self
            .env
            .svm
            .get_account(&address(self.env.key(Actor::Relayer)))
            .unwrap()
            .lamports;
        let config_before = self.env.svm.get_account(&address(common::config_pda()));
        let model_before = self
            .env
            .svm
            .get_account(&address(common::model_pda(MODEL_ID)));
        let metadata = self
            .env
            .send(Actor::Relayer, self.ix(prompt, completion))
            .unwrap();
        let after = read::<Vault>(&self.env.svm, self.vault);
        assert_eq!(after.balance, before.balance - expected);
        let available_before = before.balance.checked_sub(before.total_reserved).unwrap();
        let available_after = after.balance.checked_sub(after.total_reserved).unwrap();
        assert_eq!(
            available_after.checked_sub(available_before).unwrap(),
            session.reserved_amount.checked_sub(expected).unwrap()
        );
        assert_eq!(
            after.total_reserved,
            before.total_reserved - session.reserved_amount
        );
        assert_eq!(after.session_counter, before.session_counter);
        assert_eq!(after.owner, before.owner);
        assert_eq!(after.mint, before.mint);
        assert_eq!(after.bump, before.bump);
        assert_eq!(
            common::token_balance(&self.env.svm, &self.env.ata(Actor::Bob)),
            provider + expected
        );
        assert_eq!(
            common::token_balance(&self.env.svm, &self.env.ata(Actor::Alice)),
            user_tokens
        );
        assert_eq!(
            self.env
                .svm
                .get_account(&address(self.env.key(Actor::Alice)))
                .unwrap()
                .lamports,
            user_lamports + rent
        );
        assert_eq!(
            self.env
                .svm
                .get_account(&address(self.env.key(Actor::Relayer)))
                .unwrap()
                .lamports,
            relayer_lamports - metadata.fee
        );
        assert!(self.env.svm.get_account(&address(self.session)).is_none());
        assert_eq!(
            self.env.svm.get_account(&address(common::config_pda())),
            config_before
        );
        assert_eq!(
            self.env
                .svm
                .get_account(&address(common::model_pda(MODEL_ID))),
            model_before
        );
        common::assert_vault_invariant(&self.env, self.vault);
        common::assert_vault_matches_ata(&self.env, self.vault);
        let events = common::events::<UsageSettled>(&metadata);
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.session, self.session);
        assert_eq!(event.vault, self.vault);
        assert_eq!(event.relayer, self.env.key(Actor::Relayer));
        assert_eq!(event.charge, expected);
        assert_eq!(event.prompt_tokens, prompt);
        assert_eq!(event.completion_tokens, completion);
        assert_eq!(event.model_id, MODEL_ID);
        assert_eq!(event.unused_released, session.reserved_amount - expected);
        metadata
    }
}

#[test]
fn settles_raw_usage_with_full_provider_payment_and_event() {
    let m = Fixture::new().success(1_000_000, 500_000, 200);
    assert!(m.inner_instructions.iter().any(|v| !v.is_empty()));
}
#[test]
fn token_2022_settlement_works() {
    Fixture::with_program(address(anchor_spl::token_2022::ID)).success(1_000_000, 0, 100);
}
#[test]
fn partial_charge_releases_unused_reservation() {
    let mut f = Fixture::new();
    f.success(1_000_000, 0, 100);
    let v = read::<Vault>(&f.env.svm, f.vault);
    assert_eq!(v.balance, 900);
    assert_eq!(v.total_reserved, 0);
}
#[test]
fn exactly_reserved_charge_succeeds() {
    Fixture::new().success(1_000_000, 1_000_000, 300);
}
#[test]
fn zero_usage_releases_without_cpi() {
    let m = Fixture::new().success(0, 0, 0);
    assert!(m.inner_instructions.iter().all(Vec::is_empty));
}
#[test]
fn rounded_zero_charge_releases_without_cpi() {
    let m = Fixture::new().success(1, 0, 0);
    assert!(m.inner_instructions.iter().all(Vec::is_empty));
}
#[test]
fn settlement_works_while_paused() {
    let mut f = Fixture::new();
    let mut c = read::<Config>(&f.env.svm, common::config_pda());
    c.paused = true;
    seed_account(&mut f.env.svm, common::config_pda(), &c);
    f.success(1_000_000, 0, 100);
}
#[test]
fn multiple_reservations_release_only_selected_session() {
    let mut f = Fixture::new();
    let other = common::open_session(&mut f.env, Actor::Alice, 400, 3_600, MODEL_ID);
    let before = f.env.svm.get_account(&address(other));
    f.success(1_000_000, 0, 100);
    assert_eq!(read::<Vault>(&f.env.svm, f.vault).total_reserved, 400);
    assert_eq!(f.env.svm.get_account(&address(other)), before);
}
#[test]
fn unauthorized_relayer_is_rejected() {
    let mut f = Fixture::new();
    let mut ix = f.ix(0, 0);
    ix.accounts[0].pubkey = address(f.env.key(Actor::Attacker));
    f.failure(
        Actor::Attacker,
        ix,
        InstructionError::Custom(u32::from(BlockRouterError::UnauthorizedRelayer)),
    );
}
#[test]
fn wrong_vault_association_is_rejected() {
    let mut f = Fixture::new();
    let alice = f.env.keypair(Actor::Alice);
    let mint = CreateMint::new(&mut f.env.svm, &alice)
        .decimals(6)
        .token_program_id(&f.env.token_program)
        .send()
        .unwrap();
    let other = common::vault_pda(&alice.pubkey(), &mint);
    let init = common::initialize_vault_ix(&alice, &mint, &f.env.token_program);
    f.env.send(Actor::Alice, init).unwrap();
    let mut ix = f.ix(0, 0);
    ix.accounts[1].pubkey = address(other);
    ix.accounts[2].pubkey = common::ata_address(&address(other), &mint, &f.env.token_program);
    ix.accounts[8].pubkey = mint;
    f.error(ix, BlockRouterError::SessionVaultMismatch);
}
#[test]
fn allowance_sessions_are_rejected() {
    let mut f = Fixture::new();
    f.session(|s| s.payer_kind = PayerKind::Allowance);
    let ix = f.ix(0, 0);
    f.error(ix, BlockRouterError::SessionVaultMismatch);
}
#[test]
fn expired_session_is_rejected() {
    let mut f = Fixture::new();
    f.time(common::NOW + 3_601);
    let ix = f.ix(0, 0);
    f.error(ix, BlockRouterError::SessionExpired);
}
#[test]
fn equality_at_expiry_succeeds() {
    let mut f = Fixture::new();
    f.time(common::NOW + 3_600);
    f.success(1_000_000, 0, 100);
}
#[test]
fn model_substitution_is_rejected() {
    let mut f = Fixture::new();
    let model = common::seed_model(&mut f.env.svm, 43);
    let mut ix = f.ix(0, 0);
    ix.accounts[4].pubkey = address(model);
    f.error(ix, BlockRouterError::SessionModelMismatch);
}
#[test]
fn inactive_model_is_rejected() {
    let mut f = Fixture::new();
    f.model(|m| m.is_active = false);
    let ix = f.ix(0, 0);
    f.error(ix, BlockRouterError::ModelInactive);
}
#[test]
fn excessive_charge_is_rejected() {
    let mut f = Fixture::new();
    let ix = f.ix(4_000_000, 0);
    f.error(ix, BlockRouterError::ChargeExceedsReservation);
}
#[test]
fn attacker_provider_is_rejected() {
    let mut f = Fixture::new();
    let attacker_ata = f.env.ata(Actor::Attacker);
    let attacker_account = get_spl_account::<TokenAccount>(&f.env.svm, &attacker_ata).unwrap();
    assert_eq!(
        attacker_account.owner,
        f.env.keypair(Actor::Attacker).pubkey()
    );
    assert_eq!(attacker_account.mint, f.env.mint);
    // A real positive charge would be paid here if destination authorization failed.
    let mut ix = f.ix(1_000_000, 0);
    ix.accounts[6].pubkey = attacker_ata;
    f.error(ix, BlockRouterError::UnauthorizedProvider);
}
#[test]
fn wrong_provider_mint_is_rejected() {
    let mut f = Fixture::new();
    let bob = f.env.keypair(Actor::Bob);
    let mint = CreateMint::new(&mut f.env.svm, &bob)
        .decimals(6)
        .token_program_id(&f.env.token_program)
        .send()
        .unwrap();
    let ata = CreateAssociatedTokenAccount::new(&mut f.env.svm, &bob, &mint)
        .token_program_id(&f.env.token_program)
        .send()
        .unwrap();
    let mut ix = f.ix(0, 0);
    ix.accounts[6].pubkey = ata;
    f.error(ix, BlockRouterError::UnauthorizedProvider);
}
#[test]
fn noncanonical_provider_account_is_rejected() {
    let mut f = Fixture::new();
    let fake = Pubkey::new_unique();
    let account = f.env.svm.get_account(&f.env.ata(Actor::Bob)).unwrap();
    f.env.svm.set_account(address(fake), account).unwrap();
    let mut ix = f.ix(0, 0);
    ix.accounts[6].pubkey = address(fake);
    f.error(ix, BlockRouterError::UnauthorizedProvider);
}
#[test]
fn aliased_source_and_destination_are_rejected() {
    let mut f = Fixture::new();
    let mut c = read::<Config>(&f.env.svm, common::config_pda());
    c.provider = f.vault;
    seed_account(&mut f.env.svm, common::config_pda(), &c);
    let mut ix = f.ix(0, 0);
    ix.accounts[6].pubkey = f.env.vault_ata(f.vault);
    f.anchor_error(
        ix,
        anchor_lang::error::ErrorCode::ConstraintDuplicateMutableAccount,
    );
}
#[test]
fn wrong_provider_token_program_is_rejected() {
    let mut f = Fixture::new();
    let key = f.env.ata(Actor::Bob);
    let mut account = f.env.svm.get_account(&key).unwrap();
    account.owner = address(anchor_spl::token_2022::ID);
    f.env.svm.set_account(key, account).unwrap();
    let ix = f.ix(0, 0);
    f.error(ix, BlockRouterError::UnauthorizedProvider);
}
#[test]
fn wrong_vault_token_authority_is_rejected() {
    let mut f = Fixture::new();
    let owner = f.env.keypair(Actor::Attacker).pubkey();
    f.token(f.env.vault_ata(f.vault), |a| a.owner = owner);
    let ix = f.ix(0, 0);
    f.anchor_error(ix, anchor_lang::error::ErrorCode::ConstraintTokenOwner);
}
#[test]
fn noncanonical_vault_ata_is_rejected() {
    let mut f = Fixture::new();
    let fake = Pubkey::new_unique();
    let account = f.env.svm.get_account(&f.env.vault_ata(f.vault)).unwrap();
    f.env.svm.set_account(address(fake), account).unwrap();
    let mut ix = f.ix(0, 0);
    ix.accounts[2].pubkey = address(fake);
    f.anchor_error(ix, anchor_lang::error::ErrorCode::ConstraintAssociated);
}
#[test]
fn wrong_model_pda_is_rejected() {
    let mut f = Fixture::new();
    let fake = Pubkey::new_unique();
    let m = read::<Model>(&f.env.svm, common::model_pda(MODEL_ID));
    seed_account(&mut f.env.svm, fake, &m);
    let mut ix = f.ix(0, 0);
    ix.accounts[4].pubkey = address(fake);
    f.anchor_error(ix, anchor_lang::error::ErrorCode::ConstraintSeeds);
}
#[test]
fn wrong_session_pda_is_rejected() {
    let mut f = Fixture::new();
    let fake = Pubkey::new_unique();
    let s = read::<Session>(&f.env.svm, f.session);
    seed_account(&mut f.env.svm, fake, &s);
    let mut ix = f.ix(0, 0);
    ix.accounts[3].pubkey = address(fake);
    f.anchor_error(ix, anchor_lang::error::ErrorCode::ConstraintSeeds);
}
#[test]
fn wrong_rent_recipient_is_rejected() {
    let mut f = Fixture::new();
    let mut ix = f.ix(0, 0);
    ix.accounts[9].pubkey = address(f.env.key(Actor::Attacker));
    f.error(ix, BlockRouterError::Unauthorized);
}
#[test]
fn beneficiary_must_be_vault_owner() {
    let mut f = Fixture::new();
    let bob = f.env.key(Actor::Bob);
    f.session(|s| s.beneficiary = bob);
    let mut ix = f.ix(0, 0);
    ix.accounts[9].pubkey = address(bob);
    f.error(ix, BlockRouterError::Unauthorized);
}
#[test]
fn double_settlement_is_rejected_with_fresh_blockhash() {
    let mut f = Fixture::new();
    f.success(0, 0, 0);
    let ix = f.ix(0, 0);
    f.anchor_error(ix, anchor_lang::error::ErrorCode::AccountNotInitialized);
}
#[test]
fn u128_add_overflow_is_rejected() {
    let mut f = Fixture::new();
    f.model(|m| {
        m.prompt_rate = u64::MAX;
        m.completion_rate = u64::MAX;
    });
    let ix = f.ix(u64::MAX, u64::MAX);
    f.error(ix, BlockRouterError::MathOverflow);
}
#[test]
fn u64_charge_overflow_is_rejected() {
    let mut f = Fixture::new();
    f.model(|m| m.prompt_rate = u64::MAX);
    let ix = f.ix(u64::MAX, 0);
    f.error(ix, BlockRouterError::MathOverflow);
}
#[test]
fn reservation_subtraction_underflow_rolls_back() {
    let mut f = Fixture::new();
    f.vault(|v| v.total_reserved = 299);
    let ix = f.ix(1_000_000, 0);
    f.error(ix, BlockRouterError::MathOverflow);
}
#[test]
fn corrupted_vault_invariant_is_rejected() {
    let mut f = Fixture::new();
    f.vault(|v| v.balance = 299);
    let ix = f.ix(1_000_000, 0);
    f.error(ix, BlockRouterError::MathOverflow);
}
#[test]
fn insufficient_token_funds_cpi_rolls_back_accounting() {
    let mut f = Fixture::new();
    f.token(f.env.vault_ata(f.vault), |a| a.amount = 99);
    let ix = f.ix(1_000_000, 0);
    let metadata = f.failure(
        Actor::Relayer,
        ix,
        InstructionError::Custom(
            litesvm_token::spl_token::error::TokenError::InsufficientFunds as u32,
        ),
    );
    assert!(metadata.inner_instructions.iter().any(|v| !v.is_empty()));
    assert!(metadata
        .inner_instructions
        .iter()
        .flatten()
        .any(|inner| inner.instruction.data.first() == Some(&12)));
    let invocation = format!("Program {} invoke [2]", f.env.token_program);
    assert!(
        metadata.logs.iter().any(|log| log == &invocation),
        "{}",
        metadata.pretty_logs()
    );
}

fn timelock_case(offset: i64, expected: u64) {
    let mut f = Fixture::new();
    let effective = common::NOW + 100;
    let update = Instruction {
        program_id: address(blockrouter::id()),
        accounts: blockrouter::accounts::UpdateModelPrice {
            authority: f.env.key(Actor::Admin),
            config: common::config_pda(),
            model: common::model_pda(MODEL_ID),
        }
        .to_account_metas(None),
        data: blockrouter::instruction::UpdateModelPrice {
            prompt_rate: 150,
            completion_rate: 250,
        }
        .data(),
    };
    f.env.send(Actor::Admin, update).unwrap();
    assert_eq!(
        read::<Model>(&f.env.svm, common::model_pda(MODEL_ID)).effective_at,
        effective
    );
    f.time(effective + offset);
    f.success(1_000_000, 500_000, expected);
}
#[test]
fn pending_prices_before_timelock_use_current_rates() {
    timelock_case(-1, 200);
}
#[test]
fn pending_prices_at_timelock_use_new_rates() {
    timelock_case(0, 275);
}
#[test]
fn pending_prices_after_timelock_use_new_rates() {
    timelock_case(1, 275);
}

#[test]
fn relayer_signature_is_required() {
    let mut f = Fixture::new();
    let mut ix = f.ix(0, 0);
    ix.accounts[0].is_signer = false;
    f.failure(
        Actor::Alice,
        ix,
        InstructionError::Custom(u32::from(anchor_lang::error::ErrorCode::AccountNotSigner)),
    );
}

#[test]
fn invalid_vault_bump_is_rejected() {
    let mut f = Fixture::new();
    f.vault(|v| v.bump = v.bump.wrapping_sub(1));
    let ix = f.ix(0, 0);
    f.anchor_error(ix, anchor_lang::error::ErrorCode::ConstraintSeeds);
}

#[test]
fn wrong_config_pda_is_rejected() {
    let mut f = Fixture::new();
    let fake = Pubkey::new_unique();
    let config = read::<Config>(&f.env.svm, common::config_pda());
    seed_account(&mut f.env.svm, fake, &config);
    let mut ix = f.ix(0, 0);
    ix.accounts[5].pubkey = address(fake);
    f.anchor_error(ix, anchor_lang::error::ErrorCode::ConstraintSeeds);
}

#[test]
fn relayer_check_precedes_expiry_and_model_checks() {
    let mut f = Fixture::new();
    f.time(common::NOW + 3_601);
    f.model(|m| m.is_active = false);
    let mut ix = f.ix(0, 0);
    ix.accounts[0].pubkey = address(f.env.key(Actor::Attacker));
    f.failure(
        Actor::Attacker,
        ix,
        InstructionError::Custom(u32::from(BlockRouterError::UnauthorizedRelayer)),
    );
}

#[test]
fn expiry_check_precedes_model_binding_and_active_checks() {
    let mut f = Fixture::new();
    f.time(common::NOW + 3_601);
    let model = common::seed_model(&mut f.env.svm, 43);
    let mut m = read::<Model>(&f.env.svm, model);
    m.is_active = false;
    seed_account(&mut f.env.svm, model, &m);
    let mut ix = f.ix(0, 0);
    ix.accounts[4].pubkey = address(model);
    f.error(ix, BlockRouterError::SessionExpired);
}

#[test]
fn binding_check_precedes_active_check() {
    let mut f = Fixture::new();
    let model = common::seed_model(&mut f.env.svm, 43);
    let mut m = read::<Model>(&f.env.svm, model);
    m.is_active = false;
    seed_account(&mut f.env.svm, model, &m);
    let mut ix = f.ix(0, 0);
    ix.accounts[4].pubkey = address(model);
    f.error(ix, BlockRouterError::SessionModelMismatch);
}

#[test]
fn charge_limit_check_precedes_provider_check() {
    let mut f = Fixture::new();
    let mut ix = f.ix(4_000_000, 0);
    ix.accounts[6].pubkey = f.env.ata(Actor::Attacker);
    f.error(ix, BlockRouterError::ChargeExceedsReservation);
}

#[test]
fn different_sessions_authorized_relayer_cannot_settle_this_session() {
    let mut f = Fixture::new();
    let next_id = read::<Vault>(&f.env.svm, f.vault).session_counter;
    let other_session = common::session_pda(&f.vault, next_id);
    let other_relayer = f.env.key(Actor::Attacker);
    let open = Instruction {
        program_id: address(blockrouter::id()),
        accounts: blockrouter::accounts::OpenSession {
            user: f.env.key(Actor::Alice),
            vault: f.vault,
            session: other_session,
            config: common::config_pda(),
            system_program: anchor_lang::solana_program::system_program::ID,
            model: common::model_pda(MODEL_ID),
        }
        .to_account_metas(None),
        data: blockrouter::instruction::OpenSession {
            session_id: next_id,
            reserved_amount: 100,
            relayer: other_relayer,
            duration_secs: 3_600,
        }
        .data(),
    };
    f.env.send(Actor::Alice, open).unwrap();
    let first = read::<Session>(&f.env.svm, f.session);
    let second = read::<Session>(&f.env.svm, other_session);
    assert_eq!(first.relayer, f.env.key(Actor::Relayer));
    assert_eq!(second.relayer, other_relayer);
    assert_ne!(first.relayer, second.relayer);
    assert_eq!(second.payer_account, f.vault);
    assert_eq!(read::<Vault>(&f.env.svm, f.vault).total_reserved, 400);
    let other_before = f.env.svm.get_account(&address(other_session));
    let mut settle = f.ix(1_000_000, 0);
    settle.accounts[0].pubkey = address(other_relayer);
    f.failure(
        Actor::Attacker,
        settle,
        InstructionError::Custom(u32::from(BlockRouterError::UnauthorizedRelayer)),
    );
    assert_eq!(f.env.svm.get_account(&address(other_session)), other_before);
}
