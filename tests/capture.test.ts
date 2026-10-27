import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ScreenshotError } from '../src/errors.js'
import { buildFileName, createFileSystemOps } from '../src/storage.js'
import type { ScreenshotConfig } from '../src/config.js'
import type { ScreenshotService } from '../src/capture.js'
import {
  FakeBackend,
  countPartialFiles,
  createTestService,
  expectScreenshotError,
  listFiles,
  makeDisplay,
  makeTempDirectory,
  makeWindow,
  sequenceRandom,
  wrapOps,
  type FakeBackendOptions,
  type TempDirectory,
} from './helpers/fakes.js'
import { solidPng, splitPng } from './helpers/png.js'

const AT = new Date('2026-10-27T12:34:56.789Z')
const GRADIENT = splitPng(16, 9, { r: 10, g: 20, b: 30 }, { r: 240, g: 240, b: 240 })

interface Harness {
  temp: TempDirectory
  backend: FakeBackend
  service: ScreenshotService
  outputDir: string
}

async function withHarness(
  run: (harness: Harness) => Promise<void>,
  options: { backend?: FakeBackendOptions; config?: Partial<ScreenshotConfig>; ops?: ReturnType<typeof createFileSystemOps> } = {},
): Promise<void> {
  const temp = await makeTempDirectory()
  try {
    const backend = new FakeBackend(options.backend)
    const { service } = createTestService({
      backend,
      outputDir: temp.path,
      config: options.config ?? {},
      now: () => AT,
      random: sequenceRandom(),
      ...(options.ops ? { ops: options.ops } : {}),
    })
    await run({ temp, backend, service, outputDir: temp.path })
  } finally {
    await temp.cleanup()
  }
}

describe('screen capture', () => {
  it('captures the primary display by default', async () => {
    await withHarness(async ({ service, backend }) => {
      const result = await service.captureScreen()
      expect(backend.calls).toHaveLength(1)
      const options = backend.calls[0]!.options as { display?: unknown; outPath: string }
      expect(options.display).toBeUndefined()
      expect(result.captureType).toBe('screen')
      expect(result.width).toBe(16)
      expect(result.height).toBe(9)
      expect(result.path).toMatch(/\.png$/)
      expect(path.isAbsolute(result.path)).toBe(true)
    })
  })

  it('forwards an explicit numeric display index', async () => {
    await withHarness(async ({ service, backend }) => {
      await service.captureScreen({ display: 2 })
      expect((backend.calls[0]!.options as { display?: unknown }).display).toBe(2)
    })
  })

  it('forwards a display identifier string', async () => {
    await withHarness(async ({ service, backend }) => {
      await service.captureScreen({ display: '\\\\.\\DISPLAY2' })
      expect((backend.calls[0]!.options as { display?: unknown }).display).toBe('\\\\.\\DISPLAY2')
    })
  })

  it('rejects a negative display index before any native work', async () => {
    await withHarness(async ({ service, backend }) => {
      await expectScreenshotError(service.captureScreen({ display: -1 }), 'INVALID_ARGUMENT')
      expect(backend.calls).toHaveLength(0)
    })
  })

  it('rejects a non-integer display index', async () => {
    await withHarness(async ({ service, backend }) => {
      await expectScreenshotError(service.captureScreen({ display: 1.5 }), 'INVALID_ARGUMENT')
      expect(backend.calls).toHaveLength(0)
    })
  })

  it('rejects an empty display identifier', async () => {
    await withHarness(async ({ service }) => {
      await expectScreenshotError(service.captureScreen({ display: '   ' }), 'INVALID_ARGUMENT')
    })
  })

  it('reports the captured display in the result', async () => {
    const display = makeDisplay({ index: 1, primary: false, width: 2560, height: 1440 })
    await withHarness(
      async ({ service }) => {
        const result = await service.captureScreen({ display: 1 })
        expect(result.display).toMatchObject({ index: 1, primary: false, width: 2560, height: 1440 })
      },
      { backend: { screen: async () => ({ png: GRADIENT, display }) } },
    )
  })
})

