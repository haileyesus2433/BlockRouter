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
    assert_eq!(Session::INIT_SPACE, 124);
    assert_eq!(Session::DISCRIMINATOR.len() + Session::INIT_SPACE, 132);
    assert_eq!(Escrow::INIT_SPACE, 187);
    assert_eq!(PayerKind::INIT_SPACE, 1);
}

#[test]
fn session_serialization_requires_explicit_legacy_migration() {
    use anchor_lang::{prelude::Pubkey, AccountDeserialize, AccountSerialize};

    let session = Session {
        payer_account: Pubkey::new_unique(),
        payer_kind: PayerKind::Vault,
        beneficiary: Pubkey::new_unique(),
        relayer: Pubkey::new_unique(),
        reserved_amount: 5,
        session_id: 7,
        expires_at: 1_800_000_120,
        bump: 255,
        model_id: 42,
    };
    let mut data = Vec::new();
    session.try_serialize(&mut data).unwrap();
    assert_eq!(data.len(), 132);
    assert_eq!(
        Session::try_deserialize(&mut data.as_slice())
            .unwrap()
            .model_id,
        42
    );
    // The old layout ends after bump. It must never acquire an implicit Model.
    assert!(Session::try_deserialize(&mut &data[..130]).is_err());
}
