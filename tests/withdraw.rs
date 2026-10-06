use anchor_lang::prelude::Pubkey;
use blockrouter::{
    constants::CONFIG_SEED, errors::BlockRouterError, instructions::Withdrawn, state::Config,
};
use solana_keypair::Signer;

use crate::vault_fixture::{
    address, events, pubkey, seed_account, VaultFixture as Fixture, STARTING_BALANCE,
};

fn funded(amount: u64) -> Fixture {
    let mut fixture = Fixture::new();
    fixture.deposit(amount);
    fixture
}

#[test]
fn withdraw_returns_tokens_to_owner() {
    let mut fixture = funded(1_000);
    fixture.withdraw(400);

    let vault = fixture.read_vault();
    assert_eq!(vault.balance, 600);
    assert_eq!(fixture.token_balance(&fixture.vault_ata), 600);
    assert_eq!(
        fixture.token_balance(&fixture.alice_ata),
        STARTING_BALANCE - 600
    );
    fixture.assert_vault_invariants();
}

#[test]
fn full_withdraw_leaves_vault_and_ata_at_zero() {
    let mut fixture = funded(1_000);
    fixture.withdraw(1_000);

    assert_eq!(fixture.read_vault().balance, 0);
    assert_eq!(fixture.token_balance(&fixture.vault_ata), 0);
    assert_eq!(fixture.token_balance(&fixture.alice_ata), STARTING_BALANCE);
    fixture.assert_vault_invariants();
}

#[test]
fn withdraw_exactly_unreserved_balance_succeeds() {
    let mut fixture = funded(1_000);
    fixture.reserve(300);
    fixture.withdraw(700);

    let vault = fixture.read_vault();
    assert_eq!(vault.balance, 300);
    assert_eq!(vault.total_reserved, 300);
    fixture.assert_vault_invariants();
}

#[test]
fn withdraw_works_with_token_2022() {
    let mut fixture = Fixture::with_token_program(address(anchor_spl::token_2022::ID));
    fixture.deposit(1_000);
    fixture.withdraw(1_000);

    assert_eq!(fixture.read_vault().balance, 0);
    fixture.assert_vault_invariants();
}

#[test]
fn withdraw_works_while_paused() {
    let mut fixture = funded(1_000);
    let (config_key, bump) = Pubkey::find_program_address(&[CONFIG_SEED], &blockrouter::id());
    let config = Config {
        authority: pubkey(fixture.alice.pubkey()),
        treasury: Pubkey::new_unique(),
        provider: Pubkey::new_unique(),
        fee_bps: 0,
        dispute_window_secs: 0,
        price_timelock_secs: 0,
        paused: true,
        bump,
    };
    seed_account(&mut fixture.svm, config_key, &config);

    fixture.withdraw(1_000);
    assert_eq!(fixture.read_vault().balance, 0);
    fixture.assert_vault_invariants();
}

#[test]
fn withdraw_more_than_balance_is_rejected() {
    let mut fixture = funded(1_000);
    let alice = fixture.alice.insecure_clone();
    let instruction = fixture.withdraw_ix(&alice, fixture.alice_ata, 1_001);
    fixture.assert_failure(
        &alice,
        instruction,
        u32::from(BlockRouterError::ExceedsUnreservedBalance),
    );
}

#[test]
fn withdraw_more_than_unreserved_is_rejected() {
    let mut fixture = funded(1_000);
    fixture.reserve(300);
    let alice = fixture.alice.insecure_clone();
    let instruction = fixture.withdraw_ix(&alice, fixture.alice_ata, 701);
    fixture.assert_failure(
        &alice,
        instruction,
        u32::from(BlockRouterError::ExceedsUnreservedBalance),
    );
}

#[test]
fn zero_amount_is_rejected() {
    let mut fixture = funded(1_000);
    let alice = fixture.alice.insecure_clone();
    let instruction = fixture.withdraw_ix(&alice, fixture.alice_ata, 0);
    fixture.assert_failure(&alice, instruction, u32::from(BlockRouterError::ZeroAmount));
}

#[test]
fn attacker_cannot_withdraw_from_alices_vault() {
    let mut fixture = funded(1_000);
    let attacker = fixture.new_actor();
    let attacker_ata = fixture.unfunded_ata_for(&attacker.pubkey());

    let instruction = fixture.withdraw_ix(&attacker, attacker_ata, 1_000);
    fixture.assert_failure(
        &attacker,
        instruction,
        u32::from(BlockRouterError::Unauthorized),
    );
}

#[test]
fn destination_with_wrong_mint_is_rejected() {
    let mut fixture = funded(1_000);
    let alice = fixture.alice.insecure_clone();
    let (_, other_ata) = fixture.second_mint();

    let instruction = fixture.withdraw_ix(&alice, other_ata, 100);
    fixture.assert_failure(
        &alice,
        instruction,
        u32::from(BlockRouterError::MintMismatch),
    );
}

#[test]
fn mint_account_not_matching_vault_is_rejected() {
    let mut fixture = funded(1_000);
    let alice = fixture.alice.insecure_clone();
    let (other_mint, _) = fixture.second_mint();

    let mut instruction = fixture.withdraw_ix(&alice, fixture.alice_ata, 100);
    instruction.accounts[4].pubkey = other_mint;
    fixture.assert_failure(
        &alice,
        instruction,
        u32::from(BlockRouterError::MintMismatch),
    );
}

#[test]
fn vault_token_account_not_owned_by_vault_is_rejected() {
    let mut fixture = funded(1_000);
    let alice = fixture.alice.insecure_clone();
    let attacker = fixture.new_actor();
    let attacker_ata = fixture.funded_ata_for(&attacker);

    let mut instruction = fixture.withdraw_ix(&alice, fixture.alice_ata, 100);
    instruction.accounts[3].pubkey = attacker_ata;
    fixture.assert_failure(
        &alice,
        instruction,
        u32::from(anchor_lang::error::ErrorCode::ConstraintTokenOwner),
    );
}

#[test]
fn wrong_vault_pda_is_rejected() {
    let mut fixture = funded(1_000);
    let alice = fixture.alice.insecure_clone();
    let fake_vault = Pubkey::new_unique();
    let vault = fixture.read_vault();
    seed_account(&mut fixture.svm, fake_vault, &vault);

    let mut instruction = fixture.withdraw_ix(&alice, fixture.alice_ata, 100);
    instruction.accounts[2].pubkey = address(fake_vault);
    fixture.assert_failure(
        &alice,
        instruction,
        u32::from(anchor_lang::error::ErrorCode::ConstraintSeeds),
    );
}

#[test]
fn corrupted_reservation_is_rejected() {
    let mut fixture = funded(1_000);
    fixture.reserve(1_001);
    let alice = fixture.alice.insecure_clone();
    let instruction = fixture.withdraw_ix(&alice, fixture.alice_ata, 1);
    fixture.assert_failure(
        &alice,
        instruction,
        u32::from(BlockRouterError::MathOverflow),
    );
}

#[test]
fn emits_withdrawn() {
    let mut fixture = funded(1_000);
    let metadata = fixture.withdraw(250);
    let events = events::<Withdrawn>(&metadata);
    assert_eq!(events.len(), 1, "{}", metadata.pretty_logs());
    let event = &events[0];
    assert_eq!(event.vault, fixture.vault_key);
    assert_eq!(event.owner, pubkey(fixture.alice.pubkey()));
    assert_eq!(event.mint, pubkey(fixture.mint));
    assert_eq!(event.amount, 250);
    assert_eq!(event.balance, 750);
}
