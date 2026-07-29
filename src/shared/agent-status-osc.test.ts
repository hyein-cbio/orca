import { describe, expect, it } from 'vitest'
import { createAgentStatusOscProcessor } from './agent-status-osc'
import { createForceGc, resolveForcedGc } from './forced-gc-for-retention-tests'

describe('createAgentStatusOscProcessor', () => {
  it('strips OSC 9999 payloads from terminal data and returns parsed statuses', () => {
    const process = createAgentStatusOscProcessor()

    const result = process(
      'before\x1b]9999;{"state":"working","prompt":"ship it","agentType":"codex"}\x07after'
    )

    expect(result.cleanData).toBe('beforeafter')
    expect(result.payloads).toEqual([
      {
        state: 'working',
        prompt: 'ship it',
        agentType: 'codex'
      }
    ])
  })

  it('preserves parser state across split OSC 9999 chunks', () => {
    const process = createAgentStatusOscProcessor()

    expect(process('before\x1b]999').cleanData).toBe('before')
    const result = process('9;{"state":"done","prompt":"ok"}\x1b\\after')

    expect(result.cleanData).toBe('after')
    expect(result.payloads).toEqual([
      {
        state: 'done',
        prompt: 'ok'
      }
    ])
  })

  // The unterminated-payload carry lives in the processor closure until the
  // next chunk, and there is one processor per pane, so an attached slice
  // would pin a whole PTY chunk per pane.
  const forcedGc = resolveForcedGc()
  const itWithGc = forcedGc ? it : it.skip
  itWithGc('does not pin the source chunk behind a carried OSC 9999 payload', () => {
    const chunkChars = 16 * 1024
    const panes = 512
    const forceGc = createForceGc(forcedGc!)
    forceGc()
    const before = process.memoryUsage().heapUsed
    const processors = Array.from({ length: panes }, (_unused, index) => {
      const processChunk = createAgentStatusOscProcessor()
      // No terminator, so the payload is carried into the next chunk.
      processChunk(`${'x'.repeat(chunkChars)}\x1b]9999;{"state":"working","prompt":"p-${index}"`)
      return processChunk
    })
    forceGc()
    const retainedMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024)

    // The carry must still work: 8 MiB of chunks stay alive if it is attached.
    expect(processors[0]!('}\x07').payloads[0]).toEqual({ state: 'working', prompt: 'p-0' })
    expect(retainedMiB).toBeLessThan(2)
  })
})
