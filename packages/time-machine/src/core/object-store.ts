/**
 * Content-addressed object store.
 *
 * Every file image a checkpoint keeps is stored once, under the SHA-256 of its
 * bytes, in a two-level fan-out directory. Identical content is therefore free
 * to reference repeatedly, and a restore can verify that what it is about to
 * write back is exactly what was captured.
 *
 * Layout:
 *
 * ```
 * <root>/objects/ab/abcdef...        stored content (raw bytes)
 * <root>/tmp/                        staging files, renamed into place
 * ```
 *
 * @module @harness-ext/time-machine/object-store
 */
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import type { ContentHash } from '@harness-ext/shared';

/** Result of storing one image. */
export interface StoredObject {
  hash: ContentHash;
  size: number;
  /** False when the content was already present (deduplicated). */
  stored: boolean;
}

/** A content-addressed store rooted at a directory. */
export class ObjectStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(this.objectsDir(), { recursive: true });
    mkdirSync(this.tempDir(), { recursive: true });
  }

  /** Directory holding all content objects. */
  objectsDir(): string {
    return join(this.root, 'objects');
  }

  /** Staging directory for atomic writes. */
  tempDir(): string {
    return join(this.root, 'tmp');
  }

  /** Absolute path of one object. */
  objectPath(hash: ContentHash): string {
    return join(this.objectsDir(), hash.slice(0, 2), hash.slice(2));
  }

  /** Whether an object exists. */
  has(hash: ContentHash): boolean {
    return existsSync(this.objectPath(hash));
  }

  /** Size of a stored object, or undefined when it is missing. */
  size(hash: ContentHash): number | undefined {
    try {
      return statSync(this.objectPath(hash)).size;
    } catch {
      return undefined;
    }
  }

  /** Store bytes from memory. */
  putBuffer(content: Uint8Array): StoredObject {
    const hash = createHash('sha256').update(content).digest('hex');
    const target = this.objectPath(hash);
    if (existsSync(target)) return { hash, size: content.byteLength, stored: false };
    mkdirSync(dirname(target), { recursive: true });
    mkdirSync(this.tempDir(), { recursive: true });
    const temp = join(this.tempDir(), `${hash}.${process.pid}.${Date.now()}.part`);
    // Synchronous write keeps the rename atomic: the temp file is complete
    // before it becomes visible under its content hash.
    writeFileSync(temp, content);
    renameSync(temp, target);
    return { hash, size: content.byteLength, stored: true };
  }

  /** Stream a file into the store without holding it in memory. */
  async putFile(source: string): Promise<StoredObject> {
    const hash = await hashFile(source);
    const target = this.objectPath(hash);
    if (existsSync(target)) {
      return { hash, size: statSync(source).size, stored: false };
    }
    mkdirSync(dirname(target), { recursive: true });
    const temp = join(this.tempDir(), `${hash}.${process.pid}.${Date.now()}.part`);
    await pipeline(createReadStream(source), createWriteStream(temp));
    renameSync(temp, target);
    return { hash, size: statSync(target).size, stored: true };
  }

  /** Read an object fully. */
  read(hash: ContentHash): Buffer | undefined {
    const file = this.objectPath(hash);
    if (!existsSync(file)) return undefined;
    return readFileSync(file);
  }

  /** Read an object as UTF-8 text. */
  readText(hash: ContentHash): string | undefined {
    const buffer = this.read(hash);
    return buffer === undefined ? undefined : buffer.toString('utf8');
  }

  /** Remove an object (used by garbage collection and by corruption repair). */
  remove(hash: ContentHash): boolean {
    const target = this.objectPath(hash);
    if (!existsSync(target)) return false;
    rmSync(target, { force: true });
    return true;
  }

  /**
   * Re-hash every object and report what is missing or corrupt.
   *
   * Corruption here means "the bytes no longer hash to the name", which is the
   * only failure mode a checkpoint could otherwise report as success.
   */
  async verify(hashes?: readonly ContentHash[]): Promise<{ ok: ContentHash[]; missing: ContentHash[]; corrupt: ContentHash[] }> {
    const ok: ContentHash[] = [];
    const missing: ContentHash[] = [];
    const corrupt: ContentHash[] = [];
    const candidates = hashes ?? (await this.listObjects());
    for (const hash of candidates) {
      const file = this.objectPath(hash);
      if (!existsSync(file)) {
        missing.push(hash);
        continue;
      }
      const actual = await hashFile(file);
      if (actual === hash) ok.push(hash);
      else corrupt.push(hash);
    }
    return { ok, missing, corrupt };
  }

  /** List every stored object hash. */
  async listObjects(): Promise<ContentHash[]> {
    const { readdir } = await import('node:fs/promises');
    const out: ContentHash[] = [];
    let prefixes: string[];
    try {
      prefixes = await readdir(this.objectsDir());
    } catch {
      return out;
    }
    for (const prefix of prefixes) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      const entries = await readdir(join(this.objectsDir(), prefix)).catch(() => []);
      for (const entry of entries) {
        if (/^[0-9a-f]{62}$/.test(entry)) out.push(prefix + entry);
      }
    }
    return out;
  }

  /** Delete every object not referenced by the given set. */
  async collectGarbage(referenced: ReadonlySet<ContentHash>): Promise<{ removed: number; bytes: number }> {
    let removed = 0;
    let bytes = 0;
    for (const hash of await this.listObjects()) {
      if (referenced.has(hash)) continue;
      const size = this.size(hash) ?? 0;
      if (this.remove(hash)) {
        removed += 1;
        bytes += size;
      }
    }
    return { removed, bytes };
  }

  /** Total bytes held by the store. */
  async totalBytes(): Promise<number> {
    let total = 0;
    for (const hash of await this.listObjects()) total += this.size(hash) ?? 0;
    return total;
  }
}

async function hashFile(path: string): Promise<ContentHash> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
      yield chunk;
    }
  });
  return hash.digest('hex');
}

/** Small indirection so `read` stays synchronous without importing fs at top twice. */
function require_read(path: string): Buffer {
  const fs = require('node:fs') as typeof import('node:fs');
  return fs.readFileSync(path);
}
