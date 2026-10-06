use anchor_lang::{
    prelude::Pubkey, AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator,
    InstructionData, ToAccountMetas,
};
use blockrouter::{constants::VAULT_SEED, state::Vault};
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

pub const STARTING_BALANCE: u64 = 1_000_000;

pub fn address(key: Pubkey) -> Address {
    Address::from(key.to_bytes())
}

pub fn pubkey(key: Address) -> Pubkey {
    Pubkey::new_from_array(key.to_bytes())
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

pub struct VaultFixture {
    pub svm: LiteSVM,
    pub alice: Keypair,
    pub token_program: Address,
    pub mint: Address,
    pub alice_ata: Address,
    pub vault_key: Pubkey,
    pub vault_ata: Address,
    pub vault: Vault,
}

impl VaultFixture {
    pub fn new() -> Self {
        Self::with_token_program(address(anchor_spl::token::ID))
    }

    pub fn with_token_program(token_program: Address) -> Self {
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
        let alice_ata = create_funded_ata(&mut svm, &alice, &alice, &mint, &token_program);

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

    pub fn new_actor(&mut self) -> Keypair {
        let actor = Keypair::new();
        self.svm.airdrop(&actor.pubkey(), 10_000_000_000).unwrap();
        actor
    }

    pub fn funded_ata_for(&mut self, owner: &Keypair) -> Address {
        let alice = self.alice.insecure_clone();
        let (mint, token_program) = (self.mint, self.token_program);
        create_funded_ata(&mut self.svm, owner, &alice, &mint, &token_program)
    }

    pub fn unfunded_ata_for(&mut self, owner: &Address) -> Address {
        let alice = self.alice.insecure_clone();
        let (mint, token_program) = (self.mint, self.token_program);
        CreateAssociatedTokenAccount::new(&mut self.svm, &alice, &mint)
            .owner(owner)
            .token_program_id(&token_program)
            .send()
            .unwrap()
    }

    /// Returns (mint, alice's funded ATA) for a mint unrelated to the vault.
    pub fn second_mint(&mut self) -> (Address, Address) {
        let alice = self.alice.insecure_clone();
        let token_program = self.token_program;
        let other_mint = CreateMint::new(&mut self.svm, &alice)
            .decimals(6)
            .token_program_id(&token_program)
            .send()
            .unwrap();
        let ata = create_funded_ata(&mut self.svm, &alice, &alice, &other_mint, &token_program);
        (other_mint, ata)
    }

    pub fn deposit_ix(&self, signer: &Keypair, user_ata: Address, amount: u64) -> Instruction {
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

    pub fn withdraw_ix(&self, signer: &Keypair, user_ata: Address, amount: u64) -> Instruction {
        Instruction {
            program_id: address(blockrouter::id()),
            accounts: blockrouter::accounts::Withdraw {
                user: pubkey(signer.pubkey()),
                user_ata: pubkey(user_ata),
                vault: self.vault_key,
                vault_ata: pubkey(self.vault_ata),
                mint: pubkey(self.mint),
                token_program: pubkey(self.token_program),
            }
            .to_account_metas(None),
            data: blockrouter::instruction::Withdraw { amount }.data(),
        }
    }

    pub fn send(
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

    pub fn deposit(&mut self, amount: u64) -> TransactionMetadata {
        let alice = self.alice.insecure_clone();
        let instruction = self.deposit_ix(&alice, self.alice_ata, amount);
        self.send(&alice, instruction).unwrap()
    }

    pub fn withdraw(&mut self, amount: u64) -> TransactionMetadata {
        let alice = self.alice.insecure_clone();
        let instruction = self.withdraw_ix(&alice, self.alice_ata, amount);
        self.send(&alice, instruction).unwrap()
    }

    pub fn reserve(&mut self, total_reserved: u64) {
        self.vault = self.read_vault();
        self.vault.total_reserved = total_reserved;
        seed_account(&mut self.svm, self.vault_key, &self.vault);
    }

    pub fn read_vault(&self) -> Vault {
        let account = self.svm.get_account(&address(self.vault_key)).unwrap();
        Vault::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    pub fn token_balance(&self, ata: &Address) -> u64 {
        get_spl_account::<TokenAccount>(&self.svm, ata)
            .unwrap()
            .amount
    }

    pub fn assert_vault_invariants(&self) {
        let vault = self.read_vault();
        assert!(vault.balance >= vault.total_reserved);
        assert_eq!(vault.balance, self.token_balance(&self.vault_ata));
    }

    pub fn assert_failure(
        &mut self,
        signer: &Keypair,
        instruction: Instruction,
        expected_code: u32,
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
            TransactionError::InstructionError(0, InstructionError::Custom(expected_code)),
            "{}",
            failure.meta.pretty_logs()
        );
        let after: Vec<_> = watched.iter().map(|k| self.svm.get_account(k)).collect();
        assert_eq!(before, after);
    }
}
