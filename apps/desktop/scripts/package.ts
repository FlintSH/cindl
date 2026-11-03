/**
 * `node scripts/package.ts [--flavour real|demo]`: builds the flavour, packages
 * it as an unsigned Linux x64 AppImage with electron-builder, then runs the
 * flavour gates again on what was packaged (app.asar and the renderer).
 * Run it under `flock /tmp/cindl-heavy-build.lock` on shared machines.
 */
import builder, { type Configuration } from 'electron-builder'
import path from 'node:path'
import { appDir, BuildError, buildDesktop } from './desktop-build.ts'
import { flavourFromArgs, type FlavourBuild } from './flavours.ts'
import { gateProblems } from './gates.ts'

function packageConfig(flavour: FlavourBuild): Configuration {
  const out = flavour.outDir
  return {
    appId: flavour.appId,
    productName: flavour.productName,
    executableName: flavour.executableName,
    copyright: 'Copyright 2026 Zachary Lowery',
    artifactName: flavour.artifactName,
    directories: { output: flavour.releaseDir, buildResources: 'build-resources' },
    // app.asar holds only the bundled main process and preload. Every
    // dependency is a devDependency bundled by esbuild, so no node_modules ship.
    files: ['package.json', `${out}/main.cjs`, `${out}/preload.cjs`],
    extraMetadata: {
      name: flavour.packageName,
      productName: flavour.productName,
      main: `${out}/main.cjs`,
    },
    extraResources: [
      { from: `${out}/renderer`, to: 'renderer' },
      { from: `${out}/THIRD_PARTY_LICENSES.txt`, to: 'THIRD_PARTY_LICENSES.txt' },
    ],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    electronFuses: {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      // Kept on so CI can launch-smoke-test this exact binary through the Node
      // inspector (Playwright's _electron). See apps/desktop/AGENTS.md: an
      // unsigned Linux AppImage has no code-signing boundary for this fuse;
      // turn it off before any signed macOS or Windows build.
      enableNodeCliInspectArguments: true,
      // macOS and Windows only.
      enableEmbeddedAsarIntegrityValidation: false,
      onlyLoadAppFromAsar: true,
      loadBrowserProcessSpecificV8Snapshot: false,
      grantFileProtocolExtraPrivileges: false,
    },
    linux: {
      target: [{ target: 'AppImage', arch: ['x64'] }],
      icon: 'build-resources/icon.png',
      // Sets desktopName, so desktop environments match the window to its .desktop entry.
      syncDesktopName: true,
      category: 'Utility',
      synopsis:
        flavour.kind === 'demo'
          ? 'Synthetic demo of Cindl; never connects to Hermes'
          : 'Desktop home for a self-hosted Hermes agent',
      description:
        flavour.kind === 'demo'
          ? 'Cindl Demo shows the Cindl desktop app with invented, labelled data. It never connects to Hermes.'
          : "Cindl is a command-and-inspect surface for one owner's self-hosted Hermes agent. It connects only to an existing hermes serve backend.",
    },
    // electron-builder would put --no-sandbox in the .desktop entry; Cindl
    // refuses to run without the sandbox (see guards.ts).
    appImage: { executableArgs: [] },
    publish: null,
  }
}

try {
  const flavour = flavourFromArgs(process.argv.slice(2))
  await buildDesktop(flavour)
  const artifacts = await builder.build({
    projectDir: appDir,
    config: packageConfig(flavour),
    linux: ['AppImage'],
    x64: true,
    publish: 'never',
  })
  const resources = path.join(appDir, flavour.releaseDir, 'linux-unpacked', 'resources')
  const problems = gateProblems({
    kind: flavour.kind,
    main: [path.join(resources, 'app.asar')],
    renderer: path.join(resources, 'renderer'),
  })
  if (problems.length) throw new BuildError(problems.join('\n'))
  console.log(
    `desktop package (${flavour.kind}): gates passed\n${artifacts.map((file) => `  ${path.relative(appDir, file)}`).join('\n')}`,
  )
} catch (error) {
  if (!(error instanceof BuildError)) throw error
  console.error(`desktop package: ${error.message}`)
  process.exit(1)
}
