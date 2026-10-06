use anchor_lang::{
    prelude::Pubkey, AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator,
    InstructionData, ToAccountMetas,
};
use blockrouter::{
    constants::VAULT_SEED, errors::BlockRouterError, instructions::Deposited, state::Vault,
};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use litesvm_token::{
    get_spl_account, spl_token::state::Account as TokenAccount, CreateAssociatedTokenAccount,
    CreateMint, MintTo,
};
use solana_account::Account;
use solana_keypair::{Address, Keypair, Signer};
use solana_transaction::{Instruction, InstructionError, Transaction, TransactionError};

const STARTING_BALANCE: u64 = 1_000_000;

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
    alice: Keypair,
    token_program: Address,
    mint: Address,
    alice_ata: Address,
    vault_key: Pubkey,
    vault_ata: Address,
    vault: Vault,
}

impl Fixture {
    fn new() -> Self {
        Self::with_token_program(address(anchor_spl::token::ID))
    }

    fn with_token_program(token_program: Address) -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(
            address(blockrouter::id()),
            include_bytes!(concat!(
                env!("CARGO_TARGET_TMPDIR"),
                "/../deploy/blockrouter.so"
            )),
        )
        .unwrap();

        let alice = Keypair::new();
        svm.airdrop(&alice.pubkey(), 10_000_000_000).unwrap();
        let mint = CreateMint::new(&mut svm, &alice)
            .decimals(6)
            .token_program_id(&token_program)
            .send()
            .unwrap();
        let alice_ata = create_funded_ata(&mut svm, &alice, &mint, &token_program);

        let (vault_key, bump) = Pubkey::find_program_address(
            &[
                VAULT_SEED,
                pubkey(alice.pubkey()).as_ref(),
                pubkey(mint).as_ref(),
            ],
            &blockrouter::id(),
        );
        let vault = Vault {
            owner: pubkey(alice.pubkey()),
            mint: pubkey(mint),
            balance: 0,
            total_reserved: 0,
            session_counter: 0,
            bump,
        };
        seed_account(&mut svm, vault_key, &vault);
        let vault_ata = CreateAssociatedTokenAccount::new(&mut svm, &alice, &mint)
            .owner(&address(vault_key))
            .token_program_id(&token_program)
            .send()
            .unwrap();

        Self {
            svm,
            alice,
            token_program,
            mint,
            alice_ata,
            vault_key,
            vault_ata,
            vault,
        }
    }

    fn instruction(&self, signer: &Keypair, user_ata: Address, amount: u64) -> Instruction {
        Instruction {
            program_id: address(blockrouter::id()),
            accounts: blockrouter::accounts::Deposit {
                user: pubkey(signer.pubkey()),
                user_ata: pubkey(user_ata),
                vault: self.vault_key,
                vault_ata: pubkey(self.vault_ata),
                mint: pubkey(self.mint),
                token_program: pubkey(self.token_program),
            }
            .to_account_metas(None),
            data: blockrouter::instruction::Deposit { amount }.data(),
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

    fn deposit(&mut self, amount: u64) -> TransactionMetadata {
        let alice = self.alice.insecure_clone();
        let instruction = self.instruction(&alice, self.alice_ata, amount);
        self.send(&alice, instruction).unwrap()
    }

    fn read_vault(&self) -> Vault {
        let account = self.svm.get_account(&address(self.vault_key)).unwrap();
        Vault::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn token_balance(&self, ata: &Address) -> u64 {
        get_spl_account::<TokenAccount>(&self.svm, ata)
            .unwrap()
            .amount
    }

    fn assert_vault_invariants(&self) {
        let vault = self.read_vault();
        assert!(vault.balance >= vault.total_reserved);
        assert_eq!(vault.balance, self.token_balance(&self.vault_ata));
    }

    fn assert_failure(&mut self, signer: &Keypair, instruction: Instruction, expected_code: u32) {
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
            TransactionError::InstructionError(0, InstructionError::Custom(expected_code)),
            "{}",
            failure.meta.pretty_logs()
        );
        let after: Vec<_> = watched.iter().map(|k| self.svm.get_account(k)).collect();
        assert_eq!(before, after);
    }
}

fn create_funded_ata(
    svm: &mut LiteSVM,
    owner: &Keypair,
    mint: &Address,
    token_program: &Address,
) -> Address {
    let ata = CreateAssociatedTokenAccount::new(svm, owner, mint)
        .token_program_id(token_program)
        .send()
        .unwrap();
    MintTo::new(svm, owner, mint, &ata, STARTING_BALANCE)
        .token_program_id(token_program)
        .send()
        .unwrap();
    ata
}

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
    let instruction = fixture.instruction(&alice, fixture.alice_ata, 0);
    fixture.assert_failure(&alice, instruction, u32::from(BlockRouterError::ZeroAmount));
}

