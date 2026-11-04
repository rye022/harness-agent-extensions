/**
 * Model-facing tools of `@harness-ext/time-machine`.
 *
 * Every tool routes through {@link TimeMachineRuntime} (defined in
 * `plugin.ts`), which owns the service, the workspace resolution and the
 * pre-restore safety rule. The tools are thin on purpose: their job is to give
 * the model a typed, safe way to use the same API a client panel uses.
 *
 * @module @harness-ext/time-machine/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from './content.ts';
import { diffTexts, formatHunks, splitLines } from '@harness-ext/shared';
import type { CheckpointRecord } from './core/types.ts';
import type { RestorePlan } from './core/restore.ts';

/** A plain text block, structurally compatible with the harness `ContentBlock`. */
function text(value: string): ContentBlock {
  return { type: 'text', text: value };
}

/** Render several text blocks from one multi-line string. */
function blocks(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }];
}

/** One checkpoint, flattened for a tool result. */
interface CheckpointSummary {
  id: string;
  createdAt: string;
  origin: string;
  label?: string;
  sessionId?: string;
  turn?: number;
  files: number;
  parentId?: string;
  error?: string;
}

/** Options the runner needs; implemented by the plugin. */
export interface TimeMachineRuntime {
  /** Whether capture is active. */
  readonly enabled: boolean;
  /** Build a manual checkpoint of the workspace (or a subset of paths). */
  checkpoint(options: { label?: string; paths?: string[]; sessionId?: string; cwd?: string }): Promise<CheckpointRecord>;
  /** All checkpoints, newest first. */
  list(options?: { limit?: number; origin?: string; sessionId?: string }): CheckpointRecord[];
  /** Read one record. */
  get(id: string): CheckpointRecord | undefined;
  /** Plan (and optionally apply) a restore. */
  restore(options: {
    id: string;
    side: 'before' | 'after';
    dryRun: boolean;
    force: boolean;
    sessionId?: string;
    cwd?: string;
  }): Promise<{
    plan: RestorePlan;
    applied?: { path: string; action: string; verified: boolean }[];
    failed?: { path: string; error: string }[];
    safetyCheckpoint?: string;
  }>;
  /** Summary statistics. */
  status(): { root: string; checkpoints: number; objects: number; referencedBytes: number; journalBytes: number };
  /** Unified diff of one checkpoint against the current workspace, or against another checkpoint. */
  diff(options: { id: string; against?: string; path?: string; side: 'before' | 'after' }): Promise<string>;
}

