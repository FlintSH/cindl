// Writes generated/tokens.css and generated/fonts.css from src/. With --check,
// fails instead of writing when the committed files are stale (used in CI).
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { renderFontsCss, renderTokensCss } from '../src/css.ts'

const outputs = [
  ['../generated/tokens.css', renderTokensCss()],
  ['../generated/fonts.css', renderFontsCss()],
] as const
const check = process.argv.includes('--check')
let stale = 0
for (const [relative, content] of outputs) {
  const path = fileURLToPath(new URL(relative, import.meta.url))
  const current = await readFile(path, 'utf8').catch(() => '')
  if (current === content) continue
  if (check) {
    console.error(`${relative} is stale. Run: pnpm --filter @cindl/tokens generate`)
    stale++
  } else {
    await writeFile(path, content)
    console.log(`wrote ${relative}`)
  }
}
if (stale) process.exit(1)
