import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { ScreenshotError } from '../src/errors.js'
import type { ProcessRunner, RunRequest, RunResult } from '../src/platforms/process.js'
import {
  DEFAULT_SCRIPT_DIR,
  createWindowsBackend,
  nativeFailure,
  parseCapturePayload,
  parseWindowListPayload,
  resolvePowerShellPath,
} from '../src/platforms/windows.js'

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
    return {
      stdout: '',
      stderr: '',
      code: 0,
      timedOut: false,
      ...partial,
    }
  }
  return { requests, runner }
}

const SCREEN_CAPTURE_PAYLOAD = JSON.stringify({
  ok: true,
  platform: 'win32',
  mode: 'screen',
  strategy: 'native',
  method: 'copyfromscreen',
  path: 'C:\\shots\\screen.png',
  width: 1920,
  height: 1080,
  display: {
    index: 0,
    id: '\\\\.\\DISPLAY1',
    name: '\\\\.\\DISPLAY1',
    primary: true,
    width: 1920,
    height: 1080,
    scaleFactor: 1.5,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  },
  window: null,
  notes: [],
})

const WINDOW_CAPTURE_PAYLOAD = JSON.stringify({
  ok: true,
  platform: 'win32',
  mode: 'window',
  strategy: 'native',
  method: 'printwindow',
  path: 'C:\\shots\\window.png',
  width: 800,
  height: 600,
  display: null,
  window: {
    id: 'win32:4195478',
    title: 'Untitled - Notepad',
    app: 'notepad',
    pid: 4242,
    bounds: { x: 100, y: 120, width: 800, height: 600 },
    minimized: false,
    onScreen: true,
    foreground: true,
  },
  notes: [],
})

const WINDOW_LIST_PAYLOAD = JSON.stringify({
  ok: true,
  platform: 'win32',
  displays: [
    { index: 0, id: '\\\\.\\DISPLAY1', name: 'DISPLAY1', primary: true, width: 1920, height: 1080, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { index: 1, id: '\\\\.\\DISPLAY2', name: 'DISPLAY2', primary: false, width: 1280, height: 1024, scaleFactor: 1, bounds: { x: 1920, y: 0, width: 1280, height: 1024 } },
  ],
  windows: [
    {
      id: 'win32:4195478',
      handle: 4195478,
      title: 'Untitled - Notepad',
      app: 'notepad',
      pid: 4242,
      className: 'Notepad',
      bounds: { x: 100, y: 120, width: 800, height: 600 },
      displayIndex: 0,
      minimized: false,
      onScreen: true,
      foreground: true,
    },
    {
      id: 'win32:99',
      title: '',
      app: 'pid 7 (SomeClass)',
      pid: 7,
      className: 'SomeClass',
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      displayIndex: null,
      minimized: true,
      onScreen: false,
      foreground: false,
    },
  ],
  notes: ['a note'],
})

describe('PowerShell invocation', () => {
  it('resolves the bundled Windows PowerShell by default', () => {
    expect(resolvePowerShellPath(undefined, { SystemRoot: 'C:\\Windows' })).toBe(
      path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    )
    expect(resolvePowerShellPath(undefined, {})).toBe('powershell.exe')
  })

  it('honours an explicit path and the environment override', () => {
    expect(resolvePowerShellPath('C:\\pwsh.exe', {})).toBe('C:\\pwsh.exe')
    expect(resolvePowerShellPath(undefined, { DSH_SCREENSHOT_POWERSHELL: '/usr/local/bin/pwsh' })).toBe(
      '/usr/local/bin/pwsh',
    )
  })

  it('runs list-windows.ps1 with a non-interactive, non-shelved command line', async () => {
    const recorder = makeRunner(() => ({ stdout: WINDOW_LIST_PAYLOAD }))
    const backend = createWindowsBackend({ runner: recorder.runner, powershellPath: 'powershell.exe' })

    await backend.listTargets()

    const request = recorder.requests[0]!
    expect(request.command).toBe('powershell.exe')
    expect(request.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
    ])
    expect(request.args[5]).toBe(path.join(DEFAULT_SCRIPT_DIR, 'list-windows.ps1'))
  })

  it('passes the output path and capture mode as discrete arguments', async () => {
    const recorder = makeRunner(() => ({ stdout: SCREEN_CAPTURE_PAYLOAD }))
    const backend = createWindowsBackend({ runner: recorder.runner, powershellPath: 'powershell.exe' })

    await backend.captureScreen({ outPath: 'C:\\shots\\out.png' })

    const args = recorder.requests[0]!.args
    expect(args).toContain('-Mode')
    expect(args[args.indexOf('-Mode') + 1]).toBe('screen')
    expect(args[args.indexOf('-Out') + 1]).toBe('C:\\shots\\out.png')
    expect(args).not.toContain('-Display')
  })

  it('accepts a numeric and a string display selector', async () => {
    const recorder = makeRunner(() => ({ stdout: SCREEN_CAPTURE_PAYLOAD }))
    const backend = createWindowsBackend({ runner: recorder.runner, powershellPath: 'powershell.exe' })

    await backend.captureScreen({ outPath: 'C:\\shots\\a.png', display: 1 })
    await backend.captureScreen({ outPath: 'C:\\shots\\b.png', display: '\\\\.\\DISPLAY2' })

    expect(recorder.requests[0]!.args[recorder.requests[0]!.args.indexOf('-Display') + 1]).toBe('1')
    expect(recorder.requests[1]!.args[recorder.requests[1]!.args.indexOf('-Display') + 1]).toBe(
      '\\\\.\\DISPLAY2',
    )
  })

  it('forwards the window identifier and the strategy', async () => {
    const recorder = makeRunner(() => ({ stdout: WINDOW_CAPTURE_PAYLOAD }))
    const backend = createWindowsBackend({ runner: recorder.runner, powershellPath: 'powershell.exe' })

    await backend.captureWindow({ windowId: 'win32:4195478', outPath: 'C:\\shots\\w.png', strategy: 'native' })
    await backend.captureWindow({ windowId: 'win32:4195478', outPath: 'C:\\shots\\w2.png', strategy: 'desktop' })

    const first = recorder.requests[0]!.args
    expect(first[first.indexOf('-WindowId') + 1]).toBe('win32:4195478')
    expect(first[first.indexOf('-Strategy') + 1]).toBe('native')
    const second = recorder.requests[1]!.args
    expect(second[second.indexOf('-Strategy') + 1]).toBe('desktop')
  })

  it('passes a unicode output path unchanged', async () => {
    const unicode = 'C:\\Users\\aeshii\\Документы\\скриншоты\\shot 🎯.partial'
    const recorder = makeRunner(() => ({ stdout: SCREEN_CAPTURE_PAYLOAD }))
    const backend = createWindowsBackend({ runner: recorder.runner, powershellPath: 'powershell.exe' })

    await backend.captureScreen({ outPath: unicode })
    expect(recorder.requests[0]!.args).toContain(unicode)
  })

  it('uses the configured script directory', async () => {
    const recorder = makeRunner(() => ({ stdout: WINDOW_LIST_PAYLOAD }))
    const backend = createWindowsBackend({
      runner: recorder.runner,
      powershellPath: 'powershell.exe',
      scriptDir: 'D:\\custom\\scripts',
    })
    await backend.listTargets()
    expect(recorder.requests[0]!.args[5]).toBe(path.join('D:\\custom\\scripts', 'list-windows.ps1'))
  })
})

