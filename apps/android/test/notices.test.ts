/// <reference types="node" />
import { describe, expect, it } from 'vitest'
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
