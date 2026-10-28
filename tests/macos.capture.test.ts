/**
 * Deterministic macOS adapter tests.
 *
 * These run on any operating system and prove the TypeScript orchestration: how
 * the helper is invoked, how its JSON is parsed, and how failures map to plugin
 * error codes. They are NOT evidence that macOS screen capture works; that is
 * what `macos.integration.test.ts` is for.
 */

import { describe, expect, it } from 'vitest'
import { ScreenshotError } from '../src/errors.js'
import type { ProcessRunner, RunRequest, RunResult } from '../src/platforms/process.js'
import {
  DEFAULT_HELPER_PATH,
  HELPER_BUILD_COMMAND,
  createMacosBackend,
  parseMacosCapturePayload,
  parseMacosListPayload,
  parseMacosWindowId,
  resolveHelperPath,
} from '../src/platforms/macos.js'

interface Recorder {
  requests: RunRequest[]
  runner: ProcessRunner
}

function makeRunner(
  handler: (request: RunRequest) => Partial<RunResult> | Promise<Partial<RunResult>>,
): Recorder {
  const requests: RunRequest[] = []
  const runner: ProcessRunner = async (request) => {
    requests.push(request)
    const partial = await handler(request)
    return { stdout: '', stderr: '', code: 0, timedOut: false, ...partial }
  }
  return { requests, runner }
}

const LIST_PAYLOAD = JSON.stringify({
  ok: true,
  platform: 'darwin',
  displays: [
    { index: 0, id: '69733248', name: 'Display 69733248', primary: true, width: 2560, height: 1440, scaleFactor: 2, bounds: { x: 0, y: 0, width: 2560, height: 1440 } },
  ],
  windows: [
    {
      id: 'mac:12345',
      title: 'DSH Screenshot Fixture',
      app: 'FixtureWindowApp',
      pid: 777,
      bounds: { x: 120, y: 140, width: 520, height: 340 },
      onScreen: true,
      foreground: true,
      displayIndex: 0,
      minimized: null,
    },
    {
      id: 'mac:67890',
      title: '',
      app: 'Agent',
      pid: 888,
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      onScreen: false,
      foreground: false,
      displayIndex: null,
      minimized: null,
    },
  ],
  notes: ['ScreenCaptureKit does not report whether a window is minimized'],
})

const SCREEN_PAYLOAD = JSON.stringify({
  ok: true,
  platform: 'darwin',
  mode: 'screen',
  method: 'screencapturekit',
  path: '/tmp/screen.png',
  width: 2560,
  height: 1440,
  displays: [
    { index: 0, id: '69733248', name: 'Display 69733248', primary: true, width: 2560, height: 1440, scaleFactor: 2, bounds: { x: 0, y: 0, width: 2560, height: 1440 } },
  ],
  displayIndex: 0,
  notes: [],
})

const WINDOW_PAYLOAD = JSON.stringify({
  ok: true,
  platform: 'darwin',
  mode: 'window',
  method: 'screencapturekit',
  path: '/tmp/window.png',
  width: 1040,
  height: 680,
  window: {
    id: 'mac:12345',
    title: 'DSH Screenshot Fixture',
    app: 'FixtureWindowApp',
    pid: 777,
    bounds: { x: 120, y: 140, width: 520, height: 340 },
    onScreen: true,
    foreground: true,
  },
  notes: [],
})

const FAKE_HELPER = '/opt/dsh/dsh-screenshot-helper'

describe('helper resolution', () => {
  it('prefers an explicit path', () => {
    expect(resolveHelperPath('/a/helper', {}, (candidate) => candidate === '/a/helper')).toBe('/a/helper')
  })

  it('falls back to the environment override', () => {
    expect(
      resolveHelperPath(undefined, { DSH_SCREENSHOT_MACOS_HELPER: '/env/helper' }, (candidate) =>
        candidate === '/env/helper' || candidate === DEFAULT_HELPER_PATH,
      ),
    ).toBe('/env/helper')
  })

  it('finds the bundled path when it exists', () => {
    expect(resolveHelperPath(undefined, {}, (candidate) => candidate === DEFAULT_HELPER_PATH)).toBe(
      DEFAULT_HELPER_PATH,
    )
  })

  it('reports nothing when the helper has not been built', () => {
    expect(resolveHelperPath(undefined, {}, () => false)).toBeUndefined()
  })
})

