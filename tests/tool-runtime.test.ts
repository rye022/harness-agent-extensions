import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import * as timeMachine from '../packages/time-machine/src/index.ts';
import * as contextOs from '../packages/context-os/src/index.ts';

// Resolve the actual Harness peer dependency, rather than a tools.register stub.
const requirePeer = createRequire(new URL('../packages/time-machine/package.json', import.meta.url));
const { ToolRuntime } = await import(pathToFileURL(requirePeer.resolve('@deepseek-ai/dsh-tools')).href);

test('real tool pipeline executes and renders plugin results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-tool-pipeline-'));
  const ctx = new Context();
  ctx.provide('systemPrompt', { tools: () => () => {}, getContextOrder: () => 0, context: () => () => {} });
  ctx.provide('subprocess', {});
  ctx.provide('fs', { processPath: (target: { hostPath?: string }) => target?.hostPath ?? '' });
  const tools = new ToolRuntime(ctx);
  timeMachine.apply(ctx as never, { root: join(root, 'tm') });
  contextOs.apply(ctx as never, { dbFile: join(root, 'context.db') });
  try {
    const execute = async (name: string, args = {}) => {
      const result = await tools.execute({ name, arguments: args, callId: `test-${name}`, signal: new AbortController().signal });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.ok(result.content.length > 0, `${name} rendered content`);
      for (const block of result.content) {
        assert.equal(block.type, 'text');
        assert.equal(typeof block.text, 'string');
      }
      assert.deepEqual(JSON.parse(JSON.stringify(result.content)), result.content);
      return result;
    };
    const tm = await execute('tm_status');
    assert.equal(tm.value.captureEnabled, true);
    assert.match(tm.content[0].text, /Time Machine/);
    const co = await execute('co_status');
    assert.equal(co.value.path, join(root, 'context.db'));
    assert.match(co.content[0].text, /memory: L1=/);
    await execute('tm_list');
    const remembered = await execute('co_remember', { title: 'pipeline regression', body: 'UniquePipeToken75808133' });
    const recalled = await execute('co_recall', { query: 'UniquePipeToken75808133' });
    assert.match(recalled.content[0].text, /UniquePipeToken75808133/);
    await execute('co_brief', { query: 'UniquePipeToken75808133' });
    await execute('co_forget', { id: remembered.value.id });
  } finally {
    (ctx.get('contextOs') as { close(): void }).close();
    rmSync(root, { recursive: true, force: true });
  }
});
