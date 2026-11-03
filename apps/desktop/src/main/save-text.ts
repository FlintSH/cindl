import path from 'node:path'

/**
 * `DesktopBridge.saveText`: the renderer suggests a base name and supplies
 * the text; the owner picks the destination in the native save dialog. Only
 * one dialog may be open at a time, so a renderer cannot stack dialogs.
 */
export function createTextSaver(options: {
  showSaveDialog(defaultPath: string): Promise<{ canceled: boolean; filePath?: string }>
  writeFile(filePath: string, content: string): Promise<void>
  defaultDirectory(): string
}) {
  let open = false
  return async (fileName: string, content: string): Promise<{ saved: boolean }> => {
    if (open) return { saved: false }
    open = true
    try {
      const choice = await options.showSaveDialog(
        path.join(options.defaultDirectory(), fileName),
      )
      if (choice.canceled || !choice.filePath) return { saved: false }
      await options.writeFile(choice.filePath, content)
      return { saved: true }
    } finally {
      open = false
    }
  }
}