describe('helper invocation', () => {
  it('runs the helper with no shell and forwards the signal', async () => {
    const recorder = makeRunner(() => ({ stdout: LIST_PAYLOAD }))
    const backend = createMacosBackend({
      runner: recorder.runner,
      helperPath: FAKE_HELPER,
      exists: () => true,
    })
    const controller = new AbortController()

    const result = await backend.listTargets({ signal: controller.signal })

    expect(recorder.requests[0]!.command).toBe(FAKE_HELPER)
    expect(recorder.requests[0]!.args).toEqual(['list'])
    expect(recorder.requests[0]!.signal).toBe(controller.signal)
    expect(result.windows).toHaveLength(2)
  })

  it('passes --out and --display for a screen capture', async () => {
    const recorder = makeRunner(() => ({ stdout: SCREEN_PAYLOAD }))
    const backend = createMacosBackend({ runner: recorder.runner, helperPath: FAKE_HELPER, exists: () => true })

    await backend.captureScreen({ outPath: '/tmp/a.partial' })
    await backend.captureScreen({ outPath: '/tmp/b.partial', display: 0 })
    await backend.captureScreen({ outPath: '/tmp/c.partial', display: '69733248' })

    expect(recorder.requests[0]!.args).toEqual(['capture-screen', '--out', '/tmp/a.partial'])
    expect(recorder.requests[1]!.args).toEqual(['capture-screen', '--out', '/tmp/b.partial', '--display', '0'])
    expect(recorder.requests[2]!.args).toEqual([
      'capture-screen',
      '--out',
      '/tmp/c.partial',
      '--display',
      '69733248',
    ])
  })

  it('passes the numeric window id for a window capture', async () => {
    const recorder = makeRunner(() => ({ stdout: WINDOW_PAYLOAD }))
    const backend = createMacosBackend({ runner: recorder.runner, helperPath: FAKE_HELPER, exists: () => true })

    await backend.captureWindow({ windowId: 'mac:12345', outPath: '/tmp/w.partial', strategy: 'native' })

    expect(recorder.requests[0]!.args).toEqual([
      'capture-window',
      '--out',
      '/tmp/w.partial',
      '--id',
      '12345',
    ])
  })

  it('passes a unicode output path unchanged', async () => {
    const recorder = makeRunner(() => ({ stdout: SCREEN_PAYLOAD }))
    const backend = createMacosBackend({ runner: recorder.runner, helperPath: FAKE_HELPER, exists: () => true })
    const unicode = '/Users/aeshii/Документы/скриншоты/🎯.partial'
    await backend.captureScreen({ outPath: unicode })
    expect(recorder.requests[0]!.args).toContain(unicode)
  })

  it('uses the timeout from the configuration', async () => {
    const recorder = makeRunner(() => ({ stdout: LIST_PAYLOAD }))
    const backend = createMacosBackend({
      runner: recorder.runner,
      helperPath: FAKE_HELPER,
      exists: () => true,
      timeoutMs: 1234,
    })
    await backend.listTargets()
    expect(recorder.requests[0]!.timeoutMs).toBe(1234)
  })
})

describe('payload parsing', () => {
  it('maps windows and displays', () => {
    const result = parseMacosListPayload(JSON.parse(LIST_PAYLOAD))
    expect(result.displays[0]).toMatchObject({ index: 0, id: '69733248', primary: true, scaleFactor: 2 })
    expect(result.windows[0]).toMatchObject({
      id: 'mac:12345',
      title: 'DSH Screenshot Fixture',
      app: 'FixtureWindowApp',
      pid: 777,
      onScreen: true,
      foreground: true,
      displayIndex: 0,
    })
    expect(result.windows[0]!.minimized).toBeUndefined()
    expect(result.windows[1]!.displayIndex).toBeUndefined()
    expect(result.notes).toHaveLength(1)
  })

  it('maps a screen capture payload with the selected display', () => {
    const outcome = parseMacosCapturePayload(JSON.parse(SCREEN_PAYLOAD), 'native')
    expect(outcome.method).toBe('screencapturekit')
    expect(outcome.width).toBe(2560)
    expect(outcome.height).toBe(1440)
    expect(outcome.display).toMatchObject({ index: 0, primary: true })
    expect(outcome.fallback).toBe(false)
  })

  it('maps a window capture payload', () => {
    const outcome = parseMacosCapturePayload(JSON.parse(WINDOW_PAYLOAD), 'native')
    expect(outcome.window).toMatchObject({ id: 'mac:12345', pid: 777 })
    expect(outcome.method).toBe('screencapturekit')
  })

  it('rejects an unknown method', () => {
    expect(() => parseMacosCapturePayload({ ok: true, method: 'screenshot' }, 'native')).toThrow(
      /unknown capture method/i,
    )
  })

  it('parses window identifiers strictly', () => {
    expect(parseMacosWindowId('mac:12345')).toBe(12345)
    expect(parseMacosWindowId('12345')).toBe(12345)
    expect(parseMacosWindowId('  mac:1 ')).toBe(1)
    expect(() => parseMacosWindowId('win32:1')).toThrow(ScreenshotError)
    expect(() => parseMacosWindowId('abc')).toThrow(/not a macOS window identifier/i)
  })
})

