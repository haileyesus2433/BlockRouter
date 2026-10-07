use anchor_lang::prelude::Pubkey;
use blockrouter::{errors::BlockRouterError, instructions::Deposited};
use solana_keypair::Signer;

use crate::vault_fixture::{
    address, events, pubkey, seed_account, VaultFixture as Fixture, STARTING_BALANCE,
};

#[test]
fn deposit_credits_vault_and_moves_tokens() {
    let mut fixture = Fixture::new();
    fixture.deposit(400);

    let vault = fixture.read_vault();
    assert_eq!(vault.balance, 400);
    assert_eq!(vault.total_reserved, 0);
    assert_eq!(vault.session_counter, 0);
    assert_eq!(fixture.token_balance(&fixture.vault_ata), 400);
    assert_eq!(
        fixture.token_balance(&fixture.alice_ata),
        STARTING_BALANCE - 400
    );
    fixture.assert_vault_invariants();
}

#[test]
fn deposits_accumulate() {
    let mut fixture = Fixture::new();
    fixture.deposit(400);
    fixture.deposit(250);

    assert_eq!(fixture.read_vault().balance, 650);
    fixture.assert_vault_invariants();
}

#[test]
fn deposit_preserves_existing_reservation() {
    let mut fixture = Fixture::new();
    fixture.deposit(400);
    fixture.vault = fixture.read_vault();
    fixture.vault.total_reserved = 300;
    seed_account(&mut fixture.svm, fixture.vault_key, &fixture.vault);

    fixture.deposit(100);

    let vault = fixture.read_vault();
    assert_eq!(vault.balance, 500);
    assert_eq!(vault.total_reserved, 300);
    fixture.assert_vault_invariants();
}

#[test]
fn deposit_works_with_token_2022() {
    let mut fixture = Fixture::with_token_program(address(anchor_spl::token_2022::ID));
    fixture.deposit(400);

    assert_eq!(fixture.read_vault().balance, 400);
    fixture.assert_vault_invariants();
}

#[test]
fn zero_amount_is_rejected() {
    let mut fixture = Fixture::new();
    let alice = fixture.alice.insecure_clone();
    let instruction = fixture.deposit_ix(&alice, fixture.alice_ata, 0);
    fixture.assert_failure(&alice, instruction, u32::from(BlockRouterError::ZeroAmount));
}

#[test]
fn user_token_account_with_wrong_mint_is_rejected() {
    let mut fixture = Fixture::new();
    let alice = fixture.alice.insecure_clone();
    let (_, other_ata) = fixture.second_mint();

    let instruction = fixture.deposit_ix(&alice, other_ata, 100);
    fixture.assert_failure(
        &alice,
        instruction,
        u32::from(BlockRouterError::MintMismatch),
    );
}

#[test]
fn mint_account_not_matching_vault_is_rejected() {
    let mut fixture = Fixture::new();
    let alice = fixture.alice.insecure_clone();
    let (other_mint, _) = fixture.second_mint();

    let mut instruction = fixture.deposit_ix(&alice, fixture.alice_ata, 100);
    instruction.accounts[4].pubkey = other_mint;
    fixture.assert_failure(
        &alice,
        instruction,
        u32::from(BlockRouterError::MintMismatch),
    );
}

#[test]
fn attacker_cannot_deposit_into_alices_vault() {
    let mut fixture = Fixture::new();
    let attacker = fixture.new_actor();
    let attacker_ata = fixture.funded_ata_for(&attacker);

    let instruction = fixture.deposit_ix(&attacker, attacker_ata, 100);
    fixture.assert_failure(
        &attacker,
        instruction,
        u32::from(BlockRouterError::Unauthorized),
    );
}

#[test]
fn vault_token_account_not_owned_by_vault_is_rejected() {
    let mut fixture = Fixture::new();
    let alice = fixture.alice.insecure_clone();
    let attacker = fixture.new_actor();
    let attacker_ata = fixture.unfunded_ata_for(&attacker.pubkey());

    let mut instruction = fixture.deposit_ix(&alice, fixture.alice_ata, 100);
    instruction.accounts[3].pubkey = attacker_ata;
    fixture.assert_failure(
        &alice,
        instruction,
        u32::from(anchor_lang::error::ErrorCode::ConstraintTokenOwner),
    );
}

#[test]
fn wrong_vault_pda_is_rejected() {
    let mut fixture = Fixture::new();
    let alice = fixture.alice.insecure_clone();
    let fake_vault = Pubkey::new_unique();
    seed_account(&mut fixture.svm, fake_vault, &fixture.vault);

    let mut instruction = fixture.deposit_ix(&alice, fixture.alice_ata, 100);
    instruction.accounts[2].pubkey = address(fake_vault);
    fixture.assert_failure(
        &alice,
        instruction,
        u32::from(anchor_lang::error::ErrorCode::ConstraintSeeds),
    );
}

#[test]
fn balance_overflow_is_rejected() {
    let mut fixture = Fixture::new();
    fixture.vault.balance = u64::MAX;
    seed_account(&mut fixture.svm, fixture.vault_key, &fixture.vault);

    let alice = fixture.alice.insecure_clone();
    let instruction = fixture.deposit_ix(&alice, fixture.alice_ata, 1);
    fixture.assert_failure(
        &alice,
        instruction,
        u32::from(BlockRouterError::MathOverflow),
    );
}

#[test]
fn emits_deposited() {
    let mut fixture = Fixture::new();
    fixture.deposit(400);
    let metadata = fixture.deposit(100);
    let events = events::<Deposited>(&metadata);
    assert_eq!(events.len(), 1, "{}", metadata.pretty_logs());
    let event = &events[0];
    assert_eq!(event.vault, fixture.vault_key);
    assert_eq!(event.owner, pubkey(fixture.alice.pubkey()));
    assert_eq!(event.mint, pubkey(fixture.mint));
    assert_eq!(event.amount, 100);
    assert_eq!(event.balance, 500);
}
