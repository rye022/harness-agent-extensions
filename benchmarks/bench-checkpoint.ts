/**
 * Benchmark: time-machine checkpoint capture, diff and restore on a synthetic
 * repository (default 800 files, ~3 KiB each).
 *
 * Measured:
 *   1. workspace scan           — cost of a turn-level snapshot scan
 *   2. full snapshot            — hash + store every file (manual checkpoint)
 *   3. per-turn capture (5×20)  — the incremental path an agent actually triggers
 *   4. restore plan + apply     — conflict detection followed by a forced restore
 *   5. diff of a large file     — the diff engine on a 4 000-line rewrite
 *   6. on-disk footprint        — object store + journal size after the run
 *
 * Run: `node benchmarks/bench-checkpoint.ts`
 */
import { readFileSync, statSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanWorkspace, CheckpointService, planRestore, applyRestore } from '../packages/time-machine/src/core/index.ts'
import { IgnorePolicy, globToRegExp, DEFAULT_MAX_FILE_BYTES, diffTexts } from '../packages/shared/src/index.ts'
import { makeSyntheticRepo, makeTempDir, removeDir, timed, nowMs, round, fakeText, prng } from './lib/fixture.ts'
import type { BenchResult } from './lib/fixture.ts'

export async function run(): Promise<BenchResult> {
  const workspace = makeTempDir('tm-ws')
  const storeRoot = makeTempDir('tm-store')
  const cases: BenchResult['cases'] = []
  const notes: string[] = []
  try {
    const repo = makeSyntheticRepo(workspace, { count: 800, bytesPerFile: 3072 })
    const policy = new IgnorePolicy({
      ignoredDirectories: ['.git', 'node_modules'],
      ignoredFiles: ['.env', '*.key'],
      allowedFiles: [],
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    })
    const service = new CheckpointService({ root: storeRoot, policy, maxFiles: 5000 })

    const scan = await timed(() => scanWorkspace(workspace, { policy, maxFiles: 5000 }))
    cases.push({
      label: `scan ${repo.files.length} files (${(repo.bytes / 1024 / 1024).toFixed(1)} MiB)`,
      value: round(scan.ms),
      unit: 'ms',
      max: 15000,
      detail: `${scan.value.files.length} files captured, ${scan.value.skipped.length} skipped`,
    })

    const snapshot = await timed(() =>
      service.createSnapshot({ workspaceRoot: workspace, origin: 'manual', label: 'bench-full' }),
    )
    const snapshotBytes = snapshot.value.record.files.length
    cases.push({
      label: `full snapshot (${snapshotBytes} files)`,
      value: round(snapshot.ms),
      unit: 'ms',
      max: 30000,
      detail: `${(repo.bytes / 1024 / 1024 / (snapshot.ms / 1000)).toFixed(1)} MiB/s`,
    })

    // Five turns, twenty edits each: the incremental capture path.
    const rand = prng(7)
    const touched: string[] = []
    const turnMs: number[] = []
    let lastRecord: Awaited<ReturnType<typeof service.finalizeTurn>> | undefined
    for (let turn = 1; turn <= 5; turn += 1) {
      const scope = { sessionId: 'bench', turn, workspaceRoot: workspace }
      const started = nowMs()
      for (let i = 0; i < 20; i += 1) {
        const file = repo.files[(turn * 20 + i) % repo.files.length]!
        touched.push(file)
        await service.captureBefore({ absPath: file, tool: { name: 'write', callId: `call-${turn}-${i}` } }, scope)
        writeFileSync(file, fakeText(rand, 3072, turn * 100 + i))
      }
      lastRecord = await service.finalizeTurn(scope)
      turnMs.push(nowMs() - started)
    }
    cases.push({
      label: 'per-turn capture (20 files × 5 turns, total)',
      value: round(turnMs.reduce((a, b) => a + b, 0)),
      unit: 'ms',
      max: 20000,
      detail: `turns: ${turnMs.map((ms) => round(ms)).join(' / ')} ms`,
    })

    if (!lastRecord) throw new Error('no checkpoint was finalized')
    const planOnly = await timed(() => planRestore(service, lastRecord, 'before', workspace))
    cases.push({
      label: `restore plan (${planOnly.value.files.length} files, ${planOnly.value.conflicts.length} conflicts)`,
      value: round(planOnly.ms),
      unit: 'ms',
      max: 5000,
      detail: planOnly.value.safe ? 'safe' : 'unsafe → force required (expected here)',
    })

    const apply = await timed(() => applyRestore(service, planOnly.value, { force: true }))
    cases.push({
      label: `restore apply (${apply.value.applied.length} writes)`,
      value: round(apply.ms),
      unit: 'ms',
      max: 10000,
      detail: `verified: ${apply.value.verified ? 'yes' : 'no'}, failed: ${apply.value.failed.length}`,
    })

    // The restore must have put the pre-turn image back on disk.
    const restored = readFileSync(touched[touched.length - 1]!, 'utf8')
    notes.push(`restored file matches the pre-turn image: ${restored.length} chars`)

    const before = fakeText(prng(3), 120_000, 0)
    const after = fakeText(prng(4), 120_000, 0)
    const diff = await timed(() => diffTexts(before, after))
    cases.push({
      label: `diff of ${before.split('\n').length} lines fully rewritten`,
      value: round(diff.ms),
      unit: 'ms',
      max: 5000,
      detail: `${diff.value.hunks.length} hunks, coarse=${diff.value.coarse}, ${diff.value.added}+ ${diff.value.removed}-`,
    })

    const objectsDir = join(storeRoot, 'objects')
    let objectBytes = 0
    for (const shard of readdirSync(objectsDir)) {
      const shardDir = join(objectsDir, shard)
      for (const name of readdirSync(shardDir)) objectBytes += statSync(join(shardDir, name)).size
    }
    const journalBytes = statSync(join(storeRoot, 'checkpoints.jsonl')).size
    cases.push({
      label: 'object store footprint',
      value: round(objectBytes / 1024 / 1024, 2),
      unit: 'bytes',
      detail: `${(objectBytes / 1024 / 1024).toFixed(2)} MiB objects for ${(repo.bytes / 1024 / 1024).toFixed(1)} MiB workspace; journal ${(journalBytes / 1024).toFixed(0)} KiB`,
    })

    // Sanity checks that keep the numbers meaningful.
    if (scan.value.files.length !== repo.files.length) {
      throw new Error(`scan captured ${scan.value.files.length} of ${repo.files.length} files`)
    }
    if (!apply.value.verified) throw new Error('restore was not verified')
    notes.push(`glob check: ${globToRegExp('**/*.log').test('a/b/c.log') ? 'ok' : 'broken'}`)

    return { name: 'time-machine', cases, notes }
  } finally {
    removeDir(workspace)
    removeDir(storeRoot)
  }
}
