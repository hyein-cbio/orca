import { describe, expect, it } from 'vitest'
import { createForceGc, resolveForcedGc } from './forced-gc-for-retention-tests'
import {
  advancePartialEscapeTail,
  extractPartialEscapeTail,
  MAX_PARTIAL_ESCAPE_TAIL_LENGTH
} from './terminal-partial-escape-tail'

describe('extractPartialEscapeTail', () => {
  it('returns empty for parser-clean streams', () => {
    expect(extractPartialEscapeTail('')).toBe('')
    expect(extractPartialEscapeTail('plain text no escapes')).toBe('')
    expect(extractPartialEscapeTail('\x1b[38;5;196mred\x1b[0m done')).toBe('')
    expect(extractPartialEscapeTail('\x1b[2J\x1b[H')).toBe('')
  })

  it('returns the dangling CSI when a chunk ends mid-sequence', () => {
    expect(extractPartialEscapeTail('hello\x1b[3')).toBe('\x1b[3')
    expect(extractPartialEscapeTail('a\x1b[38;5;')).toBe('\x1b[38;5;')
    expect(extractPartialEscapeTail('\x1b')).toBe('\x1b')
    expect(extractPartialEscapeTail('\x1b[')).toBe('\x1b[')
  })

  it('returns the dangling OSC (unterminated) sequence', () => {
    // OSC 0 title with no BEL/ST terminator yet.
    expect(extractPartialEscapeTail('\x1b]0;my-title')).toBe('\x1b]0;my-title')
    // Terminated OSC is clean.
    expect(extractPartialEscapeTail('\x1b]0;title\x07after')).toBe('')
    expect(extractPartialEscapeTail('\x1b]0;title\x1b\\after')).toBe('')
  })

  it('treats a fresh ESC as aborting a pending CSI', () => {
    // The second ESC starts a new (complete) sequence.
    expect(extractPartialEscapeTail('\x1b[3\x1b[0m')).toBe('')
    // ...and a new dangling one.
    expect(extractPartialEscapeTail('\x1b[3\x1b[')).toBe('\x1b[')
  })

  it('treats CAN/SUB as aborting an in-progress escape back to ground', () => {
    // CAN (0x18) / SUB (0x1a) abort the sequence in xterm's VT500 parser.
    // esc state:
    expect(extractPartialEscapeTail('\x1b\x18')).toBe('') // ESC CAN
    expect(extractPartialEscapeTail('\x1b\x1a')).toBe('') // ESC SUB
    // escIntermediate state (ESC then an intermediate byte, then CAN):
    expect(extractPartialEscapeTail('\x1b \x18')).toBe('') // ESC SP CAN
    expect(extractPartialEscapeTail('\x1b#\x1a')).toBe('') // ESC # SUB
    // csi/osc/string already aborted — keep them green:
    expect(extractPartialEscapeTail('\x1b[38;\x18')).toBe('') // CSI ... CAN
    expect(extractPartialEscapeTail('\x1b]0;title\x18')).toBe('') // OSC ... CAN
    // A CAN that aborts, followed by a fresh dangling sequence, tracks the new one:
    expect(extractPartialEscapeTail('\x1b\x18\x1b[3')).toBe('\x1b[3')
  })

  it('is fold-safe across chunk boundaries', () => {
    // extract(a + b) === extract(extract(a) + b) — the invariant ingest relies on.
    const cases: [string, string][] = [
      ['first\x1b[3', '8;5;196mred'],
      ['\x1b', '[0m'],
      ['\x1b]0;ti', 'tle\x07'],
      ['clean', '\x1b[1'],
      // Fold-safety must hold across the CAN abort too.
      ['\x1b', '\x18after'],
      ['\x1b ', '\x18after']
    ]
    for (const [a, b] of cases) {
      expect(extractPartialEscapeTail(extractPartialEscapeTail(a) + b)).toBe(
        extractPartialEscapeTail(a + b)
      )
    }
  })
})

describe('advancePartialEscapeTail', () => {
  it('accumulates a split sequence across chunks', () => {
    let tail = ''
    tail = advancePartialEscapeTail(tail, 'ls\r\n\x1b[3')
    expect(tail).toBe('\x1b[3')
    tail = advancePartialEscapeTail(tail, '8;5;196m')
    expect(tail).toBe('') // sequence completed
  })

  it('abandons tracking (returns empty) past the cap', () => {
    // An unterminated OSC longer than the cap degrades to pre-fix behavior.
    const huge = `\x1b]0;${'x'.repeat(MAX_PARTIAL_ESCAPE_TAIL_LENGTH + 10)}`
    expect(advancePartialEscapeTail('', huge)).toBe('')
  })

  // The headless emulator parks this tail per session until the next write and
  // ships it in every snapshot, so an attached slice pins a whole written
  // stream per live session.
  const forcedGc = resolveForcedGc()
  const itWithGc = forcedGc ? it : it.skip
  itWithGc('does not pin the written stream behind a carried escape tail', () => {
    const chunkChars = 16 * 1024
    const sessions = 512
    const forceGc = createForceGc(forcedGc!)
    forceGc()
    const before = process.memoryUsage().heapUsed
    const tails = Array.from({ length: sessions }, (_unused, index) =>
      // Unterminated OSC, so the tail is carried into the next write.
      advancePartialEscapeTail('', `${'x'.repeat(chunkChars)}\x1b]0;pane-${index} title`)
    )
    forceGc()
    const retainedMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024)

    expect(tails[0]).toBe('\x1b]0;pane-0 title')
    // The fold must still complete the split sequence on the next chunk.
    expect(advancePartialEscapeTail(tails[0]!, '\x07rest')).toBe('')
    // 8 MiB of source streams stay alive if the tails are still attached.
    expect(retainedMiB).toBeLessThan(2)
  })
})
