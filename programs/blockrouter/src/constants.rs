use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

#[constant]
pub const MODEL_SEED: &[u8] = b"model";

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

#[constant]
pub const SPONSOR_VAULT_SEED: &[u8] = b"sponsor_vault";

#[constant]
pub const ALLOWANCE_SEED: &[u8] = b"allowance";

#[constant]
pub const SESSION_SEED: &[u8] = b"session";

#[constant]
pub const ESCROW_SEED: &[u8] = b"escrow";

#[constant]
pub const MAX_FEE_BPS: u16 = 1_000;

pub const RATE_DENOMINATOR: u128 = 1_000_000;

pub const MAX_ALLOWED_MODELS: usize = 8;

#[constant]
pub const MIN_SESSION_SECS: i64 = 60;

#[constant]
pub const MAX_SESSION_SECS: i64 = 7 * 24 * 60 * 60;

#[constant]
pub const MAX_CONCURRENT_SESSIONS: u16 = 4;
