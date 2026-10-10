use anchor_lang::{InstructionData, ToAccountMetas};
use blockrouter::{
    instructions::UsageSettled,
    state::{Model, PayerKind, Session, Vault},
};
use litesvm_token::{get_spl_account, spl_token::state::Mint, Burn, MintTo};
use solana_transaction::Instruction;

use crate::common::{self, address, pubkey, read, Actor, TestEnv};

#[test]
fn full_vault_lifecycle_from_deposit_to_withdraw() {
    let mut env = common::setup();
    let mint = get_spl_account::<Mint>(&env.svm, &env.mint).unwrap();
    let unit = 10_u64.checked_pow(u32::from(mint.decimals)).unwrap();
    assert_eq!(unit % 100, 0, "mint must represent whole cents exactly");
    let deposit = unit.checked_mul(10).unwrap();
    let cap = unit.checked_mul(5).unwrap();
    let charge = unit.checked_mul(120).unwrap().checked_div(100).unwrap();
    let remaining = unit.checked_mul(880).unwrap().checked_div(100).unwrap();
    let unused = unit.checked_mul(380).unwrap().checked_div(100).unwrap();
    assert_eq!(deposit.checked_sub(charge).unwrap(), remaining);
    assert_eq!(cap.checked_sub(charge).unwrap(), unused);
    let (mint_key, token_program) = (env.mint, env.token_program);
    let alice_ata = env.ata(Actor::Alice);
    let provider_ata = env.ata(Actor::Bob);
    let admin = env.keypair(Actor::Admin);
    let provider = env.keypair(Actor::Bob);

    // Fixture preparation uses real token instructions: fund Alice sufficiently
    // and start the provider at zero so its balance is the exact payment.
    MintTo::new(&mut env.svm, &admin, &mint_key, &alice_ata, deposit)
        .token_program_id(&token_program)
        .send()
        .unwrap();
    let provider_initial = common::token_balance(&env.svm, &provider_ata);
    Burn::new(
        &mut env.svm,
        &provider,
        &mint_key,
        &provider_ata,
        provider_initial,
    )
    .token_program_id(&token_program)
    .send()
    .unwrap();
    let alice_start = common::token_balance(&env.svm, &alice_ata);
    assert!(alice_start >= deposit);
    assert_eq!(common::token_balance(&env.svm, &provider_ata), 0);

    // Configure the provider and register the active pricing Model on-chain.
    let config = common::config_pda();
    let initialize_config = Instruction {
        program_id: address(blockrouter::id()),
        accounts: blockrouter::accounts::InitializeConfig {
            authority: env.key(Actor::Admin),
            config,
            program: blockrouter::id(),
            program_data: common::program_data_address(),
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None),
        data: blockrouter::instruction::InitializeConfig {
            treasury: env.key(Actor::Admin),
            provider: env.key(Actor::Bob),
            fee_bps: common::FEE_BPS,
            dispute_window_secs: common::DISPUTE_WINDOW_SECS,
            price_timelock_secs: common::PRICE_TIMELOCK_SECS,
        }
        .data(),
    };
    env.send(Actor::Admin, initialize_config).unwrap();
    let model_id = 18;
    let model_key = common::model_pda(model_id);
    let register = Instruction {
        program_id: address(blockrouter::id()),
        accounts: blockrouter::accounts::RegisterModel {
            authority: env.key(Actor::Admin),
            config,
            model: model_key,
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None),
        data: blockrouter::instruction::RegisterModel {
            model_id,
            prompt_rate: unit,
            completion_rate: unit.checked_mul(2).unwrap(),
        }
        .data(),
    };
    env.send(Actor::Admin, register).unwrap();
    let model = read::<Model>(&env.svm, model_key);
    assert!(model.is_active);
    assert_eq!(model.model_id, model_id);
    assert_eq!(model.effective_rates(env.now()), (unit, 2 * unit));

    // 1. Initialize Alice's Vault and deposit exactly 10.00.
    let vault_key = common::funded_vault(&mut env, Actor::Alice, deposit);
    let vault_ata = env.vault_ata(vault_key);
    let assert_balances = |env: &TestEnv, expected: (u64, u64, u64, u64, u64)| {
        let (balance, reserved, available, alice, provider) = expected;
        let vault = read::<Vault>(&env.svm, vault_key);
        assert_eq!(vault.balance, balance);
        assert_eq!(vault.total_reserved, reserved);
        assert_eq!(
            vault.balance.checked_sub(vault.total_reserved).unwrap(),
            available
        );
        assert_eq!(common::token_balance(&env.svm, &vault_ata), balance);
        assert_eq!(common::token_balance(&env.svm, &alice_ata), alice);
        assert_eq!(common::token_balance(&env.svm, &provider_ata), provider);
        common::assert_vault_invariant(env, vault_key);
        common::assert_vault_matches_ata(env, vault_key);
    };
    assert_balances(&env, (deposit, 0, deposit, alice_start - deposit, 0));
    let vault = read::<Vault>(&env.svm, vault_key);
    assert_eq!(vault.owner, env.key(Actor::Alice));
    assert_eq!(vault.mint, pubkey(mint_key));
    assert_eq!(vault.session_counter, 0);

    // 2. Reserve 5.00; neither token account moves funds during opening.
    let session_key = common::open_session(&mut env, Actor::Alice, cap, 120, model_id);
    assert_balances(&env, (deposit, cap, cap, alice_start - deposit, 0));
    let session = read::<Session>(&env.svm, session_key);
    assert_eq!(session.payer_account, vault_key);
    assert!(session.payer_kind == PayerKind::Vault);
    assert_eq!(session.beneficiary, env.key(Actor::Alice));
    assert_eq!(session.relayer, env.key(Actor::Relayer));
    assert_eq!(session.model_id, model_id);
    assert_eq!(session.reserved_amount, cap);
    assert_eq!(session.session_id, 0);
    assert_eq!(
        session_key,
        common::session_pda(&vault_key, session.session_id)
    );
    assert_eq!(session.expires_at, env.now() + 120);
    let available_before = deposit - cap;

    // 3. On-chain prices: 1M prompt tokens at 1.00 plus 100k completion
    // tokens at 2.00 per million produce exactly 1.20.
    let settle = Instruction {
        program_id: address(blockrouter::id()),
        accounts: blockrouter::accounts::SettleSessionUsage {
            relayer: env.key(Actor::Relayer),
            vault: vault_key,
            vault_ata: pubkey(vault_ata),
            session: session_key,
            model: model_key,
            config,
            provider_ata: pubkey(provider_ata),
            token_program: pubkey(token_program),
            mint: pubkey(mint_key),
            beneficiary: env.key(Actor::Alice),
        }
        .to_account_metas(None),
        data: blockrouter::instruction::SettleSessionUsage {
            prompt_tokens: 1_000_000,
            completion_tokens: 100_000,
        }
        .data(),
    };
    let metadata = env.send(Actor::Relayer, settle).unwrap();
    assert_balances(
        &env,
        (remaining, 0, remaining, alice_start - deposit, charge),
    );
    let settled = read::<Vault>(&env.svm, vault_key);
    let available_after = settled.balance.checked_sub(settled.total_reserved).unwrap();
    assert_eq!(
        available_after.checked_sub(available_before).unwrap(),
        unused
    );
    assert_eq!(settled.session_counter, 1);
    assert!(env.svm.get_account(&address(session_key)).is_none());
    let events = common::events::<UsageSettled>(&metadata);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].charge, charge);
    assert_eq!(events[0].unused_released, unused);
    assert_eq!(events[0].model_id, model_id);

    // 4. Withdraw all 8.80. Only the settled 1.20 leaves Alice's total funds.
    let withdraw = Instruction {
        program_id: address(blockrouter::id()),
        accounts: blockrouter::accounts::Withdraw {
            user: env.key(Actor::Alice),
            user_ata: pubkey(alice_ata),
            vault: vault_key,
            vault_ata: pubkey(vault_ata),
            mint: pubkey(mint_key),
            token_program: pubkey(token_program),
        }
        .to_account_metas(None),
        data: blockrouter::instruction::Withdraw { amount: remaining }.data(),
    };
    env.send(Actor::Alice, withdraw).unwrap();
    assert_balances(&env, (0, 0, 0, alice_start - charge, charge));
    assert_eq!(read::<Vault>(&env.svm, vault_key).session_counter, 1);
}
