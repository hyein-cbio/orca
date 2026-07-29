import { describe, expect, it } from 'vitest'
import { createForceGc, resolveForcedGc } from './forced-gc-for-retention-tests'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences
} from './terminal-reply-query-scan'

describe('terminal reply query scan', () => {
  it('records reply-eliciting queries with their output high-water sequence', () => {
    const data = `before\x1b[6nafter\x1b[?2031h`
    const result = scanTerminalReplyQuerySequences(data, 100, EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE)

    expect(result.queries).toEqual([
      { data: '\x1b[6n', startSeq: 106, endSeq: 110 },
      { data: '\x1b[?2031h', startSeq: 115, endSeq: 123 }
    ])
    expect(result.state).toEqual(EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE)
  })

  it('assembles a query split across contiguous PTY chunks', () => {
    const first = scanTerminalReplyQuerySequences(
      '\x1b[?',
      20,
      EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    )
    const second = scanTerminalReplyQuerySequences('2026$p', 23, first.state)

    expect(first.queries).toEqual([])
    expect(second.queries).toEqual([{ data: '\x1b[?2026$p', startSeq: 20, endSeq: 29 }])
  })

  it('drops a partial query when output sequence continuity is lost', () => {
    const first = scanTerminalReplyQuerySequences(
      '\x1b[?',
      20,
      EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    )
    const second = scanTerminalReplyQuerySequences('2026$p', 30, first.state)

    expect(second.queries).toEqual([])
  })

  // The pending prefix is parked in per-stream scan state until the next chunk
  // for the whole mobile-stream buffering window, so an attached slice pins a
  // whole PTY chunk per buffering stream.
  //
  // Why the pending prefix is long: V8 only builds a SlicedString past
  // SlicedString::kMinLength (13 chars); a shorter one is already copied flat
  // and would make this assertion pass with or without the detach.
  const splitQueryPrefix = '\x1b[?1049;2004;2026'
  const forcedGc = resolveForcedGc()
  const itWithGc = forcedGc ? it : it.skip
  itWithGc('does not pin the source chunk behind a pending split query', () => {
    const chunkChars = 16 * 1024
    const streams = 512
    const forceGc = createForceGc(forcedGc!)
    expect(splitQueryPrefix.length).toBeGreaterThanOrEqual(13)
    forceGc()
    const before = process.memoryUsage().heapUsed
    const states = Array.from(
      { length: streams },
      (_unused, index) =>
        // A distinct chunk per stream, each ending mid-CSI so the partial query
        // is carried. Sharing one chunk would leave a single parent alive and
        // make the assertion pass whether or not the pending prefix is detached.
        scanTerminalReplyQuerySequences(
          `${'x'.repeat(chunkChars)}pty-${index}${splitQueryPrefix}`,
          0,
          EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
        ).state
    )
    forceGc()
    const retainedMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024)

    // The pending prefix must still assemble the query across the boundary.
    const pendingStartSeq = states[0]!.pendingStartSeq!
    const resumed = scanTerminalReplyQuerySequences(
      '$p',
      pendingStartSeq + splitQueryPrefix.length,
      states[0]!
    )
    expect(resumed.queries).toEqual([
      {
        data: `${splitQueryPrefix}$p`,
        startSeq: pendingStartSeq,
        endSeq: pendingStartSeq + splitQueryPrefix.length + 2
      }
    ])
    // 8 MiB of source chunks stay alive if the pending prefixes are attached.
    expect(retainedMiB).toBeLessThan(2)
  })
})
