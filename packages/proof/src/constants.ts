/** Max concurrent lots per token (must match circuit MAX_LOTS) */
export const MAX_LOTS = 32;

/** Outer tree height (must match circuit LOT_TREE_HEIGHT) */
export const LOT_TREE_HEIGHT = 3;

/** Number of token slots = 2^LOT_TREE_HEIGHT */
export const NUM_SLOTS = 1 << LOT_TREE_HEIGHT;

/** Domain separator for siloing public leaf slots (v4: DOM_SEP__PUBLIC_LEAF_SLOT) */
export const DOM_SEP__PUBLIC_LEAF_SLOT = 1247650290;

/** Domain separator for map storage slot derivation (v4: DOM_SEP__PUBLIC_STORAGE_MAP_SLOT) */
export const DOM_SEP__PUBLIC_STORAGE_MAP_SLOT = 4015149901;

/** Size of the encrypted log tag prefix in bytes */
export const TAG_SIZE = 32;

/** Number of 32-byte ciphertext fields in an encrypted swap event */
export const MESSAGE_CIPHERTEXT_LEN = 15;

/** Oracle price precision: 1 USD = 10,000 units (4 decimals) */
export const PRICE_PRECISION = 10_000;

/** USDC decimal places */
export const USDC_DECIMALS = 6;

/** Non-USDC token decimal places */
export const TOKEN_DECIMALS = 9;
