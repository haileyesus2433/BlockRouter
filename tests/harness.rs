use anchor_lang::prelude::Pubkey;
use blockrouter::state::{Allowance, Config, Session, SponsorVault, Vault};

use crate::common::{
    address, assert_allowance_invariant, assert_sponsor_invariant, assert_vault_invariant,
    assert_vault_matches_ata, funded_vault, init_config, open_session, program_data_address, read,
    seed_account, setup, setup_with_token_program, token_balance, warp, Actor, NOW,
    PRICE_TIMELOCK_SECS, STARTING_BALANCE,
};

const ACTORS: [Actor; 7] = [
    Actor::Admin,
    Actor::Alice,
    Actor::Bob,
    Actor::Sponsor,
    Actor::Student,
    Actor::Relayer,
    Actor::Attacker,
];

#[test]
fn setup_funds_every_actor() {
    let env = setup();
    assert_eq!(env.now(), NOW);
    for who in ACTORS {
        let lamports = env.svm.get_balance(&address(env.key(who))).unwrap();
        assert!(lamports > 0, "{who:?} has no SOL");
        assert_eq!(token_balance(&env.svm, &env.ata(who)), STARTING_BALANCE);
    }
    let keys: std::collections::HashSet<Pubkey> = ACTORS.iter().map(|w| env.key(*w)).collect();
    assert_eq!(keys.len(), ACTORS.len());

    let program_data = env
        .svm
        .get_account(&address(program_data_address()))
        .unwrap();
    assert_eq!(&program_data.data[13..45], env.key(Actor::Admin).as_ref());
}

#[test]
fn warp_advances_the_clock() {
    let mut env = setup();
    warp(&mut env, 60);
    assert_eq!(env.now(), NOW + 60);
    warp(&mut env, PRICE_TIMELOCK_SECS);
    assert_eq!(env.now(), NOW + 60 + PRICE_TIMELOCK_SECS);
}

#[test]
fn warp_is_visible_to_the_program() {
    let mut env = setup();
    init_config(&mut env);
    crate::common::seed_model(&mut env.svm, 42);
    funded_vault(&mut env, Actor::Alice, 1_000);
    warp(&mut env, 500);

    let session = open_session(&mut env, Actor::Alice, 100, 120, 42);
    let session = read::<Session>(&env.svm, session);
    assert_eq!(session.expires_at, NOW + 500 + 120);
}

#[test]
fn init_config_makes_admin_the_authority() {
    let mut env = setup();
    let config = init_config(&mut env);
    let config = read::<Config>(&env.svm, config);
    assert_eq!(config.authority, env.key(Actor::Admin));
    assert!(!config.paused);
}

#[test]
fn funded_vault_deposits_and_holds_invariants() {
    let mut env = setup();
    let vault = funded_vault(&mut env, Actor::Alice, 400);

    let state = read::<Vault>(&env.svm, vault);
    assert_eq!(state.owner, env.key(Actor::Alice));
    assert_eq!(state.balance, 400);
    assert_eq!(
        token_balance(&env.svm, &env.ata(Actor::Alice)),
        STARTING_BALANCE - 400
    );
    assert_vault_invariant(&env, vault);
    assert_vault_matches_ata(&env, vault);
}

#[test]
fn funded_vault_works_with_token_2022() {
    let mut env = setup_with_token_program(address(anchor_spl::token_2022::ID));
    let vault = funded_vault(&mut env, Actor::Bob, 400);
    assert_vault_matches_ata(&env, vault);
}

#[test]
fn open_session_reserves_cap_for_relayer() {
    let mut env = setup();
    init_config(&mut env);
    crate::common::seed_model(&mut env.svm, 42);
    let vault = funded_vault(&mut env, Actor::Alice, 1_000);
    let first = open_session(&mut env, Actor::Alice, 300, 120, 42);
    let second = open_session(&mut env, Actor::Alice, 200, 120, 42);
    assert_ne!(first, second);

    let session = read::<Session>(&env.svm, first);
    assert_eq!(session.relayer, env.key(Actor::Relayer));
    assert_eq!(session.reserved_amount, 300);
    assert_eq!(session.model_id, 42);
    assert_eq!(read::<Vault>(&env.svm, vault).total_reserved, 500);
    assert_vault_invariant(&env, vault);
    assert_vault_matches_ata(&env, vault);
}

fn seed_allowance(env: &mut crate::common::TestEnv, cap: u64, spent: u64, reserved: u64) -> Pubkey {
    let key = Pubkey::new_unique();
    let allowance = Allowance {
        sponsor_vault: Pubkey::new_unique(),
        beneficiary: env.key(Actor::Student),
        cap,
        spent,
        reserved,
        allowed_models: vec![1],
        expires_at: NOW + 3_600,
        session_counter: 0,
        active_sessions: 0,
        is_active: true,
        bump: 255,
    };
    seed_account(&mut env.svm, key, &allowance);
    key
}

fn seed_sponsor_vault(env: &mut crate::common::TestEnv, balance: u64, committed: u64) -> Pubkey {
    let key = Pubkey::new_unique();
    let sponsor_vault = SponsorVault {
        sponsor: env.key(Actor::Sponsor),
        mint: crate::common::pubkey(env.mint),
        balance,
        total_committed: committed,
        bump: 255,
    };
    seed_account(&mut env.svm, key, &sponsor_vault);
    key
}

#[test]
fn allowance_invariant_accepts_valid_state() {
    let mut env = setup();
    let allowance = seed_allowance(&mut env, 100, 60, 40);
    assert_allowance_invariant(&env, allowance);
}

#[test]
#[should_panic(expected = "allowance cap")]
fn allowance_invariant_catches_violation() {
    let mut env = setup();
    let allowance = seed_allowance(&mut env, 100, 60, 41);
    assert_allowance_invariant(&env, allowance);
}

#[test]
fn sponsor_invariant_accepts_valid_state() {
    let mut env = setup();
    let sponsor_vault = seed_sponsor_vault(&mut env, 100, 100);
    assert_sponsor_invariant(&env, sponsor_vault);
}

#[test]
#[should_panic(expected = "sponsor balance")]
fn sponsor_invariant_catches_violation() {
    let mut env = setup();
    let sponsor_vault = seed_sponsor_vault(&mut env, 100, 101);
    assert_sponsor_invariant(&env, sponsor_vault);
}

#[test]
#[should_panic(expected = "vault balance")]
fn vault_invariant_catches_violation() {
    let mut env = setup();
    let vault = funded_vault(&mut env, Actor::Alice, 100);
    let mut state = read::<Vault>(&env.svm, vault);
    state.total_reserved = 101;
    seed_account(&mut env.svm, vault, &state);
    assert_vault_invariant(&env, vault);
}

#[test]
#[should_panic(expected = "diverged")]
fn vault_ata_check_catches_divergence() {
    let mut env = setup();
    let vault = funded_vault(&mut env, Actor::Alice, 100);
    let mut state = read::<Vault>(&env.svm, vault);
    state.balance = 101;
    seed_account(&mut env.svm, vault, &state);
    assert_vault_matches_ata(&env, vault);
}
