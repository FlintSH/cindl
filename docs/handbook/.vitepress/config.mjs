import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'
import { getBuildInfo } from './build-info.mjs'
import { buildSidebar, excludedPages, rewrites } from './sidebar.mjs'

const handbook = fileURLToPath(new URL('..', import.meta.url))
const repo = join(handbook, '../..')
const repoUrl = 'https://github.com/FlintSH/cindl'
// The app icon is the web client's; the handbook serves it rather than a copy.
const favicon = join(repo, 'apps/web/public/favicon.svg')
const buildInfo = getBuildInfo(repo)

const base = process.env.DOCS_BASE || '/'
if (!/^\/(?:[\w.-]+\/)*$/.test(base))
  throw new Error('DOCS_BASE must begin and end with "/", for example /cindl/.')

// tokens.css keys dark values on [data-theme]; VitePress toggles html.dark.
// Mirror the class onto the attribute before first paint and on every toggle.
const syncTheme = `(() => {
  const root = document.documentElement
  const sync = () => root.setAttribute('data-theme', root.classList.contains('dark') ? 'dark' : 'light')
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['class'] })
  sync()
})()`

const serveFavicon = {
  name: 'cindl-handbook-favicon',
  configureServer(server) {
    server.middlewares.use(`${base}favicon.svg`, (_request, response) => {
      response.setHeader('Content-Type', 'image/svg+xml')
      response.end(readFileSync(favicon))
    })
  },
}

export default defineConfig({
  title: 'Cindl handbook',
  description:
    'How Cindl works, how to develop it, and exactly what it uses from Hermes v0.22.5.',
  lang: 'en-GB',
  base,
  srcExclude: excludedPages,
  rewrites,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['meta', { name: 'referrer', content: 'no-referrer' }],
    ['meta', { name: 'cindl:commit', content: buildInfo.commit ?? 'unavailable' }],
    ['meta', { name: 'cindl:dirty', content: String(buildInfo.dirty) }],
    ['meta', { name: 'cindl:built-at', content: buildInfo.builtAt }],
    ['script', { id: 'cindl-theme-sync' }, syncTheme],
  ],
  markdown: { theme: { light: 'github-light', dark: 'github-dark' } },
  vite: {
    plugins: [serveFavicon],
    // Loopback only. The theme imports shared tokens and fonts from packages/tokens.
    server: {
      host: '127.0.0.1',
      fs: { allow: [handbook, join(repo, 'packages/tokens')] },
    },
  },
  themeConfig: {
    buildInfo,
    repo: repoUrl,
    logo: '/favicon.svg',
    siteTitle: 'Cindl handbook',
    nav: [
      { text: 'Develop', link: '/development/getting-started' },
      { text: 'Reference', link: '/reference/client-operations' },
      { text: 'Architecture', link: '/architecture/overview' },
    ],
    sidebar: buildSidebar(handbook),
    outline: { level: [2, 3], label: 'On this page' },
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: repoUrl, ariaLabel: 'Cindl on GitHub' }],
    editLink: {
      pattern: `${repoUrl}/edit/main/docs/handbook/:path`,
      text: 'Edit this page on GitHub',
    },
  },
  buildEnd({ outDir }) {
    copyFileSync(favicon, join(outDir, 'favicon.svg'))
    writeFileSync(
      join(outDir, 'build-info.json'),
      `${JSON.stringify(buildInfo, null, 2)}\n`,
    )
  },
})
