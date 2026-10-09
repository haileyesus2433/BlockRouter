use anchor_lang::{
    prelude::{Clock, Pubkey},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use blockrouter::{
    constants::{CONFIG_SEED, MIN_SESSION_SECS, SESSION_SEED},
    errors::BlockRouterError,
    instructions::SessionReclaimed,
    state::{Config, PayerKind, Session},
};
use litesvm::types::TransactionMetadata;
use solana_keypair::{Keypair, Signer};
use solana_transaction::{Instruction, Transaction};

use crate::vault_fixture::{
    address, events, initialize_vault_ix, pubkey, seed_account, vault_pda, VaultFixture,
};

const NOW: i64 = 1_800_000_000;
const RESERVATION: u64 = 300;

struct Fixture {
    vault: VaultFixture,
    config_key: Pubkey,
    session_key: Pubkey,
}

impl Fixture {
    fn new() -> Self {
        let mut vault = VaultFixture::new();
        vault.deposit(1_000);
        let mut clock = vault.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = NOW;
        vault.svm.set_sysvar(&clock);
        let config_key = Pubkey::find_program_address(&[CONFIG_SEED], &blockrouter::id()).0;
        let mut fixture = Self {
            vault,
            config_key,
            session_key: Pubkey::default(),
        };
        fixture.set_paused(false);
        fixture.session_key = fixture.open(RESERVATION);
        fixture
    }

    fn set_paused(&mut self, paused: bool) {
        let (_, bump) = Pubkey::find_program_address(&[CONFIG_SEED], &blockrouter::id());
        seed_account(
            &mut self.vault.svm,
            self.config_key,
            &Config {
                authority: pubkey(self.vault.alice.pubkey()),
                treasury: Pubkey::new_unique(),
                provider: Pubkey::new_unique(),
                fee_bps: 0,
                dispute_window_secs: 0,
                price_timelock_secs: 0,
                paused,
                bump,
            },
        );
    }

    fn open(&mut self, amount: u64) -> Pubkey {
        let session_id = self.vault.read_vault().session_counter;
        let session = Pubkey::find_program_address(
            &[
                SESSION_SEED,
                self.vault.vault_key.as_ref(),
                &session_id.to_le_bytes(),
            ],
            &blockrouter::id(),
        )
        .0;
        let alice = self.vault.alice.insecure_clone();
        let instruction = Instruction {
            program_id: address(blockrouter::id()),
            accounts: blockrouter::accounts::OpenSession {
                user: pubkey(alice.pubkey()),
                vault: self.vault.vault_key,
                session,
                config: self.config_key,
                system_program: anchor_lang::solana_program::system_program::ID,
            }
            .to_account_metas(None),
            data: blockrouter::instruction::OpenSession {
                session_id,
                reserved_amount: amount,
                relayer: Pubkey::new_unique(),
                duration_secs: MIN_SESSION_SECS,
            }
            .data(),
        };
        self.vault.send(&alice, instruction).unwrap();
        session
    }

    fn session(&self) -> Session {
        let account = self
            .vault
            .svm
            .get_account(&address(self.session_key))
            .unwrap();
        Session::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn set_time(&mut self, timestamp: i64) {
        let mut clock = self.vault.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = timestamp;
        self.vault.svm.set_sysvar(&clock);
    }

    fn expire(&mut self) {
        self.set_time(self.session().expires_at + 1);
    }

    fn instruction(&self, signer: &Keypair) -> Instruction {
        Instruction {
            program_id: address(blockrouter::id()),
            accounts: blockrouter::accounts::ReclaimExpiredSession {
                user: pubkey(signer.pubkey()),
                vault: self.vault.vault_key,
                session: self.session_key,
            }
            .to_account_metas(None),
            data: blockrouter::instruction::ReclaimExpiredSession {}.data(),
        }
    }

    fn reclaim(&mut self) -> TransactionMetadata {
        let alice = self.vault.alice.insecure_clone();
        self.vault.send(&alice, self.instruction(&alice)).unwrap()
    }

    fn assert_error(&mut self, error: BlockRouterError) {
        let alice = self.vault.alice.insecure_clone();
        let instruction = self.instruction(&alice);
        self.vault
            .assert_failure(&alice, instruction, u32::from(error));
    }

    fn assert_success(&mut self) -> TransactionMetadata {
        self.vault.assert_vault_invariants();
        let before = self.vault.read_vault();
        let session = self.session();
        let vault_tokens = self.vault.token_balance(&self.vault.vault_ata);
        let user_tokens = self.vault.token_balance(&self.vault.alice_ata);
        let user_lamports = self
            .vault
            .svm
            .get_account(&self.vault.alice.pubkey())
            .unwrap()
            .lamports;
        let rent = self
            .vault
            .svm
            .get_account(&address(self.session_key))
            .unwrap()
            .lamports;
        let metadata = self.reclaim();
        let after = self.vault.read_vault();
        assert_eq!(
            after.total_reserved,
            before.total_reserved - session.reserved_amount
        );
        assert_eq!(after.balance, before.balance);
        assert_eq!(after.session_counter, before.session_counter);
        assert_eq!(after.owner, before.owner);
        assert_eq!(after.mint, before.mint);
        assert_eq!(after.bump, before.bump);
        assert_eq!(
            self.vault.token_balance(&self.vault.vault_ata),
            vault_tokens
        );
        assert_eq!(self.vault.token_balance(&self.vault.alice_ata), user_tokens);
        self.vault.assert_vault_invariants();
        assert!(self
            .vault
            .svm
            .get_account(&address(self.session_key))
            .is_none());
        assert_eq!(
            self.vault
                .svm
                .get_account(&self.vault.alice.pubkey())
                .unwrap()
                .lamports,
            user_lamports + rent - metadata.fee
        );
        // Reclaim needs no CPI, including to either token program.
        assert!(metadata.inner_instructions.iter().all(Vec::is_empty));
        metadata
    }
}

#[test]
fn authorized_reclaim_after_expiry_releases_and_closes_session() {
    let mut fixture = Fixture::new();
    fixture.expire();
    fixture.assert_success();
    assert_eq!(fixture.vault.read_vault().total_reserved, 0);
}

#[test]
fn unauthorized_signer_is_rejected() {
    let mut fixture = Fixture::new();
    fixture.expire();
    let attacker = fixture.vault.new_actor();
    let instruction = fixture.instruction(&attacker);
    fixture.vault.assert_failure(
        &attacker,
        instruction,
        u32::from(BlockRouterError::Unauthorized),
    );
}

#[test]
fn unauthorized_beneficiary_is_rejected() {
    let mut fixture = Fixture::new();
    fixture.expire();
    let mut session = fixture.session();
    session.beneficiary = Pubkey::new_unique();
    seed_account(&mut fixture.vault.svm, fixture.session_key, &session);
    fixture.assert_error(BlockRouterError::Unauthorized);
}

#[test]
fn wrong_vault_owned_by_same_signer_is_rejected() {
    let mut fixture = Fixture::new();
    fixture.expire();
    let alice = fixture.vault.alice.insecure_clone();
    let (mint, _) = fixture.vault.second_mint();
    let other_vault = vault_pda(&alice.pubkey(), &mint);
    let init = initialize_vault_ix(&alice, &mint, &fixture.vault.token_program);
    fixture.vault.send(&alice, init).unwrap();
    let original_before = fixture
        .vault
        .svm
        .get_account(&address(fixture.vault.vault_key));
    let mut instruction = fixture.instruction(&alice);
    instruction.accounts[1].pubkey = address(other_vault);
    fixture.vault.assert_failure(
        &alice,
        instruction,
        u32::from(BlockRouterError::SessionVaultMismatch),
    );
    assert_eq!(
        fixture
            .vault
            .svm
            .get_account(&address(fixture.vault.vault_key)),
        original_before
    );
}

#[test]
fn before_expiry_is_rejected() {
    let mut fixture = Fixture::new();
    fixture.set_time(fixture.session().expires_at - 1);
    fixture.assert_error(BlockRouterError::SessionNotExpired);
}

#[test]
fn exactly_at_expiry_is_rejected() {
    let mut fixture = Fixture::new();
    fixture.set_time(fixture.session().expires_at);
    fixture.assert_error(BlockRouterError::SessionNotExpired);
}

#[test]
fn reclaim_works_while_protocol_is_paused() {
    let mut fixture = Fixture::new();
    fixture.set_paused(true);
    fixture.expire();
    fixture.assert_success();
}

#[test]
fn releases_only_selected_session_reservation() {
    let mut fixture = Fixture::new();
    let other_session = fixture.open(400);
    let other_before = fixture.vault.svm.get_account(&address(other_session));
    assert_eq!(fixture.vault.read_vault().total_reserved, 700);
    fixture.expire();
    fixture.assert_success();
    assert_eq!(fixture.vault.read_vault().total_reserved, 400);
    assert_eq!(fixture.vault.read_vault().session_counter, 2);
    assert_eq!(
        fixture.vault.svm.get_account(&address(other_session)),
        other_before
    );
}

#[test]
fn rent_is_returned_to_owner_not_separate_fee_payer() {
    let mut fixture = Fixture::new();
    fixture.expire();
    let fee_payer = fixture.vault.new_actor();
    let alice = fixture.vault.alice.insecure_clone();
    let user_before = fixture
        .vault
        .svm
        .get_account(&alice.pubkey())
        .unwrap()
        .lamports;
    let payer_before = fixture
        .vault
        .svm
        .get_account(&fee_payer.pubkey())
        .unwrap()
        .lamports;
    let rent = fixture
        .vault
        .svm
        .get_account(&address(fixture.session_key))
        .unwrap()
        .lamports;
    let instruction = fixture.instruction(&alice);
    fixture.vault.svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&fee_payer.pubkey()),
        &[&fee_payer, &alice],
        fixture.vault.svm.latest_blockhash(),
    );
    let metadata = fixture.vault.svm.send_transaction(tx).unwrap();
    assert_eq!(
        fixture
            .vault
            .svm
            .get_account(&alice.pubkey())
            .unwrap()
            .lamports,
        user_before + rent
    );
    assert_eq!(
        fixture
            .vault
            .svm
            .get_account(&fee_payer.pubkey())
            .unwrap()
            .lamports,
        payer_before - metadata.fee
    );
    assert!(fixture
        .vault
        .svm
        .get_account(&address(fixture.session_key))
        .is_none());
}

