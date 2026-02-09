/// Given an input amount of an asset and pair balances, returns the maximum output amount of the other asset.
pub fn get_amount_out(amount_in: u128, balance_in: u128, balance_out: u128) -> u128 {
    assert(amount_in > 0 as u128, "INSUFFICIENT_INPUT_AMOUNT");
    assert((balance_in > 0 as u128) & (balance_out > 0 as u128), "INSUFFICIENT_LIQUIDITY");

    let amount_in_with_fee = amount_in * 997 as u128;
    let numerator = amount_in_with_fee * balance_out;
    let denominator = balance_in * 1000 as u128 + amount_in_with_fee;
    numerator / denominator
}

/// Given an output amount of an asset and pair balances, returns a required input amount of the other asset.
pub fn get_amount_in(amount_out: u128, balance_in: u128, balance_out: u128) -> u128 {
    assert(amount_out > 0 as u128, "INSUFFICIENT_OUTPUT_AMOUNT");
    assert((balance_in > 0 as u128) & (balance_out > 0 as u128), "INSUFFICIENT_LIQUIDITY");

    let numerator = balance_in * amount_out * 1000 as u128;
    let denominator = (balance_out - amount_out) * 997 as u128;
    (numerator / denominator) + 1 as u128
}

/// Given the desired amounts and balances of token0 and token1 returns the optimal amount of token0 and token1 to be added to the pool.
pub fn get_amounts_to_add(
    amount0_max: u128,
    amount1_max: u128,
    amount0_min: u128,
    amount1_min: u128,
    balance0: u128,
    balance1: u128,
) -> (u128, u128) {
    if (balance0 == 0 as u128) | (balance1 == 0 as u128) {
        (amount0_max, amount1_max)
    } else {
        let amount1_equivalent = get_equivalent_amount(amount0_max, balance0, balance1);
        if (amount1_equivalent <= amount1_max) {
            assert(amount1_equivalent >= amount1_min, "AMOUNT_1_BELOW_MINIMUM");
            (amount0_max, amount1_equivalent)
        } else {
            let amount0_equivalent = get_equivalent_amount(amount1_max, balance1, balance0);
            assert(amount0_equivalent <= amount0_max);
            assert(amount0_equivalent >= amount0_min, "AMOUNT_0_BELOW_MINIMUM");
            (amount0_equivalent, amount1_max)
        }
    }
}

/// Returns the amount of tokens to return to a liquidity provider when they remove liquidity from the pool.
pub fn get_amounts_on_remove(
    to_burn: u128,
    total_supply: u128,
    balance0: u128,
    balance1: u128,
) -> (u128, u128) {
    (to_burn * balance0 / total_supply, to_burn * balance1 / total_supply)
}

/// Given some amount of an asset and pair balances, returns an equivalent amount of the other asset.
fn get_equivalent_amount(amount0: u128, balance0: u128, balance1: u128) -> u128 {
    assert((balance0 > 0 as u128) & (balance1 > 0 as u128), "INSUFFICIENT_LIQUIDITY");
    (amount0 * balance1) / balance0
}
