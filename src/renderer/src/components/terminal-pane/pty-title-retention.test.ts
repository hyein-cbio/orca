import { describe, expect, it } from 'vitest'
import { createForceGc, resolveForcedGc } from '../../../../shared/forced-gc-for-retention-tests'
import { createPtyOutputProcessor } from './pty-transport'

// What this proves — and what it does not.
//
// Invariant under test: the title a pane hands the store (setRuntimePaneTitle /
// updateTabTitle) is a standalone string, not a V8 SlicedString over the PTY
// frame it was parsed from. Frames are sized at the production renderer-write
// bound (PTY_BATCH_FLUSH_CHUNK_CHARS = 16 KiB, src/main/ipc/pty.ts), not the
// multi-MiB frames an earlier draft of this test assumed.
//
// Panes are held live simultaneously with no store overwrite, which is the
// unbounded-in-principle shape. Production writes `[paneId]: title`, an
// overwrite that releases the previous parent, so the real live set is
// O(panes). This is a regression guard on the retention property, NOT a
// reproduction of a shipped out-of-memory crash.
//
const MIB = 1024 * 1024
const CHUNK_CHARS = 16 * 1024
const PANES = 2048
// '█' is 2 bytes/char in V8, so a pinned frame costs twice its char count.
const PINNED_FRAME_MIB = (CHUNK_CHARS * PANES * 2) / MIB

// resolveForcedGc works without --expose-gc, so this runs in CI's plain
// `vitest run`. Skips only if a hardened host refuses to expose gc at all.
const forcedGc = resolveForcedGc()
const describeWithGc = forcedGc ? describe : describe.skip
const forceGc = forcedGc ? createForceGc(forcedGc) : (): void => undefined

function makeAgentFrame(index: number): string {
  return `${'█'.repeat(CHUNK_CHARS)}\x1b]0;✳ Working… (esc to interrupt) pane-${index}\x07`
}

describeWithGc('renderer PTY title retention', () => {
  it('does not pin each pane PTY frame behind the title handed to the store', async () => {
    forceGc()
    const before = process.memoryUsage().heapUsed
    // Stands in for store.runtimePaneTitlesByTabId / tab titles: one live title per pane.
    const storedTitles: string[] = []

    for (let pane = 0; pane < PANES; pane += 1) {
      const processor = createPtyOutputProcessor({
        onTitleChange: (normalized) => {
          storedTitles.push(normalized)
        }
      })
      processor.processData(makeAgentFrame(pane), { onData: () => undefined })
      // Drain the deferred side-effect queue the way the real drain timer does.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    forceGc()
    const retainedMiB = (process.memoryUsage().heapUsed - before) / MIB
    const titleChars = storedTitles.reduce((total, title) => total + title.length, 0)

    // eslint-disable-next-line no-console
    console.log(
      `${storedTitles.length} stored pane titles (${titleChars} chars) -> heap delta ${retainedMiB.toFixed(2)} MiB; ` +
        `source frames total ${PINNED_FRAME_MIB} MiB if every title pinned its parent`
    )

    expect(storedTitles).toHaveLength(PANES)
    expect(storedTitles[0]).toBe('✳ Working… (esc to interrupt) pane-0')
    // Titles hold well under 1 MiB of text. A delta near the frame total means
    // the slices still point at their parents.
    expect(retainedMiB).toBeLessThan(PINNED_FRAME_MIB / 8)
  })
})
