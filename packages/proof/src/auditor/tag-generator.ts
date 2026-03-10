import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import { Fr } from '@aztec/foundation/curves/bn254';
import type { DirectionalAppTaggingSecret } from '@aztec/stdlib/logs';

/**
 * Utility class for generating tags from tagging secrets.
 *
 * Tags are used to query the Aztec node for logs that match a specific
 * tagging secret. Each tag is derived from the secret and an index using
 * a poseidon2 hash.
 */
export class TagGenerator {
  static async generateTags(secret: DirectionalAppTaggingSecret, startIndex: number, count: number): Promise<Fr[]> {
    const tags: Fr[] = [];
    for (let i = 0; i < count; i++) {
      const tag = await this.generateSingleTag(secret, startIndex + i);
      tags.push(tag);
    }
    return tags;
  }

  static async generateSingleTag(secret: DirectionalAppTaggingSecret, index: number): Promise<Fr> {
    return await poseidon2Hash([secret.value, new Fr(index)]);
  }

  static async *generateTagBatches(
    secret: DirectionalAppTaggingSecret,
    startIndex: number,
    maxIndex: number,
    batchSize: number,
  ): AsyncGenerator<{ tags: Fr[]; startIndex: number; endIndex: number }> {
    let currentIndex = startIndex;

    while (currentIndex < maxIndex) {
      const remaining = maxIndex - currentIndex;
      const count = Math.min(batchSize, remaining);
      const tags = await this.generateTags(secret, currentIndex, count);

      yield {
        tags,
        startIndex: currentIndex,
        endIndex: currentIndex + count,
      };

      currentIndex += count;
    }
  }
}
