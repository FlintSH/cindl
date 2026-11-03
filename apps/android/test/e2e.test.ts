/// <reference types="node" />
import { createHash, randomBytes } from 'node:crypto'
import { base64Url } from '@cindl/hermes-adapter'
import { afterEach, describe, expect, it } from 'vitest'
import { startFakeHermesAuth, type FakeHermesAuth } from '../e2e/fakeHermesAuth.ts'
import {
  auditTargets,
  center,
  find,
  findAll,
  label,
  parseKeyboard,
  parseUi,
  TERMS_PROMPT,
  tapTarget,
} from '../e2e/ui.ts'

const PKG = 'dev.fl1nt.cindl'
const node = (attrs: Record<string, string>, children = '') => {
  const all = {
    text: '',
    'resource-id': '',
    class: 'android.view.ViewGroup',
    package: PKG,
    'content-desc': '',
    clickable: 'false',
    'long-clickable': 'false',
    checkable: 'false',
    checked: 'false',
    enabled: 'true',
    focused: 'false',
    scrollable: 'false',
    bounds: '[0,0][0,0]',
    ...attrs,
  }
  const attributes = Object.entries(all)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ')
  return children ? `<node ${attributes}>${children}</node>` : `<node ${attributes} />`
}
const dump = (body: string) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${body}</hierarchy>`

// density 320 → 2px per dp, so 48dp = 96px.
const screen = dump(
  node(
    { class: 'android.widget.FrameLayout', bounds: '[0,0][1080,2400]' },
    [
      node({ 'content-desc': 'Send', clickable: 'true', bounds: '[900,2200][996,2296]' }),
      node({ 'content-desc': 'Tiny', clickable: 'true', bounds: '[10,10][90,96]' }),
      node({
        class: 'android.widget.EditText',
        'content-desc': 'Message Hermes',
        text: 'Draft &amp; more',
        bounds: '[0,2200][880,2296]',
      }),
      node({
        class: 'android.widget.TextView',
        text: 'A paragraph with a link',
        clickable: 'true',
        bounds: '[0,400][1000,440]',
      }),
      node(
        {
          class: 'android.widget.ScrollView',
          scrollable: 'true',
          bounds: '[0,500][1080,1500]',
        },
        node({
          'content-desc': 'Half visible',
          clickable: 'true',
          bounds: '[0,1460][400,1500]',
        }),
      ),
      node({
        'content-desc': 'Other app',
        package: 'com.android.chrome',
        clickable: 'true',
        bounds: '[0,0][10,10]',
      }),
    ].join(''),
  ),
)

describe('UI Automator dumps', () => {
  it('parses the tree, decodes entities and finds by label', () => {
    const root = parseUi(screen)
    const composer = find(root, (text) => text.startsWith('Message '))
    expect(composer?.text).toBe('Draft & more')
    expect(composer && label(composer)).toBe('Message Hermes')
    expect(findAll(root, /^(Send|Tiny)$/).map(label)).toEqual(['Send', 'Tiny'])
    const scrolled = find(root, 'Half visible')
    expect(scrolled?.parent?.scrollable).toBe(true)
    expect(scrolled && tapTarget(scrolled)).toBe(scrolled)
    expect(center({ left: 900, top: 2200, right: 996, bottom: 2296 })).toEqual({
      x: 948,
      y: 2248,
    })
  })

  it('flags app targets under 48dp, skipping inline text, clipped rows and other apps', () => {
    const audit = auditTargets(parseUi(screen), { pkg: PKG, density: 320 })
    expect(audit).toMatchObject({ checked: 3, skippedClipped: 1, exemptInline: 1 })
    expect(audit.issues).toEqual([
      {
        label: 'Tiny',
        className: 'android.view.ViewGroup',
        widthDp: 40,
        heightDp: 43,
        bounds: { left: 10, top: 10, right: 90, bottom: 96 },
      },
    ])
    expect(
      auditTargets(parseUi(screen), { pkg: PKG, density: 320, minDp: 40 }).issues,
    ).toEqual([])
  })

  it('reads whether the keyboard is shown and where its top edge is', () => {
    const window =
      'Window #5 Window{1 u0 InputMethod}:\n    mFrame=[0,1500][1080,2400] last=[0,1500][1080,2400]\n    mGivenContentInsets=[0,120][0,0] mGivenVisibleInsets=[0,120][0,0]'
    expect(parseKeyboard(window, 'mInputShown=true mShowRequested=true')).toEqual({
      shown: true,
      top: 1620,
    })
    expect(parseKeyboard(window, 'mInputShown=false')).toEqual({ shown: false })
    expect(parseKeyboard('no frame here', 'isInputViewShown=true')).toEqual({
      shown: true,
    })
    // Newer releases: no flag in input_method, but the keyboard window is visible.
    expect(
      parseKeyboard(
        `${window}\n    mViewVisibility=0x0 mHaveFrame=true\n    mHasSurface=true`,
        '',
      ),
    ).toEqual({ shown: true, top: 1620 })
    expect(
      parseKeyboard(`${window}\n    mViewVisibility=0x8\n    mHasSurface=false`, ''),
    ).toEqual({ shown: false })
  })

  it('recognises terms prompts so the tests stop instead of accepting', () => {
    for (const text of ['Accept & continue', 'Google Terms of Service', 'I agree'])
      expect(TERMS_PROMPT.test(text)).toBe(true)
    expect(TERMS_PROMPT.test('Signed in')).toBe(false)
  })
})

describe('fake Hermes auth server (SYNTHETIC test double)', () => {
  let hermes: FakeHermesAuth | undefined
  afterEach(async () => {
    await hermes?.close()
    hermes = undefined
  })

  const authorize = async (server: FakeHermesAuth, verifier: string) => {
    const url = new URL('/auth/native/authorize', server.origin)
    url.searchParams.set(
      'code_challenge',
      base64Url(createHash('sha256').update(verifier).digest()),
    )
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('redirect_uri', 'http://127.0.0.1:41234/callback')
    url.searchParams.set('state', 'state-1')
    return fetch(url, { redirect: 'manual' })
  }

  it('redirects with a one-time code and exchanges it only for the right verifier', async () => {
    hermes = await startFakeHermesAuth()
    const verifier = base64Url(randomBytes(32))
    const response = await authorize(hermes, verifier)
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('http://127.0.0.1:41234/callback')
    expect(location.searchParams.get('state')).toBe('state-1')
    const code = location.searchParams.get('code') ?? ''
    const exchange = (body: Record<string, string>) =>
      fetch(`${hermes?.origin}/auth/native/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await exchange({ code, code_verifier: 'wrong'.repeat(9) })).status).toBe(400)
    // A code is single-use, even after a failed attempt.
    expect((await exchange({ code, code_verifier: verifier })).status).toBe(400)
    const second = new URL(
      (await authorize(hermes, verifier)).headers.get('location') ?? '',
    )
    const ok = await exchange({
      code: second.searchParams.get('code') ?? '',
      code_verifier: verifier,
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ token_type: 'bearer', provider: 'basic' })
    expect(hermes.events.map((event) => `${event.kind}:${event.status}`)).toEqual([
      'authorize:302',
      'token:400',
      'token:400',
      'authorize:302',
      'token:200',
    ])
    // The log is evidence: no codes, verifiers or tokens in it.
    expect(JSON.stringify(hermes.events)).not.toMatch(
      /synthetic-(code|access|refresh)|state-1/,
    )
  })

  it('holds authorize responses until released', async () => {
    hermes = await startFakeHermesAuth()
    hermes.hold()
    const pending = authorize(hermes, base64Url(randomBytes(32)))
    expect(await hermes.waitFor('authorize', 1, 2000)).toBe(true)
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(settled).toBe(false)
    expect(hermes.release()).toBe(1)
    expect((await pending).status).toBe(302)
    expect(await hermes.waitFor('token', 1, 50)).toBe(false)
  })

  it('rejects an authorize request without S256 PKCE or a loopback redirect', async () => {
    hermes = await startFakeHermesAuth()
    const url = new URL('/auth/native/authorize', hermes.origin)
    url.searchParams.set('redirect_uri', 'https://example.test/callback')
    url.searchParams.set('code_challenge', 'x')
    url.searchParams.set('code_challenge_method', 'plain')
    url.searchParams.set('state', 's')
    expect((await fetch(url, { redirect: 'manual' })).status).toBe(400)
  })
})
