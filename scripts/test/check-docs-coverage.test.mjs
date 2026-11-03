import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { makeRepo, run, writeFiles } from './helpers.mjs'

// A miniature Cindl: the same exports the real sources have, without Zod.
const CONTRACTS = `const text = { type: 'string' }
export const Widget = { type: 'object' }
export const capabilityIds = ['alpha.read', 'alpha.write'] as const
export const errorCodes = ['denied', 'gone'] as const
export const clientOps = {
  'alpha.get': { summary: 'Read alpha.', mutates: false, capability: 'alpha.read' },
  'alpha.set': { summary: 'Write alpha.', mutates: true, capability: 'alpha.write' },
}
export const CindlEvent = {
  options: [
    { shape: { type: { value: 'alpha.changed' }, widget: Widget } },
    {
      shape: {
        type: { value: 'alpha.removed' },
        id: text,
        reason: { type: 'optional', def: { innerType: { type: 'enum', options: ['gone', 'moved'] } } },
      },
    },
  ],
}
`
const SHORTCUTS = `export const shortcuts = [
  { id: 'palette', keys: ['Mod', 'K'], label: 'Open the palette', global: true },
  { id: 'help', keys: ['?'], label: 'Show shortcuts' },
]
export const keyLabel = (key: string) =>
  key === 'Mod' ? (/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl') : key
`
const UPSTREAM = `export const sidecarMethods = ['session.list'] as const
export const canonicalMethods = ['runtime.describe'] as const
export const answeredServerRequests = ['approval'] as const
export const handledNotifications = ['gateway.ready'] as const
`
const COMPAT = `export const restEndpoints = {
  status: { method: 'GET', path: '/api/status', auth: 'public' },
} as const
`
const block = (name) =>
  `<!-- BEGIN GENERATED: ${name}. Fixture. -->\n\n<!-- END GENERATED: ${name} -->\n`
const EVENTS = `# Events and errors

${block('events')}
## Events

### \`alpha.changed\`

Alpha changed in the synthetic fixture world, and the reducer stores it.

### \`alpha.removed\`

Alpha was removed from the synthetic fixture world; the reducer drops it.

## Error codes

| Code     | Meaning                |
| -------- | ---------------------- |
| \`denied\` | The fixture said no.   |
| \`gone\`   | It no longer exists.   |
`
const FILES = {
  'packages/contracts/src/index.ts': CONTRACTS,
  'apps/web/src/shortcuts.ts': SHORTCUTS,
  'packages/hermes-adapter/src/upstream-surface.ts': UPSTREAM,
  'packages/hermes-adapter/src/compat.ts': COMPAT,
  'docs/handbook/reference/capabilities.md':
    '# Capabilities\n\n| Capability | Meaning |\n| --- | --- |\n| `alpha.read` | Read alpha |\n| `alpha.write` | Write alpha |\n',
  'docs/handbook/reference/events.md': EVENTS,
  'docs/handbook/reference/client-operations.md': `# Client operations\n\n${block('client-operations')}`,
  'docs/handbook/reference/keyboard-shortcuts.md': `# Keyboard shortcuts\n\n${block('keyboard-shortcuts')}`,
  'docs/handbook/reference/hermes-v0.22.5.md':
    '# Hermes\n\nMethods `session.list` and `runtime.describe`; request `approval`; notification `gateway.ready`; route `GET /api/status`.\n',
  'docs/handbook/clients/web.md':
    '# Web client\n\n## Keyboard\n\n| Keys | Action |\n| --- | --- |\n| `Ctrl/⌘ K` | Open the palette |\n| `?` | Show shortcuts |\n',
  '.gitignore': 'docs/handbook/.vitepress/dist/\n',
}

/** A fixture repository with generated tables filled in, then `changes` applied. */
function fixture(t, changes = {}) {
  const dir = makeRepo(t, FILES)
  const generated = run('generate-docs-reference.mjs', ['--root', dir])
  assert.equal(generated.code, 0, generated.output)
  writeFiles(dir, changes)
  return dir
}

const coverage = (dir) => run('check-docs-coverage.mjs', ['--root', dir])

function assertFails(dir, pattern) {
  const result = coverage(dir)
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, pattern)
}

const read = (dir, path) => readFileSync(join(dir, path), 'utf8')

