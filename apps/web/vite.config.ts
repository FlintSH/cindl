import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * Production Content-Security-Policy. No remote scripts, styles, fonts or
 * images: img-src excludes remote hosts so agent-written Markdown cannot
 * beacon data out through image URLs. connect-src 'self' covers a same-origin
 * hermes serve mount. Dev mode omits it because Vite injects inline scripts.
 * Electron applies its own, stricter header in apps/desktop.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ')

const csp = (): Plugin => ({
  name: 'cindl-csp',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: CONTENT_SECURITY_POLICY,
      },
      injectTo: 'head-prepend',
    },
  ],
})

// Relative base: the same build loads from Electron's app:// protocol, from a
// sub-path mount, or from a local preview without rewriting asset URLs.
export default defineConfig({
  base: './',
  plugins: [react(), csp()],
  build: { target: 'es2023', sourcemap: true },
  server: { strictPort: true, port: 5173, host: '127.0.0.1' },
  preview: { strictPort: true, port: 4173, host: '127.0.0.1' },
})
