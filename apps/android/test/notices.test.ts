/// <reference types="node" />
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { archiveEntries, licenceFiles } from '../notices/archives.ts'
import {
  formatNativeNotices,
  LICENCE_ENTRY,
  parseDependencyReport,
  parsePom,
} from '../notices/native.ts'

// The shape of `gradle :app:dependencies --configuration releaseRuntimeClasspath`.
const REPORT = `
releaseRuntimeClasspath - Runtime classpath of '/release'.
+--- project :expo
|    +--- project :expo-modules-core
|    |    +--- org.jetbrains.kotlin:kotlin-stdlib:2.1.20 -> 2.2.0
|    |    \\--- androidx.core:core-ktx:1.13.1
|    |         \\--- androidx.core:core:1.13.1 (*)
+--- com.facebook.react:react-android:0.88.1
|    +--- androidx.appcompat:appcompat:1.7.0
|    \\--- com.facebook.fresco:fresco:3.7.0
+--- androidx.core:core -> 1.13.1
|    \\--- com.facebook.react:react-native:+ -> com.facebook.react:react-android:0.88.1 (*)
\\--- com.facebook.react:hermes-android -> com.facebook.hermes:hermes-android:260318099.0.5
+--- org.jetbrains.kotlin:kotlin-stdlib:{strictly 2.2.0} -> 2.2.0 (c)
\\--- com.example.unresolved:thing:1.0 (n)

(c) - A dependency constraint, not a dependency.
`

describe('native library notices', () => {
  it('lists the resolved libraries in the runtime classpath, without projects or constraints', () => {
    expect(
      parseDependencyReport(REPORT).map((c) => `${c.group}:${c.module}:${c.version}`),
    ).toEqual([
      'androidx.appcompat:appcompat:1.7.0',
      'androidx.core:core-ktx:1.13.1',
      'androidx.core:core:1.13.1',
      'com.facebook.fresco:fresco:3.7.0',
      'com.facebook.hermes:hermes-android:260318099.0.5',
      'com.facebook.react:react-android:0.88.1',
      'org.jetbrains.kotlin:kotlin-stdlib:2.2.0',
    ])
    expect(parseDependencyReport('No dependencies')).toEqual([])
  })

  it('reads the licences and parent a POM declares', () => {
    expect(
      parsePom(`<project>
        <parent><groupId>com.example</groupId><artifactId>parent</artifactId><version>3</version></parent>
        <licenses>
          <license><name>The Apache Software License,
            Version 2.0</name><url>https://www.apache.org/licenses/LICENSE-2.0.txt</url></license>
          <license><name>MIT</name></license>
        </licenses>
      </project>`),
    ).toEqual({
      licences: [
        {
          name: 'The Apache Software License, Version 2.0',
          url: 'https://www.apache.org/licenses/LICENSE-2.0.txt',
        },
        { name: 'MIT' },
      ],
      parent: { group: 'com.example', module: 'parent', version: '3' },
    })
    expect(parsePom('<project><name>x</name></project>')).toEqual({ licences: [] })
  })

  it('recognises the licence and notice files libraries ship', () => {
    for (const path of [
      'META-INF/LICENSE',
      'META-INF/LICENSE.txt',
      'META-INF/NOTICE',
      'META-INF/androidx/annotation/annotation/LICENSE.txt',
      'LICENSE',
      'META-INF/licenses/COPYING-okhttp',
    ])
      expect(LICENCE_ENTRY.test(path)).toBe(true)
    for (const path of [
      'META-INF/MANIFEST.MF',
      'com/example/License.class',
      'res/raw/notice_icon.png',
    ])
      expect(LICENCE_ENTRY.test(path)).toBe(false)
  })

  it('lists every library and groups identical licence files', () => {
    const text = formatNativeNotices([
      {
        coordinate: { group: 'a', module: 'one', version: '1' },
        licences: [{ name: 'Apache-2.0', url: 'https://example.test/apache' }],
        files: [{ path: 'META-INF/LICENSE', text: 'Same text\n' }],
        source: '/cache/a/one/1',
      },
      {
        coordinate: { group: 'b', module: 'two', version: '2' },
        licences: [],
        files: [{ path: 'classes.jar!/META-INF/LICENSE', text: 'Same text' }],
        source: '/cache/b/two/2',
      },
      {
        coordinate: { group: 'c', module: 'three', version: '3' },
        licences: [],
        files: [],
      },
    ])
    expect(text).toContain('these 3 libraries')
    expect(text).toContain(
      'a:one:1: Apache-2.0 (https://example.test/apache); 1 licence/notice file(s) below',
    )
    expect(text).toContain(
      'b:two:2: no licence declared in its POM; 1 licence/notice file(s) below',
    )
    expect(text).toContain(
      'c:three:3: no licence declared in its POM; artifact not found to read its files',
    )
    expect(text).toContain('(1 distinct texts)')
    expect(text).toContain(
      'a:one:1 (META-INF/LICENSE)\nb:two:2 (classes.jar!/META-INF/LICENSE)\n\nSame text',
    )
  })
})

