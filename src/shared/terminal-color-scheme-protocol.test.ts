import { describe, expect, it } from 'vitest'

import { createForceGc, resolveForcedGc } from './forced-gc-for-retention-tests'
import {
  mode2031SequenceFor,
  resolveTerminalColorSchemeMode,
  scanMode2031Sequences
} from './terminal-color-scheme-protocol'

describe('terminal color scheme protocol', () => {
  it('maps mode 2031 replies to CSI 997 status reports', () => {
    expect(mode2031SequenceFor('dark')).toBe('\x1b[?997;1n')
    expect(mode2031SequenceFor('light')).toBe('\x1b[?997;2n')
  })

  it('resolves system color scheme from app settings and system preference', () => {
    expect(resolveTerminalColorSchemeMode({ theme: 'dark' }, false)).toBe('dark')
    expect(resolveTerminalColorSchemeMode({ theme: 'light' }, true)).toBe('light')
    expect(resolveTerminalColorSchemeMode({ theme: 'system' }, true)).toBe('dark')
    expect(resolveTerminalColorSchemeMode({ theme: 'system' }, false)).toBe('light')
  })

  it('detects mode 2031 subscribes in compound and split private mode sequences', () => {
    expect(scanMode2031Sequences('', '\x1b[?25;2031h')).toMatchObject({
      subscribe: true,
      finalState: 'subscribed',
      tail: ''
    })

    const first = scanMode2031Sequences('', '\x1b[?20')
    expect(first).toMatchObject({ subscribe: false, finalState: null, tail: '\x1b[?20' })

    expect(scanMode2031Sequences(first.tail, '31h')).toMatchObject({
      subscribe: true,
      finalState: 'subscribed',
      tail: ''
    })
  })

  it('reports the final mode 2031 state in match order', () => {
    expect(scanMode2031Sequences('', '\x1b[?2031h\x1b[?2031l')).toMatchObject({
      subscribe: true,
      unsubscribe: true,
      finalState: 'unsubscribed',
      tail: ''
    })

    expect(scanMode2031Sequences('', '\x1b[?2031l\x1b[?2031h')).toMatchObject({
      subscribe: true,
      unsubscribe: true,
      finalState: 'subscribed',
      tail: ''
    })
  })

  // The incomplete private-mode tail is carried in per-pane scan state until the
  // next chunk, so an attached slice pins a whole PTY chunk per pane.
  const forcedGc = resolveForcedGc()
  const itWithGc = forcedGc ? it : it.skip
  itWithGc('does not pin the source chunk behind a carried private-mode tail', () => {
    const chunkChars = 16 * 1024
    const panes = 512
    const forceGc = createForceGc(forcedGc!)
    forceGc()
    const before = process.memoryUsage().heapUsed
    const tails = Array.from(
      { length: panes },
      // No final byte yet, so the params tail is carried to the next chunk.
      () => scanMode2031Sequences('', `${'x'.repeat(chunkChars)}\x1b[?1049;2004;2026;12345`).tail
    )
    forceGc()
    const retainedMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024)

    expect(tails[0]).toBe('\x1b[?1049;2004;2026;12345')
    // 8 MiB of source chunks stay alive if the tails are still attached.
    expect(retainedMiB).toBeLessThan(2)
  })
})
