/**
 * Regenerates the launcher icon and splash images in apps/android/assets from
 * the Cindl mark (the flame path in apps/web/public/favicon.svg) and the
 * colours in @cindl/tokens. Run after changing either:
 *
 *   node apps/android/scripts/render-icons.ts [path-to-chrome]   (default: google-chrome)
 *
 * SVG sources are written next to the PNGs so the assets stay reviewable.
 * Rasterising uses a local headless Chrome; no network access.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { themes } from '@cindl/tokens'

const chrome = process.argv.at(2) ?? 'google-chrome'
const assets = path.join(import.meta.dirname, '..', 'assets')
const size = 1024

// Flame from apps/web/public/favicon.svg (32-unit viewBox), bounds x 9.5..22.5, y 6.5..24.4.
const flame =
  'M16 6.5c3.6 4.2 6.5 7.6 6.5 11.4A6.5 6.5 0 0 1 9.5 18c0-2.3 1.2-4.4 2.9-6.4.3 2 1.4 3.4 2.9 3.9-.6-3.4.1-6.2.7-9Z'
const flameBox = { x: 9.5, y: 6.5, width: 13, height: 17.9 }

/** Flame scaled to `height` px and centred on a `size` px canvas. */
function flameGroup(fill: string, height: number): string {
  const scale = height / flameBox.height
  const x = (size - flameBox.width * scale) / 2 - flameBox.x * scale
  const y = (size - flameBox.height * scale) / 2 - flameBox.y * scale
  return `<path transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})" d="${flame}" fill="${fill}"/>`
}

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>\n`

const icons: Record<string, string> = {
  // Legacy launcher icon: the favicon's graphite tile.
  icon: svg(
    `<rect width="${size}" height="${size}" rx="224" fill="${themes.dark.surface}"/>${flameGroup(themes.dark.accent, 560)}`,
  ),
  // Adaptive foreground: the flame inside the 66/108 safe zone; the tile colour is set in app.config.ts.
  'adaptive-icon': svg(flameGroup(themes.dark.accent, 430)),
  // Themed (monochrome) icon: Android tints this silhouette.
  'adaptive-icon-monochrome': svg(flameGroup(themes.dark.text, 430)),
  'splash-icon-light': svg(flameGroup(themes.light.accent, 720)),
  'splash-icon-dark': svg(flameGroup(themes.dark.accent, 720)),
}

const work = mkdtempSync(path.join(tmpdir(), 'cindl-icons-'))
try {
  for (const [name, source] of Object.entries(icons)) {
    const svgPath = path.join(assets, 'source', `${name}.svg`)
    writeFileSync(svgPath, source)
    execFileSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      `--user-data-dir=${work}`,
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--screenshot=${path.join(assets, `${name}.png`)}`,
      `file://${svgPath}`,
    ])
    console.log(`rendered assets/${name}.png`)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
