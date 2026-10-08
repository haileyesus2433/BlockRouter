use anchor_lang::AccountDeserialize;
use blockrouter::{errors::BlockRouterError, instructions::VaultInitialized, state::Vault};
use litesvm_token::{
    get_spl_account,
    spl_token::{
        extension::{transfer_fee::instruction::initialize_transfer_fee_config, ExtensionType},
        instruction::initialize_mint2,
        state::{Account as TokenAccount, Mint},
    },
    CreateAssociatedTokenAccount, CreateMint,
};
use solana_keypair::{Address, Keypair, Signer};
use solana_system_interface::instruction::create_account;
use solana_transaction::{InstructionError, Transaction, TransactionError};

use crate::vault_fixture::{
    address, ata_address, events, initialize_vault_ix, pubkey, send_tx, vault_pda,
    VaultFixture as Fixture,
};

fn token_2022() -> Address {
    address(anchor_spl::token_2022::ID)
}

fn new_mint(fixture: &mut Fixture, token_program: &Address) -> Address {
    let alice = fixture.alice.insecure_clone();
    CreateMint::new(&mut fixture.svm, &alice)
        .decimals(6)
        .token_program_id(token_program)
        .send()
        .unwrap()
}

fn transfer_fee_mint(fixture: &mut Fixture) -> Address {
    let alice = fixture.alice.insecure_clone();
    let mint = Keypair::new();
    let len = ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::TransferFeeConfig])
        .unwrap();
    let instructions = [
        create_account(
            &alice.pubkey(),
            &mint.pubkey(),
            fixture.svm.minimum_balance_for_rent_exemption(len),
            len as u64,
            &token_2022(),
        ),
        initialize_transfer_fee_config(&token_2022(), &mint.pubkey(), None, None, 100, 1_000)
            .unwrap(),
        initialize_mint2(&token_2022(), &mint.pubkey(), &alice.pubkey(), None, 6).unwrap(),
    ];
    let tx = Transaction::new_signed_with_payer(
        &instructions,
        Some(&alice.pubkey()),
        &[&alice, &mint],
        fixture.svm.latest_blockhash(),
    );
    fixture.svm.send_transaction(tx).unwrap();
    mint.pubkey()
}

fn initialize(fixture: &mut Fixture, owner: &Keypair, mint: &Address, token_program: &Address) {
    let instruction = initialize_vault_ix(owner, mint, token_program);
    send_tx(&mut fixture.svm, owner, instruction).unwrap();
}

fn assert_rejected(
    fixture: &mut Fixture,
    owner: &Keypair,
    instruction: solana_transaction::Instruction,
    code: u32,
) {
    let failure = send_tx(&mut fixture.svm, owner, instruction).unwrap_err();
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(0, InstructionError::Custom(code)),
        "{}",
        failure.meta.pretty_logs()
    );
}

