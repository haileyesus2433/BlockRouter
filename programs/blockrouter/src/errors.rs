use anchor_lang::prelude::*;

#[error_code]
pub enum BlockRouterError {
    #[msg("Signer is not authorized for this account")]
    Unauthorized,
    #[msg("Signer is not the relayer bound to this session")]
    UnauthorizedRelayer,
    #[msg("Payout token account is not owned by the configured provider or has the wrong mint")]
    UnauthorizedProvider,
    #[msg("Signer is not the allowance beneficiary")]
    NotBeneficiary,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Token account mint does not match the vault mint")]
    MintMismatch,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Fee exceeds the maximum allowed basis points")]
    FeeTooHigh,
    #[msg("Amount exceeds the vault's unreserved balance")]
    ExceedsUnreservedBalance,
    #[msg("Amount exceeds the sponsor vault's uncommitted balance")]
    ExceedsUncommittedBalance,
    #[msg("Amount exceeds the allowance's remaining headroom")]
    ExceedsAllowanceHeadroom,
    #[msg("Vault has insufficient unreserved balance to open this session")]
    InsufficientUnreservedBalance,
    #[msg("Computed charge exceeds the session reservation")]
    ChargeExceedsReservation,
    #[msg("Session id does not match the next expected id")]
    SessionIdMismatch,
    #[msg("Session has expired")]
    SessionExpired,
    #[msg("Session has not expired yet")]
    SessionNotExpired,
    #[msg("Session does not belong to this vault")]
    SessionVaultMismatch,
    #[msg("Session duration is outside the allowed range")]
    InvalidDuration,
    #[msg("Expiry must be in the future")]
    InvalidExpiry,
    #[msg("Too many concurrent sessions on this allowance")]
    TooManyConcurrentSessions,
    #[msg("Model is inactive")]
    ModelInactive,
    #[msg("Model not found")]
    ModelNotFound,
    #[msg("Model is not whitelisted for this allowance")]
    ModelNotWhitelisted,
    #[msg("Too many models specified")]
    TooManyModels,
    #[msg("At least one model must be specified")]
    NoModelsSpecified,
    #[msg("Allowance is inactive")]
    AllowanceInactive,
    #[msg("Allowance has expired")]
    AllowanceExpired,
    #[msg("Allowance is already inactive")]
    AlreadyInactive,
    #[msg("Allowance must be revoked before closing")]
    AllowanceStillActive,
    #[msg("Allowance still has open sessions")]
    SessionsStillOpen,
    #[msg("Protocol is paused")]
    ProtocolPaused,
    #[msg("Signer is not the disputer for this escrow")]
    NotDisputer,
    #[msg("Dispute window is still active")]
    DisputeWindowActive,
    #[msg("Dispute window has closed")]
    DisputeWindowClosed,
    #[msg("Escrow is under dispute")]
    EscrowDisputed,
    #[msg("Escrow is already disputed")]
    AlreadyDisputed,
    #[msg("Escrow is not disputed")]
    NotDisputed,
    #[msg("Payer account does not match the escrow")]
    PayerAccountMismatch,
    #[msg("Mint uses an unsupported Token-2022 extension")]
    UnsupportedMint,
}
