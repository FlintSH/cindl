export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string }

const MAX_CELLS = 4_000_000

/**
 * Line diff for owner review of SOUL.md / skill edits (LCS, O(n*m)). Large
 * inputs fall back to "replace all" rather than freezing the UI; the review
 * screen says so.
 */
export function diffLines(
  before: string,
  after: string,
): { lines: DiffLine[]; exact: boolean } {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > MAX_CELLS)
    return {
      lines: [
        ...a.map((text) => ({ kind: 'removed' as const, text })),
        ...b.map((text) => ({ kind: 'added' as const, text })),
      ],
      exact: false,
    }
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(
              table[(i + 1) * width + j] as number,
              table[i * width + j + 1] as number,
            )
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i] as string })
      i++
      j++
    } else if (
      (table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)
    ) {
      lines.push({ kind: 'removed', text: a[i++] as string })
    } else {
      lines.push({ kind: 'added', text: b[j++] as string })
    }
  }
  while (i < a.length) lines.push({ kind: 'removed', text: a[i++] as string })
  while (j < b.length) lines.push({ kind: 'added', text: b[j++] as string })
  return { lines, exact: true }
}

export function diffStats(lines: readonly DiffLine[]) {
  return {
    added: lines.filter((l) => l.kind === 'added').length,
    removed: lines.filter((l) => l.kind === 'removed').length,
  }
}