describe('payload parsing', () => {
  it('maps the window list into the shared target model', () => {
    const result = parseWindowListPayload(JSON.parse(WINDOW_LIST_PAYLOAD))
    expect(result.displays).toHaveLength(2)
    expect(result.displays[1]).toMatchObject({ index: 1, primary: false, width: 1280 })
    expect(result.windows).toHaveLength(2)
    expect(result.windows[0]).toMatchObject({
      id: 'win32:4195478',
      title: 'Untitled - Notepad',
      app: 'notepad',
      pid: 4242,
      minimized: false,
      onScreen: true,
      foreground: true,
      displayIndex: 0,
    })
    // A null display index and an empty title must both survive the mapping.
    expect(result.windows[1]!.displayIndex).toBeUndefined()
    expect(result.windows[1]!.title).toBe('')
    expect(result.notes).toEqual(['a note'])
  })

  it('maps a capture payload including the reported method', () => {
    const outcome = parseCapturePayload(JSON.parse(SCREEN_CAPTURE_PAYLOAD), 'native')
    expect(outcome.method).toBe('copyfromscreen')
    expect(outcome.width).toBe(1920)
    expect(outcome.height).toBe(1080)
    expect(outcome.display).toMatchObject({ index: 0, primary: true, scaleFactor: 1.5 })
    expect(outcome.window).toBeUndefined()
    expect(outcome.fallback).toBe(false)
  })

  it('marks a desktop capture as a fallback', () => {
    const payload = {
      ok: true,
      method: 'desktop-region',
      width: 10,
      height: 10,
      notes: ['overlapping windows are included'],
      window: {
        id: 'win32:5',
        title: 'Notepad',
        app: 'notepad',
        pid: 5,
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        minimized: false,
        onScreen: true,
        foreground: true,
      },
    }
    const outcome = parseCapturePayload(payload, 'desktop')
    expect(outcome.method).toBe('desktop-region')
    expect(outcome.fallback).toBe(true)
    expect(outcome.window?.id).toBe('win32:5')
  })

  it('rejects an unknown capture method', () => {
    const error = (() => {
      try {
        parseCapturePayload({ ok: true, method: 'teleport', width: 1, height: 1 }, 'native')
      } catch (caught) {
        return caught as ScreenshotError
      }
      throw new Error('expected a failure')
    })()
    expect(error.code).toBe('CAPTURE_FAILED')
    expect(error.message).toMatch(/unknown capture method/i)
  })

  it('rejects a payload that is not an object', () => {
    expect(() => parseWindowListPayload([1, 2, 3])).toThrow(ScreenshotError)
    expect(() => parseWindowListPayload(null)).toThrow(ScreenshotError)
  })

  it('treats missing arrays as empty lists', () => {
    const result = parseWindowListPayload({ ok: true })
    expect(result.windows).toEqual([])
    expect(result.displays).toEqual([])
    expect(result.notes).toEqual([])
  })
})

