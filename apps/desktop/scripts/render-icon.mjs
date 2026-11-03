// Renders build-resources/icon.png (512x512, transparent corners) from the
// web app's favicon mark, so the desktop icon is the same original glyph.
// Run: pnpm --filter @cindl/desktop exec electron scripts/render-icon.mjs --ozone-platform=headless
// (add --no-sandbox where Chromium's sandbox cannot start; it only renders this local file).
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'

const SIZE = 512
const svg = readFileSync(new URL('../../web/public/favicon.svg', import.meta.url))
const output = new URL('../build-resources/icon.png', import.meta.url)

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  })
  const page = `<!doctype html><style>html,body{margin:0;overflow:hidden;background:transparent}img{display:block}</style><img width="${SIZE}" height="${SIZE}" src="data:image/svg+xml;base64,${svg.toString('base64')}">`
  await window.loadURL(`data:text/html;base64,${Buffer.from(page).toString('base64')}`)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const image = await window.webContents.capturePage({
    x: 0,
    y: 0,
    width: SIZE,
    height: SIZE,
  })
  writeFileSync(output, image.resize({ width: SIZE, height: SIZE }).toPNG())
  console.log(
    `wrote ${output.pathname} (${image.getSize().width}x${image.getSize().height})`,
  )
  app.quit()
})
