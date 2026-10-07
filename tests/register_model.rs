use anchor_lang::prelude::Pubkey;
use blockrouter::{errors::BlockRouterError, instructions::ModelRegistered};
use solana_keypair::Signer;
use solana_transaction::InstructionError;

use crate::{
    model_fixture::ModelFixture as Fixture,
    vault_fixture::{address, events, pubkey, seed_account},
};

#[test]
fn registers_model_with_rates() {
    let mut fixture = Fixture::new();
    fixture.register(1, 270, 1_100);

    let model = fixture.read_model(1);
    assert_eq!(model.model_id, 1);
    assert_eq!(model.prompt_rate, 270);
    assert_eq!(model.completion_rate, 1_100);
    assert_eq!(model.pending_prompt_rate, 0);
    assert_eq!(model.pending_completion_rate, 0);
    assert_eq!(model.effective_at, 0);
    assert!(model.is_active);
    assert_eq!(model.bump, Fixture::model_pda(1).1);
}

#[test]
fn registers_models_independently() {
    let mut fixture = Fixture::new();
    fixture.register(1, 270, 1_100);
    fixture.register(2, 50, 75);

    assert_eq!(fixture.read_model(1).prompt_rate, 270);
    assert_eq!(fixture.read_model(2).prompt_rate, 50);
    assert_ne!(Fixture::model_pda(1).0, Fixture::model_pda(2).0);
}

#[test]
fn attacker_cannot_register_model() {
    let mut fixture = Fixture::new();
    let attacker = fixture.new_actor();
    let instruction = fixture.register_ix(&attacker, 1, 270, 1_100);
    fixture.assert_failure(
        &attacker,
        instruction,
        InstructionError::Custom(u32::from(BlockRouterError::Unauthorized)),
    );
    assert!(fixture
        .svm
        .get_account(&address(Fixture::model_pda(1).0))
        .is_none());
}

#[test]
fn fake_config_is_rejected() {
    let mut fixture = Fixture::new();
    let attacker = fixture.new_actor();
    let fake_config = Pubkey::new_unique();
    let mut config = fixture.config.clone();
    config.authority = pubkey(attacker.pubkey());
    seed_account(&mut fixture.svm, fake_config, &config);

    let mut instruction = fixture.register_ix(&attacker, 1, 270, 1_100);
    instruction.accounts[1].pubkey = address(fake_config);
    fixture.assert_failure(
        &attacker,
        instruction,
        InstructionError::Custom(u32::from(anchor_lang::error::ErrorCode::ConstraintSeeds)),
    );
}

#[test]
fn duplicate_model_id_is_rejected() {
    let mut fixture = Fixture::new();
    fixture.register(1, 270, 1_100);

    let admin = fixture.admin.insecure_clone();
    let instruction = fixture.register_ix(&admin, 1, 1, 1);
    // System program AccountAlreadyInUse.
    fixture.assert_failure(&admin, instruction, InstructionError::Custom(0));
    assert_eq!(fixture.read_model(1).prompt_rate, 270);
}

#[test]
fn emits_model_registered() {
    let mut fixture = Fixture::new();
    let metadata = fixture.register(7, 270, 1_100);
    let events = events::<ModelRegistered>(&metadata);
    assert_eq!(events.len(), 1, "{}", metadata.pretty_logs());
    let event = &events[0];
    assert_eq!(event.model, Fixture::model_pda(7).0);
    assert_eq!(event.model_id, 7);
    assert_eq!(event.prompt_rate, 270);
    assert_eq!(event.completion_rate, 1_100);
}
