/**
 * `@harness-ext/time-machine` — file-level checkpoints for DeepSeek Harness.
 *
 * What it adds, and why each piece is where it is:
 *
 * - **Capture** rides the same two file-intent waterfalls the shipped
 *   `dsh-workspace-changes` plugin uses (`fs/write-intent`, `fs/edit-intent`,
 *   both `{ prepend: true }`), so the pre-image of a `write`/`edit` is stored
 *   before the mutation happens. Shell edits (`pwsh`) have no such waterfall;
 *   `capture.workspaceSnapshotOnTurnStart` covers those by hashing the tree at
 *   `turn/start`, at the cost of one scan per turn.
 * - **Grouping** follows turns: `session/event` `turn/start` opens a buffer,
 *   `turn/end` closes it into one `auto-turn` checkpoint. One turn is one
 *   undoable step, which is what a user means by "put it back".
 * - **Durability** is content-addressed: images live in
 *   `<root>/objects/<aa>/<hash>` and are shared by every checkpoint, so the
 *   hundredth checkpoint of an unchanged tree costs nothing.
 * - **Restore** is plan-then-apply, with a conflict check against the current
 *   files and a `pre-restore` safety checkpoint, so an undo is itself undoable.
 *
 * The plugin never touches the harness' own databases: it only reads session
 * events and the filesystem, which keeps it removable without data loss.
 *
 * @module @harness-ext/time-machine/plugin
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { TypedBus, type TypedBusLike, IgnorePolicy, readIfExists, sha256OfFile, diffTexts, formatHunks } from '@harness-ext/shared';
import { normalizeConfig, defaultRoot } from './config.ts';
import { CheckpointService } from './core/checkpoint-service.ts';
import { planRestore, applyRestore, type RestorePlan, type RestoreReport } from './core/restore.ts';
import { registerTools, type TimeMachineRuntime } from './tools.ts';
import { readEntryText, type TurnScope } from './core/checkpoint-service.ts';
import type { CheckpointRecord } from './core/types.ts';

/** Plugin name, surfaced by the loader and by `tm_status` output. */
export const name = 'harness-ext-time-machine';

/**
 * Services this plugin needs before it may mount. `fs` provides
 * `processPath(target)` (the host path of an `FsTarget`); `tools` provides
 * `register(definition)`. Everything else — sessions, sandbox policy — is
 * reached through the objects the harness hands to the hooks, so a harness
 * build that renames a service cannot silently break capture.
 */
export const inject = ['fs', 'tools'];

/** Cross-plugin events other extensions may subscribe to. */
export interface TimeMachineEvents {
  /** A checkpoint was written. */
  'checkpoint/created': { record: CheckpointRecord };
  /** A restore plan was computed (dry runs included). */
  'checkpoint/restore-planned': { plan: RestorePlan };
  /** A restore was applied and verified. */
  'checkpoint/restored': { record: CheckpointRecord; plan: RestorePlan; report: RestoreReport };
}

/** The service published as `ctx.timeMachine`, for Context OS and client code. */
export interface TimeMachineService {
  readonly version: string;
  readonly enabled: boolean;
  readonly events: TypedBusLike<TimeMachineEvents>;
  status(): { root: string; checkpoints: number; objects: number; referencedBytes: number; journalBytes: number };
  list(options?: { limit?: number; origin?: string; sessionId?: string }): CheckpointRecord[];
  get(id: string): CheckpointRecord | undefined;
  checkpointNow(options?: { label?: string; paths?: string[]; sessionId?: string; cwd?: string }): Promise<CheckpointRecord>;
  plan(id: string, side: 'before' | 'after'): Promise<RestorePlan>;
  restoreFrom(id: string, options?: { side?: 'before' | 'after'; force?: boolean }): Promise<{
    plan: RestorePlan;
    applied: RestoreReport['applied'];
    failed: RestoreReport['failed'];
    safetyCheckpoint?: string;
  }>;
  /** Convenience wrapper over the `checkpoint/restored` event. */
  onRestored(listener: (payload: { record: CheckpointRecord; plan: RestorePlan }) => void): () => void;
}

/** The slice of the Cordis context this plugin uses. */
export interface PluginContext {
  logger: { info(message: string): void; warn(message: string): void };
  /** Register a disposable side effect; runs when the plugin unloads. */
  effect(setup: () => (() => void) | void): void;
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean; global?: boolean }): void;
  fs: { processPath(target: unknown): string };
  tools: { register(definition: unknown): () => void };
  sandboxPolicy?: { resolve(init?: { session?: unknown }): { mode?: string; workspaceRoot?: string } };
  provide(name: string, value: unknown): void;
}