#[test]
fn double_reclaim_fails_without_releasing_again() {
    let mut fixture = Fixture::new();
    fixture.expire();
    fixture.assert_success();
    let alice = fixture.vault.alice.insecure_clone();
    let instruction = fixture.instruction(&alice);
    // VaultFixture::send expires the blockhash, avoiding AlreadyProcessed.
    fixture.vault.assert_failure(
        &alice,
        instruction,
        u32::from(anchor_lang::error::ErrorCode::AccountNotInitialized),
    );
    assert_eq!(fixture.vault.read_vault().total_reserved, 0);
}

#[test]
fn reservation_underflow_rolls_back_and_keeps_session() {
    let mut fixture = Fixture::new();
    fixture.vault.reserve(RESERVATION - 1);
    fixture.expire();
    fixture.assert_error(BlockRouterError::MathOverflow);
}

#[test]
fn wrong_session_pda_is_rejected() {
    let mut fixture = Fixture::new();
    fixture.expire();
    let fake_session = Pubkey::new_unique();
    let session = fixture.session();
    seed_account(&mut fixture.vault.svm, fake_session, &session);
    let alice = fixture.vault.alice.insecure_clone();
    let mut instruction = fixture.instruction(&alice);
    instruction.accounts[2].pubkey = address(fake_session);
    fixture.vault.assert_failure(
        &alice,
        instruction,
        u32::from(anchor_lang::error::ErrorCode::ConstraintSeeds),
    );
}

#[test]
fn allowance_payer_kind_cannot_release_vault_reservation() {
    let mut fixture = Fixture::new();
    fixture.expire();
    let mut session = fixture.session();
    session.payer_kind = PayerKind::Allowance;
    seed_account(&mut fixture.vault.svm, fixture.session_key, &session);
    fixture.assert_error(BlockRouterError::SessionVaultMismatch);
}

#[test]
fn emits_session_reclaimed_with_expected_fields() {
    let mut fixture = Fixture::new();
    fixture.expire();
    let session = fixture.session();
    let metadata = fixture.assert_success();
    let events = events::<SessionReclaimed>(&metadata);
    assert_eq!(events.len(), 1, "{}", metadata.pretty_logs());
    let event = &events[0];
    assert_eq!(event.session, fixture.session_key);
    assert_eq!(event.vault, fixture.vault.vault_key);
    assert_eq!(event.session_id, session.session_id);
    assert_eq!(event.owner, pubkey(fixture.vault.alice.pubkey()));
    assert_eq!(event.reserved_amount, session.reserved_amount);
}
