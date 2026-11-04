/**
 * Copies text from a click. The async Clipboard API first; where it is
 * refused (the desktop app denies every permission request, the clipboard's
 * included) the older copy command, which needs only the click itself.
 * Nothing is ever read from the clipboard.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Refused: try the copy command below.
  }
  const before = document.activeElement
  const area = document.createElement('textarea')
  area.value = text
  area.readOnly = true
  area.setAttribute('aria-hidden', 'true')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '0'
  area.style.opacity = '0'
  area.style.pointerEvents = 'none'
  document.body.append(area)
  area.select()
  let copied: boolean
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  area.remove()
  // Selecting the text moved focus; give it back to the button that was pressed.
  if (before instanceof HTMLElement) before.focus({ preventScroll: true })
  return copied
}
