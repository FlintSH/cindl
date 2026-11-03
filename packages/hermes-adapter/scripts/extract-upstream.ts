// Regenerates upstream/<tag>/contract-subset.json from a local checkout of the
// public Hermes source at the pinned tag. Development tool only: it reads the
// generated OpenRPC file as data and never executes upstream code.
//
//   node scripts/extract-upstream.ts --source /path/to/hermes-agent --tag v0.22.5
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  answeredServerRequests,
  canonicalMethods,
  handledNotifications,
  sidecarMethods,
} from '../src/upstream-surface.ts'

const arg = (name: string) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const source = arg('--source')
const tag = arg('--tag') ?? 'v0.22.5'
if (!source) throw new Error('Pass --source <path to a hermes-agent checkout>')

const relative = 'apps/shared/src/gateway-contract.openrpc.json'
const raw = await readFile(resolve(source, relative), 'utf8')
const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
const doc = JSON.parse(raw) as {
  methods: Array<{ name: string }>
  components: { schemas: Record<string, unknown> }
  'x-canonical-methods': Array<{ name: string }>
  'x-server-requests': Array<{ name: string }>
  'x-notifications': Array<{ name: string }>
}

const pick = <T extends { name: string }>(
  list: T[],
  names: readonly string[],
  kind: string,
) =>
  names.map((name) => {
    const entry = list.find((item) => item.name === name)
    if (!entry) throw new Error(`${kind} ${name} is absent from ${relative} at ${tag}`)
    return entry
  })
const methods = pick(doc.methods, sidecarMethods, 'method')
const canonical = pick(doc['x-canonical-methods'], canonicalMethods, 'canonical method')
const serverRequests = pick(
  doc['x-server-requests'],
  answeredServerRequests,
  'server request',
)
const notifications = pick(doc['x-notifications'], handledNotifications, 'notification')

// Transitive closure of referenced component schemas.
const schemas: Record<string, unknown> = {}
const pending = [JSON.stringify([methods, canonical, serverRequests, notifications])]
while (pending.length) {
  for (const [, name] of (pending.pop() ?? '').matchAll(
    /"#\/components\/schemas\/([^"]+)"/g,
  )) {
    if (!name || name in schemas) continue
    const schema = doc.components.schemas[name]
    if (schema === undefined) throw new Error(`Unresolved upstream schema ${name}`)
    schemas[name] = schema
    pending.push(JSON.stringify(schema))
  }
}

const sorted = Object.fromEntries(
  Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b)),
)
const subset = {
  provenance: {
    project: 'NousResearch/hermes-agent',
    license: 'MIT (see LICENSE.hermes-agent)',
    tag,
    commit,
    file: relative,
    sha256: createHash('sha256').update(raw).digest('hex'),
    note: 'Subset of the upstream generated contract. Regenerate with scripts/extract-upstream.ts; do not edit by hand.',
  },
  methods,
  canonicalMethods: canonical,
  serverRequests,
  notifications,
  components: { schemas: sorted },
}
const out = fileURLToPath(
  new URL(`../upstream/${tag}/contract-subset.json`, import.meta.url),
)
await writeFile(out, JSON.stringify(subset, null, 1) + '\n')
console.log(
  `wrote ${out}: ${methods.length} methods, ${canonical.length} canonical, ${serverRequests.length} server requests, ${notifications.length} notifications, ${Object.keys(sorted).length} schemas`,
)
