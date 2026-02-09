mod lib;
mod config;

use dep::aztec::macros::aztec;

/// AMM contract with private swap event emission.
///
/// Clone of the canonical Aztec AMM contract with one addition: swap functions emit encrypted
/// events to the swapper so they can later prove they participated in a trade.
///
/// The private swap function knows amount_in (exact) but not amount_out (computed in public).
/// The event captures what's known at private execution time. The actual amount_out can be
/// derived from the AMM's public balance change at the same block.
#[aztec]
pub contract AMM {
    use crate::{
        config::Config,
        lib::{get_amount_in, get_amount_out, get_amounts_on_remove, get_amounts_to_add},
    };
    use dep::aztec::{
        macros::{events::event, functions::{external, initializer, only_self}, storage::storage},
        messages::message_delivery::MessageDelivery,
        protocol_types::address::AztecAddress,
        state_vars::PublicImmutable,
    };

    use dep::token::Token;
    use dep::uint_note::uint_note::PartialUintNote;

    #[storage]
    struct Storage<Context> {
        config: PublicImmutable<Config, Context>,
    }

    pub global MINIMUM_LIQUIDITY: u128 = 1000;
    pub global INITIAL_LIQUIDITY: u128 = 99000;

    // -- Events --

    /// Emitted privately to the swapper when they initiate a swap.
    /// For exact-in swaps: amount_in is the exact input, amount_out is the minimum accepted.
    /// For exact-out swaps: amount_out is the exact output, amount_in is the maximum provided.
    #[event]
    struct Swap {
        token_in: AztecAddress,
        token_out: AztecAddress,
        amount_in: u128,
        amount_out: u128,
        is_exact_input: bool,
    }

    // -- Constructor --

    #[external("public")]
    #[initializer]
    fn constructor(token0: AztecAddress, token1: AztecAddress, liquidity_token: AztecAddress) {
        self.storage.config.initialize(Config { token0, token1, liquidity_token });
    }

    // -- Add Liquidity --

    #[external("private")]
    fn add_liquidity(
        amount0_max: u128,
        amount1_max: u128,
        amount0_min: u128,
        amount1_min: u128,
        authwit_nonce: Field,
    ) {
        assert(
            (amount0_min < amount0_max) | (amount0_min == amount0_max),
            "INCORRECT_TOKEN0_LIMITS",
        );
        assert(
            (amount1_min < amount1_max) | (amount1_min == amount1_max),
            "INCORRECT_TOKEN1_LIMITS",
        );
        assert((0 as u128 < amount0_max) & (0 as u128 < amount1_max), "INSUFFICIENT_INPUT_AMOUNTS");

        let config = self.storage.config.read();

        let token0 = Token::at(config.token0);
        let token1 = Token::at(config.token1);
        let liquidity_token = Token::at(config.liquidity_token);

        let sender = self.msg_sender().unwrap();

        let refund_token0_partial_note = self.call(token0
            .transfer_to_public_and_prepare_private_balance_increase(
                sender,
                self.address,
                amount0_max,
                authwit_nonce,
            ));

        let refund_token1_partial_note = self.call(token1
            .transfer_to_public_and_prepare_private_balance_increase(
                sender,
                self.address,
                amount1_max,
                authwit_nonce,
            ));

        let liquidity_partial_note =
            self.call(liquidity_token.prepare_private_balance_increase(sender));

        self.enqueue_self._add_liquidity(
            config,
            refund_token0_partial_note,
            refund_token1_partial_note,
            liquidity_partial_note,
            amount0_max,
            amount1_max,
            amount0_min,
            amount1_min,
        );
    }

    #[external("public")]
    #[only_self]
    fn _add_liquidity(
        config: Config,
        refund_token0_partial_note: PartialUintNote,
        refund_token1_partial_note: PartialUintNote,
        liquidity_partial_note: PartialUintNote,
        amount0_max: u128,
        amount1_max: u128,
        amount0_min: u128,
        amount1_min: u128,
    ) {
        let token0 = Token::at(config.token0);
        let token1 = Token::at(config.token1);
        let liquidity_token = Token::at(config.liquidity_token);

        let balance0_plus_amount0_max = self.view(token0.balance_of_public(self.address));
        let balance0 = balance0_plus_amount0_max - amount0_max;

        let balance1_plus_amount1_max = self.view(token1.balance_of_public(self.address));
        let balance1 = balance1_plus_amount1_max - amount1_max;

        let (amount0, amount1) = get_amounts_to_add(
            amount0_max,
            amount1_max,
            amount0_min,
            amount1_min,
            balance0,
            balance1,
        );

        let refund_amount_token0 = amount0_max - amount0;
        let refund_amount_token1 = amount1_max - amount1;

        if (refund_amount_token0 > 0 as u128) {
            self.call(token0.finalize_transfer_to_private(
                refund_amount_token0,
                refund_token0_partial_note,
            ));
        }
        if (refund_amount_token1 > 0 as u128) {
            self.call(token1.finalize_transfer_to_private(
                refund_amount_token1,
                refund_token1_partial_note,
            ));
        }

        let total_supply = self.view(liquidity_token.total_supply());
        let liquidity_amount = if total_supply != 0 as u128 {
            std::cmp::min(
                (amount0 * total_supply) / balance0,
                (amount1 * total_supply) / balance1,
            )
        } else {
            liquidity_token.mint_to_public(AztecAddress::zero(), MINIMUM_LIQUIDITY).call(
                self.context,
            );
            INITIAL_LIQUIDITY
        };

        assert(liquidity_amount > 0 as u128, "INSUFFICIENT_LIQUIDITY_MINTED");
        liquidity_token.finalize_mint_to_private(liquidity_amount, liquidity_partial_note).call(
            self.context,
        );
    }

    // -- Remove Liquidity --

    #[external("private")]
    fn remove_liquidity(
        liquidity: u128,
        amount0_min: u128,
        amount1_min: u128,
        authwit_nonce: Field,
    ) {
        let config = self.storage.config.read();

        let liquidity_token = Token::at(config.liquidity_token);
        let token0 = Token::at(config.token0);
        let token1 = Token::at(config.token1);

        let sender = self.msg_sender().unwrap();

        self.call(liquidity_token.transfer_to_public(sender, self.address, liquidity, authwit_nonce));

        let token0_partial_note = self.call(token0.prepare_private_balance_increase(sender));
        let token1_partial_note = self.call(token1.prepare_private_balance_increase(sender));

        self.enqueue_self._remove_liquidity(
            config,
            liquidity,
            token0_partial_note,
            token1_partial_note,
            amount0_min,
            amount1_min,
        );
    }

    #[external("public")]
    #[only_self]
    fn _remove_liquidity(
        config: Config,
        liquidity: u128,
        token0_partial_note: PartialUintNote,
        token1_partial_note: PartialUintNote,
        amount0_min: u128,
        amount1_min: u128,
    ) {
        let token0 = Token::at(config.token0);
        let token1 = Token::at(config.token1);
        let liquidity_token = Token::at(config.liquidity_token);

        let balance0 = self.view(token0.balance_of_public(self.address));
        let balance1 = self.view(token1.balance_of_public(self.address));
        let total_supply = self.view(liquidity_token.total_supply());

        let (amount0, amount1) = get_amounts_on_remove(liquidity, total_supply, balance0, balance1);
        assert(amount0 >= amount0_min, "INSUFFICIENT_0_AMOUNT");
        assert(amount1 >= amount1_min, "INSUFFICIENT_1_AMOUNT");

        self.call(liquidity_token.burn_public(self.address, liquidity, 0));
        self.call(token0.finalize_transfer_to_private(amount0, token0_partial_note));
        self.call(token1.finalize_transfer_to_private(amount1, token1_partial_note));
    }

    // -- Swap: Exact Input --

    #[external("private")]
    fn swap_exact_tokens_for_tokens(
        token_in: AztecAddress,
        token_out: AztecAddress,
        amount_in: u128,
        amount_out_min: u128,
        authwit_nonce: Field,
    ) {
        let config = self.storage.config.read();

        assert((token_in == config.token0) | (token_in == config.token1), "TOKEN_IN_IS_INVALID");
        assert((token_out == config.token0) | (token_out == config.token1), "TOKEN_OUT_IS_INVALID");
        assert(token_in != token_out, "SAME_TOKEN_SWAP");

        let sender = self.msg_sender().unwrap();

        self.call(Token::at(token_in).transfer_to_public(
            sender,
            self.address,
            amount_in,
            authwit_nonce,
        ));
        let token_out_partial_note =
            self.call(Token::at(token_out).prepare_private_balance_increase(sender));

        // Emit swap event to the sender so they can later prove they participated
        self.emit(Swap {
            token_in,
            token_out,
            amount_in,
            amount_out: amount_out_min,
            is_exact_input: true,
        }).deliver_to(sender, MessageDelivery.UNCONSTRAINED_ONCHAIN);

        self.enqueue_self._swap_exact_tokens_for_tokens(
            token_in,
            token_out,
            amount_in,
            amount_out_min,
            token_out_partial_note,
        );
    }

    #[external("public")]
    #[only_self]
    fn _swap_exact_tokens_for_tokens(
        token_in: AztecAddress,
        token_out: AztecAddress,
        amount_in: u128,
        amount_out_min: u128,
        token_out_partial_note: PartialUintNote,
    ) {
        let balance_in_plus_amount_in =
            self.view(Token::at(token_in).balance_of_public(self.address));
        let balance_in = balance_in_plus_amount_in - amount_in;

        let balance_out = self.view(Token::at(token_out).balance_of_public(self.address));

        let amount_out = get_amount_out(amount_in, balance_in, balance_out);
        assert(amount_out >= amount_out_min, "INSUFFICIENT_OUTPUT_AMOUNT");

        Token::at(token_out).finalize_transfer_to_private(amount_out, token_out_partial_note).call(
            self.context,
        );
    }

    // -- Swap: Exact Output --

    #[external("private")]
    fn swap_tokens_for_exact_tokens(
        token_in: AztecAddress,
        token_out: AztecAddress,
        amount_out: u128,
        amount_in_max: u128,
        authwit_nonce: Field,
    ) {
        let config = self.storage.config.read();

        assert((token_in == config.token0) | (token_in == config.token1), "TOKEN_IN_IS_INVALID");
        assert((token_out == config.token0) | (token_out == config.token1), "TOKEN_OUT_IS_INVALID");
        assert(token_in != token_out, "SAME_TOKEN_SWAP");

        let sender = self.msg_sender().unwrap();

        let change_token_in_partial_note = self.call(Token::at(token_in)
            .transfer_to_public_and_prepare_private_balance_increase(
                sender,
                self.address,
                amount_in_max,
                authwit_nonce,
            ));

        let token_out_partial_note =
            self.call(Token::at(token_out).prepare_private_balance_increase(sender));

        // Emit swap event to the sender so they can later prove they participated
        self.emit(Swap {
            token_in,
            token_out,
            amount_in: amount_in_max,
            amount_out,
            is_exact_input: false,
        }).deliver_to(sender, MessageDelivery.UNCONSTRAINED_ONCHAIN);

        self.enqueue_self._swap_tokens_for_exact_tokens(
            token_in,
            token_out,
            amount_in_max,
            amount_out,
            change_token_in_partial_note,
            token_out_partial_note,
        );
    }

    #[external("public")]
    #[only_self]
    fn _swap_tokens_for_exact_tokens(
        token_in: AztecAddress,
        token_out: AztecAddress,
        amount_in_max: u128,
        amount_out: u128,
        change_token_in_partial_note: PartialUintNote,
        token_out_partial_note: PartialUintNote,
    ) {
        let balance_in_plus_amount_in_max =
            self.view(Token::at(token_in).balance_of_public(self.address));
        let balance_in = balance_in_plus_amount_in_max - amount_in_max;

        let balance_out = self.view(Token::at(token_out).balance_of_public(self.address));

        let amount_in = get_amount_in(amount_out, balance_in, balance_out);
        assert(amount_in <= amount_in_max, "INSUFFICIENT_OUTPUT_AMOUNT");

        let change = amount_in_max - amount_in;
        if (change > 0 as u128) {
            self.call(Token::at(token_in).finalize_transfer_to_private(
                change,
                change_token_in_partial_note,
            ));
        }

        Token::at(token_out).finalize_transfer_to_private(amount_out, token_out_partial_note).call(
            self.context,
        );
    }

    // -- Utility --

    #[external("utility")]
    unconstrained fn get_amount_out_for_exact_in(
        balance_in: u128,
        balance_out: u128,
        amount_in: u128,
    ) -> u128 {
        get_amount_out(amount_in, balance_in, balance_out)
    }

    #[external("utility")]
    unconstrained fn get_amount_in_for_exact_out(
        balance_in: u128,
        balance_out: u128,
        amount_out: u128,
    ) -> u128 {
        get_amount_in(amount_out, balance_in, balance_out)
    }
}
