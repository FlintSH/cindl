/// <reference types="node" />
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  APPROVED_LICENCE,
  BUILD_PACKAGES,
  EMULATOR_PACKAGES,
  type PinnedPackage,
} from '../sdk/android-sdk.ts'
import {
  checkInstalled,
  checkManifests,
  errors,
  formattingDelta,
  licenceDifference,
  licenceTextSha1,
  MARKER_FILE,
  normalizeLicenceText,
  parseManifest,
  parsePackageXml,
  sourceRevision,
} from '../sdk/guard.ts'

// Synthetic files in Google's repository formats; no Google text is vendored here.
const ESCAPED_TEXT = 'Synthetic terms &amp; conditions\n  for &quot;tests&quot; only.'
const TEXT = 'Synthetic terms & conditions\n  for "tests" only.'
const licence = { id: 'android-sdk-license', textSha1: licenceTextSha1(TEXT) }

const revisionXml = (revision: string) => {
  const [major, minor, micro] = revision.split('.')
  return `<revision><major>${major}</major>${minor ? `<minor>${minor}</minor>` : ''}${micro ? `<micro>${micro}</micro>` : ''}</revision>`
}

const pin: PinnedPackage = {
  id: 'emulator',
  path: 'emulator',
  revision: '37.2.13',
  repository: 'main',
  reason: 'test package',
  archive: {
    url: 'https://dl.example.test/emulator-linux_x64-1.zip',
    sha1: 'a'.repeat(40),
    size: 10,
  },
}

function manifest(
  options: { licence?: string; revision?: string; sha1?: string; text?: string } = {},
) {
  return `<?xml version="1.0"?>
<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03">
  <license id="android-sdk-license" type="text">${options.text ?? ESCAPED_TEXT}</license>
  <license id="android-sdk-preview-license" type="text">Preview terms</license>
  <channel id="channel-0">stable</channel>
  <remotePackage path="emulator">
    ${revisionXml('37.3.6')}
    <uses-license ref="android-sdk-preview-license"/>
    <channelRef ref="channel-2"/>
    <archives><archive><complete><size>1</size><checksum type="sha1">${'b'.repeat(40)}</checksum><url>emulator-dev.zip</url></complete><host-os>linux</host-os></archive></archives>
  </remotePackage>
  <remotePackage path="emulator">
    ${revisionXml(options.revision ?? '37.2.13')}
    <uses-license ref="${options.licence ?? 'android-sdk-license'}"/>
    <channelRef ref="channel-0"/>
    <archives>
      <archive><complete><size>10</size><checksum type="sha1">${options.sha1 ?? 'a'.repeat(40)}</checksum><url>emulator-linux_x64-1.zip</url></complete><host-os>linux</host-os></archive>
      <archive><complete><size>11</size><checksum type="sha1">${'c'.repeat(40)}</checksum><url>emulator-darwin-1.zip</url></complete><host-os>macosx</host-os></archive>
    </archives>
  </remotePackage>
</sdk:sdk-repository>`
}

const messages = (findings: ReturnType<typeof checkManifests>) =>
  errors(findings).map((finding) => finding.message)

describe('Android SDK pins', () => {
  it('pins every package exactly, with a reason and, when downloaded, an archive', () => {
    for (const entry of [...BUILD_PACKAGES, ...EMULATOR_PACKAGES]) {
      expect(entry.revision).toMatch(/^\d+(\.\d+)*$/)
      expect(entry.reason.length).toBeGreaterThan(10)
    }
    for (const entry of BUILD_PACKAGES) expect(entry.archive).toBeUndefined()
    for (const entry of EMULATOR_PACKAGES) {
      expect(entry.archive?.url).toMatch(
        /^https:\/\/dl\.google\.com\/android\/repository\//,
      )
      expect(entry.archive?.sha1).toMatch(/^[0-9a-f]{40}$/)
    }
    expect(APPROVED_LICENCE).toMatchObject({ id: 'android-sdk-license' })
    expect(APPROVED_LICENCE.textSha1).toMatch(/^[0-9a-f]{40}$/)
    expect(APPROVED_LICENCE.scope).toContain('GitHub-hosted runners only')
  })
})

