/**
 * `node scripts/package.ts [--flavour real|demo] [--platform linux|win]`:
 * builds the flavour, packages it with electron-builder as an unsigned x64
 * Linux AppImage (the default) or Windows NSIS installer, runs the flavour
 * gates again on what was packaged (app.asar and the renderer), and writes a
 * `sha256sum` file next to the AppImage or installer. Build the Windows
 * installer on Windows: NSIS needs Wine anywhere else. Run it under
 * `flock /tmp/cindl-heavy-build.lock` on shared machines.
 */
import builder from 'electron-builder'
import path from 'node:path'
import { writeChecksum } from './checksums.ts'
import { appDir, BuildError, buildDesktop } from './desktop-build.ts'
import { flavourFromArgs } from './flavours.ts'
import { gateProblems } from './gates.ts'
import { packageConfig } from './package-config.ts'

type Platform = 'linux' | 'win'

/** `--platform win` (or `--platform=win`) on the command line; linux by default. */
function platformFromArgs(args: readonly string[]): Platform {
  const index = args.findIndex(
    (arg) => arg === '--platform' || arg.startsWith('--platform='),
  )
  const value =
    index < 0
      ? 'linux'
      : ((args[index]?.includes('=') ? args[index].split('=')[1] : args[index + 1]) ?? '')
  if (value !== 'linux' && value !== 'win')
    throw new BuildError(`Unknown platform "${value}"; use linux or win.`)
  return value
}

try {
  const args = process.argv.slice(2)
  const flavour = flavourFromArgs(args)
  const platform = platformFromArgs(args)
  await buildDesktop(flavour)
  const artifacts = await builder.build({
    projectDir: appDir,
    config: packageConfig(flavour),
    ...(platform === 'win' ? { win: ['nsis'] } : { linux: ['AppImage'] }),
    x64: true,
    publish: 'never',
  })
  const unpacked = platform === 'win' ? 'win-unpacked' : 'linux-unpacked'
  const resources = path.join(appDir, flavour.releaseDir, unpacked, 'resources')
  const problems = gateProblems({
    kind: flavour.kind,
    main: [path.join(resources, 'app.asar')],
    renderer: path.join(resources, 'renderer'),
  })
  if (problems.length) throw new BuildError(problems.join('\n'))
  // Checksums only for output that passed the gates.
  const checksums = artifacts
    .filter((file) => /\.(AppImage|exe)$/.test(file))
    .map(writeChecksum)
  console.log(
    `desktop package (${flavour.kind}, ${platform}): gates passed\n${[...artifacts, ...checksums].map((file) => `  ${path.relative(appDir, file)}`).join('\n')}`,
  )
} catch (error) {
  if (!(error instanceof BuildError)) throw error
  console.error(`desktop package: ${error.message}`)
  process.exit(1)
}
