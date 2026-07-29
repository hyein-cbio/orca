import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

/**
 * Resolve a real forced-GC function for retention tests, without requiring the
 * runner to pass `--expose-gc`.
 *
 * Why: CI runs plain `pnpm exec vitest run` (.github/workflows/pr.yml), so
 * `globalThis.gc` is undefined and every `describe.skip`-on-missing-gc
 * retention guard silently stops running — a reintroduced raw slice would land
 * green. `v8.setFlagsFromString('--expose-gc')` plus a throwaway VM context
 * hands back a real `gc` binding in the worker; the flag is reset immediately
 * so nothing else in the process observes it. Returns null only if the host
 * genuinely refuses (hardened runtimes), which keeps callers skippable.
 */
export function resolveForcedGc(): (() => void) | null {
  const existing = (globalThis as { gc?: () => void }).gc
  if (typeof existing === 'function') {
    return existing
  }
  try {
    setFlagsFromString('--expose-gc')
    const exposed = runInNewContext('gc') as unknown
    setFlagsFromString('--no-expose-gc')
    return typeof exposed === 'function' ? (exposed as () => void) : null
  } catch {
    return null
  }
}

/** Double-collect so a freshly unreachable parent is actually released. */
export function createForceGc(gc: () => void): () => void {
  return () => {
    gc()
    gc()
  }
}