describe('failure mapping', () => {
  it('maps a permission denial', async () => {
    const recorder = makeRunner(() => ({
      stdout: JSON.stringify({
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: 'macOS Screen Recording permission is not granted.' },
      }),
      code: 1,
    }))
    const backend = createMacosBackend({ runner: recorder.runner, helperPath: FAKE_HELPER, exists: () => true })
    const error = await backend.listTargets().catch((caught: unknown) => caught as ScreenshotError)
    expect((error as ScreenshotError).code).toBe('PERMISSION_DENIED')
    expect((error as ScreenshotError).hint).toMatch(/System Settings/)
  })

  it('maps a native window failure', async () => {
    const recorder = makeRunner(() => ({
      stdout: JSON.stringify({ ok: false, error: { code: 'WINDOW_NOT_FOUND', message: 'Window 1 is gone.' } }),
      code: 1,
    }))
    const backend = createMacosBackend({ runner: recorder.runner, helperPath: FAKE_HELPER, exists: () => true })
    await expect(
      backend.captureWindow({ windowId: 'mac:1', outPath: '/tmp/x', strategy: 'native' }),
    ).rejects.toMatchObject({ code: 'WINDOW_NOT_FOUND' })
  })

  it('reports a missing helper binary as NATIVE_HELPER_UNAVAILABLE', async () => {
    const recorder = makeRunner(() => ({ spawnError: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }))
    const backend = createMacosBackend({ runner: recorder.runner, helperPath: FAKE_HELPER, exists: () => true })
    const error = (await backend.listTargets().catch((caught: unknown) => caught)) as ScreenshotError
    expect(error.code).toBe('NATIVE_HELPER_UNAVAILABLE')
    expect(error.hint).toContain(HELPER_BUILD_COMMAND)
    expect(error.message).toMatch(/could not be executed/i)
  })

  it('reports a crashed helper with its stderr', async () => {
    const recorder = makeRunner(() => ({ stdout: '', stderr: 'dyld: Symbol not found', code: 134 }))
    const backend = createMacosBackend({ runner: recorder.runner, helperPath: FAKE_HELPER, exists: () => true })
    const error = (await backend.listTargets().catch((caught: unknown) => caught)) as ScreenshotError
    expect(error.code).toBe('CAPTURE_FAILED')
    expect(error.message).toContain('dyld: Symbol not found')
  })

  it('reports a helper killed by a signal as a crash and keeps the diagnostics', async () => {
    // A CoreGraphics assertion aborts the process, so there is no exit code and
    // stderr is the only clue about which stage failed.
    const diagnostics =
      '[stage] start capture-window\n[stage] window: content filter created\n' +
      'Assertion failed: (did_initialize), function CGS_REQUIRE_INIT, file CGInitialization.c, line 44.'
    const recorder = makeRunner(() => ({ stdout: '', stderr: diagnostics, code: null }))
    const backend = createMacosBackend({ runner: recorder.runner, helperPath: FAKE_HELPER, exists: () => true })

    const error = (await backend
      .captureWindow({ windowId: 'mac:1', outPath: '/tmp/x', strategy: 'native' })
      .catch((caught: unknown) => caught)) as ScreenshotError

    expect(error.code).toBe('CAPTURE_FAILED')
    expect(error.message).toContain('crashed')
    expect(error.message).toContain('CGS_REQUIRE_INIT')
    expect(error.message).toContain('window: content filter created')
    expect(error.hint).toMatch(/WindowServer/)
  })

  it('reports a timeout as TIMEOUT and mentions the permission prompt', async () => {
    const recorder = makeRunner(() => ({ timedOut: true, code: null }))
    const backend = createMacosBackend({ runner: recorder.runner, helperPath: FAKE_HELPER, exists: () => true })
    const error = (await backend.listTargets().catch((caught: unknown) => caught)) as ScreenshotError
    expect(error.code).toBe('TIMEOUT')
    expect(error.message).toMatch(/permission/i)
  })

  it('rejects the desktop strategy instead of faking a window image', async () => {
    const recorder = makeRunner(() => ({ stdout: WINDOW_PAYLOAD }))
    const backend = createMacosBackend({ runner: recorder.runner, helperPath: FAKE_HELPER, exists: () => true })
    await expect(
      backend.captureWindow({ windowId: 'mac:1', outPath: '/tmp/x', strategy: 'desktop' }),
    ).rejects.toMatchObject({ code: 'WINDOW_NOT_CAPTURABLE' })
    expect(recorder.requests).toHaveLength(0)
  })
})

