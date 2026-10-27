/**
 * Windows integration tests: these capture the real screen and real windows.
 *
 * They start real WinForms windows, enumerate them through the production
 * backend, and assert on the pixels that come back. Nothing here is mocked.
 *
 * The discriminating test is "captures a window without including the window
 * that overlaps it": fixture B is top-most and covers part of fixture A. A
 * capture of A's desktop rectangle would contain B's magenta body; a capture of
 * A's own content cannot.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScreenshotService } from '../src/capture.js'
import { resolveConfig } from '../src/config.js'
import { ScreenshotError } from '../src/errors.js'
import { analyzeImage, colorShare, decodePng, pixelAt, type DecodedPng } from '../src/png.js'
import { createFileSystemOps } from '../src/storage.js'
import { createWindowsBackend } from '../src/platforms/windows.js'
import type { WindowSummary } from '../src/capture.js'
import {
  countPartialFiles,
  expectScreenshotError,
  makeTempDirectory,
  type TempDirectory,
} from './helpers/fakes.js'

const FIXTURE_SCRIPT = fileURLToPath(new URL('./fixtures/fixture-window.ps1', import.meta.url))
const POWERSHELL = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

const RUN_ID = `${process.pid}-${Date.now().toString(36)}`
const TITLE_A = `DSH Fixture A ${RUN_ID}`
const TITLE_B = `DSH Fixture B ${RUN_ID}`
const TITLE_CLOSED = `DSH Fixture Closed ${RUN_ID}`
const TITLE_MINIMIZED = `DSH Fixture Minimized ${RUN_ID}`

const GREEN = { r: 0, g: 128, b: 0 }
const MAGENTA = { r: 217, g: 27, b: 192 }
const WHITE = { r: 255, g: 255, b: 255 }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe.skipIf(process.platform !== 'win32')('Windows real capture', () => {
  let temp: TempDirectory
  let service: ScreenshotService
  let windowA: WindowSummary
  let windowB: WindowSummary
  let windowMinimized: WindowSummary
  const children = new Set<ChildProcess>()

  function launchFixture(args: string[]): ChildProcess {
    const child = spawn(
      POWERSHELL,
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', FIXTURE_SCRIPT, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false },
    )
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[fixture] ${chunk.toString()}`)
    })
    children.add(child)
    return child
  }

  async function stopFixture(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      children.delete(child)
      return
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill()
    await Promise.race([exited, sleep(5_000)])
    children.delete(child)
  }

  async function findWindow(title: string, timeoutMs = 30_000): Promise<WindowSummary> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        const targets = await service.listWindows({ filter: title })
        const match = targets.windows.find((window) => window.title === title)
        if (match) return match
      } catch (error) {
        lastError = error
      }
      await sleep(250)
    }
    throw new Error(
      `fixture window ${JSON.stringify(title)} did not appear within ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ''}`,
    )
  }

  async function waitUntilGone(title: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const targets = await service.listWindows({ filter: title })
      if (!targets.windows.some((window) => window.title === title)) return
      await sleep(200)
    }
    throw new Error(`fixture window ${JSON.stringify(title)} is still enumerable after ${timeoutMs}ms`)
  }

  beforeAll(async () => {
    temp = await makeTempDirectory('dsh-shot-integration-')
    const config = resolveConfig({ outputDir: temp.path, timeoutMs: 60_000 }, {})
    service = new ScreenshotService({
      backend: createWindowsBackend({ timeoutMs: config.timeoutMs }),
      config,
      ops: createFileSystemOps(),
    })

    // A is the large green window; B is top-most and overlaps A's lower right.
    launchFixture(['-Title', TITLE_A, '-Color', '#008000', '-Width', '520', '-Height', '380', '-X', '60', '-Y', '100'])
    launchFixture(['-Title', TITLE_B, '-Color', '#D91BC0', '-Width', '280', '-Height', '220', '-X', '240', '-Y', '240', '-TopMost'])
    launchFixture(['-Title', TITLE_MINIMIZED, '-Color', '#1B4AD9', '-Width', '300', '-Height', '200', '-X', '900', '-Y', '500', '-Minimized'])

    windowA = await findWindow(TITLE_A)
    windowB = await findWindow(TITLE_B)
    windowMinimized = await findWindow(TITLE_MINIMIZED)

    console.log(
      `[integration] run ${RUN_ID}: A=${windowA.id} B=${windowB.id} minimized=${windowMinimized.id}`,
    )
  })

  afterAll(async () => {
    for (const child of [...children]) {
      await stopFixture(child)
    }
    await temp?.cleanup()
  })

  it('enumerates real displays and windows', async () => {
    const targets = await service.listWindows()
    expect(targets.displays.length).toBeGreaterThan(0)
    expect(targets.displays.some((display) => display.primary)).toBe(true)
    for (const display of targets.displays) {
      expect(display.width).toBeGreaterThan(0)
      expect(display.height).toBeGreaterThan(0)
    }

    const titles = new Set(targets.windows.map((window) => window.title))
    expect(titles.has(TITLE_A)).toBe(true)
    expect(titles.has(TITLE_B)).toBe(true)

    // Identifiers must be unique even though several windows are enumerated.
    const ids = targets.windows.map((window) => window.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('win32:'))).toBe(true)
    expect(targets.windows.every((window) => window.pid > 0)).toBe(true)
  })

  it('captures the full screen at the real display size', async () => {
    const targets = await service.listWindows()
    const primary = targets.displays.find((display) => display.primary) ?? targets.displays[0]!

    const result = await service.captureScreen()

    expect(result.captureType).toBe('screen')
    expect(result.method).toBe('copyfromscreen')
    expect(result.fallback).toBe(false)
    expect(result.width).toBe(primary.width)
    expect(result.height).toBe(primary.height)
    expect(result.display?.primary).toBe(true)

    const bytes = await fs.readFile(result.path)
    expect(bytes.length).toBeGreaterThan(1_000)
    const image = decodePng(bytes)
    expect(image.width).toBe(result.width)
    expect(image.height).toBe(result.height)

    // A desktop with windows on it is never a single colour.
    const stats = analyzeImage(image)
    expect(stats.uniform).toBe(false)
    expect(result.uniform).toBe(false)
  })

  it('captures an explicitly selected display', async () => {
    const targets = await service.listWindows()
    const primaryIndex = targets.displays.find((display) => display.primary)?.index ?? 0

    const result = await service.captureScreen({ display: primaryIndex })

    expect(result.display?.index).toBe(primaryIndex)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
  })

  it('reports an out-of-range display index', async () => {
    const targets = await service.listWindows()
    const invalid = targets.displays.length + 3
    await expectScreenshotError(service.captureScreen({ display: invalid }), 'DISPLAY_NOT_FOUND')
  })

  it('captures a window without including the window that overlaps it', async () => {
    // This is the test that separates a real window capture from a desktop crop.
    const result = await service.captureWindow({ windowId: windowA.id })

    expect(result.captureType).toBe('window')
    expect(result.method).toBe('printwindow')
    expect(result.fallback).toBe(false)
    expect(result.window?.id).toBe(windowA.id)
    expect(Math.abs(result.width - windowA.bounds.width)).toBeLessThanOrEqual(2)
    expect(Math.abs(result.height - windowA.bounds.height)).toBeLessThanOrEqual(2)

    const image = decodePng(await fs.readFile(result.path))
    const green = colorShare(image, GREEN)
    const magenta = colorShare(image, MAGENTA)
    const white = colorShare(image, WHITE)

    expect(green).toBeGreaterThan(0.4)
    expect(white).toBeGreaterThan(0.05)
    // Fixture B covers part of A's rectangle; it must not be in A's pixels.
    expect(magenta).toBeLessThan(0.005)
    expect(analyzeImage(image).uniform).toBe(false)
  })

  it('captures a second window with its own content', async () => {
    const result = await service.captureWindow({ windowId: windowB.id })

    expect(result.window?.id).toBe(windowB.id)
    expect(result.fallback).toBe(false)
    expect(Math.abs(result.width - windowB.bounds.width)).toBeLessThanOrEqual(2)

    const image = decodePng(await fs.readFile(result.path))
    expect(colorShare(image, MAGENTA)).toBeGreaterThan(0.4)
    expect(colorShare(image, GREEN)).toBeLessThan(0.005)
  })

  it('writes a decodable, non-empty PNG whose dimensions match the result', async () => {
    const result = await service.captureWindow({ windowId: windowB.id })
    const stat = await fs.stat(result.path)
    expect(stat.size).toBe(result.bytes)
    expect(stat.size).toBeGreaterThan(500)
    const image = decodePng(await fs.readFile(result.path))
    expect(image.width).toBe(result.width)
    expect(image.height).toBe(result.height)
  })

  it('gives concurrent captures distinct files', async () => {
    const results = await Promise.all([
      service.captureScreen(),
      service.captureWindow({ windowId: windowA.id }),
      service.captureScreen(),
    ])
    expect(new Set(results.map((result) => result.fileName)).size).toBe(3)
    for (const result of results) {
      const image = decodePng(await fs.readFile(result.path))
      expect(image.width).toBe(result.width)
    }
  })

  it('reports a window that was closed instead of capturing something else', async () => {
    const child = launchFixture([
      '-Title',
      TITLE_CLOSED,
      '-Color',
      '#D9A21B',
      '-Width',
      '260',
      '-Height',
      '180',
      '-X',
      '700',
      '-Y',
      '300',
    ])
    const window = await findWindow(TITLE_CLOSED)
    await stopFixture(child)
    await waitUntilGone(TITLE_CLOSED)

    const error = await service.captureWindow({ windowId: window.id }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ScreenshotError)
    expect(['WINDOW_NOT_FOUND', 'WINDOW_NOT_CAPTURABLE']).toContain((error as ScreenshotError).code)
  })

  it('rejects a malformed window identifier', async () => {
    await expectScreenshotError(service.captureWindow({ windowId: 'bogus' }), 'INVALID_ARGUMENT')
    await expectScreenshotError(service.captureWindow({ windowId: 'win32:not-a-number' }), 'INVALID_ARGUMENT')
  })

  it('reports a window handle that does not exist', async () => {
    const error = await service.captureWindow({ windowId: 'win32:1' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ScreenshotError)
    expect(['WINDOW_NOT_FOUND', 'WINDOW_NOT_CAPTURABLE']).toContain((error as ScreenshotError).code)
  })

  it('never returns an unvalidated image for a minimized window', async () => {
    // Either the platform can capture it (and the PNG must be real content), or
    // the call must fail with an explicit code. Silently returning a blank or
    // substituted image is the failure this test guards against.
    try {
      const result = await service.captureWindow({ windowId: windowMinimized.id })
      const image = decodePng(await fs.readFile(result.path))
      expect(image.width).toBeGreaterThan(0)
      expect(image.height).toBeGreaterThan(0)
      expect(analyzeImage(image).uniform).toBe(false)
      console.log(`[integration] minimized window captured with ${result.method} (fallback=${result.fallback})`)
    } catch (error) {
      expect(error).toBeInstanceOf(ScreenshotError)
      expect(['WINDOW_MINIMIZED', 'WINDOW_NOT_CAPTURABLE', 'BLANK_CAPTURE']).toContain(
        (error as ScreenshotError).code,
      )
      console.log(`[integration] minimized window refused with ${(error as ScreenshotError).code}`)
    }
  })

  it('leaves no partial files behind', async () => {
    expect(await countPartialFiles(temp.path)).toBe(0)
    const entries = await fs.readdir(temp.path)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((entry) => entry.endsWith('.png'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Capture fidelity: deterministic pixel patterns
//
// These tests exist because a capture pipeline can "succeed" while changing
// pixels: channel swaps, stride errors, resampling, or alpha compositing all
// produce a valid PNG that is subtly wrong. The pattern fixture has a known
// value for every pixel, so any deviation is measurable.
// ---------------------------------------------------------------------------

const CONVERSION_FIXTURE = fileURLToPath(new URL('./fixtures/conversion-check.ps1', import.meta.url))
const PATTERN_FIXTURE = fileURLToPath(new URL('./fixtures/pattern-window.ps1', import.meta.url))

const PATTERN_WIDTH = 320
const PATTERN_HEIGHT = 240

function runFixtureScript(script: string, args: string[]): string {
  return execFileSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { encoding: 'utf8' },
  )
}

/** Compare two images, optionally shifting the actual image by an origin. */
function compareImages(
  actual: DecodedPng,
  expected: DecodedPng,
  origin = { x: 0, y: 0 },
): { differing: number; maxDelta: number; samples: string[] } {
  let differing = 0
  let maxDelta = 0
  const samples: string[] = []
  for (let y = 0; y < expected.height; y += 1) {
    for (let x = 0; x < expected.width; x += 1) {
      const ax = x + origin.x
      const ay = y + origin.y
      if (ax < 0 || ay < 0 || ax >= actual.width || ay >= actual.height) {
        differing += 1
        if (samples.length < 10) samples.push(`(${x},${y}) outside the actual image`)
        continue
      }
      const got = pixelAt(actual, ax, ay)
      const want = pixelAt(expected, x, y)
      const delta = Math.max(
        Math.abs(got.r - want.r),
        Math.abs(got.g - want.g),
        Math.abs(got.b - want.b),
      )
      if (delta === 0) continue
      differing += 1
      maxDelta = Math.max(maxDelta, delta)
      if (samples.length < 10) {
        samples.push(
          `(${x},${y}) actual=${got.r},${got.g},${got.b} expected=${want.r},${want.g},${want.b}`,
        )
      }
    }
  }
  return { differing, maxDelta, samples }
}

