use anchor_lang::{
    prelude::{Clock, Pubkey},
    AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator, InstructionData,
    ToAccountMetas,
};
use blockrouter::{
    constants::{CONFIG_SEED, MODEL_SEED, SESSION_SEED, VAULT_SEED},
    state::{Allowance, Model, SponsorVault, Vault},
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
use solana_transaction::{Instruction, Transaction};

pub const NOW: i64 = 1_800_000_000;
pub const STARTING_BALANCE: u64 = 1_000_000;
pub const DECIMALS: u8 = 6;
pub const FEE_BPS: u16 = 250;
pub const DISPUTE_WINDOW_SECS: i64 = 86_400;
pub const PRICE_TIMELOCK_SECS: i64 = 3_600;

// Conversions between anchor-lang's Pubkey and the solana-address type LiteSVM uses.
pub fn address(key: Pubkey) -> Address {
    Address::from(key.to_bytes())
}

pub fn pubkey(key: Address) -> Pubkey {
    Pubkey::new_from_array(key.to_bytes())
}

pub fn new_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program(
        address(blockrouter::id()),
        include_bytes!(concat!(
            env!("CARGO_TARGET_TMPDIR"),
            "/../deploy/blockrouter.so"
        )),
    )
    .unwrap();
    svm
}

pub fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(
        &[blockrouter::id().as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    )
    .0
}

// ProgramData layout: u32 tag, u64 slot, Option<Pubkey> authority.
pub fn set_upgrade_authority(svm: &mut LiteSVM, authority: Option<Pubkey>) {
    let key = address(program_data_address());
    let mut account = svm.get_account(&key).unwrap();
    match authority {
        Some(authority) => {
            account.data[12] = 1;
            account.data[13..45].copy_from_slice(authority.as_ref());
        }
        None => account.data[12..45].fill(0),
    }
    svm.set_account(key, account).unwrap();
}

pub fn seed_account(svm: &mut LiteSVM, key: Pubkey, state: &impl AccountSerialize) {
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

pub fn read<T: AccountDeserialize>(svm: &LiteSVM, key: Pubkey) -> T {
    let account = svm.get_account(&address(key)).unwrap();
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}

pub fn token_balance(svm: &LiteSVM, ata: &Address) -> u64 {
    get_spl_account::<TokenAccount>(svm, ata).unwrap().amount
}

pub fn events<E: Discriminator + AnchorDeserialize>(metadata: &TransactionMetadata) -> Vec<E> {
    use anchor_lang::__private::base64::{engine::general_purpose::STANDARD, Engine};

    metadata
        .logs
        .iter()
        .filter_map(|log| {
            let encoded = log.strip_prefix("Program data: ")?;
            let bytes = STANDARD.decode(encoded).unwrap();
            bytes
                .strip_prefix(E::DISCRIMINATOR)
                .map(|payload| E::try_from_slice(payload).unwrap())
        })
        .collect()
}

pub fn send_tx(
    svm: &mut LiteSVM,
    signer: &Keypair,
    instruction: Instruction,
) -> Result<TransactionMetadata, Box<FailedTransactionMetadata>> {
    svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&signer.pubkey()),
        &[signer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).map_err(Box::new)
}

pub fn create_funded_ata(
    svm: &mut LiteSVM,
    owner: &Keypair,
    mint_authority: &Keypair,
    mint: &Address,
    token_program: &Address,
) -> Address {
    let ata = CreateAssociatedTokenAccount::new(svm, owner, mint)
        .token_program_id(token_program)
        .send()
        .unwrap();
    MintTo::new(svm, mint_authority, mint, &ata, STARTING_BALANCE)
        .token_program_id(token_program)
        .send()
        .unwrap();
    ata
}

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &blockrouter::id()).0
}

pub fn model_pda(model_id: u16) -> Pubkey {
    Pubkey::find_program_address(&[MODEL_SEED, &model_id.to_le_bytes()], &blockrouter::id()).0
}

/// Seeds a valid, active Model fixture; opening still runs the real instruction.
pub fn seed_model(svm: &mut LiteSVM, model_id: u16) -> Pubkey {
    let (key, bump) =
        Pubkey::find_program_address(&[MODEL_SEED, &model_id.to_le_bytes()], &blockrouter::id());
    seed_account(
        svm,
        key,
        &Model {
            model_id,
            prompt_rate: 1,
            completion_rate: 2,
            pending_prompt_rate: 0,
            pending_completion_rate: 0,
            effective_at: 0,
            is_active: true,
            bump,
        },
    );
    key
}