describe('window enumeration', () => {
  it('returns windows and displays without capturing', async () => {
    await withHarness(
      async ({ service, backend }) => {
        const result = await service.listWindows()
        expect(result.count).toBe(2)
        expect(result.displays).toHaveLength(1)
        expect(result.windows.map((window) => window.id)).toEqual(['win32:1', 'win32:2'])
        expect(backend.calls.every((call) => call.operation === 'list')).toBe(true)
      },
      {
        backend: {
          list: async () => ({
            windows: [
              makeWindow({ id: 'win32:1', title: 'Notepad — notes.txt', app: 'notepad' }),
              makeWindow({ id: 'win32:2', title: 'Calculator', app: 'calc' }),
            ],
            displays: [makeDisplay()],
            notes: [],
          }),
        },
      },
    )
  })

  it('filters by title, application and identifier', async () => {
    const windows = [
      makeWindow({ id: 'win32:1', title: 'Quarterly report — Word', app: 'WINWORD' }),
      makeWindow({ id: 'win32:2', title: 'Inbox', app: 'outlook' }),
      makeWindow({ id: 'win32:3', title: 'Untitled', app: 'notepad' }),
    ]
    await withHarness(
      async ({ service }) => {
        const byTitle = await service.listWindows({ filter: 'quarterly' })
        expect(byTitle.windows.map((window) => window.id)).toEqual(['win32:1'])

        const byApp = await service.listWindows({ filter: 'OUTLOOK' })
        expect(byApp.windows.map((window) => window.id)).toEqual(['win32:2'])

        const byId = await service.listWindows({ filter: 'win32:3' })
        expect(byId.windows.map((window) => window.id)).toEqual(['win32:3'])
      },
      { backend: { list: async () => ({ windows, displays: [makeDisplay()], notes: [] }) } },
    )
  })

  it('keeps windows with duplicate titles distinguishable by identifier', async () => {
    const windows = [
      makeWindow({ id: 'win32:11', title: 'Untitled - Notepad', pid: 100 }),
      makeWindow({ id: 'win32:22', title: 'Untitled - Notepad', pid: 200 }),
      makeWindow({ id: 'win32:33', title: 'Untitled - Notepad', pid: 300 }),
    ]
    await withHarness(
      async ({ service }) => {
        const result = await service.listWindows({ filter: 'untitled' })
        expect(result.count).toBe(3)
        expect(new Set(result.windows.map((window) => window.id)).size).toBe(3)
        expect(result.windows.map((window) => window.pid)).toEqual([100, 200, 300])
      },
      { backend: { list: async () => ({ windows, displays: [makeDisplay()], notes: [] }) } },
    )
  })

  it('explains an empty window list instead of failing', async () => {
    await withHarness(async ({ service }) => {
      const result = await service.listWindows()
      expect(result.count).toBe(0)
      expect(result.notes.join(' ')).toMatch(/no capturable windows/i)
    })
  })

  it('explains a filter that matched nothing', async () => {
    await withHarness(
      async ({ service }) => {
        const result = await service.listWindows({ filter: 'nothing-matches-this' })
        expect(result.count).toBe(0)
        expect(result.notes.join(' ')).toMatch(/no window matched/i)
      },
      {
        backend: {
          list: async () => ({ windows: [makeWindow()], displays: [makeDisplay()], notes: [] }),
        },
      },
    )
  })

  it('rejects a non-string filter', async () => {
    await withHarness(async ({ service, backend }) => {
      await expectScreenshotError(service.listWindows({ filter: 42 as unknown as string }), 'INVALID_ARGUMENT')
      expect(backend.calls).toHaveLength(0)
    })
  })

  it('treats an empty filter as no filter', async () => {
    await withHarness(
      async ({ service }) => {
        const result = await service.listWindows({ filter: '   ' })
        expect(result.count).toBe(1)
      },
      {
        backend: {
          list: async () => ({ windows: [makeWindow()], displays: [makeDisplay()], notes: [] }),
        },
      },
    )
  })
})

