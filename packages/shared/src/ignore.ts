/**
 * Files that a checkpoint must never capture by default.
 *
 * The default policy is deliberately conservative: version-control internals,
 * dependency trees, virtual environments, package-manager caches, editor and
 * build caches, and anything that looks like a secret. Callers can extend the
 * list or allow specific paths, but they cannot accidentally widen it while
 * constructing a checkpoint from a tool call.
 *
 * @module @harness-ext/shared/ignore
 */
import { toPosixPath } from './paths.ts';

/** Directory names (matched at any depth) that are never captured. */
export const DEFAULT_IGNORED_DIRECTORIES: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.pnpm-store',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.gradle',
  '.idea',
  '.vscode',
  'target/debug',
  'target/release',
];

/** File globs (matched against the POSIX relative path) that are never captured. */
export const DEFAULT_IGNORED_FILES: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa',
  'id_rsa.*',
  'id_ed25519',
  'id_ed25519.*',
  '.npmrc',
  '.netrc',
  '.pgpass',
  '*.keystore',
  '*.jks',
  'credentials',
  'credentials.json',
];

/** Options shared by every ignore decision. */
export interface IgnorePolicyOptions {
  /** Extra directory names to skip, matched at any depth. */
  ignoredDirectories?: readonly string[];
  /** Extra globs to skip, matched against the POSIX relative path and the basename. */
  ignoredFiles?: readonly string[];
  /** Globs that override the ignore lists (for example `!.env` style exceptions). */
  allowedFiles?: readonly string[];
  /** Files larger than this are listed but their content is not stored. */
  maxFileBytes?: number;
}

/** The resolved policy a checkpoint store answers questions with. */
export interface IgnoreDecision {
  ignored: boolean;
  /** Why it was ignored, for user-facing explanations. */
  reason?: 'directory' | 'file-pattern' | 'size' | 'binary';
}

/** Default per-file capture ceiling: 2 MiB, matching the harness change tracker. */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Compile a glob into a regular expression.
 *
 * Supported syntax: `**` (any depth, including no separator), `*` (within one
 * segment), `?` (one non-separator character), and plain characters. `!` at the
 * start is handled by the caller, not here.
 */
export function globToRegExp(glob: string): RegExp {
  const posix = toPosixPath(glob);
  let source = '^';
  for (let index = 0; index < posix.length; index += 1) {
    const char = posix[index]!;
    if (char === '*') {
      const next = posix[index + 1];
      if (next === '*') {
        const after = posix[index + 2];
        if (after === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    if ('\\^$.|+()[]{}'.includes(char)) {
      source += `\\${char}`;
      continue;
    }
    source += char;
  }
  source += '$';
  return new RegExp(source, process.platform === 'win32' ? 'i' : '');
}

/** Whether a POSIX relative path matches any of the globs. */
export function matchesAny(relPath: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return false;
  const posix = toPosixPath(relPath);
  const base = posix.slice(posix.lastIndexOf('/') + 1);
  for (const glob of globs) {
    const regexp = globToRegExp(glob);
    if (regexp.test(posix) || regexp.test(base)) return true;
  }
  return false;
}

/** Whether any path segment is one of the ignored directory names. */
export function hasIgnoredSegment(relPath: string, directories: readonly string[]): boolean {
  if (directories.length === 0) return false;
  const segments = toPosixPath(relPath).split('/');
  // The last segment is the file itself; only ancestors count as directories.
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    if (directories.includes(segment)) return true;
  }
  // A path that itself names an ignored directory (rare, but possible when a
  // caller hands us a directory path) still counts.
  const last = segments[segments.length - 1]!;
  return segments.length === 1 && directories.includes(last);
}

/** A resolved ignore policy that answers per-path questions. */
export class IgnorePolicy {
  readonly maxFileBytes: number;
  private readonly directories: readonly string[];
  private readonly files: readonly string[];
  private readonly allowed: readonly string[];

  constructor(options: IgnorePolicyOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.directories = [...DEFAULT_IGNORED_DIRECTORIES, ...(options.ignoredDirectories ?? [])];
    this.files = [...DEFAULT_IGNORED_FILES, ...(options.ignoredFiles ?? [])];
    this.allowed = options.allowedFiles ?? [];
  }

  /** Decide whether a workspace-relative path may be captured. */
  check(relPath: string, sizeBytes?: number): IgnoreDecision {
    const posix = toPosixPath(relPath);
    if (matchesAny(posix, this.allowed)) return { ignored: false };
    if (hasIgnoredSegment(posix, this.directories)) return { ignored: true, reason: 'directory' };
    if (matchesAny(posix, this.files)) return { ignored: true, reason: 'file-pattern' };
    if (sizeBytes !== undefined && sizeBytes > this.maxFileBytes) return { ignored: true, reason: 'size' };
    return { ignored: false };
  }
}

/** Whether a byte sample looks binary (a NUL byte in the first 8 KiB). */
export function looksBinary(sample: Uint8Array): boolean {
  return sample.includes(0);
}