/** Minimal session shape the hooks hand us. */
interface SessionLike {
  readonly id: string;
  readonly header?: { readonly cwd?: string };
}

/** Minimal session-event shape. */
interface SessionEventLike {
  readonly type: string;
  readonly data?: unknown;
}

/** A tool execution, as passed to the fs waterfalls. */
interface ToolActor {
  readonly name?: string;
  readonly callId?: string;
  readonly agent?: { readonly session?: SessionLike };
  readonly session?: SessionLike;
}

/** The published plugin version, kept in sync with package.json by `pnpm run version`. */
export const version = '0.1.1';

/** Apply the plugin. */
export function apply(ctx: PluginContext, rawConfig?: unknown): void {
  const { config, issues } = normalizeConfig(rawConfig);
  for (const issue of issues) ctx.logger.warn(`time-machine: config "${issue.field}": ${issue.message}`);
  if (!config.enabled) {
    ctx.logger.info('time-machine: disabled by config');
    return;
  }

  const root = config.root ?? defaultRoot();
  const policy = new IgnorePolicy({
    ...(config.ignoreExtra.length === 0 ? {} : { ignoredFiles: config.ignoreExtra }),
    maxFileBytes: config.maxFileBytes,
  });
  const service = new CheckpointService({
    root,
    policy,
    maxFiles: config.maxFiles,
    logger: { info: (message) => { ctx.logger.info(message); }, warn: (message) => { ctx.logger.warn(message); } },
  });
  const events = new TypedBus<TimeMachineEvents>();

  /** Open turns: session id → turn number and workspace root. */
  const turns = new Map<string, { turn: number; workspaceRoot: string }>();

  /** Resolve a session's workspace root the way the sandbox policy does. */
  const workspaceRootFor = (session: SessionLike | undefined): string => {
    if (session !== undefined) {
      try {
        const resolved = ctx.sandboxPolicy?.resolve({ session });
        if (resolved?.workspaceRoot !== undefined && resolved.workspaceRoot !== '') return resolved.workspaceRoot;
      } catch {
        // The policy service is optional; fall through to the session cwd.
      }
      const cwd = session.header?.cwd;
      if (cwd !== undefined && cwd !== '') return cwd;
    }
    return process.cwd();
  };

  const scopeFor = (session: SessionLike | undefined): TurnScope => {
    const state = session === undefined ? undefined : turns.get(session.id);
    return {
      ...(session === undefined ? {} : { sessionId: session.id }),
      ...(state === undefined ? {} : { turn: state.turn }),
      workspaceRoot: state?.workspaceRoot ?? workspaceRootFor(session),
    };
  };

  /** Capture one pre-image, never throwing into the write path. */
  const captureTarget = async (target: unknown, actor: ToolActor | undefined, session: SessionLike | undefined): Promise<void> => {
    try {
      const hostPath = ctx.fs.processPath(target);
      if (hostPath === '') return;
      const tool = actor?.name === undefined ? undefined : { name: actor.name, ...(actor.callId === undefined ? {} : { callId: actor.callId }) };
      await service.captureBefore(
        { absPath: hostPath, ...(tool === undefined ? {} : { tool }) },
        scopeFor(session ?? actor?.agent?.session ?? actor?.session),
      );
    } catch (error) {
      ctx.logger.warn(`time-machine: capture failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const captureHook = async (target: unknown, actor: ToolActor | undefined, next: () => Promise<unknown>): Promise<unknown> => {
    const intent = await next();
    await captureTarget(target, actor, actor?.agent?.session ?? actor?.session);
    return intent;
  };

  if (config.capture.writeIntent) ctx.on('fs/write-intent', captureHook as never, { prepend: true });
  if (config.capture.editIntent) ctx.on('fs/edit-intent', captureHook as never, { prepend: true });

  ctx.on(
    'session/event',
    ((session: SessionLike, event: SessionEventLike) => {
      if (event.type === 'turn/start') {
        const turn = numberOf(event.data, 'turn');
        const workspaceRoot = workspaceRootFor(session);
        if (turn === undefined) return;
        turns.set(session.id, { turn, workspaceRoot });
        if (config.capture.workspaceSnapshotOnTurnStart) {
          void service
            .createSnapshot({ workspaceRoot, origin: 'auto-turn', sessionId: session.id, ...(turn === undefined ? {} : { turn }) })
            .catch((error: unknown) => {
              ctx.logger.warn(`time-machine: turn snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
            });
        }
        return;
      }
      if (event.type === 'tool/result') {
        const failure = failedToolMessage(event.data);
        if (failure !== undefined) service.recordTest(scopeFor(session), failure);
        return;
      }
      if (event.type === 'turn/end') {
        const scope = scopeFor(session);
        turns.delete(session.id);
        void service
          .finalizeTurn(scope)
          .then((record) => {
            if (record === undefined) return;
            events.emit('checkpoint/created', { record });
            if (config.keep.maxCheckpoints > 0 && service.index.size > config.keep.maxCheckpoints) {
              try {
                service.index.compact();
              } catch (error) {
                ctx.logger.warn(`time-machine: journal compaction failed: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          })
          .catch((error: unknown) => {
            ctx.logger.warn(`time-machine: turn checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
          });
      }
    }) as never,
  );

  ctx.on(
    'session/disposed',
    ((session: SessionLike) => {
      service.discardTurn(scopeFor(session));
      turns.delete(session.id);
    }) as never,
  );

  // ---- runtime shared by tools and by the published service -----------------

  const locate = (record: CheckpointRecord | undefined, id: string): CheckpointRecord => {
    if (record === undefined) throw new Error(`checkpoint "${id}" not found; call tm_list to see available checkpoints`);
    return record;
  };

  const restoreInternal = async (options: {
    id: string;
    side: 'before' | 'after';
    dryRun: boolean;
    force: boolean;
  }): Promise<{ plan: RestorePlan; applied: RestoreReport['applied']; failed: RestoreReport['failed']; safetyCheckpoint?: string; record: CheckpointRecord }> => {
    const record = locate(service.index.get(options.id), options.id);
    const plan = await planRestore(service, record, options.side);
    events.emit('checkpoint/restore-planned', { plan });
    if (options.dryRun) return { plan, applied: [], failed: [], record };
    if (!plan.safe && !options.force) {
      throw new Error(
        `restore refused: ${String(plan.conflicts.length)} file(s) changed since the checkpoint; ` +
          're-run with dry_run to inspect, or force=true to overwrite',
      );
    }
    const paths = plan.files.filter((file) => file.status === 'write' || file.status === 'delete').map((file) => file.path);
    let safetyCheckpoint: string | undefined;
    if (paths.length > 0) {
      const snapshot = await service.createSnapshot({
        workspaceRoot: plan.workspaceRoot,
        origin: 'pre-restore',
        label: `before restoring ${record.id}`,
        ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
        onlyPaths: paths,
      });
      safetyCheckpoint = snapshot.record.id;
    }
    const report = await applyRestore(service, plan, { force: options.force });
    if (!report.verified) {
      throw new Error(
        `restore incomplete: ${String(report.failed.length)} file(s) failed (${report.failed.map((entry) => entry.path).join(', ')})`,
      );
    }
    events.emit('checkpoint/restored', { record, plan, report });
    return { plan, applied: report.applied, failed: report.failed, ...(safetyCheckpoint === undefined ? {} : { safetyCheckpoint }), record };
  };

  const diffOf = async (options: { id: string; against?: string; path?: string; side: 'before' | 'after' }): Promise<string> => {
    const record = locate(service.index.get(options.id), options.id);
    const other = options.against === undefined ? undefined : locate(service.index.get(options.against), options.against);
    const oldSide = options.side;
    const newSide = options.side === 'before' ? 'after' : 'before';
    const workspaceRoot = record.workspaceRoot ?? process.cwd();
    const wanted = options.path === undefined ? undefined : normalizePath(options.path);
    const chunks: string[] = [];
    for (const entry of record.files) {
      if (wanted !== undefined && normalizePath(entry.path) !== wanted) continue;
      const mirror = other?.files.find((candidate) => candidate.path === entry.path);
      const oldText = entryText(service, entry, oldSide);
      const newText =
        other === undefined ? currentText(workspaceRoot, entry.path) : mirror === undefined ? undefined : entryText(service, mirror, newSide);
      if (oldText === undefined || newText === undefined) continue;
      if (oldText === newText) continue;
      const diff = diffTexts(oldText, newText);
      if (diff.hunks.length === 0) continue;
      const title = other === undefined ? `workspace` : other.id;
      chunks.push(`diff -- ${entry.path} (${record.id} → ${title})`);
      chunks.push(formatHunks(diff.hunks));
    }
    return chunks.join('\n');
  };

  const runtime: TimeMachineRuntime = {
    enabled: true,
    async checkpoint(options) {
      const workspaceRoot = options.cwd ?? workspaceRootFor(undefined);
      const { record } = await service.createSnapshot({
        workspaceRoot,
        origin: 'manual',
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.paths === undefined ? {} : { onlyPaths: options.paths }),
      });
      events.emit('checkpoint/created', { record });
      return record;
    },
    list(options) {
      return service.index.list({
        ...(options?.limit === undefined ? {} : { limit: options.limit }),
        ...(options?.origin === undefined ? {} : { origin: options.origin as never }),
        ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      });
    },
    get(id) {
      return service.index.get(id);
    },
    async restore(options) {
      const result = await restoreInternal({
        id: options.id,
        side: options.side,
        dryRun: options.dryRun,
        force: options.force,
      });
      return {
        plan: result.plan,
        applied: result.applied,
        failed: result.failed,
        ...(result.safetyCheckpoint === undefined ? {} : { safetyCheckpoint: result.safetyCheckpoint }),
      };
    },
    status() {
      return { root, ...service.stats() };
    },
    diff: diffOf,
  };

  const toolDisposers = registerTools(runtime, {
    enabled: config.tools.enabled,
    disabled: config.tools.disabled,
    maxDiffChars: config.tools.maxDiffChars,
    maxListItems: config.tools.maxListItems,
    register: (definition) => ctx.tools.register(definition),
    logger: { warn: (message) => { ctx.logger.warn(message); } },
  });

  const published: TimeMachineService = {
    version,
    enabled: true,
    events,
    status: () => runtime.status(),
    list: (options) => runtime.list(options),
    get: (id) => runtime.get(id),
    checkpointNow: (options) => runtime.checkpoint(options ?? {}),
    plan: async (id, side) => planRestore(service, locate(service.index.get(id), id), side),
    restoreFrom: async (id, options) => {
      const result = await restoreInternal({ id, side: options?.side ?? 'before', dryRun: false, force: options?.force === true });
      return {
        plan: result.plan,
        applied: result.applied,
        failed: result.failed,
        ...(result.safetyCheckpoint === undefined ? {} : { safetyCheckpoint: result.safetyCheckpoint }),
      };
    },
    onRestored: (listener) => events.on('checkpoint/restored', (payload) => { listener(payload); }),
  };

  ctx.provide('timeMachine', published);

  ctx.effect(() => () => {
    for (const dispose of toolDisposers) dispose();
    events.clear();
    turns.clear();
  });

  ctx.logger.info(`time-machine: ready at ${root} (${String(service.index.size)} checkpoint(s) on disk)`);
}