describe('window capture', () => {
  it('forwards the identifier exactly as given', async () => {
    await withHarness(async ({ service, backend }) => {
      await service.captureWindow({ windowId: 'win32:4195478' })
      const options = backend.calls[0]!.options as { windowId: string; strategy: string }
      expect(options.windowId).toBe('win32:4195478')
      expect(options.strategy).toBe('native')
    })
  })

  it('rejects a missing identifier without touching the backend', async () => {
    await withHarness(async ({ service, backend }) => {
      await expectScreenshotError(service.captureWindow({ windowId: '' }), 'INVALID_ARGUMENT')
      await expectScreenshotError(
        service.captureWindow({ windowId: undefined as unknown as string }),
        'INVALID_ARGUMENT',
      )
      expect(backend.calls).toHaveLength(0)
    })
  })

  it('rejects identifiers containing path separators or control characters', async () => {
    await withHarness(async ({ service, backend }) => {
      for (const candidate of ['../../etc/passwd', 'win32:1\n2', 'a/b', 'a\\b']) {
        await expectScreenshotError(service.captureWindow({ windowId: candidate }), 'INVALID_ARGUMENT')
      }
      expect(backend.calls).toHaveLength(0)
    })
  })

  it('rejects an absurdly long identifier', async () => {
    await withHarness(async ({ service, backend }) => {
      await expectScreenshotError(service.captureWindow({ windowId: 'w'.repeat(201) }), 'INVALID_ARGUMENT')
      expect(backend.calls).toHaveLength(0)
    })
  })

  it('reports the captured window metadata', async () => {
    const window = makeWindow({ id: 'win32:77', title: 'Inbox — Outlook', app: 'OUTLOOK' })
    await withHarness(
      async ({ service }) => {
        const result = await service.captureWindow({ windowId: 'win32:77' })
        expect(result.captureType).toBe('window')
        expect(result.window).toMatchObject({ id: 'win32:77', title: 'Inbox — Outlook', app: 'OUTLOOK' })
      },
      { backend: { window: async () => ({ png: GRADIENT, window }) } },
    )
  })
})

describe('backend failures', () => {
  it('propagates a permission denial', async () => {
    await withHarness(
      async ({ service }) => {
        const error = await expectScreenshotError(
          service.captureScreen(),
          'PERMISSION_DENIED',
        )
        expect(error.message).toMatch(/screen recording/i)
      },
      {
        backend: {
          screen: async () => {
            throw new ScreenshotError('PERMISSION_DENIED', 'Screen Recording permission is not granted.')
          },
        },
      },
    )
  })

  it('propagates a native API failure', async () => {
    await withHarness(
      async ({ service }) => {
        await expectScreenshotError(service.captureScreen(), 'CAPTURE_FAILED')
      },
      {
        backend: {
          screen: async () => {
            throw new ScreenshotError('CAPTURE_FAILED', 'ScreenCaptureKit returned no image.')
          },
        },
      },
    )
  })

  it('wraps an unexpected exception as CAPTURE_FAILED', async () => {
    await withHarness(
      async ({ service }) => {
        const error = await expectScreenshotError(service.captureScreen(), 'CAPTURE_FAILED')
        expect(error.message).toMatch(/boom/)
      },
      {
        backend: {
          screen: async () => {
            throw new Error('boom')
          },
        },
      },
    )
  })

  it('maps a filesystem write failure to OUTPUT_WRITE_FAILED', async () => {
    const ops = wrapOps(createFileSystemOps(), {
      writeFileExclusive: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      },
    })
    await withHarness(
      async ({ service }) => {
        await expectScreenshotError(service.captureScreen(), 'OUTPUT_WRITE_FAILED')
      },
      { ops },
    )
  })
})

