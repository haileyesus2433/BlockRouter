use anchor_lang::{prelude::Pubkey, AccountDeserialize, InstructionData, ToAccountMetas};
use blockrouter::{
    constants::{CONFIG_SEED, MAX_FEE_BPS, MODEL_SEED},
    errors::BlockRouterError,
    instructions::ConfigInitialized,
    state::Config,
};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_keypair::{Address, Keypair, Signer};
use solana_transaction::{Instruction, InstructionError, Transaction, TransactionError};

use crate::common::{
    address, events, new_svm, program_data_address, pubkey, set_upgrade_authority,
};

struct Args {
    treasury: Pubkey,
    provider: Pubkey,
    fee_bps: u16,
    dispute_window_secs: i64,
    price_timelock_secs: i64,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            treasury: Pubkey::new_unique(),
            provider: Pubkey::new_unique(),
            fee_bps: 250,
            dispute_window_secs: 86_400,
            price_timelock_secs: 3_600,
        }
    }
}

struct Fixture {
    svm: LiteSVM,
    admin: Keypair,
    program_data: Pubkey,
}

impl Fixture {
    fn new() -> Self {
        let mut svm = new_svm();
        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
        let program_data = program_data_address();
        let mut fixture = Self {
            svm,
            admin,
            program_data,
        };
        let admin_key = pubkey(fixture.admin.pubkey());
        fixture.set_upgrade_authority(Some(admin_key));
        fixture
    }

    fn set_upgrade_authority(&mut self, authority: Option<Pubkey>) {
        set_upgrade_authority(&mut self.svm, authority);
    }

    fn config_key() -> Pubkey {
        Pubkey::find_program_address(&[CONFIG_SEED], &blockrouter::id()).0
    }

    fn instruction(&self, signer: &Keypair, args: &Args) -> Instruction {
        Instruction {
            program_id: address(blockrouter::id()),
            accounts: blockrouter::accounts::InitializeConfig {
                authority: pubkey(signer.pubkey()),
                config: Self::config_key(),
                program: blockrouter::id(),
                program_data: self.program_data,
                system_program: anchor_lang::solana_program::system_program::ID,
            }
            .to_account_metas(None),
            data: blockrouter::instruction::InitializeConfig {
                treasury: args.treasury,
                provider: args.provider,
                fee_bps: args.fee_bps,
                dispute_window_secs: args.dispute_window_secs,
                price_timelock_secs: args.price_timelock_secs,
            }
            .data(),
        }
    }

    fn send(
        &mut self,
        signer: &Keypair,
        instruction: Instruction,
    ) -> Result<TransactionMetadata, Box<FailedTransactionMetadata>> {
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&signer.pubkey()),
            &[signer],
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).map_err(Box::new)
    }

    fn initialize(&mut self, args: &Args) -> TransactionMetadata {
        let admin = self.admin.insecure_clone();
        let instruction = self.instruction(&admin, args);
        self.send(&admin, instruction).unwrap()
    }

    fn read_config(&self) -> Config {
        let account = self.svm.get_account(&address(Self::config_key())).unwrap();
        Config::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn new_actor(&mut self) -> Keypair {
        let actor = Keypair::new();
        self.svm.airdrop(&actor.pubkey(), 10_000_000_000).unwrap();
        actor
    }

    fn assert_failure(&mut self, signer: &Keypair, instruction: Instruction, code: u32) {
        let failure = self.send(signer, instruction).unwrap_err();
        assert_eq!(
            failure.err,
            TransactionError::InstructionError(0, InstructionError::Custom(code)),
            "{}",
            failure.meta.pretty_logs()
        );
    }

    fn assert_rejected(&mut self, signer: &Keypair, args: &Args, code: u32) {
        let instruction = self.instruction(signer, args);
        self.assert_failure(signer, instruction, code);
        assert!(self.svm.get_account(&address(Self::config_key())).is_none());
    }
}

#[test]
fn initializes_config() {
    let mut fixture = Fixture::new();
    let args = Args::default();
    fixture.initialize(&args);

    let config = fixture.read_config();
    assert_eq!(config.authority, pubkey(fixture.admin.pubkey()));
    assert_eq!(config.treasury, args.treasury);
    assert_eq!(config.provider, args.provider);
    assert_eq!(config.fee_bps, 250);
    assert_eq!(config.dispute_window_secs, 86_400);
    assert_eq!(config.price_timelock_secs, 3_600);
    assert!(!config.paused);
    assert_eq!(
        config.bump,
        Pubkey::find_program_address(&[CONFIG_SEED], &blockrouter::id()).1
    );
}