/** Format a record for `tm_list`. */
function summarize(record: CheckpointRecord): CheckpointSummary {
  return {
    id: record.id,
    createdAt: record.createdAt,
    origin: record.origin,
    ...(record.label === undefined ? {} : { label: record.label }),
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    ...(record.turn === undefined ? {} : { turn: record.turn }),
    files: record.files.length,
    ...(record.parentId === undefined ? {} : { parentId: record.parentId }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

/** Register every enabled `tm_*` tool; returns the disposers. */
export function registerTools(runtime: TimeMachineRuntime, options: {
  enabled: boolean;
  disabled: readonly string[];
  maxDiffChars: number;
  maxListItems: number;
  register(definition: ReturnType<typeof defineTool>): () => void;
  logger: { warn(message: string): void };
}): (() => void)[] {
  if (!options.enabled) return [];
  const disposers: (() => void)[] = [];
  const disabled = new Set(options.disabled);
  const add = (name: string, definition: ReturnType<typeof defineTool>): void => {
    if (disabled.has(name)) return;
    try {
      disposers.push(options.register(definition));
    } catch (error) {
      options.logger.warn(`time-machine: could not register ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  add(
    'tm_checkpoint',
    defineTool({
      name: 'tm_checkpoint',
      description:
        'Create a manual file checkpoint of the workspace before risky work. Checkpoints are content-addressed: unchanged files cost no extra space. Prefer this immediately before a multi-file refactor, a destructive command, or any change you may need to undo.',
      parameters: {
        label: { type: 'string', description: 'Short human label, e.g. "before refactoring the parser".' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional subset: absolute paths or workspace-relative paths. Default: the whole workspace.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Checkpoint id.', required: true },
            files: { type: 'integer', description: 'Files recorded.', required: true },
            bytes: { type: 'integer', description: 'Logical bytes covered by the checkpoint.', required: true },
            stored: { type: 'integer', description: 'Distinct content objects referenced.', required: true },
            error: { type: 'string', description: 'Set when part of the capture failed.' },
          },
        },
        render(_args, value) {
          const warning = value.error === undefined ? '' : `\nwarning: ${value.error}`;
          return blocks(`Checkpoint ${value.id} created: ${String(value.files)} files, ${String(value.stored)} objects.${warning}`);
        },
      },
      async execute(args) {
        const record = await runtime.checkpoint({
          ...(args.label === undefined ? {} : { label: args.label }),
          ...(args.paths === undefined ? {} : { paths: args.paths }),
        });
        return {
          id: record.id,
          files: record.files.length,
          bytes: record.stats?.bytes ?? 0,
          stored: record.stats?.stored ?? 0,
          ...(record.error === undefined ? {} : { error: record.error }),
        };
      },
    }),
  );

  add(
    'tm_list',
    defineTool({
      name: 'tm_list',
      description:
        'List file checkpoints, newest first. Use it to find the checkpoint to inspect or restore. `origin` filters by how the checkpoint was made: auto-turn (end of a turn), manual (tm_checkpoint), pre-restore (safety copy taken before a restore).',
      parameters: {
        limit: { type: 'integer', description: 'Maximum records to return (default 10).' },
        origin: {
          type: 'string',
          enum: ['auto-turn', 'manual', 'pre-restore'],
          description: 'Only checkpoints of this origin.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true },
            items: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  createdAt: { type: 'string', required: true },
                  origin: { type: 'string', required: true },
                  label: { type: 'string' },
                  sessionId: { type: 'string' },
                  turn: { type: 'integer' },
                  files: { type: 'integer', required: true },
                  parentId: { type: 'string' },
                  error: { type: 'string' },
                },
              },
            },
          },
        },
        render(_args, value) {
          if (value.items.length === 0) return blocks('No checkpoints yet.');
          const lines = value.items.map(
            (item) =>
              `${item.id}  ${item.createdAt}  ${item.origin}  ${String(item.files)} file(s)` +
              (item.label === undefined ? '' : `  "${item.label}"`) +
              (item.error === undefined ? '' : '  [incomplete]'),
          );
          return blocks(lines.join('\n'));
        },
      },
      async execute(args) {
        const limit = Math.min(args.limit ?? 10, options.maxListItems);
        const records = runtime.list({
          limit,
          ...(args.origin === undefined ? {} : { origin: args.origin }),
        });
        return { count: records.length, items: records.map(summarize) };
      },
    }),
  );

  add(
    'tm_diff',
    defineTool({
      name: 'tm_diff',
      description:
        'Show a unified diff for one checkpoint: by default the checkpoint\'s "before" state against the current files on disk. Pass `against` to diff two checkpoints against each other instead. Output is truncated at a safe length; the per-file summary is always complete.',
      parameters: {
        id: { type: 'string', description: 'Checkpoint id (see tm_list).', required: true },
        against: { type: 'string', description: 'Optional second checkpoint id to compare against.' },
        path: { type: 'string', description: 'Only this file (workspace-relative or absolute).' },
        side: {
          type: 'string',
          enum: ['before', 'after'],
          description: 'Which state of the checkpoint to use as the "old" side (default before).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', description: 'Unified diff (possibly truncated).', required: true },
            truncated: { type: 'boolean', required: true },
            files: { type: 'integer', description: 'Files with a difference.', required: true },
          },
        },
        render(_args, value) {
          return blocks(value.text === '' ? 'No differences.' : value.text);
        },
      },
      async execute(args) {
        const text = await runtime.diff({
          id: args.id,
          ...(args.against === undefined ? {} : { against: args.against }),
          ...(args.path === undefined ? {} : { path: args.path }),
          side: args.side ?? 'before',
        });
        const truncated = text.length > options.maxDiffChars;
        return {
          text: truncated ? `${text.slice(0, options.maxDiffChars)}\n… [truncated]` : text,
          truncated,
          files: countDiffs(text),
        };
      },
    }),
  );

  add(
    'tm_restore',
    defineTool({
      name: 'tm_restore',
      description:
        'Restore files from a checkpoint. A restore is planned first: files that changed since the checkpoint are reported as conflicts and block the restore unless `force` is set. A safety checkpoint of the current state is always written before anything is modified. Use `dry_run` to inspect the plan without touching the workspace.',
      parameters: {
        id: { type: 'string', description: 'Checkpoint id to restore from.', required: true },
        side: {
          type: 'string',
          enum: ['before', 'after'],
          description: 'Restore the state before the recorded change (default) or after it.',
        },
        dry_run: { type: 'boolean', description: 'Only report the plan; change nothing.' },
        force: { type: 'boolean', description: 'Apply even when conflicts exist (overwrites foreign edits).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dryRun: { type: 'boolean', required: true },
            safe: { type: 'boolean', description: 'True when nothing conflicts.', required: true },
            writes: { type: 'integer', required: true },
            deletes: { type: 'integer', required: true },
            unchanged: { type: 'integer', required: true },
            unverifiable: { type: 'integer', required: true },
            conflicts: { type: 'array', items: { type: 'string' }, description: 'Conflicting paths.', required: true },
            applied: { type: 'integer', description: 'Files actually written or deleted.', required: true },
            failed: { type: 'array', items: { type: 'string' }, description: 'Paths that failed, with the reason.', required: true },
            safetyCheckpoint: { type: 'string', description: 'Id of the pre-restore safety checkpoint.' },
            message: { type: 'string', required: true },
          },
        },
        render(_args, value) {
          return blocks(value.message);
        },
      },
      async execute(args) {
        const side = args.side ?? 'before';
        const dryRun = args.dry_run === true;
        const result = await runtime.restore({
          id: args.id,
          side,
          dryRun,
          force: args.force === true,
        });
        const plan = result.plan;
        const applied = result.applied ?? [];
        const lines: string[] = [];
        lines.push(
          `plan for ${plan.checkpointId} (${side}): ${String(plan.summary.writes)} write(s), ${String(plan.summary.deletes)} delete(s), ` +
            `${String(plan.summary.unchanged)} unchanged, ${String(plan.summary.unverifiable)} unverifiable; safe=${String(plan.safe)}`,
        );
        if (plan.conflicts.length > 0) {
          lines.push(`conflicts (${String(plan.conflicts.length)}): ${plan.conflicts.map((conflict) => conflict.path).slice(0, 20).join(', ')}`);
        }
        if (dryRun) lines.push('dry run: nothing was written.');
        else if (applied.length > 0 || (result.failed?.length ?? 0) > 0) {
          lines.push(`applied ${String(applied.length)} file(s); verified=${String(applied.every((entry) => entry.verified))}`);
          if ((result.failed?.length ?? 0) > 0) lines.push(`failed: ${(result.failed ?? []).map((entry) => `${entry.path}: ${entry.error}`).join('; ')}`);
        } else lines.push('nothing to do: the workspace already matches.');
        if (result.safetyCheckpoint !== undefined) {
          lines.push(`safety checkpoint: ${result.safetyCheckpoint} (restore it to undo this restore)`);
        }
        return {
          dryRun,
          safe: plan.safe,
          writes: plan.summary.writes,
          deletes: plan.summary.deletes,
          unchanged: plan.summary.unchanged,
          unverifiable: plan.summary.unverifiable,
          conflicts: plan.conflicts.map((conflict) => conflict.path),
          applied: applied.length,
          failed: (result.failed ?? []).map((entry) => `${entry.path}: ${entry.error}`),
          ...(result.safetyCheckpoint === undefined ? {} : { safetyCheckpoint: result.safetyCheckpoint }),
          message: lines.join('\n'),
        };
      },
    }),
  );

  add(
    'tm_status',
    defineTool({
      name: 'tm_status',
      description: 'Report Time Machine storage: where checkpoints live, how many exist, and how many bytes the object store holds.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            root: { type: 'string', required: true },
            checkpoints: { type: 'integer', required: true },
            objects: { type: 'integer', required: true },
            referencedBytes: { type: 'integer', required: true },
            journalBytes: { type: 'integer', required: true },
            captureEnabled: { type: 'boolean', required: true },
          },
        },
        render(_args, value) {
          return blocks(
            `Time Machine at ${value.root}\n` +
              `checkpoints: ${String(value.checkpoints)}  objects: ${String(value.objects)}  ` +
              `referenced: ${formatBytes(value.referencedBytes)}  journal: ${formatBytes(value.journalBytes)}\n` +
              `capture: ${value.captureEnabled ? 'on' : 'off'}`,
          );
        },
      },
      async execute() {
        const stats = runtime.status();
        return { ...stats, captureEnabled: runtime.enabled };
      },
    }),
  );

  return disposers;
}

/** Count `diff -- ` headers in a rendered diff. */
function countDiffs(text: string): number {
  let count = 0;
  for (const line of text.split('\n')) if (line.startsWith('diff -- ')) count += 1;
  return count;
}

/** Human byte size. */
function formatBytes(value: number): string {
  if (value < 1024) return `${String(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Re-exported so the runtime can render one entry without importing the core. */
export { diffTexts, formatHunks, splitLines };
