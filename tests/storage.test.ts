import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_NAME_ATTEMPTS,
  buildFileName,
  commitScreenshot,
  createFileSystemOps,
  discardPartial,
  ensureDirectory,
  isRegularFile,
  partialPath,
  randomToken,
  sanitizeLabel,
  timestampComponent,
} from '../src/storage.js'
import { ScreenshotError } from '../src/errors.js'
import { makeTempDirectory, wrapOps } from './helpers/fakes.js'

const AT = new Date('2026-10-27T12:34:56.789Z')

describe('filename derivation', () => {
  it('formats the timestamp with fixed-width, sortable parts', () => {
    expect(timestampComponent(new Date(2026, 0, 2, 3, 4, 5, 6))).toBe('20260102-030405-006')
  })

  it('turns a window title into a short filesystem-safe label', () => {
    expect(sanitizeLabel('Plugin prompt file — DeepSeek Harness')).toBe('plugin-prompt-file-deepseek-harness')
    expect(sanitizeLabel('../../etc/passwd')).toBe('etc-passwd')
    expect(sanitizeLabel('Зачем мы спрятались в Джунглях?!')).toBe('window')
    expect(sanitizeLabel('   ')).toBe('window')
    expect(sanitizeLabel(undefined, 'window')).toBe('window')
  })

  it('truncates very long titles', () => {
    const label = sanitizeLabel('a'.repeat(300))
    expect(label.length).toBeLessThanOrEqual(40)
  })

  it('builds a PNG name that carries kind, label, time and attempt', () => {
    const name = buildFileName({ kind: 'window', label: 'Notepad', at: AT, attempt: 3, random: 'abcd' })
    expect(name).toMatch(/^window-notepad-\d{8}-\d{6}-\d{3}-03-abcd\.png$/)
  })

  it('produces unique tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken()))
    expect(tokens.size).toBe(200)
  })

  it('keeps the partial file inside the output directory', () => {
    const directory = path.join(os.tmpdir(), 'shots')
    const partial = partialPath(directory, 'abc123')
    expect(path.dirname(partial)).toBe(directory)
    expect(path.basename(partial)).toBe('.dsh-screenshot-abc123.partial')
  })
})

describe('directory preparation', () => {
  it('creates a missing directory', async () => {
    const temp = await makeTempDirectory()
    try {
      const target = path.join(temp.path, 'nested', 'shots')
      await ensureDirectory(target, createFileSystemOps())
      const stat = await fs.stat(target)
      expect(stat.isDirectory()).toBe(true)
    } finally {
      await temp.cleanup()
    }
  })

  it('rejects an output path that is a file', async () => {
    const temp = await makeTempDirectory()
    try {
      const file = path.join(temp.path, 'not-a-dir')
      await fs.writeFile(file, 'x')
      await expect(ensureDirectory(file, createFileSystemOps())).rejects.toMatchObject({
        code: 'OUTPUT_WRITE_FAILED',
      })
    } finally {
      await temp.cleanup()
    }
  })

  it('reports a mkdir failure as OUTPUT_WRITE_FAILED', async () => {
    const ops = wrapOps(createFileSystemOps(), {
      mkdir: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      },
      lstat: async () => undefined,
    })
    await expect(ensureDirectory('/definitely/not/creatable', ops)).rejects.toBeInstanceOf(ScreenshotError)
  })

  it('rejects an empty output directory', async () => {
    await expect(ensureDirectory('', createFileSystemOps())).rejects.toMatchObject({
      code: 'OUTPUT_WRITE_FAILED',
    })
  })
})

