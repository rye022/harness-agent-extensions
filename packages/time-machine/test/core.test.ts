import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointService } from '../src/core/checkpoint-service.ts';
import { ObjectStore } from '../src/core/object-store.ts';
import { CheckpointIndex } from '../src/core/checkpoint-index.ts';
import { planRestore, applyRestore } from '../src/core/restore.ts';
import { sha256Hex } from '@harness-ext/shared';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tm-test-'));
}

test('object store dedupes identical content and verifies hashes', async () => {
  const dir = tempDir();
  try {
    const store = new ObjectStore(dir);
    const first = await store.putBuffer(Buffer.from('hello world'));
    const second = await store.putBuffer(Buffer.from('hello world'));
    assert.equal(first.hash, second.hash);
    assert.equal(second.stored, false);
    assert.equal((await store.listObjects()).length, 1);
    assert.equal(store.readText(first.hash), 'hello world');
    const verification = await store.verify();
    assert.deepEqual(verification.ok, [first.hash]);
    assert.equal(verification.corrupt.length, 0);
    assert.equal(await store.totalBytes(), 11);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('garbage collection keeps referenced objects only', async () => {
  const dir = tempDir();
  try {
    const store = new ObjectStore(dir);
    const keep = await store.putBuffer(Buffer.from('keep me'));
    const drop = await store.putBuffer(Buffer.from('drop me'));
    const removed = await store.collectGarbage(new Set([keep.hash]));
    assert.deepEqual(removed, { removed: 1, bytes: 7 });
    assert.equal(store.has(keep.hash), true);
    assert.equal(store.has(drop.hash), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('turn capture records before/after images and chains parent ids', async () => {
  const dir = tempDir();
  const workspace = join(dir, 'ws');
  mkdirSync(workspace);
  const file = join(workspace, 'note.txt');
  writeFileSync(file, 'version one\n');
  try {
    const service = new CheckpointService({ root: join(dir, 'store') });
    const scope = { sessionId: 's1', turn: 1, workspaceRoot: workspace };
    await service.captureBefore({ absPath: file, tool: { name: 'edit' } }, scope);
    writeFileSync(file, 'version two\n');
    const first = await service.finalizeTurn(scope);
    assert.ok(first);
    assert.equal(first.origin, 'auto-turn');
    assert.equal(first.files.length, 1);
    const entry = first.files[0]!;
    assert.equal(entry.path, 'note.txt');
    assert.equal(entry.before, sha256Hex('version one\n'));
    assert.equal(entry.after, sha256Hex('version two\n'));
    assert.equal(entry.kind, 'text');

    const scope2 = { sessionId: 's1', turn: 2, workspaceRoot: workspace };
    await service.captureBefore({ absPath: file }, scope2);
    writeFileSync(file, 'version three\n');
    const second = await service.finalizeTurn(scope2);
    assert.ok(second);
    assert.equal(second.parentId, first.id);
    assert.equal(service.index.list().length, 2);
    assert.equal(service.index.lastForSession('s1')?.id, second.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('captureBefore is first-touch-wins within one turn', async () => {
  const dir = tempDir();
  const workspace = join(dir, 'ws');
  mkdirSync(workspace);
  const file = join(workspace, 'a.txt');
  writeFileSync(file, 'one\n');
  try {
    const service = new CheckpointService({ root: join(dir, 'store') });
    const scope = { sessionId: 's1', turn: 1, workspaceRoot: workspace };
    const first = await service.captureBefore({ absPath: file }, scope);
    writeFileSync(file, 'two\n');
    const again = await service.captureBefore({ absPath: file }, scope);
    assert.equal(first?.before, sha256Hex('one\n'));
    assert.equal(again?.before, sha256Hex('one\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('idle turn produces no checkpoint; ignored files are never captured', async () => {
  const dir = tempDir();
  const workspace = join(dir, 'ws');
  mkdirSync(workspace);
  try {
    const service = new CheckpointService({ root: join(dir, 'store') });
    const scope = { sessionId: 's1', turn: 1, workspaceRoot: workspace };
    assert.equal(await service.finalizeTurn(scope), undefined);

    const secret = join(workspace, '.env');
    writeFileSync(secret, 'TOKEN=hunter2\n');
    assert.equal(await service.captureBefore({ absPath: secret }, scope), undefined);
    assert.equal(await service.finalizeTurn(scope), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore plan rewrites the before image and refuses on conflict', async () => {
  const dir = tempDir();
  const workspace = join(dir, 'ws');
  mkdirSync(workspace);
  const file = join(workspace, 'app.ts');
  writeFileSync(file, 'export const a = 1;\n');
  try {
    const service = new CheckpointService({ root: join(dir, 'store') });
    const scope = { sessionId: 's1', turn: 1, workspaceRoot: workspace };
    await service.captureBefore({ absPath: file }, scope);
    writeFileSync(file, 'export const a = 2;\n');
    const record = await service.finalizeTurn(scope);
    assert.ok(record);

    const plan = await planRestore(service, record, 'before', workspace);
    assert.equal(plan.safe, true);
    assert.equal(plan.summary.writes, 1);
    const report = await applyRestore(service, plan);
    assert.equal(report.verified, true);
    assert.equal(readFileSync(file, 'utf8'), 'export const a = 1;\n');

    // Someone else edits the file after the checkpoint: the plan must conflict.
    const again = await planRestore(service, record, 'before', workspace);
    assert.equal(again.safe, true);
    writeFileSync(file, 'export const a = 3;\n');
    const conflicted = await planRestore(service, record, 'before', workspace);
    assert.equal(conflicted.safe, false);
    assert.equal(conflicted.conflicts.length, 1);
    await assert.rejects(() => applyRestore(service, conflicted), /conflict/i);
    assert.equal(readFileSync(file, 'utf8'), 'export const a = 3;\n');
    // Forced apply is explicit.
    const forced = await applyRestore(service, conflicted, { force: true });
    assert.equal(forced.verified, true);
    assert.equal(readFileSync(file, 'utf8'), 'export const a = 1;\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a plan is re-verified before writing, so an edit between plan and apply aborts cleanly', async () => {
  const dir = tempDir();
  const workspace = join(dir, 'ws');
  mkdirSync(workspace);
  const file = join(workspace, 'app.ts');
  const other = join(workspace, 'b.ts');
  writeFileSync(file, 'one\n');
  writeFileSync(other, 'two\n');
  try {
    const service = new CheckpointService({ root: join(dir, 'store') });
    const scope = { sessionId: 's1', turn: 1, workspaceRoot: workspace };
    await service.captureBefore({ absPath: file }, scope);
    await service.captureBefore({ absPath: other }, scope);
    writeFileSync(file, 'ONE\n');
    writeFileSync(other, 'TWO\n');
    const record = await service.finalizeTurn(scope);
    assert.ok(record);

    const plan = await planRestore(service, record, 'before', workspace);
    assert.equal(plan.safe, true);
    // An editor saves between planning and applying.
    writeFileSync(file, 'unrelated edit\n');

    await assert.rejects(() => applyRestore(service, plan), /changed after the plan was built/);
    // Nothing was written, not even the file that did not drift.
    assert.equal(readFileSync(file, 'utf8'), 'unrelated edit\n');
    assert.equal(readFileSync(other, 'utf8'), 'TWO\n');

    // A re-plan sees the new content as a conflict, and force still overrides.
    const replanned = await planRestore(service, record, 'before', workspace);
    assert.equal(replanned.safe, false);
    const forced = await applyRestore(service, replanned, { force: true });
    assert.equal(forced.verified, true);
    assert.equal(readFileSync(file, 'utf8'), 'one\n');
    assert.equal(readFileSync(other, 'utf8'), 'two\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore of a file created during the turn deletes it', async () => {
  const dir = tempDir();
  const workspace = join(dir, 'ws');
  mkdirSync(workspace);
  const file = join(workspace, 'new.txt');
  try {
    const service = new CheckpointService({ root: join(dir, 'store') });
    const scope = { sessionId: 's1', turn: 1, workspaceRoot: workspace };
    await service.captureBefore({ absPath: file }, scope);
    writeFileSync(file, 'created by the agent\n');
    const record = await service.finalizeTurn(scope);
    assert.ok(record);
    assert.equal(record.files[0]!.before, null);

    const plan = await planRestore(service, record, 'before', workspace);
    assert.equal(plan.summary.deletes, 1);
    assert.equal(plan.safe, true);
    await applyRestore(service, plan);
    assert.equal(existsSyncSafe(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journal load reports damaged lines instead of throwing', async () => {
  const dir = tempDir();
  try {
    const index = new CheckpointIndex(dir);
    index.append({
      schema: 1,
      id: 'cp_1_aaaaaaaa',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdAtMs: 1,
      origin: 'manual',
      files: [],
      workspaceRoot: dir,
    });
    const journal = join(dir, 'checkpoints.jsonl');
    writeFileSync(journal, `${readFileSync(journal, 'utf8')}{"not":"a checkpoint"}\n`);
    const reloaded = new CheckpointIndex(dir);
    const report = reloaded.load();
    assert.equal(report.loaded, 1);
    assert.equal(report.damaged.length, 1);
    assert.equal(report.damaged[0]!.line, 2);
    assert.equal(reloaded.size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function existsSyncSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
