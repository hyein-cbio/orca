// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { Terminal as EsmTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const requireFromHere = createRequire(import.meta.url)
const { Terminal: CjsTerminal } = requireFromHere('@xterm/xterm') as {
  Terminal: typeof EsmTerminal
}

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function openTerminal(TerminalType: typeof EsmTerminal): {
  emitted: string[]
  terminal: EsmTerminal
  textarea: HTMLTextAreaElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new TerminalType()
  terminal.open(container)
  if (!terminal.textarea) {
    throw new Error('xterm textarea was not created')
  }
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { emitted, terminal, textarea: terminal.textarea }
}

function composition(
  textarea: HTMLTextAreaElement,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data?: string
): void {
  const event = new CompositionEvent(type, { bubbles: true })
  if (data !== undefined) {
    Object.defineProperty(event, 'data', { value: data })
  }
  textarea.dispatchEvent(event)
}

function start(textarea: HTMLTextAreaElement, text: string): void {
  textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  composition(textarea, 'compositionstart')
  composition(textarea, 'compositionupdate', text)
  textarea.value += text
  textarea.setSelectionRange(textarea.value.length, textarea.value.length)
}

function timerCount(terminal: EsmTerminal): number {
  return (
    terminal as unknown as {
      _core: { _compositionHelper: { _compositionTimers: Set<unknown> } }
    }
  )._core._compositionHelper._compositionTimers.size
}

describe.each([
  ['ESM', EsmTerminal],
  ['CJS', CjsTerminal]
])('installed xterm adversarial composition ownership (%s)', (_format, TerminalType) => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('rejects a stale end between an immediate restart and its first update', async () => {
    const { emitted, terminal, textarea } = openTerminal(TerminalType)
    start(textarea, 'A')
    await nextEventLoop()
    composition(textarea, 'compositionend', 'A')

    textarea.setSelectionRange(1, 1)
    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionend', 'A')
    await nextEventLoop()
    composition(textarea, 'compositionupdate', 'B')
    textarea.value = 'AB'
    textarea.setSelectionRange(2, 2)
    composition(textarea, 'compositionend', 'B')
    await nextEventLoop()

    expect(emitted.join('')).toBe('AB')
    terminal.dispose()
  })

  it('bounds tracked timers during same-task transaction bursts', async () => {
    const { emitted, terminal, textarea } = openTerminal(TerminalType)
    let maximumTimerCount = 0
    for (let index = 0; index < 256; index++) {
      start(textarea, '가')
      composition(textarea, 'compositionend', '가')
      maximumTimerCount = Math.max(maximumTimerCount, timerCount(terminal))
    }
    await nextEventLoop()

    expect(emitted.join('')).toBe('가'.repeat(256))
    expect(maximumTimerCount).toBeLessThanOrEqual(4)
    expect(timerCount(terminal)).toBe(0)
    terminal.dispose()
  })
})