/** Read a stored side of one entry as text, skipping binary/oversized images. */
function entryText(
  service: CheckpointService,
  entry: { before: string | null; after?: string | null; kind: string },
  side: 'before' | 'after',
): string | undefined {
  if (entry.kind === 'binary' || entry.kind === 'oversized') return undefined;
  const hash = side === 'before' ? entry.before : entry.after;
  return readEntryText(service.store, hash);
}

/** Read the current on-disk text of a manifest path. */
function currentText(workspaceRoot: string, path: string): string | undefined {
  const absPath = isAbsolute(path) ? path : resolve(workspaceRoot, path);
  if (!existsSync(absPath)) return '';
  const text = readIfExists(absPath);
  return text ?? undefined;
}

/** Normalize a manifest or user-supplied path for comparison. */
function normalizePath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

/** Read one numeric field out of an unknown event payload. */
function numberOf(data: unknown, key: string): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Turn a failed `tool/result` into a checkpoint test row. */
function failedToolMessage(data: unknown): { callId?: string; command: string; status: 'failed'; summary: string; at: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as { error?: { message?: unknown; code?: unknown }; meta?: { name?: unknown } };
  const error = record.error;
  if (error === undefined || typeof error !== 'object' || error === null) return undefined;
  const summary = typeof error.message === 'string' ? error.message : typeof error.code === 'string' ? error.code : 'tool failed';
  const name = typeof record.meta?.name === 'string' ? record.meta.name : 'tool';
  return { command: name, status: 'failed', summary, at: new Date().toISOString() };
}

/** Hash helper re-exported for the plugin's own diagnostics. */
export { sha256OfFile };
