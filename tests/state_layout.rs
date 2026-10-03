use anchor_lang::Space;
use blockrouter::state::*;

// Fails if an account layout changes.
#[test]
fn account_sizes() {
    assert_eq!(Config::INIT_SPACE, 116);
    assert_eq!(Model::INIT_SPACE, 44);
    assert_eq!(Vault::INIT_SPACE, 89);
    assert_eq!(SponsorVault::INIT_SPACE, 81);
    assert_eq!(Allowance::INIT_SPACE, 128);
    assert_eq!(Session::INIT_SPACE, 122);
    assert_eq!(Escrow::INIT_SPACE, 187);
    assert_eq!(PayerKind::INIT_SPACE, 1);
}
