// Loads the machine-readable sources the handbook must cover, straight from the
// TypeScript source (Node 24 strips types). Nothing is copied or cached, so the
// docs gates always compare against the code being checked.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const sourcePaths = {
  contracts: 'packages/contracts/src/index.ts',
  shortcuts: 'apps/web/src/shortcuts.ts',
  upstream: 'packages/hermes-adapter/src/upstream-surface.ts',
  compat: 'packages/hermes-adapter/src/compat.ts',
}

async function load(root, path) {
  try {
    return await import(pathToFileURL(resolve(root, path)).href)
  } catch (error) {
    throw new Error(
      `could not load ${path} (${error.message}). Install root dependencies first: pnpm install --frozen-lockfile`,
      { cause: error },
    )
  }
}

function nonEmpty(list, what) {
  if (!Array.isArray(list) || list.length === 0)
    throw new Error(
      `no ${what} found; was the export renamed? Update scripts/lib/sources.mjs`,
    )
  return list
}

/** Describe a Zod 4 schema in a few words, naming exported schemas. */
function describe(schema, names) {
  const name = names.get(schema)
  if (name) return name
  switch (schema?.type) {
    case 'optional':
      return describe(schema.def.innerType, names)
    case 'enum':
      return schema.options.map((option) => `\`${option}\``).join(' / ')
    case 'literal':
      return `\`${String(schema.value)}\``
    case 'union':
      return schema.options.map((option) => describe(option, names)).join(' / ')
    case 'array':
      return `${describe(schema.element, names)}[]`
    case undefined:
      throw new Error('unrecognised schema in a CindlEvent payload')
    default:
      return schema.type
  }
}

/** Every event type with its payload fields, in contract order. */
function eventsOf(contracts) {
  const names = new Map(
    Object.entries(contracts)
      .filter(([key, value]) => key !== 'CindlEvent' && typeof value?.type === 'string')
      .map(([key, value]) => [value, key]),
  )
  const options = nonEmpty(contracts.CindlEvent?.options, 'CindlEvent variants')
  return options.map((option) => {
    const { type, ...fields } = option.shape
    return {
      type: type.value,
      fields: Object.entries(fields).map(([field, schema]) => ({
        name: field,
        optional: schema.type === 'optional',
        description: describe(schema, names),
      })),
    }
  })
}

/** Call `keyLabel` as a given platform would, without leaking the override. */
function labelsFor(keyLabel, platform, keys) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform, userAgent: '' },
    configurable: true,
  })
  try {
    return keys.map((key) => keyLabel(key))
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else delete globalThis.navigator
  }
}

export async function loadSources(root) {
  const contracts = await load(root, sourcePaths.contracts)
  const shortcutModule = await load(root, sourcePaths.shortcuts)
  const upstream = await load(root, sourcePaths.upstream)
  const compat = await load(root, sourcePaths.compat)

  const operations = Object.entries(contracts.clientOps ?? {}).map(([name, op]) => ({
    name,
    capability: op.capability ?? null,
    mutates: op.mutates,
    summary: op.summary,
  }))
  if (typeof shortcutModule.keyLabel !== 'function')
    throw new Error(`${sourcePaths.shortcuts} no longer exports keyLabel`)
  const shortcuts = nonEmpty(shortcutModule.shortcuts, 'keyboard shortcuts').map(
    (shortcut) => ({
      id: shortcut.id,
      label: shortcut.label,
      global: shortcut.global === true,
      keys: [...shortcut.keys],
      windows: labelsFor(shortcutModule.keyLabel, 'Win32', shortcut.keys),
      mac: labelsFor(shortcutModule.keyLabel, 'MacIntel', shortcut.keys),
    }),
  )
  return {
    capabilityIds: [...nonEmpty(contracts.capabilityIds, 'capability ids')],
    operations: nonEmpty(operations, 'client operations'),
    events: eventsOf(contracts),
    errorCodes: [...nonEmpty(contracts.errorCodes, 'error codes')],
    shortcuts,
    upstream: {
      'legacy sidecar method': nonEmpty(upstream.sidecarMethods, 'sidecar methods'),
      'canonical method': nonEmpty(upstream.canonicalMethods, 'canonical methods'),
      'answered server request': nonEmpty(
        upstream.answeredServerRequests,
        'answered server requests',
      ),
      'handled notification': nonEmpty(upstream.handledNotifications, 'notifications'),
    },
    restEndpoints: nonEmpty(
      Object.entries(compat.restEndpoints ?? {}).map(([name, endpoint]) => ({
        name,
        ...endpoint,
      })),
      'REST endpoints',
    ),
  }
}