#[test]
fn user_token_account_with_wrong_mint_is_rejected() {
    let mut fixture = Fixture::new();
    let alice = fixture.alice.insecure_clone();
    let token_program = fixture.token_program;
    let other_mint = CreateMint::new(&mut fixture.svm, &alice)
        .decimals(6)
        .token_program_id(&token_program)
        .send()
        .unwrap();
    let other_ata = create_funded_ata(&mut fixture.svm, &alice, &other_mint, &token_program);

    let instruction = fixture.instruction(&alice, other_ata, 100);
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
    let token_program = fixture.token_program;
    let other_mint = CreateMint::new(&mut fixture.svm, &alice)
        .decimals(6)
        .token_program_id(&token_program)
        .send()
        .unwrap();

    let mut instruction = fixture.instruction(&alice, fixture.alice_ata, 100);
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
    let attacker = Keypair::new();
    fixture
        .svm
        .airdrop(&attacker.pubkey(), 10_000_000_000)
        .unwrap();
    let (mint, token_program) = (fixture.mint, fixture.token_program);
    let alice = fixture.alice.insecure_clone();
    let attacker_ata = CreateAssociatedTokenAccount::new(&mut fixture.svm, &attacker, &mint)
        .token_program_id(&token_program)
        .send()
        .unwrap();
    MintTo::new(&mut fixture.svm, &alice, &mint, &attacker_ata, 500)
        .token_program_id(&token_program)
        .send()
        .unwrap();

    let instruction = fixture.instruction(&attacker, attacker_ata, 100);
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
    let attacker = Keypair::new();
    let (mint, token_program) = (fixture.mint, fixture.token_program);
    let attacker_ata = CreateAssociatedTokenAccount::new(&mut fixture.svm, &alice, &mint)
        .owner(&attacker.pubkey())
        .token_program_id(&token_program)
        .send()
        .unwrap();

    let mut instruction = fixture.instruction(&alice, fixture.alice_ata, 100);
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

    let mut instruction = fixture.instruction(&alice, fixture.alice_ata, 100);
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
    let instruction = fixture.instruction(&alice, fixture.alice_ata, 1);
    fixture.assert_failure(
        &alice,
        instruction,
        u32::from(BlockRouterError::MathOverflow),
    );
}

#[test]
fn emits_deposited() {
    use anchor_lang::__private::base64::{engine::general_purpose::STANDARD, Engine};

    let mut fixture = Fixture::new();
    fixture.deposit(400);
    let metadata = fixture.deposit(100);
    let events: Vec<_> = metadata
        .logs
        .iter()
        .filter_map(|log| {
            let encoded = log.strip_prefix("Program data: ")?;
            let bytes = STANDARD.decode(encoded).unwrap();
            bytes
                .strip_prefix(Deposited::DISCRIMINATOR)
                .map(|payload| Deposited::try_from_slice(payload).unwrap())
        })
        .collect();
    assert_eq!(events.len(), 1, "{}", metadata.pretty_logs());
    let event = &events[0];
    assert_eq!(event.vault, fixture.vault_key);
    assert_eq!(event.owner, pubkey(fixture.alice.pubkey()));
    assert_eq!(event.mint, pubkey(fixture.mint));
    assert_eq!(event.amount, 100);
    assert_eq!(event.balance, 500);
}