fn read_vault(fixture: &Fixture, owner: &Address, mint: &Address) -> Vault {
    let account = fixture
        .svm
        .get_account(&address(vault_pda(owner, mint)))
        .unwrap();
    Vault::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn assert_initialized(fixture: &Fixture, owner: &Address, mint: &Address, token_program: &Address) {
    let vault_key = vault_pda(owner, mint);
    let vault = read_vault(fixture, owner, mint);
    assert_eq!(vault.owner, pubkey(*owner));
    assert_eq!(vault.mint, pubkey(*mint));
    assert_eq!(vault.balance, 0);
    assert_eq!(vault.total_reserved, 0);
    assert_eq!(vault.session_counter, 0);

    let ata = ata_address(&address(vault_key), mint, token_program);
    let ata_account = fixture.svm.get_account(&ata).unwrap();
    assert_eq!(ata_account.owner, *token_program);
    let token = get_spl_account::<TokenAccount>(&fixture.svm, &ata).unwrap();
    assert_eq!(token.owner, address(vault_key));
    assert_eq!(token.mint, *mint);
    assert_eq!(token.amount, vault.balance);
}

#[test]
fn initializes_vault_and_token_account() {
    let fixture = Fixture::new();
    let (owner, mint, program) = (fixture.alice.pubkey(), fixture.mint, fixture.token_program);
    assert_initialized(&fixture, &owner, &mint, &program);
    assert_eq!(
        fixture.vault.bump,
        anchor_lang::prelude::Pubkey::find_program_address(
            &[
                blockrouter::constants::VAULT_SEED,
                pubkey(owner).as_ref(),
                pubkey(mint).as_ref()
            ],
            &blockrouter::id()
        )
        .1
    );
}

#[test]
fn initializes_token_2022_vault() {
    let fixture = Fixture::with_token_program(token_2022());
    let (owner, mint) = (fixture.alice.pubkey(), fixture.mint);
    assert_initialized(&fixture, &owner, &mint, &token_2022());
}

#[test]
fn transfer_fee_mint_is_rejected() {
    let mut fixture = Fixture::new();
    let mint = transfer_fee_mint(&mut fixture);
    let alice = fixture.alice.insecure_clone();
    let instruction = initialize_vault_ix(&alice, &mint, &token_2022());
    assert_rejected(
        &mut fixture,
        &alice,
        instruction,
        u32::from(BlockRouterError::UnsupportedMint),
    );
    assert!(fixture
        .svm
        .get_account(&address(vault_pda(&alice.pubkey(), &mint)))
        .is_none());
}

#[test]
fn pre_created_vault_token_account_does_not_block_init() {
    let mut fixture = Fixture::new();
    let token_program = fixture.token_program;
    let mint = new_mint(&mut fixture, &token_program);
    let attacker = fixture.new_actor();
    let alice = fixture.alice.insecure_clone();
    let vault_key = vault_pda(&alice.pubkey(), &mint);
    CreateAssociatedTokenAccount::new(&mut fixture.svm, &attacker, &mint)
        .owner(&address(vault_key))
        .token_program_id(&token_program)
        .send()
        .unwrap();

    initialize(&mut fixture, &alice, &mint, &token_program);
    assert_initialized(&fixture, &alice.pubkey(), &mint, &token_program);
}

#[test]
fn vault_cannot_be_initialized_twice() {
    let mut fixture = Fixture::new();
    let alice = fixture.alice.insecure_clone();
    let instruction = initialize_vault_ix(&alice, &fixture.mint, &fixture.token_program);
    // System program AccountAlreadyInUse.
    assert_rejected(&mut fixture, &alice, instruction, 0);
}

#[test]
fn vaults_are_separate_per_owner_and_mint() {
    let mut fixture = Fixture::new();
    let token_program = fixture.token_program;
    let second_mint = new_mint(&mut fixture, &token_program);
    let bob = fixture.new_actor();
    let alice = fixture.alice.insecure_clone();
    let first_mint = fixture.mint;

    initialize(&mut fixture, &alice, &second_mint, &token_program);
    initialize(&mut fixture, &bob, &first_mint, &token_program);

    let keys = [
        vault_pda(&alice.pubkey(), &first_mint),
        vault_pda(&alice.pubkey(), &second_mint),
        vault_pda(&bob.pubkey(), &first_mint),
    ];
    assert_ne!(keys[0], keys[1]);
    assert_ne!(keys[0], keys[2]);
    assert_ne!(keys[1], keys[2]);
    assert_initialized(&fixture, &alice.pubkey(), &second_mint, &token_program);
    assert_initialized(&fixture, &bob.pubkey(), &first_mint, &token_program);
}

#[test]
fn vault_token_account_not_owned_by_vault_is_rejected() {
    let mut fixture = Fixture::new();
    let token_program = fixture.token_program;
    let mint = new_mint(&mut fixture, &token_program);
    let alice = fixture.alice.insecure_clone();
    let attacker = fixture.new_actor();
    let attacker_ata = fixture_ata(&mut fixture, &attacker, &mint, &token_program);

    let mut instruction = initialize_vault_ix(&alice, &mint, &token_program);
    instruction.accounts[3].pubkey = attacker_ata;
    assert_rejected(
        &mut fixture,
        &alice,
        instruction,
        u32::from(anchor_lang::error::ErrorCode::ConstraintTokenOwner),
    );
}

#[test]
fn mismatched_token_program_is_rejected() {
    let mut fixture = Fixture::new();
    let bob = fixture.new_actor();
    let mint = fixture.mint;
    let instruction = initialize_vault_ix(&bob, &mint, &token_2022());
    let failure = send_tx(&mut fixture.svm, &bob, instruction).unwrap_err();
    // The token account creation CPI fails before Anchor's mint check runs.
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(0, InstructionError::IncorrectProgramId)
    );
    assert!(fixture
        .svm
        .get_account(&address(vault_pda(&bob.pubkey(), &mint)))
        .is_none());
}

#[test]
fn emits_vault_initialized() {
    let mut fixture = Fixture::new();
    let token_program = fixture.token_program;
    let mint = new_mint(&mut fixture, &token_program);
    let alice = fixture.alice.insecure_clone();
    let instruction = initialize_vault_ix(&alice, &mint, &token_program);
    let metadata = send_tx(&mut fixture.svm, &alice, instruction).unwrap();

    let events = events::<VaultInitialized>(&metadata);
    assert_eq!(events.len(), 1, "{}", metadata.pretty_logs());
    let event = &events[0];
    let vault_key = vault_pda(&alice.pubkey(), &mint);
    assert_eq!(event.vault, vault_key);
    assert_eq!(event.owner, pubkey(alice.pubkey()));
    assert_eq!(event.mint, pubkey(mint));
    assert_eq!(
        event.vault_ata,
        pubkey(ata_address(&address(vault_key), &mint, &token_program))
    );
}

fn fixture_ata(
    fixture: &mut Fixture,
    owner: &Keypair,
    mint: &Address,
    token_program: &Address,
) -> Address {
    CreateAssociatedTokenAccount::new(&mut fixture.svm, owner, mint)
        .token_program_id(token_program)
        .send()
        .unwrap()
}