describe('degraded mode without the helper', () => {
  const absent = { exists: () => false }

  it('explains that window enumeration needs the helper', async () => {
    const recorder = makeRunner(() => ({}))
    const backend = createMacosBackend({ runner: recorder.runner, ...absent })
    const error = (await backend.listTargets().catch((caught: unknown) => caught)) as ScreenshotError
    expect(error.code).toBe('NATIVE_HELPER_UNAVAILABLE')
    expect(error.hint).toContain(HELPER_BUILD_COMMAND)
    expect(recorder.requests).toHaveLength(0)
  })

  it('captures the main display with the system utility', async () => {
    const recorder = makeRunner(() => ({}))
    const backend = createMacosBackend({ runner: recorder.runner, ...absent })

    const outcome = await backend.captureScreen({ outPath: '/tmp/a.png' })

    expect(recorder.requests[0]!.command).toBe('/usr/sbin/screencapture')
    expect(recorder.requests[0]!.args).toEqual(['-x', '-t', 'png', '/tmp/a.png'])
    expect(outcome.method).toBe('screencapture-cli')
    expect(outcome.fallback).toBe(true)
    expect(outcome.notes.join(' ')).toMatch(/main display only/i)
  })

  it('refuses display selection without the helper', async () => {
    const recorder = makeRunner(() => ({}))
    const backend = createMacosBackend({ runner: recorder.runner, ...absent })
    await expect(backend.captureScreen({ outPath: '/tmp/a.png', display: 1 })).rejects.toMatchObject({
      code: 'NATIVE_HELPER_UNAVAILABLE',
    })
    expect(recorder.requests).toHaveLength(0)
  })

  it('captures a window by CGWindowID with the system utility', async () => {
    const recorder = makeRunner(() => ({}))
    const backend = createMacosBackend({ runner: recorder.runner, ...absent })
    const outcome = await backend.captureWindow({ windowId: 'mac:42', outPath: '/tmp/w.png', strategy: 'native' })
    expect(recorder.requests[0]!.args).toEqual(['-x', '-o', '-t', 'png', '-l', '42', '/tmp/w.png'])
    expect(outcome.method).toBe('screencapture-cli')
  })

  it('rejects a non-numeric window id without the helper', async () => {
    const recorder = makeRunner(() => ({}))
    const backend = createMacosBackend({ runner: recorder.runner, ...absent })
    await expect(
      backend.captureWindow({ windowId: 'bogus', outPath: '/tmp/w.png', strategy: 'native' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(recorder.requests).toHaveLength(0)
  })

  it('reports a failing system utility', async () => {
    const recorder = makeRunner(() => ({ code: 1, stderr: 'could not create image' }))
    const backend = createMacosBackend({ runner: recorder.runner, ...absent })
    const error = (await backend.captureScreen({ outPath: '/tmp/a.png' }).catch((caught: unknown) => caught)) as ScreenshotError
    expect(error.code).toBe('CAPTURE_FAILED')
    expect(error.message).toContain('could not create image')
  })
})
