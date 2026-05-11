export const precision = (n: bigint = 1n, decimals: bigint = 18n) =>
    n * 10n ** decimals;

/** Parse a potentially negative hex string like "-0x1a" into a BigInt */
export function parseSignedHex(s: string): bigint {
    if (s.startsWith('-0x') || s.startsWith('-0X')) {
        return -BigInt(s.slice(1));
    }
    return BigInt(s);
}

/** Convert proof bytes to field array (32 bytes per field) */
export function proofBytesToFields(proofBytes: Uint8Array): string[] {
    const fields: string[] = [];
    for (let i = 0; i < proofBytes.length; i += 32) {
        const chunk = proofBytes.slice(i, i + 32);
        const hex = '0x' + Buffer.from(chunk).toString('hex');
        fields.push(hex);
    }
    return fields;
}