/** Bright pixels whose eight neighbours are all dark: the reported artifact shape. */
function countIsolatedBrightPixels(image: DecodedPng): number {
  const luma = (c: { r: number; g: number; b: number }): number =>
    0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  let count = 0
  for (let y = 1; y < image.height - 1; y += 1) {
    for (let x = 1; x < image.width - 1; x += 1) {
      if (luma(pixelAt(image, x, y)) < 200) continue
      let dark = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          if (luma(pixelAt(image, x + dx, y + dy)) <= 80) dark += 1
        }
      }
      if (dark === 8) count += 1
    }
  }
  return count
}

describe.skipIf(process.platform !== 'win32')('Windows capture fidelity', () => {
  let temp: TempDirectory
  let service: ScreenshotService
  let expectedPath: string
  let patternWindow: WindowSummary
  let patternTitle: string
  const children = new Set<ChildProcess>()

  async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill()
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
    children.delete(child)
  }

  beforeAll(async () => {
    temp = await makeTempDirectory('dsh-shot-fidelity-')
    const config = resolveConfig({ outputDir: temp.path, timeoutMs: 60_000 }, {})
    service = new ScreenshotService({
      backend: createWindowsBackend({ timeoutMs: config.timeoutMs }),
      config,
      ops: createFileSystemOps(),
    })

    patternTitle = `DSH Pattern ${process.pid}-${Date.now().toString(36)}`
    expectedPath = path.join(temp.path, 'expected-pattern.png')
    const child = spawn(
      POWERSHELL,
      [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        PATTERN_FIXTURE,
        '-Title',
        patternTitle,
        '-ExpectedPath',
        expectedPath,
        '-Width',
        String(PATTERN_WIDTH),
        '-Height',
        String(PATTERN_HEIGHT),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false },
    )
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[pattern] ${chunk.toString()}`))
    children.add(child)

    const deadline = Date.now() + 40_000
    while (Date.now() < deadline) {
      const targets = await service.listWindows({ filter: patternTitle }).catch(() => undefined)
      const match = targets?.windows.find((window) => window.title === patternTitle)
      if (match) {
        patternWindow = match
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!patternWindow) throw new Error(`pattern fixture window ${patternTitle} never appeared`)
  })

  afterAll(async () => {
    for (const child of [...children]) await stop(child)
    await temp?.cleanup()
  })

  it('converts a capture buffer without compositing it over a background', async () => {
    // GDI capture buffers carry an undefined alpha byte: 0 wherever nothing was
    // painted. Compositing those pixels over white fabricated pure-white dots.
    const output = path.join(temp.path, 'conversion.png')
    const payload = JSON.parse(runFixtureScript(CONVERSION_FIXTURE, ['-Out', output])) as {
      ok: boolean
      width: number
      height: number
      expected: Array<[number, number, number]>
    }
    expect(payload.ok).toBe(true)

    const image = decodePng(await fs.readFile(output))
    expect(image.width).toBe(4)
    expect(image.height).toBe(3)

    payload.expected.forEach((want, index) => {
      const got = pixelAt(image, index % 4, Math.floor(index / 4))
      expect([got.r, got.g, got.b]).toEqual(want)
    })

    // The specific pixel that the old conversion turned into pure white.
    expect(pixelAt(image, 0, 1)).toEqual({ r: 16, g: 16, b: 16 })
    // A sub-threshold alpha must not lighten the colour either (sample 10).
    expect(pixelAt(image, 2, 2)).toEqual({ r: 32, g: 64, b: 128 })
  })

  it('reproduces a deterministic window pixel for pixel', async () => {
    expect(patternWindow.bounds.width).toBe(PATTERN_WIDTH)
    expect(patternWindow.bounds.height).toBe(PATTERN_HEIGHT)

    const result = await service.captureWindow({ windowId: patternWindow.id })
    expect(result.method).toBe('printwindow')
    expect(result.fallback).toBe(false)
    expect(result.width).toBe(PATTERN_WIDTH)
    expect(result.height).toBe(PATTERN_HEIGHT)

    const captured = decodePng(await fs.readFile(result.path))
    const expected = decodePng(await fs.readFile(expectedPath))
    const comparison = compareImages(captured, expected)

    expect(comparison.samples).toEqual([])
    expect(comparison.differing).toBe(0)
  })

  it('keeps single-pixel detail and exact colours', async () => {
    const result = await service.captureWindow({ windowId: patternWindow.id })
    const image = decodePng(await fs.readFile(result.path))

    // 1px checkerboard: alternating pure white and pure black must survive.
    expect(pixelAt(image, 120, 120)).toEqual({ r: 255, g: 255, b: 255 })
    expect(pixelAt(image, 121, 120)).toEqual({ r: 0, g: 0, b: 0 })
    // 1px vertical lines every 4px.
    expect(pixelAt(image, 160, 160)).toEqual({ r: 255, g: 255, b: 255 })
    expect(pixelAt(image, 161, 160)).toEqual({ r: 16, g: 16, b: 16 })
    // Flat colour bands and the eight pure swatches. (316,36) is outside the
    // 1px outline and the antialiased text, so it must be the flat dark colour.
    expect(pixelAt(image, 100, 60)).toEqual({ r: 240, g: 240, b: 240 })
    expect(pixelAt(image, 316, 36)).toEqual({ r: 16, g: 16, b: 16 })
    expect(pixelAt(image, 20, 220)).toEqual({ r: 255, g: 0, b: 0 })
    expect(pixelAt(image, 60, 220)).toEqual({ r: 0, g: 255, b: 0 })
    expect(pixelAt(image, 100, 220)).toEqual({ r: 0, g: 0, b: 255 })
    expect(pixelAt(image, 140, 220)).toEqual({ r: 255, g: 255, b: 255 })
    expect(pixelAt(image, 180, 220)).toEqual({ r: 0, g: 0, b: 0 })
    expect(pixelAt(image, 220, 220)).toEqual({ r: 255, g: 0, b: 255 })
    expect(pixelAt(image, 260, 220)).toEqual({ r: 0, g: 255, b: 255 })
    expect(pixelAt(image, 300, 220)).toEqual({ r: 255, g: 255, b: 0 })
    // A gradient row must stay a gradient, not a channel-swapped one.
    expect(pixelAt(image, 0, 100)).toEqual({ r: 0, g: 0, b: 255 })
    expect(pixelAt(image, PATTERN_WIDTH - 1, 100)).toEqual({ r: 255, g: 0, b: 0 })
  })

  it('does not introduce isolated bright pixels into a window capture', async () => {
    const result = await service.captureWindow({ windowId: patternWindow.id })
    const captured = decodePng(await fs.readFile(result.path))
    const expected = decodePng(await fs.readFile(expectedPath))

    expect(countIsolatedBrightPixels(captured)).toBe(countIsolatedBrightPixels(expected))
    expect(countIsolatedBrightPixels(captured)).toBe(0)
  })

  it('matches the fixture region of a full-screen capture', async () => {
    const screen = await service.captureScreen()
    expect(screen.method).toBe('copyfromscreen')
    const full = decodePng(await fs.readFile(screen.path))

    const comparison = compareImages(full, decodePng(await fs.readFile(expectedPath)), {
      x: patternWindow.bounds.x,
      y: patternWindow.bounds.y,
    })

    expect(comparison.samples).toEqual([])
    expect(comparison.differing).toBe(0)
  })
})
