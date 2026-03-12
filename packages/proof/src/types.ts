/**
 * A FIFO cost basis lot: amount of tracked token acquired at a given oracle price.
 */
export interface Lot {
    amount: bigint;
    costPerUnit: bigint;
}
