use blockrouter::{errors::BlockRouterError, instructions::ModelPriceUpdated};
use solana_transaction::InstructionError;

use crate::{
    model_fixture::{ModelFixture as Fixture, NOW, TIMELOCK_SECS},
    vault_fixture::{events, seed_account},
};

fn registered() -> Fixture {
    let mut fixture = Fixture::new();
    fixture.register(1, 270, 1_100);
    fixture
}

#[test]
fn decrease_applies_immediately() {
    let mut fixture = registered();
    fixture.update(1, 200, 900);

    let model = fixture.read_model(1);
    assert_eq!((model.prompt_rate, model.completion_rate), (200, 900));
    assert_eq!(model.effective_at, 0);
    assert_eq!(model.effective_rates(fixture.now()), (200, 900));
}

#[test]
fn unchanged_rates_apply_immediately() {
    let mut fixture = registered();
    fixture.update(1, 270, 1_100);

    let model = fixture.read_model(1);
    assert_eq!(model.effective_at, 0);
    assert_eq!(model.effective_rates(fixture.now()), (270, 1_100));
}

#[test]
fn increase_waits_for_timelock() {
    let mut fixture = registered();
    fixture.update(1, 300, 1_200);

    let model = fixture.read_model(1);
    assert_eq!((model.prompt_rate, model.completion_rate), (270, 1_100));
    assert_eq!(
        (model.pending_prompt_rate, model.pending_completion_rate),
        (300, 1_200)
    );
    assert_eq!(model.effective_at, NOW + TIMELOCK_SECS);

    // Anything priced mid-timelock, such as a settlement, uses the old rate.
    fixture.warp(TIMELOCK_SECS - 1);
    assert_eq!(model.effective_rates(fixture.now()), (270, 1_100));

    fixture.warp(1);
    assert_eq!(model.effective_rates(fixture.now()), (300, 1_200));
}

#[test]
fn mixed_change_is_timelocked() {
    let mut fixture = registered();
    fixture.update(1, 100, 2_000);

    let model = fixture.read_model(1);
    assert_eq!(model.effective_at, NOW + TIMELOCK_SECS);
    assert_eq!(model.effective_rates(fixture.now()), (270, 1_100));
}

#[test]
fn decrease_cancels_pending_increase() {
    let mut fixture = registered();
    fixture.update(1, 300, 1_200);
    fixture.update(1, 250, 1_000);

    let model = fixture.read_model(1);
    assert_eq!(model.effective_at, 0);
    assert_eq!(
        (model.pending_prompt_rate, model.pending_completion_rate),
        (0, 0)
    );
    fixture.warp(TIMELOCK_SECS);
    assert_eq!(model.effective_rates(fixture.now()), (250, 1_000));
}

#[test]
fn new_increase_restarts_timelock() {
    let mut fixture = registered();
    fixture.update(1, 300, 1_200);
    fixture.warp(TIMELOCK_SECS / 2);
    fixture.update(1, 400, 1_300);

    let model = fixture.read_model(1);
    assert_eq!(model.effective_at, fixture.now() + TIMELOCK_SECS);
    assert_eq!(model.effective_rates(fixture.now()), (270, 1_100));
}

#[test]
fn matured_change_is_promoted_on_next_write() {
    let mut fixture = registered();
    fixture.update(1, 300, 1_200);
    fixture.warp(TIMELOCK_SECS);

    // Relative to the promoted 300/1_200 this is a decrease, so it applies now.
    fixture.update(1, 290, 1_150);

    let model = fixture.read_model(1);
    assert_eq!((model.prompt_rate, model.completion_rate), (290, 1_150));
    assert_eq!(model.effective_at, 0);
}

#[test]
fn attacker_cannot_update_price() {
    let mut fixture = registered();
    let attacker = fixture.new_actor();
    let instruction = fixture.update_ix(&attacker, 1, 1, 1);
    fixture.assert_failure(
        &attacker,
        instruction,
        InstructionError::Custom(u32::from(BlockRouterError::Unauthorized)),
    );
}

#[test]
fn unregistered_model_is_rejected() {
    let mut fixture = Fixture::new();
    let admin = fixture.admin.insecure_clone();
    let instruction = fixture.update_ix(&admin, 9, 1, 1);
    fixture.assert_failure(
        &admin,
        instruction,
        InstructionError::Custom(u32::from(
            anchor_lang::error::ErrorCode::AccountNotInitialized,
        )),
    );
}

#[test]
fn timelock_overflow_is_rejected() {
    let mut fixture = registered();
    fixture.config.price_timelock_secs = i64::MAX;
    let (config_key, config) = (fixture.config_key, fixture.config.clone());
    seed_account(&mut fixture.svm, config_key, &config);

    let admin = fixture.admin.insecure_clone();
    let instruction = fixture.update_ix(&admin, 1, 300, 1_200);
    fixture.assert_failure(
        &admin,
        instruction,
        InstructionError::Custom(u32::from(BlockRouterError::MathOverflow)),
    );
}

#[test]
fn emits_model_price_updated() {
    let mut fixture = registered();

    let metadata = fixture.update(1, 200, 900);
    let events_now = events::<ModelPriceUpdated>(&metadata);
    assert_eq!(events_now.len(), 1, "{}", metadata.pretty_logs());
    assert!(events_now[0].immediate);
    assert_eq!(events_now[0].effective_at, 0);
    assert_eq!(events_now[0].model_id, 1);

    let metadata = fixture.update(1, 300, 1_200);
    let events_later = events::<ModelPriceUpdated>(&metadata);
    assert_eq!(events_later.len(), 1, "{}", metadata.pretty_logs());
    let event = &events_later[0];
    assert_eq!(event.model, Fixture::model_pda(1).0);
    assert!(!event.immediate);
    assert_eq!(event.prompt_rate, 300);
    assert_eq!(event.completion_rate, 1_200);
    assert_eq!(event.effective_at, NOW + TIMELOCK_SECS);
}
