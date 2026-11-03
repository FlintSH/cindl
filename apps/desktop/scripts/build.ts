/** `node scripts/build.ts [--flavour real|demo]`: see desktop-build.ts. */
import { BuildError, buildDesktop } from './desktop-build.ts'
import { flavourFromArgs } from './flavours.ts'

try {
  await buildDesktop(flavourFromArgs(process.argv.slice(2)))
} catch (error) {
  if (!(error instanceof BuildError)) throw error
  console.error(`desktop build: ${error.message}`)
  process.exit(1)
}