describe('repository manifests', () => {
  it('reads licences, revisions, channels and archives', () => {
    const parsed = parseManifest(manifest())
    expect(parsed.licences.get('android-sdk-license')).toBe(TEXT)
    expect(parsed.packages.filter((entry) => entry.channel === 'channel-0')).toEqual([
      {
        path: 'emulator',
        revision: '37.2.13',
        licence: 'android-sdk-license',
        channel: 'channel-0',
        archives: [
          {
            hostOs: 'linux',
            url: 'emulator-linux_x64-1.zip',
            sha1: 'a'.repeat(40),
            size: 10,
          },
          {
            hostOs: 'macosx',
            url: 'emulator-darwin-1.zip',
            sha1: 'c'.repeat(40),
            size: 11,
          },
        ],
      },
    ])
    expect(licenceTextSha1(`  ${TEXT}\n`)).toBe(licenceTextSha1(TEXT))
  })

  it('identifies a licence by its words, not its formatting', () => {
    const words = licenceTextSha1(TEXT)
    // Line endings, wrapping, indentation and blank lines are formatting.
    expect(licenceTextSha1(TEXT.replace(/\n/g, '\r\n'))).toBe(words)
    expect(licenceTextSha1(TEXT.replace('conditions\n  for', 'conditions for'))).toBe(
      words,
    )
    expect(licenceTextSha1(`\n\t${TEXT.replace(/ /g, '  ')}\n\n\n`)).toBe(words)
    expect(normalizeLicenceText('Café  terms')).toBe('Café terms')
    // Any change in wording, punctuation or characters is a different licence.
    expect(licenceTextSha1(TEXT.replace('tests', 'test'))).not.toBe(words)
    expect(licenceTextSha1(TEXT.replace('"tests"', 'tests'))).not.toBe(words)
    expect(licenceTextSha1(TEXT.replace('&', 'and'))).not.toBe(words)
  })

  it('spells out a formatting-only difference as line hunks', () => {
    expect(formattingDelta(TEXT, TEXT)).toBe('identical')
    expect(
      formattingDelta('Terms\n\nOne two\n\nThree', 'Terms\n\nOne  two\n\n\nThree\n'),
    ).toBe(
      'manifest lines 3-4 "One  two\\n" → installed line 3 "One two"; ' +
        'manifest line 7 "" → installed none (after line 5) ""',
    )
  })

  it('shows where two licence texts differ in their words', () => {
    expect(licenceDifference(TEXT.replace(/\n/g, '\r\n'), TEXT)).toBe(
      'same words (formatting differs only)',
    )
    expect(licenceDifference(TEXT.replace('tests', 'demos'), TEXT)).toMatch(
      /^words differ at character 34 of 46 \(approved 46\): installed ".*demos.*"; approved ".*tests.*"$/,
    )
  })

  it('passes a pinned package offered under the approved text in the stable channel', () => {
    expect(checkManifests({ main: parseManifest(manifest()) }, [pin], licence)).toEqual(
      [],
    )
  })

  it('stops on changed terms, another licence or a package that is gone', () => {
    expect(
      messages(
        checkManifests(
          { main: parseManifest(manifest({ text: 'New terms' })) },
          [pin],
          licence,
        ),
      ),
    ).toEqual([
      expect.stringMatching(
        /not the approved one .*owner must review the new terms/,
      ) as string,
    ])
    expect(
      messages(checkManifests({ main: parseManifest(manifest()) }, [pin]))[0],
    ).toMatch(/not the approved one/)
    expect(
      messages(
        checkManifests(
          { main: parseManifest(manifest({ licence: 'android-sdk-preview-license' })) },
          [pin],
          licence,
        ),
      ),
    ).toEqual([
      expect.stringMatching(
        /emulator uses android-sdk-preview-license, not android-sdk-license/,
      ) as string,
    ])
    expect(
      messages(
        checkManifests(
          { main: parseManifest(manifest()) },
          [{ ...pin, id: 'ndk;27.3.13750724' }],
          licence,
        ),
      ),
    ).toEqual([expect.stringMatching(/no longer in Google's stable channel/) as string])
    expect(messages(checkManifests({}, [pin], licence))[0]).toMatch(/No manifest read/)
  })

  it('notes a newer revision and rejects an archive that does not match the pin', () => {
    const newer = checkManifests(
      { main: parseManifest(manifest({ revision: '37.2.15' })) },
      [pin],
      licence,
    )
    expect(newer).toEqual([
      {
        level: 'notice',
        message:
          'emulator: Google now lists revision 37.2.15; CI keeps the pinned 37.2.13.',
      },
    ])
    expect(
      messages(
        checkManifests(
          { main: parseManifest(manifest({ sha1: 'd'.repeat(40) })) },
          [pin],
          licence,
        ),
      ),
    ).toEqual([expect.stringMatching(/pinned archive does not match/) as string])
  })
})

describe('installed packages', () => {
  const buildTools: PinnedPackage = {
    id: 'build-tools;37.0.0',
    path: 'build-tools/37.0.0',
    revision: '37.0.0',
    repository: 'main',
    reason: 'test package',
  }
  const packageXml = (
    options: { revision?: string; licence?: string; text?: string } = {},
  ) => `
<ns2:repository xmlns:ns2="http://schemas.android.com/repository/android/common/02">
  <license id="${options.licence ?? 'android-sdk-license'}" type="text">${options.text ?? ESCAPED_TEXT}</license>
  <localPackage path="build-tools;37.0.0" obsolete="false">
    ${revisionXml(options.revision ?? '37.0.0')}
    <display-name>Android SDK Build-Tools 37</display-name>
    <uses-license ref="${options.licence ?? 'android-sdk-license'}"/>
  </localPackage>
</ns2:repository>`

  it('parses package.xml and source.properties', () => {
    expect(parsePackageXml(packageXml())).toEqual({
      path: 'build-tools;37.0.0',
      revision: '37.0.0',
      licence: 'android-sdk-license',
      licenceText: TEXT,
    })
    expect(parsePackageXml('<nothing/>')).toBeUndefined()
    expect(sourceRevision('Pkg.Desc=Android Emulator\nPkg.Revision=37.2.13\n')).toBe(
      '37.2.13',
    )
  })

  it('accepts a preinstalled package at the pinned revision under the approved text', () => {
    const files = { 'build-tools/37.0.0/package.xml': packageXml() }
    expect(
      checkInstalled((path) => files[path as keyof typeof files], [buildTools], licence),
    ).toEqual({
      findings: [],
      installed: [
        {
          id: 'build-tools;37.0.0',
          revision: '37.0.0',
          licence: 'android-sdk-license',
          source: 'preinstalled',
          licenceText: expect.stringMatching(
            /^48 chars, raw sha1 [0-9a-f]{40}, words sha1 [0-9a-f]{40}$/,
          ) as string,
        },
      ],
      otherTexts: {},
      // The matched text is kept (by raw sha1) so CI can log how its formatting differs.
      matchedTexts: { [createHash('sha1').update(TEXT).digest('hex')]: TEXT },
    })
  })

  it('accepts the formatting sdkmanager wrote on the runner (CI run 41588184526)', () => {
    // On GitHub's image the package.xml licence text (16960 chars, raw sha1 24333f8a…, the hash
    // sdkmanager records) differs from Google's manifest (16962 chars) in exactly three ways: a
    // double space in clause 3.4 is single, clause 9.3's list items (A)-(D) are on one line
    // instead of five, and there is no final newline. Same words. Synthetic stand-in:
    const manifestText =
      'Terms\n\n3.4 You may not  use it.\n\n9.3 Google may end it if:\n(A) you breach it;\n(B) the law requires it.\n\nJanuary 16, 2019\n'
    const installedText =
      'Terms\n\n3.4 You may not use it.\n\n9.3 Google may end it if: (A) you breach it; (B) the law requires it.\n\nJanuary 16, 2019'
    const approved = {
      id: 'android-sdk-license',
      textSha1: licenceTextSha1(manifestText),
    }
    // The first guard compared the trimmed raw text, which is what stopped that run.
    const raw = (text: string) => createHash('sha1').update(text.trim()).digest('hex')
    expect(raw(installedText)).not.toBe(raw(manifestText))
    const files = {
      'build-tools/37.0.0/package.xml': packageXml({ text: installedText }),
    }
    const result = checkInstalled(
      (path) => files[path as keyof typeof files],
      [buildTools],
      approved,
    )
    expect(result.findings).toEqual([])
    expect(formattingDelta(installedText, manifestText)).toBe(
      'manifest line 3 "3.4 You may not  use it." → installed line 3 "3.4 You may not use it."; ' +
        'manifest lines 5-7 "9.3 Google may end it if:\\n(A) you breach it;\\n(B) the law requires it." → ' +
        'installed line 5 "9.3 Google may end it if: (A) you breach it; (B) the law requires it."; ' +
        'manifest line 10 "" → installed none (after line 7) ""',
    )
    // A changed word in the same layout is still a different licence.
    const changed = {
      'build-tools/37.0.0/package.xml': packageXml({
        text: installedText.replace('breach', 'ignore'),
      }),
    }
    expect(
      errors(
        checkInstalled(
          (path) => changed[path as keyof typeof changed],
          [buildTools],
          approved,
        ).findings,
      ),
    ).toHaveLength(1)
  })

  it('accepts a package.xml text that differs from the manifest only in formatting', () => {
    // sdkmanager may write the text back with other line breaks (JAXB escapes CR as &#xD;).
    const files = {
      'build-tools/37.0.0/package.xml': packageXml({
        text: ESCAPED_TEXT.replace(/\n/g, '&#xD;\n'),
      }),
    }
    const result = checkInstalled(
      (path) => files[path as keyof typeof files],
      [buildTools],
      licence,
    )
    expect(result.findings).toEqual([])
    expect(result.installed).toHaveLength(1)
  })

  it('names exactly what is missing or unapproved, with the licence id', () => {
    const files: Record<string, string> = {}
    const check = () =>
      checkInstalled((path) => files[path], [buildTools], licence).findings.map(
        (f) => f.message,
      )
    expect(check()).toEqual([
      'build-tools;37.0.0 revision 37.0.0 (licence android-sdk-license) is not installed.',
    ])
    files['build-tools/37.0.0/package.xml'] = packageXml({ revision: '36.0.0' })
    expect(check()[0]).toMatch(/found revision 36\.0\.0/)
    files['build-tools/37.0.0/package.xml'] = packageXml({
      licence: 'android-sdk-preview-license',
    })
    expect(check()[0]).toMatch(/installed under android-sdk-preview-license\. Stop/)
    files['build-tools/37.0.0/package.xml'] = packageXml({ text: 'Older terms' })
    expect(check()[0]).toMatch(
      /is installed with a different licence text \(11 chars, raw sha1 [0-9a-f]{40}, words sha1 [0-9a-f]{40}; approved words sha1 [0-9a-f]{40}\)\. Stop: review the terms\./,
    )
    expect(
      checkInstalled((path) => files[path], [buildTools], licence).otherTexts,
    ).toEqual({ [licenceTextSha1('Older terms')]: 'Older terms' })
    files['build-tools/37.0.0/package.xml'] = packageXml().replace(
      /<license [^>]*>[\s\S]*?<\/license>/,
      '',
    )
    expect(check()).toEqual([
      'build-tools;37.0.0 revision 37.0.0 (licence android-sdk-license) has no android-sdk-license text in its package.xml. Stop: review the package.',
    ])
  })

  it('accepts a package CI downloaded only when its marker matches the pin', () => {
    const marker = {
      id: 'emulator',
      revision: '37.2.13',
      licence: licence.id,
      licenceTextSha1: licence.textSha1,
      archive: { ...pin.archive, sha256: 'e'.repeat(64) },
    }
    const files: Record<string, string> = {
      [`emulator/${MARKER_FILE}`]: JSON.stringify(marker),
    }
    expect(checkInstalled((path) => files[path], [pin], licence)).toEqual({
      findings: [],
      otherTexts: {},
      matchedTexts: {},
      installed: [
        {
          id: 'emulator',
          revision: '37.2.13',
          licence: 'android-sdk-license',
          source: 'downloaded',
          sha256: 'e'.repeat(64),
        },
      ],
    })
    files[`emulator/${MARKER_FILE}`] = JSON.stringify({ ...marker, revision: '37.2.12' })
    expect(
      errors(checkInstalled((path) => files[path], [pin], licence).findings),
    ).toHaveLength(1)
    files[`emulator/${MARKER_FILE}`] = '{not json'
    expect(
      errors(checkInstalled((path) => files[path], [pin], licence).findings),
    ).toHaveLength(1)
  })
})
