/** How far the keyboard's top edge reaches into a view ending at `viewBottom` (both in window dp). */
export function keyboardOverlap(
  viewBottom: number,
  keyboardTop: number | undefined,
): number {
  return keyboardTop === undefined ? 0 : Math.max(0, Math.round(viewBottom - keyboardTop))
}
