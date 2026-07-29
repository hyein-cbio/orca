import { describe, expect, it } from 'vitest'
import { createForceGc, resolveForcedGc } from './forced-gc-for-retention-tests'
import { extractAllOscTitles } from './osc-title-extraction'

// What this proves — and what it does not.
//
// Invariant under test: an extracted OSC title is a standalone string, not a V8
// SlicedString pinning the PTY chunk it was cut from. Chunks are sized at the
// production renderer-write bound (PTY_BATCH_FLUSH_CHUNK_CHARS = 16 KiB, see
// src/main/ipc/pty.ts), not the multi-MiB chunks an earlier draft assumed.
//
// This is the unbounded-in-principle case: N titles from N distinct chunks all
// held live at once. Production's per-pane store write is an overwrite, so the
// live set there is O(panes) and small. So this is a regression guard on the
// retention property, NOT a reproduction of a shipped out-of-memory crash.
//
const MIB = 1024 * 1024
const CHUNK_CHARS = 16 * 1024
const RETAINED_TITLES = 4096
const PINNED_CHUNK_MIB = (CHUNK_CHARS * RETAINED_TITLES) / MIB

// resolveForcedGc works without --expose-gc, so this runs in CI's plain
// `vitest run`. Skips only if a hardened host refuses to expose gc at all.
const forcedGc = resolveForcedGc()
const describeWithGc = forcedGc ? describe : describe.skip
const forceGc = forcedGc ? createForceGc(forcedGc) : (): void => undefined

function makePtyChunk(index: number): string {
  // A realistic dense agent frame: bulk redraw plus one OSC 0 working title.
  return `${'x'.repeat(CHUNK_CHARS)}\x1b]0;✳ Working… (esc to interrupt) ${index}\x07`
}

describeWithGc('OSC title retention', () => {
  it('does not pin the source PTY chunk behind a retained title', () => {
    forceGc()
    const before = process.memoryUsage().heapUsed
    const retained: string[] = []
    for (let index = 0; index < RETAINED_TITLES; index += 1) {
      // The chunk itself goes out of scope every iteration; only the title survives.
      const titles = extractAllOscTitles(makePtyChunk(index))
      retained.push(titles.at(-1) as string)
    }
    forceGc()
    const retainedMiB = (process.memoryUsage().heapUsed - before) / MIB
    const titleChars = retained.reduce((total, title) => total + title.length, 0)

    // eslint-disable-next-line no-console
    console.log(
      `retained ${retained.length} titles (${titleChars} chars total) -> heap delta ${retainedMiB.toFixed(2)} MiB; ` +
        `source chunks total ${PINNED_CHUNK_MIB} MiB if every title pinned its parent`
    )

    expect(retained).toHaveLength(RETAINED_TITLES)
    expect(retained[0]).toBe('✳ Working… (esc to interrupt) 0')
    // The titles hold well under 1 MiB of actual text. A delta anywhere near the
    // source-chunk total means the slices still point at their parents.
    expect(retainedMiB).toBeLessThan(PINNED_CHUNK_MIB / 8)
  })
})
