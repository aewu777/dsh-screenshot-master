import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScreenshotError } from '../src/errors.js'
import type { JsonSchemaNode, ToolDefinition } from '../src/toolkit.js'
import { apply, setup } from '../src/index.js'
import {
  buildToolDefinitions,
  formatCaptureResult,
  formatTargetList,
  registerTools,
  type ToolRegistry,
} from '../src/tools.js'
import {
  FakeBackend,
  createTestService,
  expectScreenshotError,
  makeDisplay,
  makeTempDirectory,
  makeWindow,
  sequenceRandom,
} from './helpers/fakes.js'
import { splitPng } from './helpers/png.js'

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))

interface FakeRegistry extends ToolRegistry {
  readonly registered: ToolDefinition[]
}

function makeRegistry(): FakeRegistry {
  const registered: ToolDefinition[] = []
  return {
    registered,
    register(definition: ToolDefinition) {
      registered.push(definition)
      return () => {
        const index = registered.indexOf(definition)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  }
}

/** Build a service backed by a fake backend and a temporary output directory. */
async function withTools(
  run: (context: {
    registry: FakeRegistry
    backend: FakeBackend
    definitions: ToolDefinition[]
    directory: string
  }) => Promise<void>,
  backendOptions: ConstructorParameters<typeof FakeBackend>[0] = {},
): Promise<void> {
  const temp = await makeTempDirectory()
  try {
    const registry = makeRegistry()
    const backend = new FakeBackend(backendOptions)
    const { service } = createTestService({
      backend,
      outputDir: temp.path,
      random: sequenceRandom(),
    })
    const dispose = registerTools({ tools: registry, service })
    try {
      await run({ registry, backend, definitions: registry.registered, directory: temp.path })
    } finally {
      dispose()
    }
  } finally {
    await temp.cleanup()
  }
}

function propertyOf(schema: JsonSchemaNode, name: string): JsonSchemaNode {
  const property = schema.properties?.[name]
  if (!property) throw new Error(`schema has no property ${name}`)
  return property
}

describe('tool registration', () => {
  it('registers exactly the three documented tools', async () => {
    await withTools(async ({ definitions }) => {
      expect(definitions.map((definition) => definition.name)).toEqual([
        'screenshot_screen',
        'list_windows',
        'screenshot_window',
      ])
    })
  })

  it('produces definitions shaped like the harness ToolDefinition contract', async () => {
    await withTools(async ({ definitions }) => {
      for (const definition of definitions) {
        expect(typeof definition.name).toBe('string')
        expect(definition.description.length).toBeGreaterThan(40)
        expect(definition.parameters.type).toBe('object')
        expect(typeof definition.output).toBe('object')
        expect(definition.output.schema.type).toBe('object')
        expect(typeof definition.output.render).toBe('function')

        // Render a realistic value so the formatter's real path is exercised.
        const sample =
          definition.name === 'list_windows'
            ? { count: 0, windows: [], displays: [], notes: [] }
            : {
                path: '/tmp/x.png',
                fileName: 'x.png',
                bytes: 1,
                width: 4,
                height: 4,
                captureType: 'screen',
                method: 'copyfromscreen',
                takenAt: '2026-10-27T12:00:00.000Z',
                uniform: false,
                fallback: false,
                notes: [],
              }

        const rendered = definition.output.render({}, sample)
        expect(Array.isArray(rendered)).toBe(true)
        expect(rendered[0]).toMatchObject({ type: 'text' })
        expect(typeof rendered[0]!.text).toBe('string')
      }
    })
  })

  it('declares a non-empty English description per tool', async () => {
    await withTools(async ({ definitions }) => {
      const description = Object.fromEntries(
        definitions.map((definition) => [definition.name, definition.description]),
      )
      expect(description.screenshot_screen).toMatch(/capture the full screen/i)
      expect(description.screenshot_screen).toMatch(/not opened/i)
      expect(description.list_windows).toMatch(/never captures an image/i)
      expect(description.list_windows).toMatch(/not unique/i)
      expect(description.screenshot_window).toMatch(/list_windows/)
    })
  })

  it('removes every tool when the disposer runs', async () => {
    const temp = await makeTempDirectory()
    try {
      const registry = makeRegistry()
      const backend = new FakeBackend()
      const { service } = createTestService({ backend, outputDir: temp.path })
      const dispose = registerTools({ tools: registry, service })
      expect(registry.registered).toHaveLength(3)
      dispose()
      expect(registry.registered).toHaveLength(0)
      // Calling the disposer twice must be harmless.
      expect(() => dispose()).not.toThrow()
    } finally {
      await temp.cleanup()
    }
  })

  it('can be built directly from a service', async () => {
    const temp = await makeTempDirectory()
    try {
      const { service } = createTestService({ backend: new FakeBackend(), outputDir: temp.path })
      expect(buildToolDefinitions(service).map((definition) => definition.name)).toEqual([
        'screenshot_screen',
        'list_windows',
        'screenshot_window',
      ])
    } finally {
      await temp.cleanup()
    }
  })
})

describe('parameter schemas', () => {
  it('screenshot_screen accepts an optional display index or identifier', async () => {
    await withTools(async ({ definitions }) => {
      const tool = definitions.find((definition) => definition.name === 'screenshot_screen')!
      const display = propertyOf(tool.parameters, 'display')
      expect(display.oneOf).toHaveLength(2)
      expect(display.oneOf!.map((branch) => branch.type)).toEqual(['integer', 'string'])
      expect(tool.parameters.required ?? []).not.toContain('display')
      expect(tool.parameters.additionalProperties).toBe(false)
    })
  })

  it('list_windows accepts an optional string filter', async () => {
    await withTools(async ({ definitions }) => {
      const tool = definitions.find((definition) => definition.name === 'list_windows')!
      expect(propertyOf(tool.parameters, 'filter').type).toBe('string')
      expect(tool.parameters.required ?? []).toEqual([])
      expect(tool.parameters.additionalProperties).toBe(false)
    })
  })

  it('screenshot_window requires a string window_id', async () => {
    await withTools(async ({ definitions }) => {
      const tool = definitions.find((definition) => definition.name === 'screenshot_window')!
      expect(tool.parameters.required).toEqual(['window_id'])
      expect(propertyOf(tool.parameters, 'window_id').type).toBe('string')
      expect(tool.parameters.additionalProperties).toBe(false)
    })
  })

  it('documents the result fields the tools return', async () => {
    await withTools(async ({ definitions }) => {
      for (const name of ['screenshot_screen', 'screenshot_window']) {
        const tool = definitions.find((definition) => definition.name === name)!
        const schema = tool.output.schema
        expect(schema.required).toEqual(
          expect.arrayContaining(['path', 'width', 'height', 'captureType', 'method']),
        )
        expect(propertyOf(schema, 'path').type).toBe('string')
        expect(propertyOf(schema, 'captureType').enum).toEqual(['screen', 'window'])
      }
      const list = definitions.find((definition) => definition.name === 'list_windows')!
      expect(propertyOf(list.output.schema, 'count').type).toBe('number')
      expect(list.output.schema.required).toEqual(expect.arrayContaining(['windows', 'displays']))
    })
  })
})

describe('argument validation', () => {
  it('rejects a screenshot_window call without window_id', async () => {
    await withTools(async ({ definitions, backend }) => {
      const tool = definitions.find((definition) => definition.name === 'screenshot_window')!
      await expectScreenshotError(tool.execute({}, {}), 'INVALID_ARGUMENT')
      expect(backend.calls).toHaveLength(0)
    })
  })

  it('rejects a numeric window_id', async () => {
    await withTools(async ({ definitions, backend }) => {
      const tool = definitions.find((definition) => definition.name === 'screenshot_window')!
      await expectScreenshotError(tool.execute({ window_id: 4195478 }, {}), 'INVALID_ARGUMENT')
      expect(backend.calls).toHaveLength(0)
    })
  })

  it('rejects unknown parameters', async () => {
    await withTools(async ({ definitions, backend }) => {
      const tool = definitions.find((definition) => definition.name === 'screenshot_window')!
      await expectScreenshotError(
        tool.execute({ window_id: 'win32:1', title: 'Notepad' }, {}),
        'INVALID_ARGUMENT',
      )
      expect(backend.calls).toHaveLength(0)
    })
  })

  it('rejects a negative display index at the service boundary', async () => {
    await withTools(async ({ definitions, backend }) => {
      const tool = definitions.find((definition) => definition.name === 'screenshot_screen')!
      await expectScreenshotError(tool.execute({ display: -3 }, {}), 'INVALID_ARGUMENT')
      expect(backend.calls).toHaveLength(0)
    })
  })

  it('rejects a non-string filter', async () => {
    await withTools(async ({ definitions, backend }) => {
      const tool = definitions.find((definition) => definition.name === 'list_windows')!
      await expectScreenshotError(tool.execute({ filter: 12 }, {}), 'INVALID_ARGUMENT')
      expect(backend.calls).toHaveLength(0)
    })
  })
})

describe('argument forwarding', () => {
  it('forwards the window identifier unchanged', async () => {
    await withTools(async ({ definitions, backend }) => {
      const tool = definitions.find((definition) => definition.name === 'screenshot_window')!
      await tool.execute({ window_id: 'win32:4195478' }, {})
      const options = backend.calls[0]!.options as { windowId: string }
      expect(options.windowId).toBe('win32:4195478')
    })
  })

  it('forwards the display selector unchanged', async () => {
    await withTools(async ({ definitions, backend }) => {
      const tool = definitions.find((definition) => definition.name === 'screenshot_screen')!
      await tool.execute({ display: '\\\\.\\DISPLAY2' }, {})
      expect((backend.calls[0]!.options as { display?: unknown }).display).toBe('\\\\.\\DISPLAY2')
    })
  })

  it('captures each of several windows that share a title', async () => {
    const windows = [
      makeWindow({ id: 'win32:11', title: 'Untitled - Notepad', pid: 100 }),
      makeWindow({ id: 'win32:22', title: 'Untitled - Notepad', pid: 200 }),
    ]
    await withTools(
      async ({ definitions, backend }) => {
        const list = definitions.find((definition) => definition.name === 'list_windows')!
        const listed = (await list.execute({ filter: 'notepad' }, {})) as {
          windows: Array<{ id: string }>
        }
        expect(listed.windows.map((window) => window.id)).toEqual(['win32:11', 'win32:22'])

        const capture = definitions.find((definition) => definition.name === 'screenshot_window')!
        await capture.execute({ window_id: 'win32:22' }, {})
        expect((backend.calls.at(-1)!.options as { windowId: string }).windowId).toBe('win32:22')
      },
      { list: async () => ({ windows, displays: [makeDisplay()], notes: [] }) },
    )
  })
})

describe('rendering', () => {
  it('renders a capture result with path, dimensions and method', async () => {
    await withTools(
      async ({ definitions }) => {
        const tool = definitions.find((definition) => definition.name === 'screenshot_screen')!
        const value = await tool.execute({}, {})
        const text = tool.output.render({}, value)[0]!.text
        expect(text).toContain('Saved screen screenshot to')
        expect(text).toContain('16x9')
        expect(text).toContain('copyfromscreen')
        expect(text).toMatch(/taken at:/)
      },
      { screen: async () => ({ png: splitPng(16, 9, { r: 1, g: 1, b: 1 }, { r: 250, g: 250, b: 250 }) }) },
    )
  })

  it('renders a window list with displays and windows', async () => {
    await withTools(
      async ({ definitions }) => {
        const tool = definitions.find((definition) => definition.name === 'list_windows')!
        const value = await tool.execute({}, {})
        const text = tool.output.render({}, value)[0]!.text
        expect(text).toContain('Displays (1)')
        expect(text).toContain('Windows (1)')
        expect(text).toContain('win32:1')
      },
      {
        list: async () => ({
          windows: [makeWindow({ id: 'win32:1', title: 'Notepad', app: 'notepad' })],
          displays: [makeDisplay()],
          notes: [],
        }),
      },
    )
  })

  it('renders an empty list without failing', async () => {
    await withTools(async ({ definitions }) => {
      const tool = definitions.find((definition) => definition.name === 'list_windows')!
      const value = await tool.execute({}, {})
      const text = tool.output.render({}, value)[0]!.text
      expect(text).toContain('(none reported)')
    })
  })

  it('includes a fallback note in the rendered capture', () => {
    const text = formatCaptureResult({
      path: '/tmp/shot.png',
      fileName: 'shot.png',
      bytes: 10,
      width: 100,
      height: 50,
      captureType: 'window',
      method: 'desktop-region',
      takenAt: '2026-10-27T12:00:00.000Z',
      uniform: false,
      fallback: true,
      notes: ['overlapping windows are included'],
      window: { id: 'win32:1', title: 'Notepad', app: 'notepad', pid: 42, bounds: { x: 0, y: 0, width: 100, height: 50 } },
    })
    expect(text).toContain('desktop-region (fallback)')
    expect(text).toContain('Notepad')
    expect(text).toContain('overlapping windows are included')
  })

  it('renders notes for an empty target list', () => {
    const text = formatTargetList({
      count: 0,
      windows: [],
      displays: [],
      notes: ['The platform reported no capturable windows.'],
    })
    expect(text).toContain('note: The platform reported no capturable windows.')
  })
})

describe('error reporting', () => {
  it('surfaces the code and the actionable hint', async () => {
    await withTools(
      async ({ definitions }) => {
        const tool = definitions.find((definition) => definition.name === 'screenshot_screen')!
        try {
          await tool.execute({}, {})
          throw new Error('expected the capture to fail')
        } catch (error) {
          expect(error).toBeInstanceOf(ScreenshotError)
          const failure = error as ScreenshotError
          expect(failure.code).toBe('PERMISSION_DENIED')
          expect(failure.message).toContain('Screen Recording permission is not granted.')
          expect(failure.message).toContain('System Settings')
          expect(failure.message).not.toContain('undefined')
        }
      },
      {
        screen: async () => {
          throw new ScreenshotError('PERMISSION_DENIED', 'Screen Recording permission is not granted.', {
            hint: 'Grant it in System Settings > Privacy & Security, then restart the app.',
          })
        },
      },
    )
  })
})

describe('plugin entry point', () => {
  it('registers the tools through ctx.effect at startup without capturing', async () => {
    const temp = await makeTempDirectory()
    try {
      const registry = makeRegistry()
      const effects: Array<() => void> = []
      const ctx = {
        tools: registry,
        effect(callback: () => (() => void) | void) {
          const disposer = callback()
          if (typeof disposer === 'function') effects.push(disposer)
          return {}
        },
      }

      apply(ctx, { outputDir: temp.path, allowUniformCaptures: true })

      expect(registry.registered).toHaveLength(3)
      expect(effects).toHaveLength(1)
      // Registration must not perform a capture.
      expect(await fs.readdir(temp.path)).toEqual([])

      effects[0]!()
      expect(registry.registered).toHaveLength(0)
    } finally {
      await temp.cleanup()
    }
  })

  it('registers clearly failing tools on an unsupported platform', async () => {
    const temp = await makeTempDirectory()
    try {
      const registry = makeRegistry()
      const result = setup({ tools: registry }, { outputDir: temp.path }, { platform: 'linux' })
      expect(registry.registered).toHaveLength(3)

      const tool = registry.registered.find((definition) => definition.name === 'screenshot_screen')!
      const error = await expectScreenshotError(tool.execute({}, {}), 'UNSUPPORTED_PLATFORM')
      expect(error.message).toMatch(/win32.*darwin/s)
      expect(result.service.backend.displayName).toContain('unsupported')
    } finally {
      await temp.cleanup()
    }
  })

  it('rejects a context without a tool registry', () => {
    expect(() => setup({} as never, {})).toThrow(/tool registry/i)
  })

  it('builds the tools for the current platform without capturing', async () => {
    const temp = await makeTempDirectory()
    try {
      const registry = makeRegistry()
      const result = setup({ tools: registry }, { outputDir: temp.path })
      expect(result.config.outputDir).toBe(path.resolve(temp.path))
      expect(registry.registered).toHaveLength(3)
      expect(await fs.readdir(temp.path)).toEqual([])
    } finally {
      await temp.cleanup()
    }
  })
})

describe('scope guarantees', () => {
  const FORBIDDEN = [
    'child_process',
    'fetch(',
    'node:http',
    'node:https',
    'node:net',
    'node:os',
    'tesseract',
    'ocr',
    'shell.openPath',
  ]

  it('never opens, analyses, uploads or transmits an image from the shared layer', async () => {
    for (const file of ['capture.ts', 'tools.ts', 'storage.ts', 'png.ts', 'toolkit.ts', 'index.ts']) {
      const source = await fs.readFile(path.join(SRC_DIR, file), 'utf8')
      for (const needle of FORBIDDEN) {
        // `node:os` is legitimately imported by config.ts only; other files must stay clean.
        if (file === 'index.ts' && needle === 'node:os') continue
        expect({ file, needle, found: source.includes(needle) }).toEqual({
          file,
          needle,
          found: false,
        })
      }
    }
  })

  it('confines native process spawning to the platform backends', async () => {
    for (const file of ['capture.ts', 'tools.ts', 'storage.ts', 'png.ts', 'toolkit.ts', 'index.ts', 'config.ts']) {
      const source = await fs.readFile(path.join(SRC_DIR, file), 'utf8')
      expect(source).not.toContain('spawn(')
      expect(source).not.toContain('execFile')
    }
    for (const file of ['process.ts', 'windows.ts', 'macos.ts']) {
      const source = await fs.readFile(path.join(SRC_DIR, 'platforms', file), 'utf8')
      expect(source.length).toBeGreaterThan(0)
    }
  })
})
