use anchor_lang::{
    prelude::{Clock, Pubkey},
    AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator, InstructionData,
    ToAccountMetas,
};
use blockrouter::{
    constants::{CONFIG_SEED, MAX_SESSION_SECS, MIN_SESSION_SECS, SESSION_SEED, VAULT_SEED},
    errors::BlockRouterError,
    instructions::SessionOpened,
    state::{Config, PayerKind, Session, Vault},
};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_account::Account;
use solana_keypair::{Address, Keypair, Signer};
use solana_transaction::{Instruction, InstructionError, Transaction, TransactionError};

const NOW: i64 = 1_800_000_000;

fn address(key: Pubkey) -> Address {
    Address::from(key.to_bytes())
}

fn pubkey(key: Address) -> Pubkey {
    Pubkey::new_from_array(key.to_bytes())
}

fn seed_account(svm: &mut LiteSVM, key: Pubkey, state: &impl AccountSerialize) {
    let mut data = Vec::new();
    state.try_serialize(&mut data).unwrap();
    svm.set_account(
        address(key),
        Account {
            lamports: svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: address(blockrouter::id()),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

struct Fixture {
    svm: LiteSVM,
    user: Keypair,
    vault_key: Pubkey,
    config_key: Pubkey,
    vault: Vault,
    config: Config,
    relayer: Pubkey,
}

impl Fixture {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(
            address(blockrouter::id()),
            include_bytes!(concat!(
                env!("CARGO_TARGET_TMPDIR"),
                "/../deploy/blockrouter.so"
            )),
        )
        .unwrap();
        let mut clock = svm.get_sysvar::<Clock>();
        clock.unix_timestamp = NOW;
        svm.set_sysvar(&clock);

        let user = Keypair::new();
        svm.airdrop(&user.pubkey(), 1_000_000_000).unwrap();
        let owner = pubkey(user.pubkey());
        let mint = Pubkey::new_unique();
        let (vault_key, vault_bump) = Pubkey::find_program_address(
            &[VAULT_SEED, owner.as_ref(), mint.as_ref()],
            &blockrouter::id(),
        );
        let (config_key, config_bump) =
            Pubkey::find_program_address(&[CONFIG_SEED], &blockrouter::id());
        let vault = Vault {
            owner,
            mint,
            balance: 20,
            total_reserved: 3,
            session_counter: 7,
            bump: vault_bump,
        };
        let config = Config {
            authority: owner,
            treasury: Pubkey::new_unique(),
            provider: Pubkey::new_unique(),
            fee_bps: 0,
            dispute_window_secs: 0,
            price_timelock_secs: 0,
            paused: false,
            bump: config_bump,
        };
        seed_account(&mut svm, vault_key, &vault);
        seed_account(&mut svm, config_key, &config);
        Self {
            svm,
            user,
            vault_key,
            config_key,
            vault,
            config,
            relayer: Pubkey::new_unique(),
        }
    }

    fn session_pda(&self, session_id: u64) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[
                SESSION_SEED,
                self.vault_key.as_ref(),
                &session_id.to_le_bytes(),
            ],
            &blockrouter::id(),
        )
    }

    fn instruction(
        &self,
        session_id: u64,
        reserved_amount: u64,
        duration_secs: i64,
    ) -> Instruction {
        Instruction {
            program_id: address(blockrouter::id()),
            accounts: blockrouter::accounts::OpenSession {
                user: pubkey(self.user.pubkey()),
                vault: self.vault_key,
                session: self.session_pda(session_id).0,
                config: self.config_key,
                system_program: anchor_lang::solana_program::system_program::ID,
            }
            .to_account_metas(None),
            data: blockrouter::instruction::OpenSession {
                session_id,
                reserved_amount,
                relayer: self.relayer,
                duration_secs,
            }
            .data(),
        }
    }

    fn send(
        &mut self,
        instruction: Instruction,
    ) -> Result<TransactionMetadata, Box<FailedTransactionMetadata>> {
        let tx = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&self.user.pubkey()),
            &[&self.user],
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).map_err(Box::new)
    }

    fn read_vault(&self) -> Vault {
        let account = self.svm.get_account(&address(self.vault_key)).unwrap();
        Vault::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn read_session(&self, session_id: u64) -> Session {
        let account = self
            .svm
            .get_account(&address(self.session_pda(session_id).0))
            .unwrap();
        assert_eq!(account.owner, address(blockrouter::id()));
        Session::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn assert_success(&mut self, amount: u64, duration: i64) {
        let before = self.read_vault();
        let id = before.session_counter;
        let instruction = self.instruction(id, amount, duration);
        self.send(instruction).unwrap();
        let session = self.read_session(id);
        assert_eq!(session.payer_account, self.vault_key);
        assert!(session.payer_kind == PayerKind::Vault);
        assert_eq!(session.beneficiary, before.owner);
        assert_eq!(session.relayer, self.relayer);
        assert_eq!(session.reserved_amount, amount);
        assert_eq!(session.session_id, id);
        assert_eq!(session.expires_at, NOW + duration);
        assert_eq!(session.bump, self.session_pda(id).1);
        let after = self.read_vault();
        assert_eq!(after.balance, before.balance);
        assert_eq!(after.total_reserved, before.total_reserved + amount);
        assert_eq!(after.session_counter, id + 1);
        assert_eq!(after.owner, before.owner);
        assert_eq!(after.mint, before.mint);
        assert_eq!(after.bump, before.bump);
        assert!(after.balance >= after.total_reserved);
    }

    fn assert_failure(&mut self, instruction: Instruction, expected_code: u32) {
        let before = self.svm.get_account(&address(self.vault_key)).unwrap();
        let session_key = instruction.accounts[2].pubkey;
        let session_before = self.svm.get_account(&session_key);
        let failure = self.send(instruction).unwrap_err();
        assert_eq!(
            failure.err,
            TransactionError::InstructionError(0, InstructionError::Custom(expected_code)),
            "{}",
            failure.meta.pretty_logs()
        );
        assert_eq!(self.svm.get_account(&address(self.vault_key)), Some(before));
        assert_eq!(self.svm.get_account(&session_key), session_before);
    }

    fn assert_error(&mut self, id: u64, amount: u64, duration: i64, error: BlockRouterError) {
        self.assert_failure(self.instruction(id, amount, duration), u32::from(error));
    }
}

#[test]
fn opens_session_and_preserves_vault_invariant() {
    Fixture::new().assert_success(5, 120);
}

#[test]
fn minimum_duration_succeeds() {
    Fixture::new().assert_success(5, MIN_SESSION_SECS);
}

#[test]
fn maximum_duration_succeeds() {
    Fixture::new().assert_success(5, MAX_SESSION_SECS);
}

#[test]
fn reserves_exactly_available_balance() {
    let mut fixture = Fixture::new();
    fixture.assert_success(17, 120);
    let vault = fixture.read_vault();
    assert_eq!(vault.balance, vault.total_reserved);
}

#[test]
fn paused_protocol_is_rejected() {
    let mut fixture = Fixture::new();
    fixture.config.paused = true;
    seed_account(&mut fixture.svm, fixture.config_key, &fixture.config);
    fixture.assert_error(7, 5, 120, BlockRouterError::ProtocolPaused);
}

#[test]
fn wrong_owner_is_rejected() {
    let mut fixture = Fixture::new();
    fixture.user = Keypair::new();
    fixture
        .svm
        .airdrop(&fixture.user.pubkey(), 1_000_000_000)
        .unwrap();
    fixture.assert_error(7, 5, 120, BlockRouterError::Unauthorized);
}

#[test]
fn zero_reservation_is_rejected() {
    Fixture::new().assert_error(7, 0, 120, BlockRouterError::ZeroAmount);
}

#[test]
fn insufficient_available_balance_is_rejected() {
    Fixture::new().assert_error(7, 18, 120, BlockRouterError::InsufficientUnreservedBalance);
}

#[test]
fn fresh_incorrect_session_id_is_rejected() {
    Fixture::new().assert_error(8, 5, 120, BlockRouterError::SessionIdMismatch);
}

#[test]
fn duration_below_minimum_is_rejected() {
    Fixture::new().assert_error(
        7,
        5,
        MIN_SESSION_SECS - 1,
        BlockRouterError::InvalidDuration,
    );
}

#[test]
fn duration_above_maximum_is_rejected() {
    Fixture::new().assert_error(
        7,
        5,
        MAX_SESSION_SECS + 1,
        BlockRouterError::InvalidDuration,
    );
}

#[test]
fn malformed_vault_accounting_is_rejected() {
    let mut fixture = Fixture::new();
    fixture.vault.total_reserved = 21;
    seed_account(&mut fixture.svm, fixture.vault_key, &fixture.vault);
    fixture.assert_error(7, 5, 120, BlockRouterError::MathOverflow);
}

#[test]
fn counter_overflow_is_rejected_without_wrapping() {
    let mut fixture = Fixture::new();
    fixture.vault.session_counter = u64::MAX;
    seed_account(&mut fixture.svm, fixture.vault_key, &fixture.vault);
    fixture.assert_error(u64::MAX, 5, 120, BlockRouterError::MathOverflow);
}

#[test]
fn expiry_overflow_is_rejected() {
    let mut fixture = Fixture::new();
    let mut clock = fixture.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::MAX;
    fixture.svm.set_sysvar(&clock);
    fixture.assert_error(7, 5, MIN_SESSION_SECS, BlockRouterError::MathOverflow);
}

#[test]
fn sequential_sessions_never_reuse_old_ids() {
    let mut fixture = Fixture::new();
    fixture.assert_success(5, 120);
    fixture.assert_success(5, 120);
    assert_ne!(fixture.session_pda(7).0, fixture.session_pda(8).0);
    assert_eq!(fixture.read_vault().session_counter, 9);
    assert_eq!(fixture.read_session(7).session_id, 7);
    assert_eq!(fixture.read_session(8).session_id, 8);

    // Simulate removal of the old account without implementing a closing instruction.
    fixture
        .svm
        .set_account(address(fixture.session_pda(7).0), Account::default())
        .unwrap();
    fixture.svm.expire_blockhash();
    fixture.assert_error(7, 5, 120, BlockRouterError::SessionIdMismatch);
}

#[test]
fn emits_session_opened() {
    use anchor_lang::__private::base64::{engine::general_purpose::STANDARD, Engine};

    let mut fixture = Fixture::new();
    let instruction = fixture.instruction(7, 5, 120);
    let metadata = fixture.send(instruction).unwrap();
    let events: Vec<_> = metadata
        .logs
        .iter()
        .filter_map(|log| {
            let encoded = log.strip_prefix("Program data: ")?;
            let bytes = STANDARD.decode(encoded).unwrap();
            bytes
                .strip_prefix(SessionOpened::DISCRIMINATOR)
                .map(|payload| SessionOpened::try_from_slice(payload).unwrap())
        })
        .collect();
    assert_eq!(events.len(), 1, "{}", metadata.pretty_logs());
    let event = &events[0];
    assert_eq!(event.session, fixture.session_pda(7).0);
    assert_eq!(event.payer_account, fixture.vault_key);
    assert_eq!(event.session_id, 7);
    assert_eq!(event.beneficiary, fixture.vault.owner);
    assert_eq!(event.relayer, fixture.relayer);
    assert_eq!(event.reserved_amount, 5);
    assert_eq!(event.expires_at, NOW + 120);
}

#[test]
fn wrong_session_pda_is_rejected() {
    let mut fixture = Fixture::new();
    let mut instruction = fixture.instruction(7, 5, 120);
    instruction.accounts[2].pubkey = address(fixture.session_pda(8).0);
    fixture.assert_failure(
        instruction,
        u32::from(anchor_lang::error::ErrorCode::ConstraintSeeds),
    );
}

#[test]
fn wrong_config_pda_is_rejected() {
    let mut fixture = Fixture::new();
    let wrong_key = Pubkey::new_unique();
    seed_account(&mut fixture.svm, wrong_key, &fixture.config);
    let mut instruction = fixture.instruction(7, 5, 120);
    instruction.accounts[3].pubkey = address(wrong_key);
    fixture.assert_failure(
        instruction,
        u32::from(anchor_lang::error::ErrorCode::ConstraintSeeds),
    );
}

#[test]
fn wrong_vault_pda_is_rejected() {
    let mut fixture = Fixture::new();
    let wrong_key = Pubkey::new_unique();
    seed_account(&mut fixture.svm, wrong_key, &fixture.vault);
    let mut instruction = fixture.instruction(7, 5, 120);
    instruction.accounts[1].pubkey = address(wrong_key);
    let (session, _) = Pubkey::find_program_address(
        &[SESSION_SEED, wrong_key.as_ref(), &7_u64.to_le_bytes()],
        &blockrouter::id(),
    );
    instruction.accounts[2].pubkey = address(session);
    fixture.assert_failure(
        instruction,
        u32::from(anchor_lang::error::ErrorCode::ConstraintSeeds),
    );
    let account = fixture.svm.get_account(&address(wrong_key)).unwrap();
    let vault = Vault::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(vault.total_reserved, 3);
    assert_eq!(vault.session_counter, 7);
}

#[test]
fn missing_user_signer_is_rejected() {
    let mut fixture = Fixture::new();
    let fee_payer = Keypair::new();
    fixture
        .svm
        .airdrop(&fee_payer.pubkey(), 1_000_000_000)
        .unwrap();
    let mut instruction = fixture.instruction(7, 5, 120);
    instruction.accounts[0].is_signer = false;
    let vault_before = fixture.svm.get_account(&address(fixture.vault_key));
    let tx = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&fee_payer.pubkey()),
        &[&fee_payer],
        fixture.svm.latest_blockhash(),
    );
    let failure = fixture.svm.send_transaction(tx).unwrap_err();
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(u32::from(anchor_lang::error::ErrorCode::AccountNotSigner))
        )
    );
    assert_eq!(
        fixture.svm.get_account(&address(fixture.vault_key)),
        vault_before
    );
    assert!(fixture
        .svm
        .get_account(&address(fixture.session_pda(7).0))
        .is_none());
}

#[test]
fn paused_check_precedes_other_handler_checks() {
    let mut fixture = Fixture::new();
    fixture.config.paused = true;
    seed_account(&mut fixture.svm, fixture.config_key, &fixture.config);
    fixture.user = Keypair::new();
    fixture
        .svm
        .airdrop(&fixture.user.pubkey(), 1_000_000_000)
        .unwrap();
    fixture.assert_error(8, 0, 0, BlockRouterError::ProtocolPaused);
}
