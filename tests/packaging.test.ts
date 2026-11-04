/**
 * Packaging tests.
 *
 * These do not test behaviour — they test that the two packages can actually be
 * installed and mounted by DeepSeek Harness: the manifest fields the loader
 * reads, the patch file each bundle declares, and (when `pnpm build` has run)
 * the shape of the emitted `lib/index.js`.
 *
 * A packaging regression is silent: the profile installs, the app boots, and the
 * plugin simply never appears. That is why these assertions are in the suite.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const packages = [
  { dir: 'time-machine', pkg: '@harness-ext/time-machine', id: 'harness-ext-time-machine' },
  { dir: 'context-os', pkg: '@harness-ext/context-os', id: 'harness-ext-context-os' },
]

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

for (const entry of packages) {
  const packageDir = join(repoRoot, 'packages', entry.dir)
  const manifest = readJson(join(packageDir, 'package.json'))
  const dsh = manifest.dsh as { bundle?: { patch?: string }; compatibility?: { dshReleases?: Record<string, string> } } | undefined

  test(`${entry.pkg}: manifest is loadable by the harness`, () => {
    assert.equal(manifest.name, entry.pkg)
    assert.equal(manifest.type, 'module')
    assert.equal(manifest.main, 'lib/index.js')
    assert.equal(manifest.types, 'lib/index.d.ts')
    const exportsField = manifest.exports as Record<string, unknown> | undefined
    assert.ok(exportsField?.['.'], 'exports["."] must exist')
    assert.ok(existsSync(join(packageDir, 'lib/index.js')) || !existsSync(join(packageDir, 'lib')),
      'if lib/ exists it must contain index.js (run `pnpm build`)')

    const files = manifest.files as string[]
    for (const required of ['lib', 'src', 'cordis.patch.yml']) assert.ok(files.includes(required), `files must include ${required}`)
  })

  test(`${entry.pkg}: declares a bundle patch and a compatibility entry`, () => {
    assert.equal(dsh?.bundle?.patch, './cordis.patch.yml')
    assert.equal(dsh?.compatibility?.dshReleases?.['0.2.1-rc.5'], 'compatible')
    const patch = readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /^- insert:/m)
    assert.match(patch, new RegExp(`^\\s*- id: ${entry.id}$`, 'm'))
    assert.match(patch, new RegExp(`^\\s*name: '${entry.pkg.replace('/', '\\/')}'$`, 'm'))
  })

  test(`${entry.pkg}: peers cover cordis, session and tools`, () => {
    const peers = manifest.peerDependencies as Record<string, string>
    for (const peer of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools']) {
      assert.ok(peers[peer], `missing peer dependency ${peer}`)
    }
    const deps = manifest.dependencies as Record<string, string>
    assert.equal(deps['@harness-ext/shared'], 'workspace:*')
  })

  test(`${entry.pkg}: the built entry exports a Cordis plugin`, async (t) => {
    const built = join(packageDir, 'lib/index.js')
    if (!existsSync(built)) {
      t.diagnostic('lib/index.js not built yet — run `pnpm build` to cover this assertion')
      return
    }
    const module = (await import(pathToFileURL(built).href)) as Record<string, unknown>
    assert.equal(typeof module.apply, 'function')
    assert.equal(module.name, entry.id)
    assert.ok(Array.isArray(module.inject))
    assert.equal(typeof module.version, 'string')
  })
}

test('patch ids are unique across both bundles', () => {
  const ids: string[] = []
  for (const entry of packages) {
    const patch = readFileSync(join(repoRoot, 'packages', entry.dir, 'cordis.patch.yml'), 'utf8')
    for (const line of patch.split(/\r?\n/)) {
      const match = /^\s*- id:\s*(\S+)\s*$/.exec(line)
      if (match?.[1]) ids.push(match[1])
    }
  }
  assert.ok(ids.length >= 2, `expected at least two ids, got ${ids.join(', ')}`)
  assert.equal(new Set(ids).size, ids.length, `duplicate id in ${ids.join(', ')}`)
})

test('no package ships a stray tarball or build output inside src', () => {
  for (const entry of packages) {
    const srcDir = join(repoRoot, 'packages', entry.dir, 'src')
    const offenders = readdirSync(srcDir, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.js') || name.endsWith('.tgz') || name.endsWith('.d.ts'))
    assert.deepEqual(offenders, [], `unexpected build output under src/: ${offenders.join(', ')}`)
  }
})
