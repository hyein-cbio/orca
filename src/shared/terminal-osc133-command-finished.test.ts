import { describe, expect, it, vi } from 'vitest'
import { createForceGc, resolveForcedGc } from './forced-gc-for-retention-tests'
import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'

describe('createOsc133CommandFinishedScanner', () => {
  it('reports the exit code for a complete OSC 133;D sequence', () => {
    const onCommandFinished = vi.fn()
    const scanner = createOsc133CommandFinishedScanner(onCommandFinished)

    scanner.scan('build output\x1b]133;D;3\x07more')

    expect(onCommandFinished).toHaveBeenCalledWith(3)
  })

  it('carries an unterminated sequence into the next chunk', () => {
    const onCommandFinished = vi.fn()
    const scanner = createOsc133CommandFinishedScanner(onCommandFinished)

    scanner.scan('\x1b]133;D;')
    expect(onCommandFinished).not.toHaveBeenCalled()

    scanner.scan('7\x07')
    expect(onCommandFinished).toHaveBeenCalledWith(7)
  })

  it('drops the carry on reset', () => {
    const onCommandFinished = vi.fn()
    const scanner = createOsc133CommandFinishedScanner(onCommandFinished)

    scanner.scan('\x1b]133;D;1')
    scanner.reset()
    scanner.scan('\x07')

    expect(onCommandFinished).not.toHaveBeenCalled()
  })

  // The carry lives in the scanner closure until the next chunk, and there is
  // one scanner per pane, so an attached slice pins a whole PTY chunk per pane.
  const forcedGc = resolveForcedGc()
  const itWithGc = forcedGc ? it : it.skip
  itWithGc('does not pin the source chunk behind a carried OSC 133 payload', () => {
    const chunkChars = 16 * 1024
    const panes = 512
    const forceGc = createForceGc(forcedGc!)
    const finished = vi.fn()
    forceGc()
    const before = process.memoryUsage().heapUsed
    const scanners = Array.from({ length: panes }, (_unused, index) => {
      const scanner = createOsc133CommandFinishedScanner(finished)
      // No terminator yet, so the payload is carried into the next chunk.
      scanner.scan(`${'x'.repeat(chunkChars)}\x1b]133;D;${index} pending payload tail text`)
      return scanner
    })
    forceGc()
    const retainedMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024)

    // The carry must still resolve across the chunk boundary.
    scanners[0]!.scan('\x07')
    expect(finished).toHaveBeenCalledWith(0)
    // 8 MiB of source chunks stay alive if the carries are still attached.
    expect(retainedMiB).toBeLessThan(2)
  })
})
