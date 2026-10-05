use anchor_lang::prelude::Result;

use crate::{constants::RATE_DENOMINATOR, errors::BlockRouterError};

/// Calculates the charge in base units, rounding down after combining both token costs.
pub fn calculate_charge(
    prompt_tokens: u64,
    completion_tokens: u64,
    prompt_rate: u64,
    completion_rate: u64,
) -> Result<u64> {
    let prompt_cost = u128::from(prompt_tokens)
        .checked_mul(u128::from(prompt_rate))
        .ok_or(BlockRouterError::MathOverflow)?;
    let completion_cost = u128::from(completion_tokens)
        .checked_mul(u128::from(completion_rate))
        .ok_or(BlockRouterError::MathOverflow)?;
    let charge = prompt_cost
        .checked_add(completion_cost)
        .ok_or(BlockRouterError::MathOverflow)?
        .checked_div(RATE_DENOMINATOR)
        .ok_or(BlockRouterError::MathOverflow)?;

    u64::try_from(charge).map_err(|_| BlockRouterError::MathOverflow.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::error::Error;

    fn assert_math_overflow(result: Result<u64>) {
        let Error::AnchorError(error) = result.unwrap_err() else {
            panic!("expected an Anchor MathOverflow error");
        };
        assert_eq!(
            error.error_code_number,
            u32::from(BlockRouterError::MathOverflow)
        );
        assert_eq!(error.error_name, "MathOverflow");
    }

    #[test]
    fn zero_usage() {
        assert_eq!(calculate_charge(0, 0, u64::MAX, u64::MAX).unwrap(), 0);
    }

    #[test]
    fn low_rate_rounds_down() {
        assert_eq!(calculate_charge(1, 0, 1, 0).unwrap(), 0);
    }

    #[test]
    fn just_below_one_million_tokens() {
        assert_eq!(calculate_charge(999_999, 0, 1, 0).unwrap(), 0);
    }

    #[test]
    fn one_million_tokens() {
        assert_eq!(calculate_charge(1_000_000, 0, 7, 0).unwrap(), 7);
        assert_eq!(calculate_charge(0, 1_000_000, 0, 7).unwrap(), 7);
    }

    #[test]
    fn combines_costs_before_division() {
        assert_eq!(calculate_charge(500_000, 500_000, 1, 1).unwrap(), 1);
    }

    #[test]
    fn combined_cost_overflows_u128() {
        assert_math_overflow(calculate_charge(u64::MAX, u64::MAX, u64::MAX, u64::MAX));
    }

    #[test]
    fn charge_overflows_u64() {
        assert_math_overflow(calculate_charge(u64::MAX, 0, u64::MAX, 0));
    }
}
