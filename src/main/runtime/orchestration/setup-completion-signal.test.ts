import { describe, expect, it, vi } from 'vitest'
import { createForceGc, resolveForcedGc } from '../../../shared/forced-gc-for-retention-tests'
import { buildObservedSetupCommand, createSetupCompletionScanner } from './setup-completion-signal'

describe('orchestration setup completion signal', () => {
  it('preserves a POSIX setup exit code in a visible completion signal', () => {
    const { command } = buildObservedSetupCommand(
      '/repo/.git/orca/setup-runner.sh',
      'posix',
      'token-posix'
    )

    expect(command).toContain('bash /repo/.git/orca/setup-runner.sh')
    expect(command).toContain('__ORCA_SETUP_COMPLETE__:token-posix:%s\\n')
    expect(command).toContain('"$status"')
    expect(command).toContain('exit "$status"')
  })

  it('preserves a native Windows setup path and exit code without shell interpolation', () => {
    const runnerPath = 'C:\\repo %name%!^&\\.git\\orca\\setup-runner.cmd'
    const observed = buildObservedSetupCommand(runnerPath, 'windows', 'token-windows')
    const encodedCommand = observed.command.split(' ').at(-1)
    const script = Buffer.from(encodedCommand ?? '', 'base64').toString('utf16le')

    expect(observed.command).toContain('powershell.exe -NoLogo -NoProfile -NonInteractive')
    expect(observed.env).toEqual({ ORCA_SETUP_RUNNER_PATH: runnerPath })
    expect(script).toContain('& $runner')
    expect(script).toContain('__ORCA_SETUP_COMPLETE__:token-windows:')
    expect(script).toContain('exit $status')
    expect(script).not.toContain(runnerPath)
  })

  it('keeps a WSL runner on the POSIX completion path', () => {
    const { command } = buildObservedSetupCommand(
      '\\\\wsl.localhost\\Ubuntu\\repo\\.git\\orca\\setup-runner.sh',
      'windows',
      'token-wsl'
    )

    expect(command).toContain('bash /repo/.git/orca/setup-runner.sh')
    expect(command).toContain('__ORCA_SETUP_COMPLETE__:token-wsl:%s\\n')
    expect(command).toContain('exit "$status"')
  })

  it('recognizes one completion signal across output chunk boundaries', () => {
    const onComplete = vi.fn()
    const scanner = createSetupCompletionScanner('token-chunks', onComplete)

    scanner.scan('installing...\r\n__ORCA_SETUP_COMPLETE__:wrong:0\r\n__ORCA_SETUP_COMP')
    scanner.scan('LETE__:token-chunks:1')
    expect(onComplete).not.toHaveBeenCalled()
    scanner.scan('7\r')
    expect(onComplete).not.toHaveBeenCalled()
    scanner.scan('\nPS C:\\repo>')
    scanner.scan('__ORCA_SETUP_COMPLETE__:token-chunks:0\r\n')

    expect(onComplete).toHaveBeenCalledOnce()
    expect(onComplete).toHaveBeenCalledWith(17)
  })
})

// The carry lives in the scanner closure — one per running setup — until the
// next chunk, so an attached slice pins a whole setup-output chunk each.
describe('setup completion scanner retention', () => {
  const forcedGc = resolveForcedGc()
  const itWithGc = forcedGc ? it : it.skip
  itWithGc('does not pin the source chunk behind the carry', () => {
    const chunkChars = 16 * 1024
    const setups = 512
    const forceGc = createForceGc(forcedGc!)
    forceGc()
    const before = process.memoryUsage().heapUsed
    const scanners = Array.from({ length: setups }, (_unused, index) => {
      const scanner = createSetupCompletionScanner(`token-${index}`, () => undefined)
      // A distinct chunk per setup. Sharing one would leave a single parent
      // alive and pass whether or not the carry is detached.
      scanner.scan(`${'x'.repeat(chunkChars)}setup-${index}`)
      return scanner
    })
    forceGc()
    const retainedMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024)

    // The carry must still complete a marker split across the chunk boundary.
    const exitCodes: number[] = []
    const split = createSetupCompletionScanner('tok', (code) => exitCodes.push(code))
    split.scan(`${'x'.repeat(chunkChars)}__ORCA_SETUP_COMPLETE__:tok`)
    split.scan(':7\n')
    expect(exitCodes).toEqual([7])
    expect(scanners).toHaveLength(setups)
    // 8 MiB of source chunks stay alive if the carries are attached.
    expect(retainedMiB).toBeLessThan(2)
  })
})
