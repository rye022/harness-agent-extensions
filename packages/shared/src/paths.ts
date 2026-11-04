/**
 * Path normalisation and containment checks.
 *
 * Checkpoint manifests are portable: they key files by a POSIX-style path that
 * is either relative to the workspace root or absolute. Every comparison runs
 * through these helpers so a Windows backslash path and the same path written
 * by a POSIX tooling layer still match.
 *
 * @module @harness-ext/shared/paths
 */
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Convert a native path to the POSIX-style form stored in manifests. */
export function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

/** Normalise a path for comparison: POSIX separators, case-folded on Windows. */
export function pathKey(path: string): string {
  const posix = toPosixPath(path).replace(/\/+/g, '/');
  return process.platform === 'win32' ? posix.toLowerCase() : posix;
}

/** Whether `child` is `parent` itself or lives underneath it. */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/** Render a manifest path for humans: workspace-relative when possible, `~` under home, absolute otherwise. */
export function displayPath(absolutePath: string, workspaceRoot?: string, home: string = homedir()): string {
  if (workspaceRoot !== undefined && isWithin(workspaceRoot, absolutePath)) {
    const rel = toPosixPath(relative(resolve(workspaceRoot), resolve(absolutePath)));
    return rel === '' ? '.' : rel;
  }
  if (isWithin(home, absolutePath)) {
    const rel = toPosixPath(relative(home, absolutePath));
    return rel === '' ? '~' : `~/${rel}`;
  }
  return toPosixPath(absolutePath);
}

/**
 * Resolve a manifest path against a workspace root.
 *
 * Manifest paths are POSIX strings; `.` segments are collapsed so `a/./b` and
 * `a/b` address the same object.
 */
export function resolveManifestPath(path: string, workspaceRoot: string): string {
  const normalized = toPosixPath(path);
  if (isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized)) {
    return resolve(normalized);
  }
  const joined = resolve(workspaceRoot, normalized.replaceAll('/', sep));
  return joined;
}

/** Join a POSIX-style relative path onto a root, keeping the result native. */
export function joinPosix(root: string, rel: string): string {
  return resolve(root, rel.replaceAll('/', sep));
}
