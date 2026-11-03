/** The renderer's origin. Shared by main and the preload, which must not import Node modules. */
export const APP_SCHEME = 'app'
export const APP_HOST = 'cindl'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`
