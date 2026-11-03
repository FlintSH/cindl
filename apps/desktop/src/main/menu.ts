import type { MenuItemConstructorOptions } from 'electron'

export const HANDBOOK_URL =
  'https://github.com/FlintSH/cindl/blob/main/docs/handbook/clients/desktop.md'

/**
 * The application menu: standard roles and accelerators only, so Cindl's own
 * shortcuts (apps/web/src/shortcuts.ts: Mod+K, Mod+J, Mod+., Alt+1..4) stay
 * free. Developer tools appear only when they are allowed.
 */
export function buildMenuTemplate(options: {
  devTools: boolean
  openHandbook(): void
}): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions[] = [
    { role: 'reload' },
    ...(options.devTools
      ? ([{ role: 'forceReload' }, { role: 'toggleDevTools' }] as const)
      : []),
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ]
  return [
    {
      label: '&File',
      submenu: [{ role: 'close' }, { type: 'separator' }, { role: 'quit' }],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    { label: '&View', submenu: view },
    { label: '&Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    {
      label: '&Help',
      submenu: [
        { label: 'Cindl desktop handbook', click: () => options.openHandbook() },
        { type: 'separator' },
        { role: 'about' },
      ],
    },
  ]
}
