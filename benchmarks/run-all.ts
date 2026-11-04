/**
 * Benchmark runner.
 *
 *   node benchmarks/run-all.ts            # run everything, write results/
 *   node benchmarks/run-all.ts recall     # run only benchmarks whose name matches
 *
 * Exit code is non-zero when an assertion in `BenchCase.min`/`max` fails, so the
 * command is usable in CI without a separate script. Results are written to
 * `benchmarks/results/latest.json` (machine) and `benchmarks/results/latest.md`
 * (paste into a PR).
 *
 * Reproducibility: all fixtures are generated from fixed seeds; the numbers
 * depend on the machine (CPU, filesystem, antivirus) — compare runs on the same
 * machine, not across machines.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, round } from './lib/fixture.ts'
import type { BenchResult } from './lib/fixture.ts'

const here = dirname(fileURLToPath(import.meta.url))
const filter = process.argv[2]?.toLowerCase()

const modules: Array<{ name: string; run: () => Promise<BenchResult> }> = [
  { name: 'checkpoint', run: async () => (await import('./bench-checkpoint.ts')).run() },
  { name: 'recall', run: async () => (await import('./bench-recall.ts')).run() },
  { name: 'brief', run: async () => (await import('./bench-brief.ts')).run() },
]

function formatValue(value: number, unit: string): string {
  if (unit === 'ratio') return value.toFixed(3)
  if (unit === 'bytes') return `${value.toFixed(2)} MiB`
  if (unit === 'count') return String(value)
  return `${value}${unit}`
}

async function main(): Promise<void> {
  const selected = modules.filter((m) => !filter || m.name.includes(filter))
  if (selected.length === 0) {
    console.error(`no benchmark matches "${filter}"`)
    process.exitCode = 1
    return
  }
  const started = Date.now()
  const results: BenchResult[] = []
  for (const module of selected) {
    process.stdout.write(`\n▶ ${module.name}\n`)
    try {
      const result = await module.run()
      results.push(result)
      for (const c of result.cases) {
        console.log(`  · ${c.label}: ${formatValue(c.value, c.unit)}${c.detail ? `  — ${c.detail}` : ''}`)
      }
      for (const note of result.notes ?? []) console.log(`    ${note}`)
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
      console.error(`  ✗ ${module.name} failed: ${message}`)
      results.push({ name: module.name, cases: [], notes: [`FAILED: ${message.split('\n')[0]}`] })
    }
  }

  const { failures } = evaluate(results)
  const elapsed = Date.now() - started
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    elapsedMs: elapsed,
    results,
    failures,
  }

  const outDir = join(here, 'results')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  const lines: string[] = [
    '# Benchmark results',
    '',
    `- generated: ${report.generatedAt}`,
    `- node: ${report.node} (${report.platform}/${report.arch})`,
    `- wall time: ${(elapsed / 1000).toFixed(1)} s`,
    '',
  ]
  for (const result of results) {
    lines.push(`## ${result.name}`, '', '| case | value | note |', '| --- | --- | --- |')
    for (const c of result.cases) {
      lines.push(`| ${c.label} | ${formatValue(c.value, c.unit)} | ${c.detail ?? ''} |`)
    }
    if (result.notes?.length) {
      lines.push('', '<details><summary>notes</summary>', '')
      for (const note of result.notes) lines.push(`- ${note}`)
      lines.push('', '</details>')
    }
    lines.push('')
  }
  lines.push(failures.length === 0 ? '**All assertions passed.**' : '**Assertion failures:**')
  for (const failure of failures) lines.push(`- ${failure}`)
  writeFileSync(join(outDir, 'latest.md'), `${lines.join('\n')}\n`, 'utf8')

  console.log(`\n─────────────────────────────────────────────`)
  for (const result of results) {
    const worst = result.cases.reduce(
      (acc, c) => (c.unit === 'ms' && c.value > acc.value ? { label: c.label, value: c.value } : acc),
      { label: '', value: 0 },
    )
    console.log(`${result.name.padEnd(22)} ${String(result.cases.length).padStart(2)} cases${worst.label ? `   slowest: ${worst.label} ${round(worst.value)}ms` : ''}`)
  }
  console.log(`results: benchmarks/results/latest.{json,md}  (${(elapsed / 1000).toFixed(1)} s)`)
  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion failure(s):`)
    for (const failure of failures) console.error(`  ✗ ${failure}`)
    process.exitCode = 1
  }
}

await main()
