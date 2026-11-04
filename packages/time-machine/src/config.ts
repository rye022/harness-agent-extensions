/**
 * Plugin configuration for `@harness-ext/time-machine`.
 *
 * The config object arrives from the Cordis patch layer (`cordis.patch.yml`
 * `config:` block, merged by the loader) and is therefore plain JSON. Every
 * field is optional; `normalizeConfig` clamps numbers into a sane range and
 * reports what it changed instead of throwing, so a typo degrades one feature
 * rather than keeping the plugin from mounting.
 *
 * @module @harness-ext/time-machine/config
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where a checkpoint's images and journal live. */
export interface TimeMachineConfig {
  /** Master switch; `false` leaves no hooks and no tools registered. */
  enabled: boolean;
  /** Data root. `undefined` means `<DSH_HOME>/time-machine`. */
  root?: string;
  /** Files larger than this are recorded as `oversized` (hash only, no image). */
  maxFileBytes: number;
  /** Upper bound on files a single workspace snapshot may capture. */
  maxFiles: number;
  /** Extra path patterns to ignore, on top of the built-in secrets/VCS list. */
  ignoreExtra: string[];
  /** Which mutation sources are captured. */
  capture: {
    /** Capture before `fs/write-intent` (the `write` tool). */
    writeIntent: boolean;
    /** Capture before `fs/edit-intent` (the `edit` tool). */
    editIntent: boolean;
    /**
     * Hash the whole workspace at `turn/start` so a checkpoint can also undo
     * shell (`pwsh`) edits made during the turn. Off by default: it costs one
     * full scan per turn.
     */
    workspaceSnapshotOnTurnStart: boolean;
  };
  /** Journal maintenance. */
  keep: {
    /** Compact the journal once it holds more than this many records. */
    maxCheckpoints: number;
  };
  /** Model-facing tools. */
  tools: {
    /** Register the `tm_*` tools at all. */
    enabled: boolean;
    /** Tool names to skip, e.g. `['tm_checkpoint']`. */
    disabled: string[];
    /** Diff output is cut off beyond this many characters. */
    maxDiffChars: number;
    /** List output is cut off beyond this many records. */
    maxListItems: number;
  };
}

/** The defaults actually used when a field is absent. */
export const DEFAULT_CONFIG: TimeMachineConfig = {
  enabled: true,
  maxFileBytes: 2 * 1024 * 1024,
  maxFiles: 5000,
  ignoreExtra: [],
  capture: {
    writeIntent: true,
    editIntent: true,
    workspaceSnapshotOnTurnStart: false,
  },
  keep: {
    maxCheckpoints: 2000,
  },
  tools: {
    enabled: true,
    disabled: [],
    maxDiffChars: 20000,
    maxListItems: 50,
  },
};

/** A field that normalization had to correct. */
export interface ConfigIssue {
  field: string;
  message: string;
}

/** `normalizeConfig` output. */
export interface NormalizedConfig {
  config: TimeMachineConfig;
  issues: ConfigIssue[];
}

/** The DSH data directory, matching every other DSH plugin. */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['DSH_HOME'];
  if (configured !== undefined && configured.trim() !== '') return configured;
  return join(homedir(), '.dsh');
}

/** Default checkpoint root. */
export function defaultRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), 'time-machine');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function bool(value: unknown, fallback: boolean, field: string, issues: ConfigIssue[]): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  issues.push({ field, message: `expected a boolean, got ${typeof value}; using ${String(fallback)}` });
  return fallback;
}

function int(value: unknown, fallback: number, min: number, max: number, field: string, issues: ConfigIssue[]): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ field, message: `expected a number, got ${typeof value}; using ${String(fallback)}` });
    return fallback;
  }
  const rounded = Math.trunc(value);
  if (rounded < min || rounded > max) {
    const clamped = Math.min(max, Math.max(min, rounded));
    issues.push({ field, message: `${String(value)} is outside [${String(min)}, ${String(max)}]; using ${String(clamped)}` });
    return clamped;
  }
  return rounded;
}

function stringList(value: unknown, field: string, issues: ConfigIssue[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push({ field, message: `expected an array of strings, got ${typeof value}` });
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item.trim());
    else issues.push({ field, message: 'ignored a non-string entry' });
  }
  return out;
}

/** Validate and clamp a raw patch-layer config object. */
export function normalizeConfig(raw: unknown): NormalizedConfig {
  const issues: ConfigIssue[] = [];
  const input = asRecord(raw) ?? {};
  if (raw !== undefined && asRecord(raw) === undefined) {
    issues.push({ field: '<root>', message: `expected an object, got ${typeof raw}${Array.isArray(raw) ? ' (array)' : ''}` });
  }

  const capture = asRecord(input['capture']) ?? {};
  const keep = asRecord(input['keep']) ?? {};
  const tools = asRecord(input['tools']) ?? {};

  const rootRaw = input['root'];
  let root: string | undefined;
  if (typeof rootRaw === 'string' && rootRaw.trim() !== '') root = rootRaw.trim();
  else if (rootRaw !== undefined) issues.push({ field: 'root', message: 'expected a non-empty string; using the default root' });

  const config: TimeMachineConfig = {
    enabled: bool(input['enabled'], DEFAULT_CONFIG.enabled, 'enabled', issues),
    ...(root === undefined ? {} : { root }),
    maxFileBytes: int(input['maxFileBytes'], DEFAULT_CONFIG.maxFileBytes, 1024, 512 * 1024 * 1024, 'maxFileBytes', issues),
    maxFiles: int(input['maxFiles'], DEFAULT_CONFIG.maxFiles, 1, 200000, 'maxFiles', issues),
    ignoreExtra: stringList(input['ignoreExtra'], 'ignoreExtra', issues),
    capture: {
      writeIntent: bool(capture['writeIntent'], DEFAULT_CONFIG.capture.writeIntent, 'capture.writeIntent', issues),
      editIntent: bool(capture['editIntent'], DEFAULT_CONFIG.capture.editIntent, 'capture.editIntent', issues),
      workspaceSnapshotOnTurnStart: bool(
        capture['workspaceSnapshotOnTurnStart'],
        DEFAULT_CONFIG.capture.workspaceSnapshotOnTurnStart,
        'capture.workspaceSnapshotOnTurnStart',
        issues,
      ),
    },
    keep: {
      maxCheckpoints: int(keep['maxCheckpoints'], DEFAULT_CONFIG.keep.maxCheckpoints, 10, 1000000, 'keep.maxCheckpoints', issues),
    },
    tools: {
      enabled: bool(tools['enabled'], DEFAULT_CONFIG.tools.enabled, 'tools.enabled', issues),
      disabled: stringList(tools['disabled'], 'tools.disabled', issues),
      maxDiffChars: int(tools['maxDiffChars'], DEFAULT_CONFIG.tools.maxDiffChars, 200, 2000000, 'tools.maxDiffChars', issues),
      maxListItems: int(tools['maxListItems'], DEFAULT_CONFIG.tools.maxListItems, 1, 10000, 'tools.maxListItems', issues),
    },
  };

  return { config, issues };
}