describe('check-docs-coverage', () => {
  it('passes when every source item is documented', (t) => {
    const dir = fixture(t)
    const result = coverage(dir)
    assert.equal(result.code, 0, result.output)
    assert.match(
      result.output,
      /2 capabilities, 2 client operations, 2 events, 2 error codes/,
    )
    const operations = read(dir, 'docs/handbook/reference/client-operations.md')
    assert.match(
      operations,
      /\| `alpha\.set` +\| `alpha\.write` +\| yes +\| Write alpha\. +\|/,
    )
    const shortcuts = read(dir, 'docs/handbook/reference/keyboard-shortcuts.md')
    assert.match(
      shortcuts,
      /<kbd>Ctrl<\/kbd> \+ <kbd>K<\/kbd> +\| <kbd>⌘<\/kbd> \+ <kbd>K<\/kbd>/,
    )
    const events = read(dir, 'docs/handbook/reference/events.md')
    assert.match(events, /`reason`: optional `gone` \/ `moved`/)
    assert.match(events, /\[`alpha\.changed`\]\(#alpha-changed\) +\| `widget`: Widget/)
  })

  it('finds missing and stale capabilities', (t) => {
    const page = 'docs/handbook/reference/capabilities.md'
    assertFails(
      fixture(t, {
        [page]:
          '# Capabilities\n\n| Capability | Meaning |\n| --- | --- |\n| `alpha.read` | Read |\n',
      }),
      /capability `alpha\.write` is not documented/,
    )
    assertFails(
      fixture(t, {
        [page]: `${FILES[page]}| \`alpha.delete\` | Delete |\n`,
      }),
      /documents `alpha\.delete`, which is not a current capability/,
    )
    assertFails(
      fixture(t, { [page]: FILES[page].replace('| Write alpha |', '|  |') }),
      /the row for `alpha\.write` has an empty cell/,
    )
  })

  it('fails when a generated table no longer matches the source', (t) => {
    const dir = fixture(t)
    writeFiles(dir, {
      'packages/contracts/src/index.ts': CONTRACTS.replace(
        'Write alpha.',
        'Replace alpha.',
      ),
    })
    assertFails(dir, /client-operations\.md: generated tables are out of date/)
    const check = run('generate-docs-reference.mjs', ['--root', dir, '--check'])
    assert.equal(check.code, 1)
    assert.equal(run('generate-docs-reference.mjs', ['--root', dir]).code, 0)
    assert.equal(coverage(dir).code, 0)
  })

  it('requires a described section for every event and a row for every error code', (t) => {
    const page = 'docs/handbook/reference/events.md'
    const dir = fixture(t)
    const events = read(dir, page)
    writeFiles(dir, { [page]: events.replace(/### `alpha\.removed`\n\n.*\n/, '') })
    assertFails(dir, /event type `alpha\.removed` is not documented/)
    writeFiles(dir, {
      [page]: events.replace(
        'Alpha was removed from the synthetic fixture world; the reducer drops it.',
        'Gone.',
      ),
    })
    assertFails(dir, /`alpha\.removed` needs a description/)
    writeFiles(dir, { [page]: events.replace(/\| `gone`.*\n/, '') })
    assertFails(dir, /error code `gone` is not documented/)
  })

  it('requires every pinned Hermes name and REST endpoint', (t) => {
    const page = 'docs/handbook/reference/hermes-v0.22.5.md'
    assertFails(
      fixture(t, { [page]: FILES[page].replace('`gateway.ready`', 'gateway ready') }),
      /handled notification `gateway\.ready` is missing/,
    )
    assertFails(
      fixture(t, {
        [page]: FILES[page].replace('`GET /api/status`', 'the status route'),
      }),
      /REST endpoint `GET \/api\/status` is missing/,
    )
  })

  it('rejects placeholder text outside code', (t) => {
    assertFails(
      fixture(t, { 'docs/handbook/guide.md': '# Guide\n\nTODO: write this page.\n' }),
      /guide\.md: placeholder text "TODO" outside code/,
    )
    assert.equal(
      coverage(
        fixture(t, { 'docs/handbook/guide.md': '# Guide\n\nThe gate rejects `TODO`.\n' }),
      ).code,
      0,
    )
  })

  it('fails when a page is missing', (t) => {
    assertFails(
      fixture(t, { 'docs/handbook/reference/capabilities.md': null }),
      /capabilities\.md: page is missing/,
    )
  })

  it('resolves root links in handbook pages to the public folder, as VitePress serves it', (t) => {
    const ok = fixture(t, {
      'docs/handbook/public/screenshots/web/demo.png': 'png',
      'docs/handbook/guide.md': '# Guide\n\n![Demo](/screenshots/web/demo.png)\n',
    })
    assert.equal(coverage(ok).code, 0, coverage(ok).output)
    assertFails(
      fixture(t, {
        'docs/handbook/guide.md': '# Guide\n\n![Demo](/screenshots/web/missing.png)\n',
      }),
      /guide\.md:3: links to \/screenshots\/web\/missing\.png, which does not exist/,
    )
  })

  it('finds links and file references that point nowhere', (t) => {
    assertFails(
      fixture(t, {
        'docs/handbook/guide.md': '# Guide\n\nSee [events](reference/nothing.md).\n',
      }),
      /guide\.md:3: links to reference\/nothing\.md, which does not exist/,
    )
    assertFails(
      fixture(t, {
        'packages/hermes-adapter/src/compat.ts': `// See docs/handbook/reference/missing-page.md\n${COMPAT}`,
      }),
      /compat\.ts:1: names docs\/handbook\/reference\/missing-page\.md, which does not exist/,
    )
    assertFails(
      fixture(t, {
        'packages/contracts/src/note.ts': '// (see docs: guide/nowhere)\nexport {}\n',
      }),
      /"docs: guide\/nowhere" is not a handbook page/,
    )
    assertFails(
      fixture(t, {
        'README.md': '[Design](https://github.com/FlintSH/cindl/blob/main/DESIGN.md)\n',
      }),
      /README\.md:1: links to https:\/\/github\.com\/FlintSH\/cindl\/blob\/main\/DESIGN\.md/,
    )
    const ignored = fixture(t, {
      'docs/handbook/guide.md':
        '# Guide\n\nThe site builds into `docs/handbook/.vitepress/dist`.\n',
    })
    assert.equal(coverage(ignored).code, 0)
  })

  it('checks the key combinations in the web client page', (t) => {
    const web = (rows) =>
      `# Web client\n\n## Keyboard\n\n| Keys | Action |\n| --- | --- |\n${rows.join('\n')}\n`
    const page = 'docs/handbook/clients/web.md'
    const good = ['| `Ctrl/⌘ K` | Open the palette |', '| `?` | Show shortcuts |']
    assert.equal(coverage(fixture(t, { [page]: web(good) })).code, 0)
    assert.equal(
      coverage(
        fixture(t, {
          [page]: web([...good, '| `Enter` / `Shift Enter` | Send / new line |']),
        }),
      ).code,
      0,
    )
    assertFails(
      fixture(t, { [page]: web([good[0]]) }),
      /web\.md: the keyboard table is missing \? \(Show shortcuts\)/,
    )
    assertFails(
      fixture(t, { [page]: web([...good, '| `Alt 1` to `Alt 2` | Go places |']) }),
      /web\.md: the keyboard table lists Alt\+1, which is not in apps\/web\/src\/shortcuts\.ts/,
    )
    assertFails(
      fixture(t, { [page]: web([...good, '| Press both | Something |']) }),
      /web\.md: cannot read the keys in "Press both"/,
    )
    assertFails(
      fixture(t, { [page]: '# Web client\n\n## Shortcuts\n\nSee the app.\n' }),
      /web\.md: no "Keyboard" section/,
    )
    assertFails(
      fixture(t, { [page]: '# Web client\n\n## Keyboard\n\nPress keys.\n' }),
      /web\.md: the Keyboard section has no "Keys" table and no link/,
    )
    const linked =
      '# Web client\n\n## Keyboard shortcuts\n\nSee [the list](../reference/keyboard-shortcuts.md).\n'
    assert.equal(coverage(fixture(t, { [page]: linked })).code, 0)
    assertFails(fixture(t, { [page]: null }), /clients\/web\.md: page is missing/)
  })

  it('fails instead of passing when a source list is empty', (t) => {
    const dir = fixture(t)
    writeFiles(dir, {
      'packages/contracts/src/index.ts': CONTRACTS.replace(
        "['alpha.read', 'alpha.write']",
        '[]',
      ),
    })
    assertFails(dir, /no capability ids found/)
  })
})
