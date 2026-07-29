import { afterEach, describe, expect, it, vi } from 'vitest'
import { createForceGc, resolveForcedGc } from '../../shared/forced-gc-for-retention-tests'
import { extractLastOsc7Uri, extractOscScanTail } from './osc7-uri-extraction'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OSC-7 URI extraction', () => {
  it('extracts BEL and ST terminated OSC-7 URIs', () => {
    expect(extractLastOsc7Uri('\x1b]7;file:///first\x07noise\x1b]7;file:///second\x1b\\')).toBe(
      'file:///second'
    )
  })

  it('recovers when abandoned incomplete OSC data is followed by a fresh URI', () => {
    expect(extractLastOsc7Uri('\x1b]7;file:///abandoned\x1b]7;file:///fresh\x07')).toBe(
      'file:///fresh'
    )
  })

  it('keeps only bounded incomplete OSC tail text', () => {
    const tail = extractOscScanTail(`\x1b]7;file:///${'x'.repeat(10_000)}`, 128)

    expect(tail).toHaveLength(128)
  })

  it('scans large pasted OSC-like output without regex iteration', () => {
    const execSpy = vi.spyOn(RegExp.prototype, 'exec')
    const data = `${'pasted \x1b]x;noise\x07 '.repeat(10_000)}\x1b]7;file:///repo\x07`

    expect(extractLastOsc7Uri(data)).toBe('file:///repo')
    expect(execSpy).not.toHaveBeenCalled()
  })

  // The tail is parked per-PTY (orca-runtime osc7ScanTailByPtyId) and per
  // daemon scanner until the next chunk, so an attached slice pins one whole
  // source chunk per tracked PTY.
  const forcedGc = resolveForcedGc()
  const itWithGc = forcedGc ? it : it.skip
  itWithGc('does not pin the source chunk behind a carried OSC scan tail', () => {
    const chunkChars = 16 * 1024
    const ptys = 512
    const forceGc = createForceGc(forcedGc!)
    forceGc()
    const before = process.memoryUsage().heapUsed
    const carried = new Map<string, string>()
    for (let index = 0; index < ptys; index += 1) {
      // No terminator yet, so the tail is carried to the next chunk.
      const chunk = `${'x'.repeat(chunkChars)}\x1b]7;file://host/Users/dev/orca/wt-${index}`
      carried.set(`pty-${index}`, extractOscScanTail(chunk, 4096))
    }
    forceGc()
    const retainedMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024)

    expect(carried.get('pty-0')).toBe('\x1b]7;file://host/Users/dev/orca/wt-0')
    // 8 MiB of source chunks stay alive if the tails are still attached.
    expect(retainedMiB).toBeLessThan(2)
  })
})