describe('output validation', () => {
  it('fails when the native layer reports success but writes no file', async () => {
    await withHarness(
      async ({ service }) => {
        const error = await expectScreenshotError(service.captureScreen(), 'CAPTURE_FAILED')
        expect(error.message).toMatch(/wrote no file/i)
      },
      { backend: { screen: async () => ({ skipWrite: true }) } },
    )
  })

  it('fails on an empty file', async () => {
    await withHarness(
      async ({ service }) => {
        await expectScreenshotError(service.captureScreen(), 'INVALID_PNG')
      },
      { backend: { screen: async () => ({ raw: Buffer.alloc(0) }) } },
    )
  })

  it('fails on bytes that are not a PNG', async () => {
    await withHarness(
      async ({ service }) => {
        await expectScreenshotError(service.captureScreen(), 'INVALID_PNG')
      },
      { backend: { screen: async () => ({ raw: Buffer.from('this is not a png file at all') }) } },
    )
  })

  it('fails on a truncated PNG', async () => {
    await withHarness(
      async ({ service }) => {
        await expectScreenshotError(service.captureScreen(), 'INVALID_PNG')
      },
      { backend: { screen: async () => ({ raw: GRADIENT.subarray(0, 40) }) } },
    )
  })

  it('rejects a uniform image as a blank capture', async () => {
    await withHarness(
      async ({ service }) => {
        const error = await expectScreenshotError(service.captureScreen(), 'BLANK_CAPTURE')
        expect(error.hint).toMatch(/hardware-accelerated|permission/i)
      },
      { backend: { screen: async () => ({ png: solidPng(32, 18, { r: 0, g: 0, b: 0 }) }) } },
    )
  })

  it('accepts a uniform image when explicitly allowed', async () => {
    await withHarness(
      async ({ service }) => {
        const result = await service.captureScreen()
        expect(result.uniform).toBe(true)
      },
      {
        backend: { screen: async () => ({ png: solidPng(32, 18, { r: 255, g: 255, b: 255 }) }) },
        config: { allowUniformCaptures: true },
      },
    )
  })

  it('fails when the reported dimensions disagree with the PNG', async () => {
    await withHarness(
      async ({ service }) => {
        const error = await expectScreenshotError(service.captureScreen(), 'CAPTURE_FAILED')
        expect(error.message).toMatch(/reported 100x100/)
      },
      { backend: { screen: async () => ({ png: GRADIENT, width: 100, height: 100 }) } },
    )
  })
})

describe('window fallback', () => {
  it('retries a blank native capture using the desktop region', async () => {
    let calls = 0
    await withHarness(
      async ({ service, backend }) => {
        const result = await service.captureWindow({ windowId: 'win32:9' })
        expect(backend.calls).toHaveLength(2)
        expect((backend.calls[1]!.options as { strategy: string }).strategy).toBe('desktop')
        expect(result.method).toBe('desktop-region')
        expect(result.fallback).toBe(true)
        expect(result.notes.join(' ')).toMatch(/blank|no content|BLANK_CAPTURE/i)
      },
      {
        backend: {
          supportsDesktopWindowFallback: true,
          window: async () => {
            calls += 1
            // The native attempt is blank; the desktop attempt has content.
            return calls === 1 ? { png: solidPng(10, 10, { r: 255, g: 255, b: 255 }) } : { png: GRADIENT }
          },
        },
      },
    )
  })

  it('does not substitute another window when the target is gone', async () => {
    await withHarness(
      async ({ service, backend }) => {
        await expectScreenshotError(service.captureWindow({ windowId: 'win32:9' }), 'WINDOW_NOT_FOUND')
        expect(backend.calls).toHaveLength(1)
      },
      {
        backend: {
          supportsDesktopWindowFallback: true,
          window: async () => {
            throw new ScreenshotError('WINDOW_NOT_FOUND', 'Window win32:9 does not exist any more.')
          },
        },
      },
    )
  })

  it('does not fall back when the configuration disables it', async () => {
    await withHarness(
      async ({ service, backend }) => {
        await expectScreenshotError(service.captureWindow({ windowId: 'win32:9' }), 'BLANK_CAPTURE')
        expect(backend.calls).toHaveLength(1)
      },
      {
        backend: {
          supportsDesktopWindowFallback: true,
          window: async () => ({ png: solidPng(10, 10, { r: 0, g: 0, b: 0 }) }),
        },
        config: { windowFallback: false },
      },
    )
  })

  it('does not fall back when the backend has no desktop strategy', async () => {
    await withHarness(
      async ({ service, backend }) => {
        await expectScreenshotError(service.captureWindow({ windowId: 'win32:9' }), 'BLANK_CAPTURE')
        expect(backend.calls).toHaveLength(1)
      },
      {
        backend: {
          supportsDesktopWindowFallback: false,
          window: async () => ({ png: solidPng(10, 10, { r: 0, g: 0, b: 0 }) }),
        },
      },
    )
  })

  it('reports a blank capture when the fallback is blank too', async () => {
    await withHarness(
      async ({ service, backend }) => {
        await expectScreenshotError(service.captureWindow({ windowId: 'win32:9' }), 'BLANK_CAPTURE')
        expect(backend.calls).toHaveLength(2)
      },
      {
        backend: {
          supportsDesktopWindowFallback: true,
          window: async () => ({ png: solidPng(10, 10, { r: 0, g: 0, b: 0 }) }),
        },
      },
    )
  })
})

