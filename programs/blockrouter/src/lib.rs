pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;
pub mod utils;

use anchor_lang::prelude::*;

declare_id!("7maTNWbtCpuCXeRUVCNDR2a9YU7kaeUqtvrqz4ustyyi");

#[program]
pub mod blockrouter {}