describe('failure mapping', () => {
  it('maps a structured native error', () => {
    const error = nativeFailure({ code: 'WINDOW_NOT_FOUND', message: 'Window win32:5 does not exist any more.' })
    expect(error.code).toBe('WINDOW_NOT_FOUND')
    expect(error.hint).toMatch(/list_windows/)
  })

  it('maps an unknown native code to CAPTURE_FAILED', () => {
    expect(nativeFailure({ code: 'MELTDOWN', message: 'x' }).code).toBe('CAPTURE_FAILED')
  })

  it('survives a missing error object', () => {
    expect(nativeFailure(undefined).code).toBe('CAPTURE_FAILED')
  })

  it('reports a permission denial from the script', async () => {
    const recorder = makeRunner(() => ({
      stdout: JSON.stringify({ ok: false, error: { code: 'WINDOW_NOT_CAPTURABLE', message: 'protected' } }),
      code: 1,
    }))
    const backend = createWindowsBackend({ runner: recorder.runner, powershellPath: 'powershell.exe' })
    await expect(
      backend.captureWindow({ windowId: 'win32:1', outPath: 'x', strategy: 'native' }),
    ).rejects.toMatchObject({ code: 'WINDOW_NOT_CAPTURABLE' })
  })

  it('reports a non-zero exit without JSON as CAPTURE_FAILED with the stderr tail', async () => {
    const recorder = makeRunner(() => ({ stdout: '', stderr: 'Access is denied.', code: 1 }))
    const backend = createWindowsBackend({ runner: recorder.runner, powershellPath: 'powershell.exe' })
    try {
      await backend.listTargets()
      throw new Error('expected a failure')
    } catch (error) {
      expect((error as ScreenshotError).code).toBe('CAPTURE_FAILED')
      expect((error as ScreenshotError).message).toContain('Access is denied.')
    }
  })

  it('reports a missing PowerShell as NATIVE_HELPER_UNAVAILABLE', async () => {
    const recorder = makeRunner(() => ({ spawnError: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }))
    const backend = createWindowsBackend({ runner: recorder.runner, powershellPath: 'powershell.exe' })
    const error = await backend.listTargets().catch((caught: unknown) => caught as ScreenshotError)
    expect(error).toBeInstanceOf(ScreenshotError)
    expect((error as ScreenshotError).code).toBe('NATIVE_HELPER_UNAVAILABLE')
  })

  it('reports a timeout as TIMEOUT', async () => {
    const recorder = makeRunner(() => ({ timedOut: true, code: null }))
    const backend = createWindowsBackend({ runner: recorder.runner, powershellPath: 'powershell.exe' })
    await expect(backend.listTargets()).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('rejects a success payload combined with a failure exit code', async () => {
    const recorder = makeRunner(() => ({ stdout: WINDOW_LIST_PAYLOAD, code: 3 }))
    const backend = createWindowsBackend({ runner: recorder.runner, powershellPath: 'powershell.exe' })
    await expect(backend.listTargets()).rejects.toMatchObject({ code: 'CAPTURE_FAILED' })
  })

  it('ignores banner text printed before the JSON line', async () => {
    const recorder = makeRunner(() => ({ stdout: `WARNING: something\n${WINDOW_LIST_PAYLOAD}\n` }))
    const backend = createWindowsBackend({ runner: recorder.runner, powershellPath: 'powershell.exe' })
    const result = await backend.listTargets()
    expect(result.windows).toHaveLength(2)
  })

  it('forwards the abort signal to the runner', async () => {
    const recorder = makeRunner(() => ({ stdout: WINDOW_LIST_PAYLOAD }))
    const backend = createWindowsBackend({ runner: recorder.runner, powershellPath: 'powershell.exe' })
    const controller = new AbortController()
    await backend.listTargets({ signal: controller.signal })
    expect(recorder.requests[0]!.signal).toBe(controller.signal)
  })
})