describe('output files', () => {
  it('writes into a unicode output directory', async () => {
    const temp = await makeTempDirectory()
    try {
      const directory = path.join(temp.path, 'скриншоты 🎯')
      const backend = new FakeBackend()
      const { service } = createTestService({
        backend,
        outputDir: directory,
        now: () => AT,
        random: sequenceRandom(),
      })
      const result = await service.captureScreen()
      expect(result.path).toContain('скриншоты 🎯')
      expect(await fs.readFile(result.path)).toEqual(GRADIENT)
    } finally {
      await temp.cleanup()
    }
  })

  it('picks a different name when the first candidate exists', async () => {
    await withHarness(
      async ({ service, outputDir }) => {
        const taken = buildFileName({ kind: 'screen', label: 'display0', at: AT, attempt: 0, random: 'fixed' })
        await fs.writeFile(path.join(outputDir, taken), 'existing')

        const result = await service.captureScreen()
        expect(result.fileName).not.toBe(taken)
        expect(await fs.readFile(path.join(outputDir, taken), 'utf8')).toBe('existing')
      },
      { backend: { screen: async () => ({ png: GRADIENT, display: makeDisplay({ index: 0 }) }) } },
    )
  })

  it('handles concurrent captures without collisions', async () => {
    await withHarness(async ({ service, outputDir }) => {
      const results = await Promise.all(Array.from({ length: 5 }, () => service.captureScreen()))
      const names = new Set(results.map((result) => result.fileName))
      expect(names.size).toBe(5)
      expect(await listFiles(outputDir)).toHaveLength(5)
      for (const result of results) {
        expect(await fs.readFile(result.path)).toEqual(GRADIENT)
      }
    })
  })

  it('leaves no partial file behind after a success', async () => {
    await withHarness(async ({ service, outputDir }) => {
      await service.captureScreen()
      expect(await countPartialFiles(outputDir)).toBe(0)
    })
  })

  it('leaves no partial file behind after a failure', async () => {
    await withHarness(
      async ({ service, outputDir }) => {
        await expectScreenshotError(service.captureScreen(), 'BLANK_CAPTURE')
        expect(await countPartialFiles(outputDir)).toBe(0)
      },
      { backend: { screen: async () => ({ png: solidPng(10, 10, { r: 0, g: 0, b: 0 }) }) } },
    )
  })

  it('keeps the partial file when keepTempFiles is enabled', async () => {
    await withHarness(
      async ({ service, outputDir }) => {
        await expectScreenshotError(service.captureScreen(), 'BLANK_CAPTURE')
        expect(await countPartialFiles(outputDir)).toBe(1)
      },
      {
        backend: { screen: async () => ({ png: solidPng(10, 10, { r: 0, g: 0, b: 0 }) }) },
        config: { keepTempFiles: true },
      },
    )
  })

  it('never deletes screenshots that were already on disk', async () => {
    await withHarness(async ({ service, outputDir }) => {
      const existing = path.join(outputDir, 'previous-run.png')
      await fs.writeFile(existing, 'keep me')
      await service.captureScreen()
      expect(await fs.readFile(existing, 'utf8')).toBe('keep me')
    })
  })
})
