/**
 * Plugin-layer test: mounts the real Cordis entry against a fake context.
 *
 * The point of this file is to prove that capture, checkpointing, restore and
 * the `tm_*` tools work through the same code paths the harness calls, without
 * needing a running harness. The fake context implements only what the plugin
 * declares: `fs.processPath`, `tools.register`, `effect`, `on`, `provide`,
 * `sandboxPolicy.resolve` and `logger`.
 *
 * @module @harness-ext/time-machine/test/plugin
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { apply } from '../src/plugin.ts';

/** A compiled tool definition, as `tools.register` receives it. */
interface RegisteredTool {
  name: string;
  parameters: unknown;
  output: { schema: unknown; render(args: never, value: never): unknown };
  execute(args: never, exec: never): Promise<unknown>;
}

/** The fake context. */
function fakeContext(options: { workspaceRoot: string }) {
  const handlers = new Map<string, ((...args: never[]) => unknown)[]>();
  const tools = new Map<string, RegisteredTool>();
  const provided = new Map<string, unknown>();
  const disposers: (() => void)[] = [];
  const logs: string[] = [];
  const ctx = {
    logger: {
      info: (message: string) => { logs.push(`info: ${message}`); },
      warn: (message: string) => { logs.push(`warn: ${message}`); },
    },
    effect(setup: () => (() => void) | void) {
      const cleanup = setup();
      if (typeof cleanup === 'function') disposers.push(cleanup);
    },
    on(name: string, listener: (...args: never[]) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(listener);
      handlers.set(name, list);
    },
    fs: { processPath: (target: unknown) => (target as { path: string }).path },
    tools: {
      register(definition: RegisteredTool) {
        tools.set(definition.name, definition);
        return () => { tools.delete(definition.name); };
      },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: options.workspaceRoot }) },
    provide(name: string, value: unknown) { provided.set(name, value); },
  };
  const emit = async (name: string, ...args: unknown[]): Promise<unknown> => {
    let result: unknown;
    for (const listener of handlers.get(name) ?? []) result = await (listener as (...inner: unknown[]) => unknown)(...args);
    return result;
  };
  return { ctx, handlers, tools, provided, disposers, logs, emit };
}

/** Wait until `predicate` holds, or fail. */
async function until(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}

describe('time-machine plugin', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'tm-plugin-'));
  const dataRoot = join(workdir, 'time-machine');
  const workspace = join(workdir, 'workspace');
  const file = join(workspace, 'notes.txt');
  const created = join(workspace, 'created.txt');

  after(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  const harness = fakeContext({ workspaceRoot: workspace });

  it('mounts, captures before a write, and records the turn', async () => {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(file, 'first line\nsecond line\n');

    apply(harness.ctx as never, { root: dataRoot, capture: { workspaceSnapshotOnTurnStart: false } });

    assert.ok(harness.provided.has('timeMachine'), 'the service is published as ctx.timeMachine');
    assert.ok(harness.tools.has('tm_restore'), 'tools were registered');

    const session = { id: 'session-1', header: { cwd: workspace } };
    await harness.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });

    const actor = { name: 'write', callId: 'call-1', agent: { session } };
    const intent = await harness.emit('fs/write-intent', { path: file }, actor, async () => ({ ok: true }));
    assert.deepEqual(intent, { ok: true }, 'the waterfall result is proxied untouched');

    // The tool body would now write; emulate it.
    writeFileSync(file, 'first line\nsecond line changed\n');
    writeFileSync(created, 'brand new\n');

    const service = harness.provided.get('timeMachine') as {
      list(): { id: string; files: { path: string; before: string | null }[] }[];
      events: { on(type: string, listener: (payload: unknown) => void): () => void };
    };

    await harness.emit('session/event', session, { type: 'tool/result', data: { turn: 1, step: 1, error: { name: 'ToolError', code: 'ESHELL', message: 'boom' } } });
    await harness.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

    await until(() => service.list().length === 1, 'the turn checkpoint');
    const [record] = service.list();
    const entry = record.files.find((candidate) => candidate.path === 'notes.txt');
    assert.ok(entry !== undefined, 'the written file is in the checkpoint');
    assert.ok(entry.before !== null, 'the pre-image hash was recorded');
    assert.equal(JSON.parse(readFileSync(join(dataRoot, 'checkpoints.jsonl'), 'utf8')).files.length > 0, true);
  });

  it('restores the captured state through tm_restore', async () => {
    const service = harness.provided.get('timeMachine') as { list(): { id: string }[] };
    const [record] = service.list();
    const restore = harness.tools.get('tm_restore');
    assert.ok(restore !== undefined);

    const tools = harness.ctx.tools as unknown as { register(definition: RegisteredTool): () => void };
    assert.ok(tools !== undefined);

    // Dry run first: nothing may change.
    const dry = (await restore.execute({ id: record.id, dry_run: true }, {})) as { dryRun: boolean; writes: number };
    assert.equal(dry.dryRun, true);
    assert.equal(readFileSync(file, 'utf8'), 'first line\nsecond line changed\n');

    const applied = (await restore.execute({ id: record.id }, {})) as { applied: number; failed: string[]; safetyCheckpoint?: string };
    assert.equal(applied.failed.length, 0);
    assert.equal(applied.applied, 1);
    assert.equal(readFileSync(file, 'utf8'), 'first line\nsecond line\n');
    assert.ok(applied.safetyCheckpoint !== undefined, 'a pre-restore safety checkpoint is always written');
  });

  it('refuses a conflicting restore unless forced', async () => {
    writeFileSync(file, 'someone else edited this\n');
    const service = harness.provided.get('timeMachine') as { list(): { id: string }[] };
    const records = service.list();
    const restore = harness.tools.get('tm_restore');
    assert.ok(restore !== undefined);
    const target = records[records.length - 1];
    await assert.rejects(
      restore.execute({ id: target.id }, {} as never),
      /restore refused/,
      'a conflicted plan must not apply',
    );
    const forced = (await restore.execute({ id: target.id, force: true }, {} as never)) as { applied: number };
    assert.equal(forced.applied, 1);
    assert.equal(readFileSync(file, 'utf8'), 'first line\nsecond line\n');
  });

  it('unloads every registration through ctx.effect', () => {
    for (const disposer of harness.disposers) disposer();
    const after = harness.tools.size;
    assert.equal(after, 0, 'tools are removed when the plugin disposer runs');
  });
});
