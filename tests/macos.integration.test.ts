/**
 * macOS real-capture integration tests.
 *
 * Test A captures the current screen through the production backend.
 * Test B compiles and launches a dedicated AppKit fixture window, finds it
 * through the production enumeration, and captures that specific window.
 *
 * Both tests are skipped on non-macOS machines and MUST actually run on macOS.
 * If the runner has no GUI session, no display, or no Screen Recording
 * permission, these tests fail (they are never skipped) so that a missing
 * capability is reported as unverified rather than passed.
 *
 * The helper binary must be built first: `npm run build:native:macos`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScreenshotService, type WindowSummary } from '../src/capture.js'
import { resolveConfig } from '../src/config.js'
import { ScreenshotError } from '../src/errors.js'
import { analyzeImage, colorShare, decodePng } from '../src/png.js'
import { createFileSystemOps } from '../src/storage.js'
import { createMacosBackend, DEFAULT_HELPER_PATH, HELPER_BUILD_COMMAND } from '../src/platforms/macos.js'
import { makeTempDirectory, type TempDirectory } from './helpers/fakes.js'

const FIXTURE_SOURCE = fileURLToPath(new URL('./fixtures/FixtureWindowApp.swift', import.meta.url))

const MAGENTA = { r: 217, g: 27, b: 192 }
const GREEN = { r: 0, g: 128, b: 0 }
const WHITE = { r: 255, g: 255, b: 255 }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Run a command to completion, resolving with its exit code and output. */
function run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 180_000 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

describe.skipIf(process.platform !== 'darwin')('macOS real capture', () => {
  let temp: TempDirectory
  let service: ScreenshotService
  const children = new Set<ChildProcess>()

  async function expectNativeHelper(): Promise<void> {
    const helper = await fs.stat(DEFAULT_HELPER_PATH).catch(() => undefined)
    if (!helper) {
      throw new Error(
        `The macOS native helper is missing at ${DEFAULT_HELPER_PATH}. ` +
          `Build it with \`${HELPER_BUILD_COMMAND}\` before running the real-capture tests. ` +
          'This is an environment problem, not a passing verification.',
      )
    }
  }

  async function compileFixture(): Promise<string> {
    const output = path.join(temp.path, 'fixture-window-app')
    const result = await run('xcrun', ['--sdk', 'macosx', 'swiftc', '-O', '-o', output, FIXTURE_SOURCE])
    if (result.code !== 0) {
      throw new Error(
        `Could not compile the AppKit fixture window: ${result.stderr || result.stdout}. ` +
          'The Xcode command line tools are required for this test.',
      )
    }
    return output
  }

  function launchFixture(binary: string, environment: Record<string, string>): ChildProcess {
    const child = spawn(binary, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...environment },
    })
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[fixture] ${chunk.toString()}`))
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

  async function findWindow(title: string, timeoutMs = 40_000): Promise<WindowSummary> {
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
      await sleep(300)
    }
    throw new Error(
      `fixture window ${JSON.stringify(title)} did not appear within ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ''}`,
    )
  }

  /**
   * Turn a permission denial into a failure that states the environment problem,
   * instead of a passing test.
   */
  async function capture<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ScreenshotError && error.code === 'PERMISSION_DENIED') {
        throw new Error(
          `Real capture is blocked: ${error.message} ` +
            'Grant Screen Recording permission to the process running the tests (and to the application that ' +
            'launched it), then re-run. This environment cannot verify macOS capture.',
        )
      }
      throw error
    }
  }

  beforeAll(async () => {
    temp = await makeTempDirectory('dsh-shot-macos-integration-')
    await expectNativeHelper()
    const config = resolveConfig({ outputDir: temp.path, timeoutMs: 120_000 }, {})
    service = new ScreenshotService({
      backend: createMacosBackend({ timeoutMs: config.timeoutMs }),
      config,
      ops: createFileSystemOps(),
    })
  })

  afterAll(async () => {
    for (const child of [...children]) {
      await stopFixture(child)
    }
    await temp?.cleanup()
  })

  // ---------------------------------------------------------------------------
  // Test A: real full-screen capture
  // ---------------------------------------------------------------------------
  it('A: captures the real screen through ScreenCaptureKit', async () => {
    const targets = await capture(() => service.listWindows())
    expect(targets.displays.length).toBeGreaterThan(0)
    const primary = targets.displays.find((display) => display.primary) ?? targets.displays[0]!
    expect(primary.width).toBeGreaterThan(0)
    expect(primary.height).toBeGreaterThan(0)

    const result = await capture(() => service.captureScreen())

    // The native implementation must have produced the image: the CLI fallback
    // is not accepted as evidence that ScreenCaptureKit works.
    expect(result.method).toBe('screencapturekit')
    expect(result.fallback).toBe(false)

    const stat = await fs.stat(result.path)
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBeGreaterThan(1_000)

    const image = decodePng(await fs.readFile(result.path))
    expect(image.width).toBe(result.width)
    expect(image.height).toBe(result.height)
    expect(image.width).toBe(primary.width)
    expect(image.height).toBe(primary.height)

    const stats = analyzeImage(image)
    expect(stats.uniform).toBe(false)
    expect(stats.luminanceStdDev).toBeGreaterThan(0)
  })

  // ---------------------------------------------------------------------------
  // Test B: real individual-window capture
  // ---------------------------------------------------------------------------
  it('B: captures one real window, not the surrounding desktop', async () => {
    const binary = await compileFixture()

    // Two overlapping fixtures: the back one is green, the front one magenta.
    const back = launchFixture(binary, {
      DSH_FIXTURE_TITLE: 'DSH Fixture Back',
      DSH_FIXTURE_COLOR: '#008000',
      DSH_FIXTURE_X: '120',
      DSH_FIXTURE_Y: '120',
      DSH_FIXTURE_W: '520',
      DSH_FIXTURE_H: '340',
    })
    await sleep(1_500)
    const front = launchFixture(binary, {
      DSH_FIXTURE_TITLE: 'DSH Fixture Front',
      DSH_FIXTURE_COLOR: '#D91BC0',
      DSH_FIXTURE_X: '300',
      DSH_FIXTURE_Y: '260',
      DSH_FIXTURE_W: '300',
      DSH_FIXTURE_H: '220',
    })

    const backWindow = await findWindow('DSH Fixture Back')
    const frontWindow = await findWindow('DSH Fixture Front')

    expect(backWindow.id).not.toBe(frontWindow.id)
    expect(backWindow.id.startsWith('mac:')).toBe(true)

    // Capture the back window by its actual identifier.
    const result = await capture(() => service.captureWindow({ windowId: backWindow.id }))

    expect(result.method).toBe('screencapturekit')
    expect(result.fallback).toBe(false)
    expect(result.window?.id).toBe(backWindow.id)

    const image = decodePng(await fs.readFile(result.path))
    expect(image.width).toBeGreaterThan(0)
    expect(image.height).toBeGreaterThan(0)

    // A window capture is the size of that window, not of the screen.
    const targets = await service.listWindows()
    const screen = targets.displays[0]
    if (screen) {
      expect(image.width).toBeLessThan(screen.width)
    }

    const green = colorShare(image, GREEN)
    const white = colorShare(image, WHITE)
    const magenta = colorShare(image, MAGENTA)

    expect(green).toBeGreaterThan(0.3)
    expect(white).toBeGreaterThan(0.05)
    // The overlapping front window must not leak into a capture of the back one.
    expect(magenta).toBeLessThan(0.01)
    expect(analyzeImage(image).uniform).toBe(false)

    await stopFixture(front)
    await stopFixture(back)
  })
})