describe('licence files in archives (CI run 41599393316)', () => {
  // Real archives in a temporary directory: an AAR whose classes.jar is empty (resource-only
  // AARs ship one) stopped that run, because `unzip -Z1` reports "Empty zipfile." with exit 1.
  const work = mkdtempSync(join(tmpdir(), 'cindl-notices-test-'))
  afterAll(() => rmSync(work, { recursive: true, force: true }))

  /** A zip with stored (uncompressed) entries; an empty one is just the end record. */
  const writeZip = (name: string, files: Record<string, string | Buffer>) => {
    const local: Buffer[] = []
    const central: Buffer[] = []
    let offset = 0
    for (const [entry, content] of Object.entries(files)) {
      const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
      const fileName = Buffer.from(entry)
      const header = Buffer.alloc(30)
      header.writeUInt32LE(0x04034b50, 0)
      header.writeUInt16LE(20, 4)
      header.writeUInt32LE(crc32(data), 14)
      header.writeUInt32LE(data.length, 18)
      header.writeUInt32LE(data.length, 22)
      header.writeUInt16LE(fileName.length, 26)
      const record = Buffer.alloc(46)
      record.writeUInt32LE(0x02014b50, 0)
      record.writeUInt16LE(20, 4)
      record.writeUInt16LE(20, 6)
      record.writeUInt32LE(crc32(data), 16)
      record.writeUInt32LE(data.length, 20)
      record.writeUInt32LE(data.length, 24)
      record.writeUInt16LE(fileName.length, 28)
      record.writeUInt32LE(offset, 42)
      local.push(header, fileName, data)
      central.push(record, fileName)
      offset += header.length + fileName.length + data.length
    }
    const directory = Buffer.concat(central)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(Object.keys(files).length, 8)
    end.writeUInt16LE(Object.keys(files).length, 10)
    end.writeUInt32LE(directory.length, 12)
    end.writeUInt32LE(offset, 16)
    const path = join(work, name)
    const bytes = Buffer.concat([...local, directory, end])
    writeFileSync(path, bytes)
    return { path, bytes }
  }

  it('treats an empty archive as having no files, and reads the AAR around it', () => {
    const empty = writeZip('empty.jar', {})
    expect(archiveEntries(empty.path)).toEqual([])
    const aar = writeZip('resources.aar', {
      'classes.jar': empty.bytes,
      LICENSE: 'AAR licence',
    })
    expect(licenceFiles(aar.path)).toEqual([{ path: 'LICENSE', text: 'AAR licence' }])
  })

  it('finds licence files in a JAR and in the classes.jar inside an AAR', () => {
    const jar = writeZip('lib.jar', {
      'META-INF/LICENSE': 'Jar licence',
      'com/example/A.class': 'x',
    })
    expect(licenceFiles(jar.path)).toEqual([
      { path: 'META-INF/LICENSE', text: 'Jar licence' },
    ])
    const aar = writeZip('lib.aar', {
      'classes.jar': jar.bytes,
      'AndroidManifest.xml': '<m/>',
    })
    expect(licenceFiles(aar.path)).toEqual([
      { path: 'classes.jar!/META-INF/LICENSE', text: 'Jar licence' },
    ])
  })

  it('stops on an archive it cannot read', () => {
    const broken = join(work, 'broken.jar')
    writeFileSync(broken, 'not a zip')
    expect(() => archiveEntries(broken)).toThrow(/Could not read .*broken\.jar/)
  })
})
