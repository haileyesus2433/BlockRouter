use anchor_lang::{prelude::Pubkey, InstructionData, ToAccountMetas};
use blockrouter::{
    constants::{CONFIG_SEED, SESSION_SEED},
    errors::BlockRouterError,
    state::Config,
};
use solana_keypair::Signer;
use solana_transaction::Instruction;

use crate::vault_fixture::{address, pubkey, seed_account, VaultFixture as Fixture};

const SESSION_SECS: i64 = 3_600;

fn seed_config(fixture: &mut Fixture, paused: bool) -> Pubkey {
    let (config_key, bump) = Pubkey::find_program_address(&[CONFIG_SEED], &blockrouter::id());
    let config = Config {
        authority: pubkey(fixture.alice.pubkey()),
        treasury: Pubkey::new_unique(),
        provider: Pubkey::new_unique(),
        fee_bps: 0,
        dispute_window_secs: 0,
        price_timelock_secs: 0,
        paused,
        bump,
    };
    seed_account(&mut fixture.svm, config_key, &config);
    crate::common::seed_model(&mut fixture.svm, 42);
    config_key
}

fn open_session(fixture: &mut Fixture, config_key: Pubkey, reserved_amount: u64) {
    let session_id = fixture.read_vault().session_counter;
    let (session, _) = Pubkey::find_program_address(
        &[
            SESSION_SEED,
            fixture.vault_key.as_ref(),
            &session_id.to_le_bytes(),
        ],
        &blockrouter::id(),
    );
    let alice = fixture.alice.insecure_clone();
    let instruction = Instruction {
        program_id: address(blockrouter::id()),
        accounts: blockrouter::accounts::OpenSession {
            user: pubkey(alice.pubkey()),
            vault: fixture.vault_key,
            session,
            config: config_key,
            system_program: anchor_lang::solana_program::system_program::ID,
            model: crate::common::model_pda(42),
        }
        .to_account_metas(None),
        data: blockrouter::instruction::OpenSession {
            session_id,
            reserved_amount,
            relayer: Pubkey::new_unique(),
            duration_secs: SESSION_SECS,
        }
        .data(),
    };
    fixture.send(&alice, instruction).unwrap();
}

fn assert_withdraw_rejected(fixture: &mut Fixture, amount: u64) {
    let alice = fixture.alice.insecure_clone();
    let instruction = fixture.withdraw_ix(&alice, fixture.alice_ata, amount);
    fixture.assert_failure(
        &alice,
        instruction,
        u32::from(BlockRouterError::ExceedsUnreservedBalance),
    );
}

#[test]
fn invariants_hold_across_deposit_and_withdraw_sequence() {
    let mut fixture = Fixture::new();
    let steps: [(bool, u64); 6] = [
        (true, 500),
        (false, 200),
        (true, 1_000),
        (false, 1_300),
        (true, 50),
        (false, 50),
    ];
    for (is_deposit, amount) in steps {
        if is_deposit {
            fixture.deposit(amount);
        } else {
            fixture.withdraw(amount);
        }
        fixture.assert_vault_invariants();
    }
    assert_eq!(fixture.read_vault().balance, 0);
    assert_eq!(fixture.token_balance(&fixture.vault_ata), 0);
}

#[test]
fn open_session_reservation_limits_withdraw() {
    let mut fixture = Fixture::new();
    let config = seed_config(&mut fixture, false);
    fixture.deposit(1_000);
    open_session(&mut fixture, config, 300);
    fixture.assert_vault_invariants();

    assert_withdraw_rejected(&mut fixture, 701);
    fixture.withdraw(700);
    fixture.assert_vault_invariants();
    assert_withdraw_rejected(&mut fixture, 1);

    fixture.deposit(200);
    fixture.withdraw(200);
    fixture.assert_vault_invariants();

    let vault = fixture.read_vault();
    assert_eq!(vault.balance, 300);
    assert_eq!(vault.total_reserved, 300);
}

#[test]
fn multiple_sessions_reserve_cumulatively() {
    let mut fixture = Fixture::new();
    let config = seed_config(&mut fixture, false);
    fixture.deposit(1_000);
    open_session(&mut fixture, config, 300);
    open_session(&mut fixture, config, 400);
    fixture.assert_vault_invariants();

    assert_withdraw_rejected(&mut fixture, 301);
    fixture.withdraw(300);
    fixture.assert_vault_invariants();
    assert_eq!(fixture.read_vault().total_reserved, 700);
}

#[test]
fn paused_protocol_still_allows_withdrawing_unreserved_funds() {
    let mut fixture = Fixture::new();
    let config = seed_config(&mut fixture, false);
    fixture.deposit(1_000);
    open_session(&mut fixture, config, 300);
    seed_config(&mut fixture, true);

    assert_withdraw_rejected(&mut fixture, 701);
    fixture.withdraw(700);
    fixture.assert_vault_invariants();
    assert_eq!(fixture.read_vault().balance, 300);
}
