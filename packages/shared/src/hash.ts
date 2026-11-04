/**
 * Content hashing used by both extensions.
 *
 * Everything that claims "this is the same bytes" in a checkpoint, a memory
 * record or a restored file goes through these helpers, so the hash format is
 * part of the on-disk contract: lowercase hex SHA-256, 64 characters.
 *
 * @module @harness-ext/shared/hash
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Lowercase hex SHA-256 of stored content. */
export type ContentHash = string;

const CONTENT_HASH = /^[0-9a-f]{64}$/;

/** Hash an in-memory string or byte buffer. */
export function sha256Hex(data: string | Uint8Array): ContentHash {
  return createHash('sha256').update(data).digest('hex');
}

/** Hash a file by streaming it, so large files never have to fit in memory. */
export async function sha256OfFile(path: string): Promise<ContentHash> {
  return await new Promise<ContentHash>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Whether a value is a well-formed content hash. */
export function isContentHash(value: unknown): value is ContentHash {
  return typeof value === 'string' && CONTENT_HASH.test(value);
}
