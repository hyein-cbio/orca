import { describe, expect, it } from 'vitest'
import { createForceGc, resolveForcedGc } from './forced-gc-for-retention-tests'
import {
  extractHiddenStartupRendererQueryData,
  HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS
} from './terminal-reply-query-extraction'

describe('extractHiddenStartupRendererQueryData', () => {
  it('carries a CSI query split across chunks', () => {
    const first = extractHiddenStartupRendererQueryData('output\x1b[6', '')
    expect(first.pending).toBe('\x1b[6')
    expect(first.statefulQueryData).toBe('')

    const second = extractHiddenStartupRendererQueryData('n', first.pending)
    expect(second.statefulQueryData).toBe('\x1b[6n')
    expect(second.pending).toBe('')
  })

  it('carries a partial OSC color query across chunks', () => {
    const first = extractHiddenStartupRendererQueryData('\x1b]11;', '')
    expect(first.pending).toBe('\x1b]11;')

    const second = extractHiddenStartupRendererQueryData('?\x07', first.pending)
    expect(second.oscColorQueryData).toBe('\x1b]11;?\x07')
    expect(second.pending).toBe('')
  })

  it('bounds the carried pending prefix', () => {
    const { pending } = extractHiddenStartupRendererQueryData(`\x1b[${'1;'.repeat(200)}`, '')
    expect(pending.length).toBe(HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS)
  })

  // `pending` is parked per pane (hiddenStartupRendererQueryPending in
  // pty-connection.ts) until the next chunk, so an attached slice pins a whole
  // PTY chunk per open pane.
  //
  // Why the split CSI is long: V8 only builds a SlicedString past
  // SlicedString::kMinLength (13 chars); a shorter prefix is already copied
  // flat and would make this assertion pass with or without the detach.
  const splitCsi = '\x1b[?1049;2004;2026'
  const forcedGc = resolveForcedGc()
  const itWithGc = forcedGc ? it : it.skip
  itWithGc('does not pin the source chunk behind a carried pending query', () => {
    const chunkChars = 16 * 1024
    const panes = 512
    const forceGc = createForceGc(forcedGc!)
    expect(splitCsi.length).toBeGreaterThanOrEqual(13)
    forceGc()
    const before = process.memoryUsage().heapUsed
    const pendings = Array.from(
      { length: panes },
      (_unused, index) =>
        // A distinct chunk per pane, each ending mid-CSI. Sharing one chunk
        // would leave a single parent alive and pass either way.
        extractHiddenStartupRendererQueryData(
          `${'x'.repeat(chunkChars)}pane-${index}${splitCsi}`,
          ''
        ).pending
    )
    forceGc()
    const retainedMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024)

    // The pending prefix must still assemble the query across the boundary.
    expect(pendings[0]).toBe(splitCsi)
    expect(extractHiddenStartupRendererQueryData('$p', pendings[0]!).statefulQueryData).toBe(
      `${splitCsi}$p`
    )
    // 8 MiB of source chunks stay alive if the pending prefixes are attached.
    expect(retainedMiB).toBeLessThan(2)
  })
})