pub fn vault_pda(owner: &Address, mint: &Address) -> Pubkey {
    Pubkey::find_program_address(
        &[VAULT_SEED, pubkey(*owner).as_ref(), pubkey(*mint).as_ref()],
        &blockrouter::id(),
    )
    .0
}

pub fn session_pda(payer_account: &Pubkey, session_id: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[
            SESSION_SEED,
            payer_account.as_ref(),
            &session_id.to_le_bytes(),
        ],
        &blockrouter::id(),
    )
    .0
}

pub fn ata_address(owner: &Address, mint: &Address, token_program: &Address) -> Address {
    let (ata, _) = Pubkey::find_program_address(
        &[
            pubkey(*owner).as_ref(),
            pubkey(*token_program).as_ref(),
            pubkey(*mint).as_ref(),
        ],
        &anchor_spl::associated_token::ID,
    );
    address(ata)
}

pub fn initialize_vault_ix(
    owner: &Keypair,
    mint: &Address,
    token_program: &Address,
) -> Instruction {
    let vault = vault_pda(&owner.pubkey(), mint);
    Instruction {
        program_id: address(blockrouter::id()),
        accounts: blockrouter::accounts::InitializeVault {
            user: pubkey(owner.pubkey()),
            vault,
            mint: pubkey(*mint),
            vault_ata: pubkey(ata_address(&address(vault), mint, token_program)),
            token_program: pubkey(*token_program),
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None),
        data: blockrouter::instruction::InitializeVault {}.data(),
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Actor {
    Admin,
    Alice,
    Bob,
    Sponsor,
    Student,
    Relayer,
    Attacker,
}

pub struct TestEnv {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub alice: Keypair,
    pub bob: Keypair,
    pub sponsor: Keypair,
    pub student: Keypair,
    pub relayer: Keypair,
    pub attacker: Keypair,
    pub mint: Address,
    pub token_program: Address,
}

impl TestEnv {
    pub fn keypair(&self, who: Actor) -> Keypair {
        match who {
            Actor::Admin => &self.admin,
            Actor::Alice => &self.alice,
            Actor::Bob => &self.bob,
            Actor::Sponsor => &self.sponsor,
            Actor::Student => &self.student,
            Actor::Relayer => &self.relayer,
            Actor::Attacker => &self.attacker,
        }
        .insecure_clone()
    }

    pub fn key(&self, who: Actor) -> Pubkey {
        pubkey(self.keypair(who).pubkey())
    }

    /// The actor's funded token account for the test mint.
    pub fn ata(&self, who: Actor) -> Address {
        ata_address(&self.keypair(who).pubkey(), &self.mint, &self.token_program)
    }

    pub fn vault_ata(&self, vault: Pubkey) -> Address {
        ata_address(&address(vault), &self.mint, &self.token_program)
    }

    pub fn send(
        &mut self,
        who: Actor,
        instruction: Instruction,
    ) -> Result<TransactionMetadata, Box<FailedTransactionMetadata>> {
        let signer = self.keypair(who);
        send_tx(&mut self.svm, &signer, instruction)
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }
}

/// Program loaded with admin as upgrade authority, clock at NOW, SPL Token mint,
/// every actor funded with SOL and STARTING_BALANCE tokens.
pub fn setup() -> TestEnv {
    setup_with_token_program(address(anchor_spl::token::ID))
}

pub fn setup_with_token_program(token_program: Address) -> TestEnv {
    let mut svm = new_svm();
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = NOW;
    svm.set_sysvar(&clock);

    let [admin, alice, bob, sponsor, student, relayer, attacker] =
        std::array::from_fn(|_| Keypair::new());
    set_upgrade_authority(&mut svm, Some(pubkey(admin.pubkey())));

    for actor in [
        &admin, &alice, &bob, &sponsor, &student, &relayer, &attacker,
    ] {
        svm.airdrop(&actor.pubkey(), 10_000_000_000).unwrap();
    }
    let mint = CreateMint::new(&mut svm, &admin)
        .decimals(DECIMALS)
        .token_program_id(&token_program)
        .send()
        .unwrap();
    for actor in [
        &admin, &alice, &bob, &sponsor, &student, &relayer, &attacker,
    ] {
        create_funded_ata(&mut svm, actor, &admin, &mint, &token_program);
    }

    TestEnv {
        svm,
        admin,
        alice,
        bob,
        sponsor,
        student,
        relayer,
        attacker,
        mint,
        token_program,
    }
}

/// Initializes config with admin as authority and a fresh treasury and provider.
pub fn init_config(env: &mut TestEnv) -> Pubkey {
    let config = config_pda();
    let instruction = Instruction {
        program_id: address(blockrouter::id()),
        accounts: blockrouter::accounts::InitializeConfig {
            authority: env.key(Actor::Admin),
            config,
            program: blockrouter::id(),
            program_data: program_data_address(),
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None),
        data: blockrouter::instruction::InitializeConfig {
            treasury: Pubkey::new_unique(),
            provider: Pubkey::new_unique(),
            fee_bps: FEE_BPS,
            dispute_window_secs: DISPUTE_WINDOW_SECS,
            price_timelock_secs: PRICE_TIMELOCK_SECS,
        }
        .data(),
    };
    env.send(Actor::Admin, instruction).unwrap();
    config
}

/// Initializes `who`'s vault for the test mint and deposits `amount`.
pub fn funded_vault(env: &mut TestEnv, who: Actor, amount: u64) -> Pubkey {
    let owner = env.keypair(who);
    let (mint, token_program) = (env.mint, env.token_program);
    let vault = vault_pda(&owner.pubkey(), &mint);
    send_tx(
        &mut env.svm,
        &owner,
        initialize_vault_ix(&owner, &mint, &token_program),
    )
    .unwrap();
    if amount > 0 {
        let instruction = Instruction {
            program_id: address(blockrouter::id()),
            accounts: blockrouter::accounts::Deposit {
                user: env.key(who),
                user_ata: pubkey(env.ata(who)),
                vault,
                vault_ata: pubkey(env.vault_ata(vault)),
                mint: pubkey(mint),
                token_program: pubkey(token_program),
            }
            .to_account_metas(None),
            data: blockrouter::instruction::Deposit { amount }.data(),
        };
        env.send(who, instruction).unwrap();
    }
    vault
}

/// Opens the next session on `who`'s vault, bound to the relayer actor.
/// Requires init_config and funded_vault first.
pub fn open_session(env: &mut TestEnv, who: Actor, cap: u64, secs: i64, model_id: u16) -> Pubkey {
    let vault = vault_pda(&env.keypair(who).pubkey(), &env.mint);
    let session_id = read::<Vault>(&env.svm, vault).session_counter;
    let session = session_pda(&vault, session_id);
    let instruction = Instruction {
        program_id: address(blockrouter::id()),
        accounts: blockrouter::accounts::OpenSession {
            user: env.key(who),
            vault,
            session,
            config: config_pda(),
            system_program: anchor_lang::solana_program::system_program::ID,
            model: model_pda(model_id),
        }
        .to_account_metas(None),
        data: blockrouter::instruction::OpenSession {
            session_id,
            reserved_amount: cap,
            relayer: env.key(Actor::Relayer),
            duration_secs: secs,
        }
        .data(),
    };
    env.send(who, instruction).unwrap();
    session
}

pub fn assert_vault_invariant(env: &TestEnv, vault: Pubkey) {
    let vault = read::<Vault>(&env.svm, vault);
    assert!(
        vault.balance >= vault.total_reserved,
        "vault balance {} < total_reserved {}",
        vault.balance,
        vault.total_reserved
    );
}

pub fn assert_allowance_invariant(env: &TestEnv, allowance: Pubkey) {
    let allowance = read::<Allowance>(&env.svm, allowance);
    let used = allowance
        .spent
        .checked_add(allowance.reserved)
        .expect("spent + reserved overflowed");
    assert!(
        allowance.cap >= used,
        "allowance cap {} < spent {} + reserved {}",
        allowance.cap,
        allowance.spent,
        allowance.reserved
    );
}

pub fn assert_sponsor_invariant(env: &TestEnv, sponsor_vault: Pubkey) {
    let sponsor_vault = read::<SponsorVault>(&env.svm, sponsor_vault);
    assert!(
        sponsor_vault.balance >= sponsor_vault.total_committed,
        "sponsor balance {} < total_committed {}",
        sponsor_vault.balance,
        sponsor_vault.total_committed
    );
}

pub fn assert_vault_matches_ata(env: &TestEnv, vault: Pubkey) {
    let state = read::<Vault>(&env.svm, vault);
    assert_eq!(
        state.balance,
        token_balance(&env.svm, &env.vault_ata(vault)),
        "PDA state and token account have diverged"
    );
}

pub fn warp(env: &mut TestEnv, secs: i64) {
    let mut clock = env.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = clock
        .unix_timestamp
        .checked_add(secs)
        .expect("warp overflowed the clock");
    env.svm.set_sysvar(&clock);
}