describe('committing a screenshot', () => {
  it('writes the bytes and reports the absolute path', async () => {
    const temp = await makeTempDirectory()
    try {
      const data = Buffer.from('png-bytes')
      const result = await commitScreenshot({
        outputDir: temp.path,
        kind: 'screen',
        data,
        at: AT,
        random: () => 'abcd',
        ops: createFileSystemOps(),
      })
      expect(path.isAbsolute(result.absolutePath)).toBe(true)
      expect(result.bytes).toBe(data.length)
      expect(await fs.readFile(result.absolutePath)).toEqual(data)
    } finally {
      await temp.cleanup()
    }
  })

  it('never overwrites an existing file; it picks the next name', async () => {
    const temp = await makeTempDirectory()
    try {
      const taken = buildFileName({ kind: 'screen', at: AT, attempt: 0, random: 'abcd' })
      const takenPath = path.join(temp.path, taken)
      await fs.writeFile(takenPath, 'original')

      const result = await commitScreenshot({
        outputDir: temp.path,
        kind: 'screen',
        data: Buffer.from('second'),
        at: AT,
        random: () => 'abcd',
        ops: createFileSystemOps(),
      })

      expect(result.fileName).not.toBe(taken)
      expect(await fs.readFile(takenPath, 'utf8')).toBe('original')
      expect(await fs.readFile(result.absolutePath, 'utf8')).toBe('second')
    } finally {
      await temp.cleanup()
    }
  })

  it('gives up after the maximum number of attempts', async () => {
    const temp = await makeTempDirectory()
    try {
      for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
        const name = buildFileName({ kind: 'screen', at: AT, attempt, random: 'abcd' })
        await fs.writeFile(path.join(temp.path, name), 'taken')
      }
      await expect(
        commitScreenshot({
          outputDir: temp.path,
          kind: 'screen',
          data: Buffer.from('x'),
          at: AT,
          random: () => 'abcd',
          ops: createFileSystemOps(),
        }),
      ).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' })
    } finally {
      await temp.cleanup()
    }
  })

  it('maps a write permission failure to OUTPUT_WRITE_FAILED', async () => {
    const temp = await makeTempDirectory()
    try {
      const ops = wrapOps(createFileSystemOps(), {
        writeFileExclusive: async () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        },
      })
      await expect(
        commitScreenshot({
          outputDir: temp.path,
          kind: 'screen',
          data: Buffer.from('x'),
          at: AT,
          random: () => 'abcd',
          ops,
        }),
      ).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' })
    } finally {
      await temp.cleanup()
    }
  })

  it('removes the file when it ends up empty', async () => {
    const temp = await makeTempDirectory()
    try {
      const ops = wrapOps(createFileSystemOps(), {
        stat: async () => ({ size: 0, isFile: () => true, isDirectory: () => false }),
      })
      await expect(
        commitScreenshot({
          outputDir: temp.path,
          kind: 'screen',
          data: Buffer.from('x'),
          at: AT,
          random: () => 'abcd',
          ops,
        }),
      ).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' })

      expect(await fs.readdir(temp.path)).toEqual([])
    } finally {
      await temp.cleanup()
    }
  })

  it('supports unicode output directories and labels', async () => {
    const temp = await makeTempDirectory()
    try {
      const directory = path.join(temp.path, 'скриншоты 🎯')
      await fs.mkdir(directory, { recursive: true })
      const result = await commitScreenshot({
        outputDir: directory,
        kind: 'window',
        label: 'Блокнот',
        data: Buffer.from('x'),
        at: AT,
        random: () => 'abcd',
        ops: createFileSystemOps(),
      })
      expect(result.absolutePath).toContain('скриншоты 🎯')
      expect(await isRegularFile(result.absolutePath, createFileSystemOps())).toBe(true)
    } finally {
      await temp.cleanup()
    }
  })
})

describe('partial files', () => {
  it('removes an existing partial file', async () => {
    const temp = await makeTempDirectory()
    try {
      const partial = partialPath(temp.path, 'abc')
      await fs.writeFile(partial, 'x')
      await discardPartial(partial, createFileSystemOps())
      expect(await fs.readdir(temp.path)).toEqual([])
    } finally {
      await temp.cleanup()
    }
  })

  it('ignores a partial file that never existed', async () => {
    const temp = await makeTempDirectory()
    try {
      await expect(
        discardPartial(partialPath(temp.path, 'missing'), createFileSystemOps()),
      ).resolves.toBeUndefined()
    } finally {
      await temp.cleanup()
    }
  })
})
