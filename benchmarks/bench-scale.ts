/**
 * Scale benchmark: a repository far larger than the unit fixtures.
 *
 * `pnpm bench` stays fast because it runs on every CI job; this script is the
 * opt-in "large repository" measurement. It builds 10 000 files (~12 MiB), then
 * measures the two paths that touch every file — the workspace scan and the full
 * snapshot — plus a turn-sized capture and a 50-file restore.
 *
 * Run it with:
 *
 *     pnpm bench:scale
 *
 * Nothing here is asserted: absolute numbers depend on the disk (NVMe vs network
 * share) far more than on the code, so the point is the shape — scan is linear in
 * file count, snapshot is linear in bytes, per-turn capture is proportional to
 * the files a turn touched.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CheckpointService } from '../packages/time-machine/src/core/checkpoint-service.ts'
import { scanWorkspace } from '../packages/time-machine/src/core/workspace-scan.ts'
import { planRestore, applyRestore } from '../packages/time-machine/src/core/restore.ts'
import { IgnorePolicy } from '../packages/shared/src/ignore.ts'
import { makeSyntheticRepo, makeTempDir, nowMs, percentile, round, timed } from './lib/fixture.ts'

const FILES = Number(process.env['BENCH_SCALE_FILES'] ?? 10_000)

async function main(): Promise<void> {
  const dir = makeTempDir('scale-bench')
  const workspace = join(dir, 'ws')
  mkdirSync(workspace, { recursive: true })
  const store = new CheckpointService({ root: join(dir, 'store') })
  try {
    const created = await timed(() => makeSyntheticRepo(workspace, { count: FILES, bytesPerFile: 1200, dirs: 120 }))
    log(`fixture: ${String(FILES)} files, ${(created.value.bytes / 1024 / 1024).toFixed(1)} MiB, created in ${round(created.ms, 0)} ms`)

    const scanned = await timed(() => scanWorkspace(workspace, { policy: new IgnorePolicy(), maxFiles: FILES * 2 }))
    log(
      `scan: ${round(scanned.ms, 0)} ms for ${String(scanned.value.files.length)} files ` +
        `(${round(scanned.ms / Math.max(1, scanned.value.files.length), 3)} ms/file, truncated=${String(scanned.value.truncated)})`,
    )

    const snapshot = await timed(() =>
      store.createSnapshot({ workspaceRoot: workspace, origin: 'manual', label: `scale-${String(FILES)}` }),
    )
    const record = snapshot.value.record
    log(
      `snapshot: ${round(snapshot.ms, 0)} ms, ${String(record.files.length)} files, ` +
        `${round((created.value.bytes / 1024 / 1024 / (snapshot.ms / 1000)), 2)} MiB/s target rate`,
    )

    // A turn touches a handful of files; capture cost must not depend on repo size.
    const samples: number[] = []
    for (let turn = 0; turn < 5; turn += 1) {
      const scope = { sessionId: `s${String(turn)}`, turn, workspaceRoot: workspace }
      const started = nowMs()
      for (let index = 0; index < 20; index += 1) {
        const target = record.files[(turn * 20 + index) % record.files.length]!
        await store.captureBefore({ absPath: target.path.startsWith('/') ? target.path : join(workspace, target.path) }, scope)
      }
      await store.finalizeTurn(scope)
      samples.push(nowMs() - started)
    }
    log(
      `turn capture: 5 turns x 20 files, median ${round(percentile(samples, 0.5), 0)} ms/turn ` +
        `(p95 ${round(percentile(samples, 0.95), 0)} ms)`,
    )

    // Drift 50 files away from the snapshot, then measure a real restore.
    const drifted = record.files.slice(0, 50).map((entry) => join(workspace, entry.path))
    for (const [index, file] of drifted.entries()) writeFileSync(file, `// drifted ${String(index)}\n`)

    const planned = await timed(() => planRestore(store, record, 'before', workspace))
    const plan = planned.value
    const applied = await timed(() => applyRestore(store, plan, { force: true }))
    log(
      `restore: plan of ${String(record.files.length)} entries in ${round(planned.ms, 0)} ms ` +
        `(${String(plan.summary.writes)} writes, ${String(plan.summary.unchanged)} unchanged, safe=${String(plan.safe)}), ` +
        `applied ${String(applied.value.applied.length)} writes in ${round(applied.ms, 0)} ms, verified=${String(applied.value.verified)}`,
    )
    if (applied.value.applied.length !== 50) {
      throw new Error(`expected 50 restored files, got ${String(applied.value.applied.length)}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function log(line: string): void {
  process.stdout.write(`  ${line}\n`)
}

await main()
