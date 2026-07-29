import { describe, expect, it } from 'vitest'
import { detachString } from './detached-string'
import { createForceGc, resolveForcedGc } from './forced-gc-for-retention-tests'

describe('detachString', () => {
  it('returns the value unchanged', () => {
    for (const value of ['', 'a', '✳ Working… (esc to interrupt)', '{"questions":[]}', ' \n\t ']) {
      expect(detachString(value)).toBe(value)
    }
  })

  it('preserves surrogate pairs and astral characters', () => {
    const value = '🚀 done \u{1f4a9}'
    expect(detachString(value)).toBe(value)
    expect(detachString(value).length).toBe(value.length)
  })

  it('preserves a lone surrogate', () => {
    const value = '\ud83d'
    expect(detachString(value)).toBe(value)
  })

  // Why the control arm: V8 only builds a SlicedString when the result is at
  // least SlicedString::kMinLength (13) chars; shorter slices are already
  // copied flat. A retention assertion over a short result therefore passes
  // with or without detachString and proves nothing. Measuring the raw slice
  // in the same run makes the test fail if that premise ever stops holding.
  //
  // resolveForcedGc works without --expose-gc, so this guard runs under the
  // plain `vitest run` CI uses instead of silently skipping.
  const forcedGc = resolveForcedGc()
  const itWithGc = forcedGc ? it : it.skip
  itWithGc('detaches a slice from its parent buffer', () => {
    const chunkChars = 16 * 1024
    const slices = 4096
    const forceGc = createForceGc(forcedGc!)
    // Comfortably over kMinLength so the untouched slice really is a SlicedString.
    const measure = (detach: boolean): number => {
      const held: string[] = []
      forceGc()
      const before = process.memoryUsage().heapUsed
      for (let index = 0; index < slices; index += 1) {
        const sliced = `${'x'.repeat(chunkChars)}|retained-title-${index}`.slice(chunkChars + 1)
        held.push(detach ? detachString(sliced) : sliced)
      }
      forceGc()
      const retainedMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024)
      expect(held).toHaveLength(slices)
      expect(held[0].length).toBeGreaterThanOrEqual(13)
      return retainedMiB
    }

    const attachedMiB = measure(false)
    const detachedMiB = measure(true)
    // ~128 MiB of parents stay alive when the slices are left attached.
    expect(attachedMiB).toBeGreaterThan(16)
    expect(detachedMiB).toBeLessThan(attachedMiB / 8)
  })
})
