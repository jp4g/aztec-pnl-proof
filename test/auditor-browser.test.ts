import { describe, test } from 'node:test';
import { expect } from 'expect';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { ExtendedDirectionalAppTaggingSecret, SiloedTag } from '@aztec/stdlib/logs';
import { Fr } from '@aztec/foundation/curves/bn254';
import { retrieveEncryptedEvents } from '@privpnl/proof/auditor/browser';

describe('browser auditor', () => {
    test('uses v4 siloed log tag derivation', async () => {
        const app = AztecAddress.fromBigInt(123n);
        const extendedSecret = new ExtendedDirectionalAppTaggingSecret(new Fr(456n), app);
        const expectedTags = await Promise.all(
            [0, 1].map(index => SiloedTag.compute({ extendedSecret, index })),
        );
        const requests: unknown[] = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (_url: any, init?: any) => {
            const body = JSON.parse(init?.body as string);
            requests.push(body);
            return new Response(JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: [[], []],
            }));
        };

        try {
            await retrieveEncryptedEvents(
                'http://node.example',
                'http://history.example',
                [{
                    secret: extendedSecret.toString(),
                    direction: 'inbound',
                    counterparty: AztecAddress.fromBigInt(789n).toString(),
                }],
                { startIndex: 0, maxIndices: 2, batchSize: 2 },
            );
        } finally {
            globalThis.fetch = originalFetch;
        }

        expect(requests).toHaveLength(1);
        expect((requests[0] as any).method).toBe('node_getPrivateLogsByTags');
        expect((requests[0] as any).params[0]).toEqual(expectedTags.map(tag => tag.toString()));
    });

    test('sorts events without dropping repeated transaction hashes', async () => {
        const app = AztecAddress.fromBigInt(123n);
        const extendedSecret = new ExtendedDirectionalAppTaggingSecret(new Fr(456n), app);
        const field = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
        const logData = Array.from({ length: 16 }, (_, i) => field(i + 1));
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (_url: any, init?: any) => {
            const body = JSON.parse(init?.body as string);
            if (body.method === 'node_getBlockHeader') {
                return new Response(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: { state: { partial: { publicDataTree: { root: field(body.params[0]) } } } },
                }));
            }
            return new Response(JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: [
                    [{ txHash: '0xabc', blockNumber: 2, logData }],
                    [{ txHash: '0xabc', blockNumber: 1, logData }],
                ],
            }));
        };

        let result;
        try {
            result = await retrieveEncryptedEvents(
                'http://node.example',
                'http://history.example',
                [{
                    secret: extendedSecret.toString(),
                    direction: 'inbound',
                    counterparty: AztecAddress.fromBigInt(789n).toString(),
                }],
                { startIndex: 0, maxIndices: 2, batchSize: 2 },
            );
        } finally {
            globalThis.fetch = originalFetch;
        }

        expect(result.totalEvents).toBe(2);
        expect(result.events.map(event => event.blockNumber)).toEqual(['1', '2']);
        expect(result.events.map(event => event.txHash)).toEqual(['0xabc', '0xabc']);
    });

    test('rejects same-block events because private logs have no sequencer order', async () => {
        const app = AztecAddress.fromBigInt(123n);
        const extendedSecret = new ExtendedDirectionalAppTaggingSecret(new Fr(456n), app);
        const field = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
        const logData = Array.from({ length: 16 }, (_, i) => field(i + 1));
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (_url: any, init?: any) => {
            const body = JSON.parse(init?.body as string);
            if (body.method === 'node_getBlockHeader') {
                return new Response(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: { state: { partial: { publicDataTree: { root: field(body.params[0]) } } } },
                }));
            }
            return new Response(JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: [
                    [{ txHash: '0xabc', blockNumber: 1, logData }],
                    [{ txHash: '0xdef', blockNumber: 1, logData }],
                ],
            }));
        };

        try {
            await expect(retrieveEncryptedEvents(
                'http://node.example',
                'http://history.example',
                [{
                    secret: extendedSecret.toString(),
                    direction: 'inbound',
                    counterparty: AztecAddress.fromBigInt(789n).toString(),
                }],
                { startIndex: 0, maxIndices: 2, batchSize: 2 },
            )).rejects.toThrow(/Cannot prove 2 swap events from block 1/);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
