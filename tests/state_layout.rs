use anchor_lang::{Discriminator, Space};
use blockrouter::state::*;

// Fails if an account layout changes.
#[test]
fn account_sizes() {
    assert_eq!(Config::INIT_SPACE, 116);
    assert_eq!(Model::INIT_SPACE, 44);
    assert_eq!(Vault::INIT_SPACE, 89);
    assert_eq!(SponsorVault::INIT_SPACE, 81);
    assert_eq!(Allowance::INIT_SPACE, 128);
    // 122 fixed bytes + 4-byte vec length + 8 allowed models * 2 bytes.
    assert_eq!(Session::INIT_SPACE, 142);
    assert_eq!(Session::DISCRIMINATOR.len() + Session::INIT_SPACE, 150);
    assert_eq!(Escrow::INIT_SPACE, 187);
    assert_eq!(PayerKind::INIT_SPACE, 1);
}

#[test]
fn session_with_every_allowed_model_fits_its_allocation() {
    use anchor_lang::{prelude::Pubkey, AccountDeserialize, AccountSerialize};
    use blockrouter::constants::MAX_ALLOWED_MODELS;

    let session = Session {
        payer_account: Pubkey::new_unique(),
        payer_kind: PayerKind::Vault,
        beneficiary: Pubkey::new_unique(),
        relayer: Pubkey::new_unique(),
        reserved_amount: 5,
        session_id: 7,
        expires_at: 1_800_000_120,
        bump: 255,
        allowed_models: (1..=MAX_ALLOWED_MODELS as u16).collect(),
    };
    let mut data = Vec::new();
    session.try_serialize(&mut data).unwrap();
    assert_eq!(
        data.len(),
        Session::DISCRIMINATOR.len() + Session::INIT_SPACE
    );
    let decoded = Session::try_deserialize(&mut data.as_slice()).unwrap();
    assert_eq!(decoded.allowed_models, (1..=8).collect::<Vec<u16>>());
}
