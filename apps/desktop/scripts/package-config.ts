/**
 * electron-builder configuration for one flavour: the Linux AppImage and the
 * Windows NSIS installer, both x64 and unsigned, with the same fuses
 * (scripts/package.ts runs it).
 */
import type { Configuration } from 'electron-builder'
import { copyrightHolder, copyrightLine } from './desktop-build.ts'
import type { FlavourBuild } from './flavours.ts'

export function packageConfig(flavour: FlavourBuild): Configuration {
  const out = flavour.outDir
  return {
    appId: flavour.appId,
    productName: flavour.productName,
    executableName: flavour.executableName,
    copyright: copyrightLine(),
    artifactName: flavour.artifactName,
    directories: { output: flavour.releaseDir, buildResources: 'resources' },
    // app.asar holds only the bundled main process and preload. Every
    // dependency is a devDependency bundled by esbuild, so no node_modules ship.
    files: ['package.json', `${out}/main.cjs`, `${out}/preload.cjs`],
    extraMetadata: {
      name: flavour.packageName,
      productName: flavour.productName,
      main: `${out}/main.cjs`,
      // From LICENSE, so package.json does not repeat the holder's name.
      author: copyrightHolder(),
    },
    extraResources: [
      { from: `${out}/renderer`, to: 'renderer' },
      { from: `${out}/THIRD_PARTY_LICENSES.txt`, to: 'THIRD_PARTY_LICENSES.txt' },
    ],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    // The same fuses on Linux and Windows.
    electronFuses: {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      // Kept on so CI can launch-smoke-test this exact binary through the Node
      // inspector (Playwright's _electron). See apps/desktop/AGENTS.md: an
      // unsigned AppImage or Windows installer has no code-signing boundary
      // for this fuse (a process running as you can read the keyring or DPAPI
      // anyway); turn it off before any signed macOS or Windows build.
      enableNodeCliInspectArguments: true,
      // macOS and Windows only. Off: without a signature, whoever can change
      // app.asar can change the executable that holds its hash as well.
      enableEmbeddedAsarIntegrityValidation: false,
      onlyLoadAppFromAsar: true,
      loadBrowserProcessSpecificV8Snapshot: false,
      grantFileProtocolExtraPrivileges: false,
    },
    linux: {
      target: [{ target: 'AppImage', arch: ['x64'] }],
      icon: 'resources/icon.png',
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
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: 'resources/icon.png',
      // Unsigned: there is no Authenticode certificate, and none will be
      // bought. With no signing configuration electron-builder skips signing
      // (it still sets the icon and version details), and SmartScreen warns.
    },
    nsis: {
      artifactName: flavour.installerName,
      // A per-user install: no administrator rights, nothing outside the
      // account. No auto-update, so no differential-update block map.
      oneClick: true,
      perMachine: false,
      differentialPackage: false,
    },
    publish: null,
  }
}