#[test]
fn maximum_fee_is_accepted() {
    let mut fixture = Fixture::new();
    fixture.initialize(&Args {
        fee_bps: MAX_FEE_BPS,
        ..Args::default()
    });
    assert_eq!(fixture.read_config().fee_bps, MAX_FEE_BPS);
}

#[test]
fn fee_above_maximum_is_rejected() {
    let mut fixture = Fixture::new();
    let admin = fixture.admin.insecure_clone();
    let args = Args {
        fee_bps: MAX_FEE_BPS + 1,
        ..Args::default()
    };
    fixture.assert_rejected(&admin, &args, u32::from(BlockRouterError::FeeTooHigh));
}

#[test]
fn attacker_cannot_initialize_config() {
    let mut fixture = Fixture::new();
    let attacker = fixture.new_actor();
    fixture.assert_rejected(
        &attacker,
        &Args::default(),
        u32::from(BlockRouterError::Unauthorized),
    );
}

#[test]
fn immutable_program_cannot_initialize_config() {
    let mut fixture = Fixture::new();
    fixture.set_upgrade_authority(None);
    let admin = fixture.admin.insecure_clone();
    fixture.assert_rejected(
        &admin,
        &Args::default(),
        u32::from(BlockRouterError::Unauthorized),
    );
}

#[test]
fn foreign_program_data_is_rejected() {
    let mut fixture = Fixture::new();
    let attacker = fixture.new_actor();
    let fake_program_data = Pubkey::new_unique();
    let mut account = fixture
        .svm
        .get_account(&address(fixture.program_data))
        .unwrap();
    account.data[13..45].copy_from_slice(pubkey(attacker.pubkey()).as_ref());
    fixture
        .svm
        .set_account(address(fake_program_data), account)
        .unwrap();

    let mut instruction = fixture.instruction(&attacker, &Args::default());
    instruction.accounts[3].pubkey = address(fake_program_data);
    fixture.assert_failure(
        &attacker,
        instruction,
        u32::from(anchor_lang::error::ErrorCode::ConstraintRaw),
    );
    assert!(fixture
        .svm
        .get_account(&address(Fixture::config_key()))
        .is_none());
}

#[test]
fn config_cannot_be_initialized_twice() {
    let mut fixture = Fixture::new();
    fixture.initialize(&Args::default());
    let before = fixture.read_config();

    let admin = fixture.admin.insecure_clone();
    let instruction = fixture.instruction(
        &admin,
        &Args {
            fee_bps: 0,
            ..Args::default()
        },
    );
    // System program AccountAlreadyInUse.
    fixture.assert_failure(&admin, instruction, 0);
    assert_eq!(fixture.read_config().fee_bps, before.fee_bps);
}

#[test]
fn initialized_authority_passes_admin_guard() {
    let mut fixture = Fixture::new();
    fixture.initialize(&Args::default());

    let admin = fixture.admin.insecure_clone();
    let model =
        Pubkey::find_program_address(&[MODEL_SEED, &1u16.to_le_bytes()], &blockrouter::id()).0;
    let instruction = Instruction {
        program_id: address(blockrouter::id()),
        accounts: blockrouter::accounts::RegisterModel {
            authority: pubkey(admin.pubkey()),
            config: Fixture::config_key(),
            model,
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None),
        data: blockrouter::instruction::RegisterModel {
            model_id: 1,
            prompt_rate: 270,
            completion_rate: 1_100,
        }
        .data(),
    };
    fixture.send(&admin, instruction).unwrap();
    assert!(fixture
        .svm
        .get_account(&Address::from(model.to_bytes()))
        .is_some());
}

#[test]
fn emits_config_initialized() {
    let mut fixture = Fixture::new();
    let args = Args::default();
    let metadata = fixture.initialize(&args);
    let events = events::<ConfigInitialized>(&metadata);
    assert_eq!(events.len(), 1, "{}", metadata.pretty_logs());
    let event = &events[0];
    assert_eq!(event.config, Fixture::config_key());
    assert_eq!(event.authority, pubkey(fixture.admin.pubkey()));
    assert_eq!(event.treasury, args.treasury);
    assert_eq!(event.provider, args.provider);
    assert_eq!(event.fee_bps, 250);
    assert_eq!(event.dispute_window_secs, 86_400);
    assert_eq!(event.price_timelock_secs, 3_600);
}
