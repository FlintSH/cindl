/**
 * The two desktop flavours (ADR 0011). Both load the same production web
 * renderer. The real flavour bundles no synthetic data and cannot enter demo
 * mode; Cindl Demo bundles the synthetic scenario and is labelled by its
 * product name, app id and window title as well as by the renderer's notice.
 */
import { DEMO_PRODUCT_NAME } from '@cindl/contracts'

export interface FlavourBuild {
  kind: 'real' | 'demo'
  /** Main-process entry point. */
  entry: string
  /** Build output, relative to apps/desktop (both are git-ignored). */
  outDir: string
  /** package.json `name` inside the package. */
  packageName: string
  productName: string
  appId: string
  executableName: string
  /** The Linux AppImage's file name. */
  artifactName: string
  /** The Windows NSIS installer's file name. */
  installerName: string
  /** electron-builder output, relative to apps/desktop. */
  releaseDir: string
}

export const flavours: Readonly<Record<'real' | 'demo', FlavourBuild>> = {
  real: {
    kind: 'real',
    entry: 'src/main/index.ts',
    outDir: 'dist',
    packageName: '@cindl/desktop',
    productName: 'Cindl',
    appId: 'io.github.flintsh.cindl',
    executableName: 'cindl',
    artifactName: 'Cindl-${version}-${arch}.${ext}',
    installerName: 'Cindl-Setup-${version}.${ext}',
    releaseDir: 'release/real',
  },
  demo: {
    kind: 'demo',
    entry: 'src/main/demo.ts',
    outDir: 'dist-demo',
    packageName: '@cindl/desktop-demo',
    productName: DEMO_PRODUCT_NAME,
    appId: 'io.github.flintsh.cindl.demo',
    executableName: 'cindl-demo',
    artifactName: 'Cindl-Demo-${version}-${arch}.${ext}',
    installerName: 'Cindl-Demo-Setup-${version}.${ext}',
    releaseDir: 'release/demo',
  },
}

/** `--flavour demo` (or `--flavour=demo`) on the command line; real by default. */
export function flavourFromArgs(args: readonly string[]): FlavourBuild {
  const index = args.findIndex(
    (arg) => arg === '--flavour' || arg.startsWith('--flavour='),
  )
  const value =
    index < 0
      ? 'real'
      : ((args[index]?.includes('=') ? args[index].split('=')[1] : args[index + 1]) ?? '')
  if (value !== 'real' && value !== 'demo')
    throw new Error(`Unknown flavour "${value}"; use real or demo.`)
  return flavours[value]
}
