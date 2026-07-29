import { describe, expect, it } from 'vitest'
import { createForceGc, resolveForcedGc } from '../../shared/forced-gc-for-retention-tests'
import { TerminalMouseModeMirror } from './terminal-mouse-mode-mirror'

describe('TerminalMouseModeMirror', () => {
  it('mirrors DECSET mouse tracking and SGR encoding modes', () => {
    const mirror = new TerminalMouseModeMirror()
    expect(mirror.mouseTrackingMode).toBe('none')

    mirror.scan('\x1b[?1002h\x1b[?1006h')
    expect(mirror.mouseTrackingMode).toBe('drag')
    expect(mirror.sgrMouseMode).toBe(true)

    mirror.scan('\x1b[?1002l')
    expect(mirror.mouseTrackingMode).toBe('none')
  })

  it('assembles a DECSET split across chunks', () => {
    const mirror = new TerminalMouseModeMirror()
    mirror.scan('output\x1b[?100')
    expect(mirror.mouseTrackingMode).toBe('none')

    mirror.scan('3h')
    expect(mirror.mouseTrackingMode).toBe('any')
  })

  it('clears mirrored modes on RIS', () => {
    const mirror = new TerminalMouseModeMirror()
    mirror.scan('\x1b[?1003h\x1b[?1016h')
    expect(mirror.sgrMousePixelsMode).toBe(true)

    mirror.scan('\x1bc')
    expect(mirror.mouseTrackingMode).toBe('none')
    expect(mirror.sgrMousePixelsMode).toBe(false)
  })

  // One mirror per daemon session holds the scan tail until the next chunk, so
  // an attached slice pins a whole PTY chunk per live session.
  const forcedGc = resolveForcedGc()
  const itWithGc = forcedGc ? it : it.skip
  itWithGc('does not pin the source chunk behind a carried private-mode tail', () => {
    const chunkChars = 16 * 1024
    const sessions = 512
    const forceGc = createForceGc(forcedGc!)
    forceGc()
    const before = process.memoryUsage().heapUsed
    const mirrors = Array.from({ length: sessions }, () => {
      const mirror = new TerminalMouseModeMirror()
      // Ends mid-DECSET, so the params tail is carried into the next chunk.
      mirror.scan(`${'x'.repeat(chunkChars)}\x1b[?1002;1006;100`)
      return mirror
    })
    forceGc()
    const retainedMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024)

    // The carry must still complete the split DECSET across the boundary.
    mirrors[0]!.scan('3h')
    expect(mirrors[0]!.mouseTrackingMode).toBe('any')
    expect(mirrors[0]!.sgrMouseMode).toBe(true)
    // 8 MiB of source chunks stay alive if the tails are still attached.
    expect(retainedMiB).toBeLessThan(2)
  })
})
