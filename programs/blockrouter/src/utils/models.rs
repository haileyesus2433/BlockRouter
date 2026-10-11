use anchor_lang::prelude::*;

use crate::{
    constants::{MAX_ALLOWED_MODELS, MODEL_SEED},
    errors::BlockRouterError,
    state::Model,
};

/// Checks a model id list: non-empty, bounded, no duplicates.
pub fn validate_model_ids(ids: &[u16]) -> Result<()> {
    require!(!ids.is_empty(), BlockRouterError::NoModelsSpecified);
    require!(
        ids.len() <= MAX_ALLOWED_MODELS,
        BlockRouterError::TooManyModels
    );
    for (index, id) in ids.iter().enumerate() {
        require!(!ids[..index].contains(id), BlockRouterError::DuplicateModel);
    }
    Ok(())
}

/// Loads the canonical Model PDA for `model_id` from a remaining account.
pub fn load_model<'info>(
    info: &'info AccountInfo<'info>,
    model_id: u16,
    program_id: &Pubkey,
) -> Result<Account<'info, Model>> {
    let model = Account::<Model>::try_from(info).map_err(|_| BlockRouterError::ModelNotFound)?;
    require!(model.model_id == model_id, BlockRouterError::ModelNotFound);
    let expected = Pubkey::create_program_address(
        &[MODEL_SEED, &model_id.to_le_bytes(), &[model.bump]],
        program_id,
    )
    .map_err(|_| BlockRouterError::ModelNotFound)?;
    require_keys_eq!(info.key(), expected, BlockRouterError::ModelNotFound);
    Ok(model)
}
