/**
 * Return a copy of `value` that shares no backing store with the string it was
 * sliced from.
 *
 * Why: `String.prototype.slice` on a long string produces a V8 SlicedString
 * that keeps a pointer to its parent, so a short slice retained in long-lived
 * state (a store entry, a cached field) pins the entire source buffer — a raw
 * PTY chunk or a hook JSON payload — for as long as the slice is reachable.
 * Concatenating forces V8 to flatten into a fresh flat string, dropping the
 * parent pointer. The leading space is stripped back off so the value is
 * unchanged.
 */
export function detachString(value: string): string {
  if (value.length === 0) {
    return ''
  }
  return ` ${value}`.slice(1)
}
