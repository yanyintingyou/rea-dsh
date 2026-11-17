#!/usr/bin/env node
/**
 * Make an installed rea-agents package serve DeepSeek Harness.
 *
 * DSH forwards MCP tool schemas to the model API, which rejects a schema whose
 * `pattern` cannot compile. rea-agents 6.9.0 emits `^[^\uD800-\uDFFF]*$` for its
 * local-path fields, and that API rejects the whole request with
 * `Invalid schema for function "mcp__rea__binary_session"`.
 *
 * The script patches a stock install in place:
 *   1. `.regex(/^[^\uD800-\uDFFF]*$/u, msg)` becomes `.refine((value) => ...,
 *      msg)`. Zod emits no `pattern` for a refine, and the runtime check stays.
 *   2. The `{"pattern":"^[^\\uD800-\\uDFFF]*$"}` entries are removed from the
 *      pre-generated tool catalogs that `tools/list` actually serves.
 *   3. The two catalog digests that the server verifies at startup are
 *      recomputed, otherwise it exits with "REA could not start".
 *
 * Usage: node dsh/apply-dsh-patch.mjs [path/to/rea-agents]
 *        The default target is ./node_modules/rea-agents.
 *
 * Re-running is safe: files that already carry the patch are left alone.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REGEX_CALL = /\.regex\((\/\^\[\^\\uD800-\\uDFFF\]\*\$\/u), ("[^"]*")\)/g
const REFINE_CALL = /\.refine\(\(value\) => \/\^\[\^\\uD800-\\uDFFF\]\*\$\/u\.test\(value\)/
const CATALOG_PATTERN = String.raw`,{"pattern":"^[^\\uD800-\\uDFFF]*$"}`
const CATALOGS = [
  { file: 'mcp-catalog.json', profile: 'compact' },
  { file: 'mcp-catalog-full.json', profile: 'full' },
]

const target = resolve(process.argv[2] ?? 'node_modules/rea-agents')
const manifestPath = join(target, 'package.json')
const distPath = join(target, 'dist')

function fail(message) {
  console.error(`apply-dsh-patch: ${message}`)
  process.exit(1)
}

if (!existsSync(manifestPath) || !existsSync(distPath)) {
  fail(`no rea-agents package at ${target} (expected package.json and dist/)`)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

function scriptFiles(directory) {
  const found = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) found.push(...scriptFiles(path))
    else if (entry.endsWith('.js')) found.push(path)
  }
  return found
}

// Step 1: strip the pattern object from each catalog, then hash what the server will serve.
const digests = {}
for (const catalog of CATALOGS) {
  const path = join(distPath, catalog.file)
  const original = readFileSync(path, 'utf8')
  const next = original.split(CATALOG_PATTERN).join('')
  if (next.includes('uD800')) {
    fail(`${catalog.file} still contains a lone-surrogate pattern; check the rea-agents version`)
  }
  if (next !== original) writeFileSync(path, next)
  catalog.removed = original.length - next.length
  digests[catalog.profile] = sha256(next)
}

// Step 2: the digests the previous install recorded, so every copy can be updated.
const recordedPath = join(distPath, 'recordedMcpCatalog.js')
const previous = Object.fromEntries(
  [...readFileSync(recordedPath, 'utf8').matchAll(/"(\w+)":"([a-f0-9]{64})"/g)].map((m) => [m[1], m[2]]),
)

// Step 3: rewrite the regex call and the recorded digests across the runtime scripts.
let refineFiles = 0
let digestFiles = 0
for (const path of scriptFiles(distPath)) {
  const original = readFileSync(path, 'utf8')
  let next = original

  next = next.replace(REGEX_CALL, (_, pattern, message) => `.refine((value) => ${pattern}.test(value), ${message})`)
  if (next !== original) refineFiles += 1

  let digestTouched = false
  for (const [profile, digest] of Object.entries(digests)) {
    const before = previous[profile]
    if (!before || before === digest) continue
    if (!next.includes(before)) continue
    next = next.split(before).join(digest)
    digestTouched = true
  }
  if (digestTouched) digestFiles += 1
  if (next !== original) writeFileSync(path, next)
}

// Correctness: the patched path schema is on disk and the new digests are recorded.
if (!REFINE_CALL.test(readFileSync(join(distPath, 'domain', 'localPath.js'), 'utf8'))) {
  fail('dist/domain/localPath.js does not carry the patched path schema; check the rea-agents version')
}
const recordedNow = readFileSync(recordedPath, 'utf8')
for (const [profile, digest] of Object.entries(digests)) {
  if (!recordedNow.includes(digest)) fail(`${recordedPath} does not record the new ${profile} digest`)
}

console.log(`rea-agents ${manifest.version} at ${target}`)
console.log(`refine call rewritten in ${refineFiles} script(s); digest references updated in ${digestFiles}`)
console.log(CATALOGS.map((c) => `${c.file}: ${c.removed} bytes of pattern removed`).join('; '))
console.log(`catalogs: compact ${digests.compact}  full ${digests.full}`)
console.log(`entry: ${join(target, 'scripts', 'rea.mjs')}`)
