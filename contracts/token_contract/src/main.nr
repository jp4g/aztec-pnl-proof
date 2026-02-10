use aztec::macros::aztec;

/// Token contract with private transfer event emission.
///
/// Clone of the canonical Aztec Token contract with one addition: private transfers, mints, and
/// burns emit encrypted events so the participants can later prove token movements.
///
/// - Private transfer: emits Send to sender, Receive to recipient
/// - Mint to private: emits Receive to recipient
/// - Burn private: emits Send to burner
#[aztec]
pub contract Token {
    use std::ops::{Add, Sub};

    use compressed_string::FieldCompressedString;

    use aztec::{
        authwit::auth::compute_authwit_nullifier,
        context::{PrivateCall, PrivateContext},
        macros::{
            events::event,
            functions::{authorize_once, external, initializer, internal, only_self, view},
            storage::storage,
        },
        messages::message_delivery::MessageDelivery,
        protocol_types::{address::AztecAddress, traits::ToField},
        state_vars::{Map, Owned, PublicImmutable, PublicMutable, StateVariable},
    };

    use uint_note::uint_note::{PartialUintNote, UintNote};

    use balance_set::BalanceSet;

    global INITIAL_TRANSFER_CALL_MAX_NOTES: u32 = 2;
    global RECURSIVE_TRANSFER_CALL_MAX_NOTES: u32 = 8;

    // -- Events --

    /// Emitted privately to the sender when they send tokens.
    #[event]
    struct Send {
        token: AztecAddress,
        to: AztecAddress,
        amount: u128,
    }

    /// Emitted privately to the recipient when they receive tokens.
    #[event]
    struct Receive {
        token: AztecAddress,
        from: AztecAddress,
        amount: u128,
    }

    #[storage]
    struct Storage<Context> {
        admin: PublicMutable<AztecAddress, Context>,
        minters: Map<AztecAddress, PublicMutable<bool, Context>, Context>,
        balances: Owned<BalanceSet<Context>, Context>,
        total_supply: PublicMutable<u128, Context>,
        public_balances: Map<AztecAddress, PublicMutable<u128, Context>, Context>,
        symbol: PublicImmutable<FieldCompressedString, Context>,
        name: PublicImmutable<FieldCompressedString, Context>,
        decimals: PublicImmutable<u8, Context>,
    }

    // -- Constructor --

    #[external("public")]
    #[initializer]
    fn constructor(admin: AztecAddress, name: str<31>, symbol: str<31>, decimals: u8) {
        assert(!admin.is_zero(), "invalid admin");
        self.storage.admin.write(admin);
        self.storage.minters.at(admin).write(true);
        self.storage.name.initialize(FieldCompressedString::from_string(name));
        self.storage.symbol.initialize(FieldCompressedString::from_string(symbol));
        self.storage.decimals.initialize(decimals);
    }

    // -- Admin --

    #[external("public")]
    fn set_admin(new_admin: AztecAddress) {
        assert(self.storage.admin.read().eq(self.msg_sender().unwrap()), "caller is not admin");
        self.storage.admin.write(new_admin);
    }

    #[external("public")]
    #[view]
    fn public_get_name() -> FieldCompressedString {
        self.storage.name.read()
    }

    #[external("private")]
    #[view]
    fn private_get_name() -> FieldCompressedString {
        self.storage.name.read()
    }

    #[external("public")]
    #[view]
    fn public_get_symbol() -> pub FieldCompressedString {
        self.storage.symbol.read()
    }

    #[external("private")]
    #[view]
    fn private_get_symbol() -> pub FieldCompressedString {
        self.storage.symbol.read()
    }

    #[external("public")]
    #[view]
    fn public_get_decimals() -> pub u8 {
        self.storage.decimals.read()
    }

    #[external("private")]
    #[view]
    fn private_get_decimals() -> pub u8 {
        self.storage.decimals.read()
    }

    #[external("public")]
    #[view]
    fn get_admin() -> Field {
        self.storage.admin.read().to_field()
    }

    #[external("public")]
    #[view]
    fn is_minter(minter: AztecAddress) -> bool {
        self.storage.minters.at(minter).read()
    }

    #[external("public")]
    #[view]
    fn total_supply() -> u128 {
        self.storage.total_supply.read()
    }

    #[external("public")]
    #[view]
    fn balance_of_public(owner: AztecAddress) -> u128 {
        self.storage.public_balances.at(owner).read()
    }

    #[external("public")]
    fn set_minter(minter: AztecAddress, approve: bool) {
        assert(self.storage.admin.read().eq(self.msg_sender().unwrap()), "caller is not admin");
        self.storage.minters.at(minter).write(approve);
    }

    // -- Public functions --

    #[external("public")]
    fn mint_to_public(to: AztecAddress, amount: u128) {
        assert(self.storage.minters.at(self.msg_sender().unwrap()).read(), "caller is not minter");
        let new_balance = self.storage.public_balances.at(to).read().add(amount);
        let supply = self.storage.total_supply.read().add(amount);
        self.storage.public_balances.at(to).write(new_balance);
        self.storage.total_supply.write(supply);
    }

    #[authorize_once("from", "authwit_nonce")]
    #[external("public")]
    fn transfer_in_public(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        authwit_nonce: Field,
    ) {
        let from_balance = self.storage.public_balances.at(from).read().sub(amount);
        self.storage.public_balances.at(from).write(from_balance);
        let to_balance = self.storage.public_balances.at(to).read().add(amount);
        self.storage.public_balances.at(to).write(to_balance);
    }

    #[authorize_once("from", "authwit_nonce")]
    #[external("public")]
    fn burn_public(from: AztecAddress, amount: u128, authwit_nonce: Field) {
        let from_balance = self.storage.public_balances.at(from).read().sub(amount);
        self.storage.public_balances.at(from).write(from_balance);
        let new_supply = self.storage.total_supply.read().sub(amount);
        self.storage.total_supply.write(new_supply);
    }

    // -- Private functions --

    #[authorize_once("from", "authwit_nonce")]
    #[external("private")]
    fn transfer_to_public(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        authwit_nonce: Field,
    ) {
        self.storage.balances.at(from).sub(amount).deliver(MessageDelivery.CONSTRAINED_ONCHAIN);
        self.enqueue_self._increase_public_balance(to, amount);
    }

    #[authorize_once("from", "authwit_nonce")]
    #[external("private")]
    fn transfer_to_public_and_prepare_private_balance_increase(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        authwit_nonce: Field,
    ) -> PartialUintNote {
        self.storage.balances.at(from).sub(amount).deliver(MessageDelivery.CONSTRAINED_ONCHAIN);
        self.enqueue_self._increase_public_balance(to, amount);
        self.internal._prepare_private_balance_increase(from)
    }

    #[external("private")]
    fn transfer(to: AztecAddress, amount: u128) {
        let from = self.msg_sender().unwrap();

        let change = self.internal.subtract_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);
        self.storage.balances.at(from).add(change).deliver(MessageDelivery.UNCONSTRAINED_ONCHAIN);
        self.storage.balances.at(to).add(amount).deliver(MessageDelivery.UNCONSTRAINED_ONCHAIN);

        let this = self.address;

        // Emit Send event to the sender
        self.emit(Send { token: this, to, amount }).deliver_to(
            from,
            MessageDelivery.UNCONSTRAINED_ONCHAIN,
        );

        // Emit Receive event to the recipient
        self.emit(Receive { token: this, from, amount }).deliver_to(
            to,
            MessageDelivery.UNCONSTRAINED_ONCHAIN,
        );
    }

    #[internal("private")]
    fn subtract_balance(account: AztecAddress, amount: u128, max_notes: u32) -> u128 {
        let subtracted = self.storage.balances.at(account).try_sub(amount, max_notes);
        assert(subtracted > 0 as u128, "Balance too low");
        if subtracted >= amount {
            subtracted - amount
        } else {
            let remaining = amount - subtracted;
            compute_recurse_subtract_balance_call(*context, account, remaining).call(context)
        }
    }

    #[no_predicates]
    #[contract_library_method]
    fn compute_recurse_subtract_balance_call(
        context: PrivateContext,
        account: AztecAddress,
        remaining: u128,
    ) -> PrivateCall<25, 2, u128> {
        Token::at(context.this_address())._recurse_subtract_balance(account, remaining)
    }

    #[only_self]
    #[external("private")]
    fn _recurse_subtract_balance(account: AztecAddress, amount: u128) -> u128 {
        self.internal.subtract_balance(account, amount, RECURSIVE_TRANSFER_CALL_MAX_NOTES)
    }

    #[external("private")]
    fn cancel_authwit(inner_hash: Field) {
        let on_behalf_of = self.msg_sender().unwrap();
        let nullifier = compute_authwit_nullifier(on_behalf_of, inner_hash);
        self.context.push_nullifier(nullifier);
    }

    #[authorize_once("from", "authwit_nonce")]
    #[external("private")]
    fn transfer_in_private(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        authwit_nonce: Field,
    ) {
        self.storage.balances.at(from).sub(amount).deliver(MessageDelivery.CONSTRAINED_ONCHAIN);
        self.storage.balances.at(to).add(amount).deliver(MessageDelivery.CONSTRAINED_ONCHAIN);

        let this = self.address;

        // Emit Send event to the sender
        self.emit(Send { token: this, to, amount }).deliver_to(
            from,
            MessageDelivery.UNCONSTRAINED_ONCHAIN,
        );

        // Emit Receive event to the recipient
        self.emit(Receive { token: this, from, amount }).deliver_to(
            to,
            MessageDelivery.UNCONSTRAINED_ONCHAIN,
        );
    }

    #[authorize_once("from", "authwit_nonce")]
    #[external("private")]
    fn burn_private(from: AztecAddress, amount: u128, authwit_nonce: Field) {
        self.storage.balances.at(from).sub(amount).deliver(MessageDelivery.CONSTRAINED_ONCHAIN);
        self.enqueue_self._reduce_total_supply(amount);

        let this = self.address;

        // Emit Send event to the burner (burn = send to nowhere)
        self.emit(Send { token: this, to: AztecAddress::zero(), amount }).deliver_to(
            from,
            MessageDelivery.UNCONSTRAINED_ONCHAIN,
        );
    }

    // -- Transfer to private --

    #[external("private")]
    fn transfer_to_private(to: AztecAddress, amount: u128) {
        let from = self.msg_sender().unwrap();
        let partial_note = self.internal._prepare_private_balance_increase(to);
        self.enqueue_self._finalize_transfer_to_private_unsafe(from, amount, partial_note);
    }

    #[external("private")]
    fn prepare_private_balance_increase(to: AztecAddress) -> PartialUintNote {
        self.internal._prepare_private_balance_increase(to)
    }

    #[internal("private")]
    fn _prepare_private_balance_increase(to: AztecAddress) -> PartialUintNote {
        let partial_note = UintNote::partial(
            to,
            self.storage.balances.get_storage_slot(),
            self.context,
            to,
            self.msg_sender().unwrap(),
        );

        partial_note
    }

    #[external("public")]
    fn finalize_transfer_to_private(amount: u128, partial_note: PartialUintNote) {
        let from_and_completer = self.msg_sender().unwrap();
        self.internal._finalize_transfer_to_private(from_and_completer, amount, partial_note);
    }

    #[authorize_once("from", "authwit_nonce")]
    #[external("private")]
    fn finalize_transfer_to_private_from_private(
        from: AztecAddress,
        partial_note: PartialUintNote,
        amount: u128,
        authwit_nonce: Field,
    ) {
        self.storage.balances.at(from).sub(amount).deliver(MessageDelivery.CONSTRAINED_ONCHAIN);
        partial_note.complete_from_private(self.context, self.msg_sender().unwrap(), amount);
    }

    #[external("public")]
    #[only_self]
    fn _finalize_transfer_to_private_unsafe(
        from_and_completer: AztecAddress,
        amount: u128,
        partial_note: PartialUintNote,
    ) {
        self.internal._finalize_transfer_to_private(from_and_completer, amount, partial_note);
    }

    #[internal("public")]
    fn _finalize_transfer_to_private(
        from_and_completer: AztecAddress,
        amount: u128,
        partial_note: PartialUintNote,
    ) {
        let balance_storage = self.storage.public_balances.at(from_and_completer);
        let from_balance = balance_storage.read().sub(amount);
        balance_storage.write(from_balance);
        partial_note.complete(self.context, from_and_completer, amount);
    }

    // -- Mint to private --

    #[external("private")]
    fn mint_to_private(to: AztecAddress, amount: u128) {
        let partial_note = self.internal._prepare_private_balance_increase(to);
        self.enqueue_self._finalize_mint_to_private_unsafe(
            self.msg_sender().unwrap(),
            amount,
            partial_note,
        );

        let this = self.address;

        // Emit Receive event to the mint recipient
        self.emit(Receive { token: this, from: AztecAddress::zero(), amount }).deliver_to(
            to,
            MessageDelivery.UNCONSTRAINED_ONCHAIN,
        );
    }

    #[external("public")]
    fn finalize_mint_to_private(amount: u128, partial_note: PartialUintNote) {
        let minter_and_completer = self.msg_sender().unwrap();
        assert(self.storage.minters.at(minter_and_completer).read(), "caller is not minter");
        self.internal._finalize_mint_to_private(minter_and_completer, amount, partial_note);
    }

    #[external("public")]
    #[only_self]
    fn _finalize_mint_to_private_unsafe(
        minter_and_completer: AztecAddress,
        amount: u128,
        partial_note: PartialUintNote,
    ) {
        assert(self.storage.minters.at(minter_and_completer).read(), "caller is not minter");
        self.internal._finalize_mint_to_private(minter_and_completer, amount, partial_note);
    }

    #[internal("public")]
    fn _finalize_mint_to_private(
        completer: AztecAddress,
        amount: u128,
        partial_note: PartialUintNote,
    ) {
        let supply = self.storage.total_supply.read().add(amount);
        self.storage.total_supply.write(supply);
        partial_note.complete(self.context, completer, amount);
    }

    // -- Internal public helpers --

    #[external("public")]
    #[only_self]
    fn _increase_public_balance(to: AztecAddress, amount: u128) {
        let to_balance = self.storage.public_balances.at(to);
        let new_balance = to_balance.read().add(amount);
        to_balance.write(new_balance);
    }

    #[external("public")]
    #[only_self]
    fn _reduce_total_supply(amount: u128) {
        let new_supply = self.storage.total_supply.read().sub(amount);
        self.storage.total_supply.write(new_supply);
    }

    // -- Utility --

    #[external("utility")]
    unconstrained fn balance_of_private(owner: AztecAddress) -> u128 {
        self.storage.balances.at(owner).balance_of()
    }
}
