use anchor_lang::{
    prelude::{Clock, Pubkey},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use blockrouter::{
    constants::{CONFIG_SEED, MODEL_SEED},
    state::{Config, Model},
};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_keypair::{Address, Keypair, Signer};
use solana_transaction::{Instruction, InstructionError, TransactionError};

use crate::common::{address, pubkey, seed_account, PRICE_TIMELOCK_SECS};

pub use crate::common::NOW;
pub const TIMELOCK_SECS: i64 = PRICE_TIMELOCK_SECS;

pub struct ModelFixture {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub config_key: Pubkey,
    pub config: Config,
}

impl ModelFixture {
    pub fn new() -> Self {
        let mut svm = crate::common::new_svm();
        let mut clock = svm.get_sysvar::<Clock>();
        clock.unix_timestamp = NOW;
        svm.set_sysvar(&clock);

        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
        let (config_key, bump) = Pubkey::find_program_address(&[CONFIG_SEED], &blockrouter::id());
        let config = Config {
            authority: pubkey(admin.pubkey()),
            treasury: Pubkey::new_unique(),
            provider: Pubkey::new_unique(),
            fee_bps: 250,
            dispute_window_secs: 86_400,
            price_timelock_secs: TIMELOCK_SECS,
            paused: false,
            bump,
        };
        seed_account(&mut svm, config_key, &config);

        Self {
            svm,
            admin,
            config_key,
            config,
        }
    }

    pub fn new_actor(&mut self) -> Keypair {
        let actor = Keypair::new();
        self.svm.airdrop(&actor.pubkey(), 10_000_000_000).unwrap();
        actor
    }

    pub fn model_pda(model_id: u16) -> (Pubkey, u8) {
        let key = crate::common::model_pda(model_id);
        let (_, bump) = Pubkey::find_program_address(
            &[MODEL_SEED, &model_id.to_le_bytes()],
            &blockrouter::id(),
        );
        (key, bump)
    }

    pub fn register_ix(
        &self,
        signer: &Keypair,
        model_id: u16,
        prompt_rate: u64,
        completion_rate: u64,
    ) -> Instruction {
        Instruction {
            program_id: address(blockrouter::id()),
            accounts: blockrouter::accounts::RegisterModel {
                authority: pubkey(signer.pubkey()),
                config: self.config_key,
                model: Self::model_pda(model_id).0,
                system_program: anchor_lang::solana_program::system_program::ID,
            }
            .to_account_metas(None),
            data: blockrouter::instruction::RegisterModel {
                model_id,
                prompt_rate,
                completion_rate,
            }
            .data(),
        }
    }

    pub fn send(
        &mut self,
        signer: &Keypair,
        instruction: Instruction,
    ) -> Result<TransactionMetadata, Box<FailedTransactionMetadata>> {
        crate::common::send_tx(&mut self.svm, signer, instruction)
    }

    pub fn register(
        &mut self,
        model_id: u16,
        prompt_rate: u64,
        completion_rate: u64,
    ) -> TransactionMetadata {
        let admin = self.admin.insecure_clone();
        let instruction = self.register_ix(&admin, model_id, prompt_rate, completion_rate);
        self.send(&admin, instruction).unwrap()
    }

    pub fn update_ix(
        &self,
        signer: &Keypair,
        model_id: u16,
        prompt_rate: u64,
        completion_rate: u64,
    ) -> Instruction {
        Instruction {
            program_id: address(blockrouter::id()),
            accounts: blockrouter::accounts::UpdateModelPrice {
                authority: pubkey(signer.pubkey()),
                config: self.config_key,
                model: Self::model_pda(model_id).0,
            }
            .to_account_metas(None),
            data: blockrouter::instruction::UpdateModelPrice {
                prompt_rate,
                completion_rate,
            }
            .data(),
        }
    }

    pub fn update(
        &mut self,
        model_id: u16,
        prompt_rate: u64,
        completion_rate: u64,
    ) -> TransactionMetadata {
        let admin = self.admin.insecure_clone();
        let instruction = self.update_ix(&admin, model_id, prompt_rate, completion_rate);
        self.send(&admin, instruction).unwrap()
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn warp(&mut self, secs: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp += secs;
        self.svm.set_sysvar(&clock);
    }

    pub fn read_model(&self, model_id: u16) -> Model {
        let account = self
            .svm
            .get_account(&address(Self::model_pda(model_id).0))
            .unwrap();
        Model::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    pub fn assert_failure(
        &mut self,
        signer: &Keypair,
        instruction: Instruction,
        expected: InstructionError,
    ) {
        let watched: Vec<Address> = instruction
            .accounts
            .iter()
            .filter(|a| !a.is_signer)
            .map(|a| a.pubkey)
            .collect();
        let before: Vec<_> = watched.iter().map(|k| self.svm.get_account(k)).collect();
        let failure = self.send(signer, instruction).unwrap_err();
        assert_eq!(
            failure.err,
            TransactionError::InstructionError(0, expected),
            "{}",
            failure.meta.pretty_logs()
        );
        let after: Vec<_> = watched.iter().map(|k| self.svm.get_account(k)).collect();
        assert_eq!(before, after);
    }
}
