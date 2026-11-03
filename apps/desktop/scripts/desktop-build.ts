/**
 * Builds one desktop flavour into its output directory (dist/ for the real
 * app, dist-demo/ for Cindl Demo):
 *
 *   main.cjs      the main process, bundled (no node_modules ship with the app)
 *   preload.cjs   the sandboxed preload, bundled (only `electron` is external)
 *   renderer/     the production apps/web build, without source maps
 *   package.json  so the directory runs unpacked: `electron dist-demo`
 *   THIRD_PARTY_LICENSES.txt
 *
 * Run `pnpm --filter @cindl/web build` first. Both flavours use that same
 * production renderer; the gates in gates.ts check the result.
 */
import { build, type Metafile, type Plugin } from 'esbuild'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FlavourBuild } from './flavours.ts'
import { filesUnder, gateProblems } from './gates.ts'
import { bundledPackages, renderLicenses, runtimeClosure } from './licenses.ts'

export const appDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const repoDir = path.resolve(appDir, '../..')
const webDir = path.join(repoDir, 'apps/web')
const webDist = path.join(webDir, 'dist')

export class BuildError extends Error {}

/**
 * `@cindl/contracts` builds its zod schemas at module scope, which esbuild
 * must assume has side effects. The preload only needs `desktopChannels`, so
 * its build treats the contracts sources as side-effect free and the schemas
 * (and zod) are tree-shaken away.
 */
const contractsSource = `${path.sep}packages${path.sep}contracts${path.sep}src${path.sep}`
const pureContracts: Plugin = {
  name: 'pure-contracts',
  setup(context) {
    context.onResolve({ filter: /^(?:@cindl\/contracts|\.\.?\/.*)$/ }, async (args) => {
      if (args.pluginData === pureContracts) return undefined
      if (args.path !== '@cindl/contracts' && !args.importer.includes(contractsSource))
        return undefined
      const resolved = await context.resolve(args.path, {
        kind: args.kind,
        importer: args.importer,
        resolveDir: args.resolveDir,
        pluginData: pureContracts,
      })
      if (resolved.errors.length) return { errors: resolved.errors }
      return { path: resolved.path, sideEffects: false }
    })
  },
}

export async function buildDesktop(flavour: FlavourBuild): Promise<string> {
  const indexHtml = path.join(webDist, 'index.html')
  if (!existsSync(indexHtml))
    throw new BuildError(
      'apps/web/dist/index.html is missing. Run `pnpm --filter @cindl/web build` first.',
    )
  if (!readFileSync(indexHtml, 'utf8').includes('Content-Security-Policy'))
    throw new BuildError('apps/web/dist is not a production build (no CSP meta tag).')

  const outDir = path.join(appDir, flavour.outDir)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const common = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    legalComments: 'eof',
    logLevel: 'warning',
    metafile: true,
    absWorkingDir: appDir,
    define: { 'process.env.NODE_ENV': '"production"' },
  } as const
  const main = await build({
    ...common,
    entryPoints: [flavour.entry],
    outfile: path.join(outDir, 'main.cjs'),
    target: 'node24',
    // ws loads these optional native accelerators in a try/catch; Cindl ships neither.
    external: ['electron', 'bufferutil', 'utf-8-validate'],
  })
  const preload = await build({
    ...common,
    entryPoints: ['src/preload/index.ts'],
    outfile: path.join(outDir, 'preload.cjs'),
    target: 'chrome156',
    external: ['electron'],
    plugins: [pureContracts],
  })

  // The sandboxed preload can only require `electron`: no Node built-ins may sneak in.
  const unexpected = Object.values(preload.metafile.inputs)
    .flatMap((input) => input.imports.filter((entry) => entry.external))
    .map((entry) => entry.path)
    .filter((name) => name !== 'electron')
  if (unexpected.length)
    throw new BuildError(
      `preload imports ${unexpected.join(', ')}; only electron is allowed.`,
    )

  cpSync(webDist, path.join(outDir, 'renderer'), {
    recursive: true,
    filter: (source) => !source.endsWith('.map'),
  })
  const desktopPackage = JSON.parse(
    readFileSync(path.join(appDir, 'package.json'), 'utf8'),
  ) as { version: string }
  writeFileSync(
    path.join(outDir, 'package.json'),
    `${JSON.stringify(
      {
        name: flavour.packageName,
        productName: flavour.productName,
        version: desktopPackage.version,
        private: true,
        license: 'MIT',
        main: 'main.cjs',
      },
      null,
      2,
    )}\n`,
  )

  // Licences for everything the artifact redistributes besides Electron
  // itself (electron-builder adds Electron's and Chromium's licence files).
  const inputs = (metafile: Metafile) => Object.keys(metafile.inputs)
  const fonts = path.join(repoDir, 'packages/tokens/fonts')
  const { text, missing } = renderLicenses({
    header: `${flavour.productName} desktop third-party licences\n\nCindl itself is MIT licensed, Copyright 2026 Zachary Lowery.\n${readFileSync(path.join(repoDir, 'LICENSE'), 'utf8').trim()}\n\nThe packages below are bundled into the main process, the preload or the renderer, under their own licences.`,
    packages: [
      ...bundledPackages(inputs(main.metafile), appDir),
      ...bundledPackages(inputs(preload.metafile), appDir),
      ...runtimeClosure(webDir),
    ],
    extra: [
      {
        title: 'Instrument Sans (fonts)',
        file: path.join(fonts, 'instrument-sans/OFL.txt'),
      },
      {
        title: 'JetBrains Mono (fonts)',
        file: path.join(fonts, 'jetbrains-mono/OFL.txt'),
      },
    ],
  })
  writeFileSync(path.join(outDir, 'THIRD_PARTY_LICENSES.txt'), text)
  if (missing.length)
    console.warn(`desktop build: no licence file shipped by ${missing.join(', ')}`)

  const problems = gateProblems({
    kind: flavour.kind,
    main: [path.join(outDir, 'main.cjs'), path.join(outDir, 'preload.cjs')],
    renderer: path.join(outDir, 'renderer'),
  })
  if (problems.length) throw new BuildError(problems.join('\n'))

  const size = (file: string) =>
    `${(statSync(path.join(outDir, file)).size / 1024).toFixed(1)} KiB`
  console.log(
    `desktop build (${flavour.kind}): ${flavour.outDir}/main.cjs ${size('main.cjs')}, preload.cjs ${size('preload.cjs')}, renderer ${filesUnder(path.join(outDir, 'renderer')).length} files; gates passed`,
  )
  return outDir
}
