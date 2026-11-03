import assert from 'node:assert/strict'
import { symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fake, git, makeRepo, run, tempDir, writeFiles } from './helpers.mjs'

// A fictional copyright holder: the scanner reads the name from LICENSE.
const HOLDER = 'Quinlan Vexmoor'
const BASE = {
  LICENSE: `MIT License\n\nCopyright (c) 2026 ${HOLDER}\n`,
  'README.md': `# Fixture\n\nAbout it.\n\n## Licence\n\nMIT, Copyright (c) 2026 ${HOLDER}.\n`,
  'docs/guide.md': '# Guide\n\nConnect to https://hermes.example.test from 127.0.0.1.\n',
}

/** Scan a fixture repository made of BASE plus `files` (all tracked). */
function scan(t, files = {}, args = [], env = {}) {
  const dir = makeRepo(t, { ...BASE, ...files })
  return run('check-privacy.mjs', ['--root', dir, ...args], { env })
}

function assertFlagged(result, pattern) {
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, pattern)
}

describe('check-privacy', () => {
  it('passes a repository with only synthetic data', (t) => {
    const result = scan(t, {
      'docs/hosts.md': [
        'Use 192.0.2.10, 198.51.100.7, 203.0.113.9, 127.0.0.1, 0.0.0.0, 10.0.2.2 or [::1].',
        'IPv6 examples use 2001:db8::1. Versions such as 1.2.3.4.5 are not addresses.',
        'Mail person@example.test, owner@studio.example or someone@hermes.invalid.',
        'Sign in at https://u:p@hermes.example.test/login.',
      ].join('\n'),
      'src/storage.ts': 'const scope = chrome.storage.local\nexport default scope\n',
    })
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /no secrets, private addresses or personal data found/)
  })

  it('flags private and public IPv4 addresses', (t) => {
    const lan = ['192', '168', '4', '20'].join('.')
    const result = scan(t, { 'docs/net.md': `The host is ${lan}.\n` })
    assertFlagged(result, /docs\/net\.md:1: IPv4 address/)
    assert.doesNotMatch(result.output, new RegExp(lan.replace(/\./g, '\\.')))
  })

  it('flags IPv6 addresses outside the documentation range', (t) => {
    const ula = ['fd7a', '115c', 'a1e0', '', '1'].join(':')
    assertFlagged(scan(t, { 'config/net.yml': `host: ${ula}\n` }), /IPv6 address/)
  })

  it('flags personal email addresses', (t) => {
    const email = ['someone', 'gmail.com'].join('@')
    const result = scan(t, { 'docs/team.md': `Contact ${email}.\n` })
    assertFlagged(result, /email address/)
    assert.doesNotMatch(result.output, /someone@/)
  })

  it('flags private hostnames in documents, and in code where they are hosts', (t) => {
    const nas = ['nas', 'local'].join('.')
    assertFlagged(
      scan(t, { 'docs/home.md': `Files live on ${nas}.\n` }),
      /private hostname/,
    )
    const url = `const url = 'http://${['router', 'lan'].join('.')}:8080/'\n`
    assertFlagged(scan(t, { 'src/net.ts': url }), /private hostname \(\.lan\)/)
    const tailnet = ['box', 'tail1234', 'ts', 'net'].join('.')
    assertFlagged(
      scan(t, { 'src/x.ts': `// ${tailnet}\n` }),
      /private hostname \(\.ts\.net\)/,
    )
  })

  it('flags credentials in URLs for real hosts', (t) => {
    const url = `https://admin:${'hunter'}2@${['git', 'corp-example', 'net'].join('.')}/repo`
    assertFlagged(scan(t, { 'docs/clone.md': `Clone ${url}\n` }), /credentials in a URL/)
  })

  it('flags every secret format, and never prints the secret', (t) => {
    const secrets = {
      'PEM private key': fake('-----BEGIN ', 'RSA PRIVATE', ' KEY-----'),
      'JSON Web Token': fake(
        'eyJ',
        'hbGciOiJIUzI1NiJ9',
        '.',
        'eyJ',
        'zdWIiOiJmaXh0dXJlIn0',
        '.',
        'c2lnbmF0dXJlMTIz',
      ),
      'GitHub token': fake('gh', 'p_', 'A1b2'.repeat(9)),
      'AWS access key id': fake('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
      'OpenAI or Anthropic API key': fake('sk', '-ant-', 'api03', '-', 'x'.repeat(24)),
      'Google API key': fake('AI', 'za', 'S'.repeat(35)),
      'Slack token': fake('xo', 'xb-', '1234567890-abcdef'),
      'GitLab token': fake('gl', 'pat-', 'z'.repeat(20)),
      'Hugging Face token': fake('h', 'f_', 'Q'.repeat(30)),
      'npm token': fake('np', 'm_', 'N'.repeat(36)),
      'Stripe live key': fake('sk', '_live_', 'S1'.repeat(10)),
      'Telegram bot token': fake('123456789', ':AA', 'T'.repeat(33)),
      'AWS secret access key': fake('aws_secret', '_access_key = ', 'W'.repeat(40)),
    }
    const dir = makeRepo(t, {
      ...BASE,
      ...Object.fromEntries(
        Object.values(secrets).map((value, index) => [
          `test/secret-${index}.test.ts`,
          `export const value = '${value}'\n`,
        ]),
      ),
    })
    const result = run('check-privacy.mjs', ['--root', dir])
    assert.equal(result.code, 1)
    for (const [rule, value] of Object.entries(secrets)) {
      assert.match(result.output, new RegExp(`: ${rule.replace(/[()]/g, '\\$&')}`))
      assert.ok(!result.output.includes(value), `${rule} was printed in full`)
    }
  })

  it('flags credentials as they appear in pasted diagnostics', (t) => {
    const ticket = fake('hermes-gateway', '-ticket.', 'Tk7', 'q'.repeat(9))
    const lines = [
      `Sec-WebSocket-Protocol: hermes-gateway-v1, ${ticket}`,
      `Authorization: ${fake('Bear', 'er ', 'eyZ9', 'x'.repeat(12))}`,
      `GET /api/display/ws?${fake('tic', 'ket=', 'a1b2', 'c3d4e5')}`,
      `{"${fake('access', '_token')}": "${fake('at', '_live_', '42abcdef')}"}`,
    ]
    const result = scan(t, { 'docs/diag.md': `${lines.join('\n')}\n` })
    assert.equal(result.code, 1, result.output)
    for (const rule of [
      'WebSocket ticket',
      'Authorization header value',
      'secret in a URL query',
      'secret key/value pair',
    ])
      assert.match(result.output, new RegExp(`docs/diag\\.md:\\d+: ${rule}`))
  })

  it('leaves placeholders, prose and short test vectors alone', (t) => {
    const result = scan(t, {
      'docs/how.md': [
        'Send `Authorization: Bearer <token>` with the ticket `hermes-gateway-ticket.<ticket>`.',
        'Token handling stays in the main process; use ?ticket=${TICKET} and password: [redacted].',
        'Set api_key=YOUR_KEY_1 in your own shell.',
      ].join('\n'),
      'packages/a/test/redact.test.ts': `export const v = ['${fake('Bear', 'er ', 'abc12345678')}', '${fake('pass', 'word: "hunter2-x"')}']\n`,
    })
    assert.equal(result.code, 0, result.output)
    const long = scan(t, {
      'src/leak.ts': `export const h = '${fake('Bear', 'er ', 'A1'.repeat(16))}'\n`,
    })
    assertFlagged(long, /src\/leak\.ts:1: Authorization header value/)
  })

  it('does not mistake versions, file names or expressions for addresses or hosts', (t) => {
    const result = scan(t, {
      'test/ua.test.ts':
        "export const ua = 'Mozilla/5.0 Chrome/138.0.0.0 Safari/537.36'\n",
      'docs/env.md': 'Copy `.env.example` to `.env.local` and never commit it.\n',
      '.github/workflows/x.yml': 'if: ${{ !github.event.repository.private }}\n',
    })
    assert.equal(result.code, 0, result.output)
  })

  it('allows screenshots in nested folders of the reviewed evidence paths', (t) => {
    const dir = makeRepo(t, BASE)
    writeFiles(dir, {
      'docs/handbook/public/screenshots/web/talk-dark.png': Buffer.from([0, 137, 80, 78]),
    })
    git(dir, ['add', '--all'])
    const result = run('check-privacy.mjs', ['--root', dir])
    assert.equal(result.code, 0, result.output)
  })

  it('scans a symbolic link as its target text and rejects links out of the tree', (t) => {
    const dir = makeRepo(t, BASE)
    symlinkSync(`../../${['nas', 'lan'].join('.')}/share`, join(dir, 'docs/nas-link'))
    symlinkSync('/etc/hosts', join(dir, 'docs/hosts-link'))
    symlinkSync('missing-target.md', join(dir, 'docs/dangling-link'))
    git(dir, ['add', '--all'])
    const result = run('check-privacy.mjs', ['--root', dir])
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /docs\/nas-link: link target: private hostname \(\.lan\)/)
    assert.match(
      result.output,
      /docs\/hosts-link: symbolic link points outside the repository/,
    )
    assert.doesNotMatch(result.output, /dangling-link/)
  })

  it('names every kind of credential file and build output it refuses', (t) => {
    const refused = {
      credentials: [
        'deploy/id_rsa',
        'config/auth.json',
        'config/credentials-prod.json',
        'data/cookies-work.json',
        'e2e/storage-state.json',
        'android/google-services.json',
        'ios/GoogleService-Info.plist',
        'data/state.sqlite',
        'data/cache.db',
        'home/.hermes/config.yaml',
        'android/release.keystore',
        'android/keystore.properties',
        'captures/session.har',
        'certs/client.p12',
      ],
      output: [
        'node_modules/x/index.js',
        'apps/web/build/a.js',
        'out/main.js',
        'coverage/lcov.info',
        '.vite/deps.json',
        'test-results/a.txt',
        'apps/android/android/build.gradle',
        'logs/run.log',
        'apps/web/assets/app.js.map',
        'packages/a/tsconfig.tsbuildinfo',
        'docs/.DS_Store',
        'release/cindl.apk',
        'release/Cindl.AppImage',
      ],
    }
    const files = Object.fromEntries(
      [...refused.credentials, ...refused.output].map((path) => [path, 'x\n']),
    )
    const result = scan(t, files)
    assert.equal(result.code, 1)
    for (const path of refused.credentials)
      assert.match(
        result.output,
        new RegExp(`${path.replace(/[.]/g, '\\.')}: this kind of file`),
      )
    for (const path of refused.output)
      assert.match(
        result.output,
        new RegExp(`${path.replace(/[.]/g, '\\.')}: build output`),
      )
  })

  it('allows the copyright holder only in the licence files and README licence section', (t) => {
    assert.equal(scan(t).code, 0)
    assertFlagged(
      scan(t, { 'docs/about.md': `Written by ${HOLDER}.\n` }),
      /docs\/about\.md:1: names the copyright holder/,
    )
    assertFlagged(
      scan(t, { 'src/a.ts': '// Thanks, Vexmoor\n' }),
      /names the copyright holder/,
    )
    assertFlagged(
      scan(t, { 'README.md': `# Fixture\n\nBy ${HOLDER}.\n\n## Licence\n\nMIT.\n` }),
      /README\.md:3: names the copyright holder/,
    )
  })

  it('fails when LICENSE names no copyright holder', (t) => {
    assertFlagged(scan(t, { LICENSE: 'MIT License\n' }), /cannot check identity/)
  })

  it('flags committed build output, caches and local state', (t) => {
    const result = scan(t, {
      'apps/web/dist/index.js': 'export {}\n',
      'docs/handbook/.vitepress/cache/deps.json': '{}\n',
      '.agent-artifacts/HANDOFF.md': '# notes\n',
    })
    assertFlagged(result, /apps\/web\/dist\/index\.js: build output/)
    assert.match(result.output, /\.vitepress\/cache\/deps\.json: build output/)
    assert.match(result.output, /\.agent-artifacts\/HANDOFF\.md: build output/)
  })

  it('flags credential-bearing files but allows .env.example', (t) => {
    const result = scan(t, {
      '.env': 'A=1\n',
      'deploy/key.pem': 'x\n',
      '.env.example': 'A=\n',
    })
    assertFlagged(result, /^- \.env: this kind of file holds credentials/m)
    assert.match(result.output, /deploy\/key\.pem: this kind of file/)
    assert.doesNotMatch(result.output, /\.env\.example/)
  })

  it('flags binaries and large files outside the allowed paths', (t) => {
    const binary = Buffer.from([0, 1, 2, 3, 0, 255])
    const dir = makeRepo(t, { ...BASE })
    writeFiles(dir, {
      'assets/blob.bin': binary,
      'packages/tokens/fonts/sans/Sans.woff2': binary,
      'docs/huge.md': `${'synthetic text '.repeat(20_000)}\n`,
    })
    git(dir, ['add', '--all'])
    const result = run('check-privacy.mjs', ['--root', dir])
    assert.equal(result.code, 1)
    assert.match(
      result.output,
      /assets\/blob\.bin: binary file outside the allowed asset paths/,
    )
    assert.doesNotMatch(result.output, /Sans\.woff2/)
    assert.match(result.output, /docs\/huge\.md: \d+ KiB exceeds the 256 KiB limit/)
  })

  it('scans untracked files only when asked', (t) => {
    const dir = makeRepo(t, BASE)
    writeFileSync(join(dir, 'notes.md'), `Ask ${['me', 'gmail.com'].join('@')}\n`)
    assert.equal(run('check-privacy.mjs', ['--root', dir]).code, 0)
    const included = run('check-privacy.mjs', ['--root', dir, '--include-untracked'])
    assertFlagged(included, /notes\.md:1: email address/)
  })

  it('checks private markers from a local file without printing them', (t) => {
    const markers = join(tempDir(t), 'markers.txt')
    writeFileSync(markers, '# my private names\nHarbourview\n')
    const files = { 'docs/trip.md': 'We met at the harbourview cafe.\n' }
    const viaFlag = scan(t, files, ['--markers', markers])
    assertFlagged(viaFlag, /docs\/trip\.md:1: private marker #1/)
    assert.doesNotMatch(viaFlag.output, /harbourview/i)
    const viaEnv = scan(t, files, [], { CINDL_PRIVACY_MARKERS: markers })
    assertFlagged(viaEnv, /private marker #1/)
  })
})
