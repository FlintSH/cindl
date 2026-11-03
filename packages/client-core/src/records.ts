/**
 * State maps are keyed by ids that come from Hermes or the URL (`constructor`,
 * `__proto__` and `toString` included). They are null-prototype objects and are
 * read only through `entry`, so an id can never resolve to an inherited
 * property. Plain spreads would silently reintroduce Object.prototype.
 */
export type Records<T> = Readonly<Record<string, T>>

export function records<T>(): Records<T> {
  return Object.create(null) as Records<T>
}

export function entry<T>(map: Records<T>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined
}

export function hasEntry(map: Records<unknown>, key: string | undefined): boolean {
  return key !== undefined && Object.hasOwn(map, key)
}

export function withEntry<T>(map: Records<T>, key: string, value: T): Records<T> {
  const next = Object.assign(Object.create(null), map) as Record<string, T>
  // On a null-prototype object this defines an own property even for `__proto__`.
  Object.defineProperty(next, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
  return next
}

export function withoutEntry<T>(map: Records<T>, key: string): Records<T> {
  if (!Object.hasOwn(map, key)) return map
  const next = Object.assign(Object.create(null), map) as Record<string, T>
  delete next[key]
  return next
}

/** Rebuild a map from entries (used where several keys change at once). */
export function fromEntries<T>(entries: Iterable<readonly [string, T]>): Records<T> {
  let next = records<T>()
  for (const [key, value] of entries) next = withEntry(next, key, value)
  return next
}
