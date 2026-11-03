// Cindl handbook theme: VitePress's default theme without its bundled Inter
// font, restyled with the shared Cindl tokens and fonts (packages/tokens).
// Everything is served from the site itself: no font CDN, scripts or analytics.
import DefaultTheme from 'vitepress/theme-without-fonts'
import '../../../../packages/tokens/generated/fonts.css'
import '../../../../packages/tokens/generated/tokens.css'
import Layout from './Layout.vue'
import './style.css'

export default { extends: DefaultTheme, Layout }
