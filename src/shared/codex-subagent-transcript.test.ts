import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createCodexSubagentTranscriptState,
  hasTrackedCodexTranscriptSubagents,
  reconcileCodexSubagentTranscript
} from './codex-subagent-transcript'
import { codexRosterToSnapshots, type CodexSubagentRoster } from './codex-subagent-roster'
import { createForceGc, resolveForcedGc } from './forced-gc-for-retention-tests'

const CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f316f'

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

function activity(kind: string, occurredAtMs = 1234): unknown {
  return {
    type: 'event_msg',
    payload: {
      type: 'sub_agent_activity',
      occurred_at_ms: occurredAtMs,
      agent_thread_id: CHILD_ID,
      agent_path: '/root/sidebar_repro',
      kind
    }
  }
}

/** `<root>/YYYY/MM/DD` for a timestamp, matching how Codex buckets rollouts by local start date. */
function dayDirectory(root: string, atMs: number): string {
  const at = new Date(atMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return join(root, String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()))
}

describe('Codex subagent transcript reconciliation', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it('adds a child from the parent rollout and removes it after task completion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-subagent-transcript-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(parentPath, jsonl([activity('started')]))
    writeFileSync(childPath, jsonl([{ type: 'event_msg', payload: { type: 'task_started' } }]))
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()

    reconcileCodexSubagentTranscript(state, roster, parentPath)

    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(true)
    expect(codexRosterToSnapshots(roster)).toEqual([
      {
        id: CHILD_ID,
        description: '/root/sidebar_repro',
        state: 'working',
        startedAt: 1234,
        agentType: undefined,
        model: undefined
      }
    ])

    writeFileSync(
      childPath,
      jsonl([
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'task_complete' } }
      ])
    )
    reconcileCodexSubagentTranscript(state, roster, parentPath)

    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
    expect(codexRosterToSnapshots(roster)).toBeUndefined()
  })

  it('resolves a child rollout filed under a later session day than the parent', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-subagent-transcript-'))
    dirs.push(root)
    const childStartedAt = Date.now()
    const parentDir = dayDirectory(root, childStartedAt - 24 * 60 * 60 * 1000)
    const childDir = dayDirectory(root, childStartedAt)
    mkdirSync(parentDir, { recursive: true })
    mkdirSync(childDir, { recursive: true })
    const parentPath = join(parentDir, 'rollout-parent.jsonl')
    const childPath = join(childDir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(parentPath, jsonl([activity('started', childStartedAt)]))
    writeFileSync(childPath, jsonl([{ type: 'event_msg', payload: { type: 'task_started' } }]))
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()

    reconcileCodexSubagentTranscript(state, roster, parentPath)
    writeFileSync(
      childPath,
      jsonl([
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'task_complete' } }
      ])
    )
    reconcileCodexSubagentTranscript(state, roster, parentPath)

    // Why: only a cross-day lookup can observe the completion; the parent-directory scan never finds this file.
    expect(roster.size).toBe(0)
    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
  })

  it('retires a child whose rollout never becomes readable', () => {
    vi.useFakeTimers()
    try {
      const dir = mkdtempSync(join(tmpdir(), 'codex-subagent-transcript-'))
      dirs.push(dir)
      const parentPath = join(dir, 'rollout-parent.jsonl')
      writeFileSync(parentPath, jsonl([activity('started')]))
      const state = createCodexSubagentTranscriptState()
      const roster: CodexSubagentRoster = new Map()

      reconcileCodexSubagentTranscript(state, roster, parentPath)
      expect(roster.size).toBe(1)

      // Why: within the grace window a slow-to-appear rollout must not drop a live child.
      vi.advanceTimersByTime(30_000)
      reconcileCodexSubagentTranscript(state, roster, parentPath)
      expect(roster.size).toBe(1)

      vi.advanceTimersByTime(31_000)
      reconcileCodexSubagentTranscript(state, roster, parentPath)
      expect(roster.size).toBe(0)
      expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes a child when Codex reports it interrupted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-subagent-transcript-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    writeFileSync(parentPath, jsonl([activity('started')]))
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()
    reconcileCodexSubagentTranscript(state, roster, parentPath)

    writeFileSync(parentPath, jsonl([activity('started'), activity('interrupted')]))
    reconcileCodexSubagentTranscript(state, roster, parentPath)

    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
    expect(roster.size).toBe(0)
  })

  // The trailing partial line is parked per cursor in
  // codexSubagentTranscriptByPaneKey until the next poll, and `split` yields
  // slices of the up-to-1 MiB read buffer, so an attached carry pins a whole
  // buffer per tracked pane.
  const forcedGc = resolveForcedGc()
  const itWithGc = forcedGc ? it : it.skip
  itWithGc('does not pin the read buffer behind a carried partial line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-subagent-transcript-retention-'))
    dirs.push(dir)
    const forceGc = createForceGc(forcedGc!)
    const panes = 128
    const bulkLine = JSON.stringify({ type: 'event_msg', payload: { type: 'x'.repeat(500_000) } })

    const states = Array.from({ length: panes }, (_unused, index) => {
      const parentPath = join(dir, `rollout-parent-${index}.jsonl`)
      // Trailing partial line (no newline) is what gets carried.
      writeFileSync(parentPath, `${jsonl([activity('started')])}${bulkLine}\n{"partial":${index}`)
      return { state: createCodexSubagentTranscriptState(), parentPath }
    })

    forceGc()
    const before = process.memoryUsage().heapUsed
    for (const { state, parentPath } of states) {
      reconcileCodexSubagentTranscript(state, new Map(), parentPath)
    }
    forceGc()
    const retainedMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024)

    expect(states[0]!.state.parent.carry).toBe('{"partial":0')
    // ~64 MiB of read buffers stay alive if the carries are still attached.
    expect(retainedMiB).toBeLessThan(8)
  })
})
