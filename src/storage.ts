/**
 * Output-file handling: unique names, no accidental overwrite, no leftover
 * partial files.
 *
 * The flow for one screenshot is:
 *   1. the backend writes a PNG to a uniquely named `.partial` file,
 *   2. the service decodes and validates it,
 *   3. the bytes are written to the final name with the `wx` flag, which fails
 *      instead of overwriting if the name is already taken,
 *   4. the `.partial` file is removed.
 *
 * Every step is injectable so the failure paths can be tested without a real
 * filesystem.
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ScreenshotError, toScreenshotError } from './errors.js'

export interface FileStat {
  size: number
  isFile(): boolean
  isDirectory(): boolean
}

export interface FileSystemOps {
  mkdir(directory: string): Promise<void>
  readFile(target: string): Promise<Buffer>
  stat(target: string): Promise<FileStat>
  /** Returns `undefined` instead of throwing when the path does not exist. */
  lstat(target: string): Promise<FileStat | undefined>
  /** Create with the `wx` flag: reject with `EEXIST` rather than overwrite. */
  writeFileExclusive(target: string, data: Buffer): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(target: string): Promise<void>
}

export function createFileSystemOps(): FileSystemOps {
  return {
    async mkdir(directory) {
      await fs.mkdir(directory, { recursive: true })
    },
    async readFile(target) {
      return fs.readFile(target)
    },
    async stat(target) {
      return fs.stat(target)
    },
    async lstat(target) {
      try {
        return await fs.lstat(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    async writeFileExclusive(target, data) {
      await fs.writeFile(target, data, { flag: 'wx', mode: 0o600 })
    },
    async rename(from, to) {
      await fs.rename(from, to)
    },
    async unlink(target) {
      await fs.unlink(target)
    },
  }
}

/** Number of distinct names tried before giving up on a unique filename. */
export const MAX_NAME_ATTEMPTS = 8

const LABEL_PATTERN = /[^A-Za-z0-9]+/g

/**
 * Reduce a window title to a short, filesystem-safe ASCII label.
 *
 * Titles are user data: they can contain path separators, control characters,
 * emoji or 300 characters of text, so anything outside `[A-Za-z0-9]` is
 * replaced and the result is truncated.
 */
export function sanitizeLabel(input: string | undefined, fallback = 'window'): string {
  if (!input) return fallback
  const cleaned = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(LABEL_PATTERN, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return cleaned.length > 0 ? cleaned.toLowerCase() : fallback
}

/** `20261027-201500-123` in local time; fixed-width parts keep names sortable. */
export function timestampComponent(at: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return [
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`,
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`,
    pad(at.getMilliseconds(), 3),
  ].join('-')
}

export interface FileNameInput {
  kind: 'screen' | 'window'
  label?: string
  at: Date
  attempt: number
  random: string
}

/** Build one candidate filename. Uniqueness is enforced when it is written. */
export function buildFileName(input: FileNameInput): string {
  const parts: string[] = [input.kind]
  if (input.label) parts.push(sanitizeLabel(input.label))
  parts.push(timestampComponent(input.at))
  parts.push(String(input.attempt).padStart(2, '0'))
  parts.push(input.random)
  return `${parts.join('-')}.png`
}

export function randomToken(bytes = 4): string {
  return randomBytes(bytes).toString('hex')
}

/** Path of the intermediate file the backend writes. Always inside `outputDir`. */
export function partialPath(outputDir: string, token: string): string {
  return path.join(outputDir, `.dsh-screenshot-${token}.partial`)
}

/** Create the output directory, failing with an actionable error. */
export async function ensureDirectory(directory: string, ops: FileSystemOps): Promise<void> {
  if (!directory) {
    throw new ScreenshotError('OUTPUT_WRITE_FAILED', 'No output directory is configured.', {
      hint: 'Set `outputDir` in the plugin configuration or DSH_SCREENSHOT_OUTPUT_DIR.',
    })
  }
  const existing = await ops.lstat(directory).catch(() => undefined)
  if (existing && !existing.isDirectory()) {
    throw new ScreenshotError('OUTPUT_WRITE_FAILED', `The output path is not a directory: ${directory}`, {
      hint: 'Point `outputDir` at a directory, not a file.',
    })
  }
  try {
    await ops.mkdir(directory)
  } catch (error) {
    throw toScreenshotError(error, 'OUTPUT_WRITE_FAILED')
  }
}

export interface CommitResult {
  absolutePath: string
  fileName: string
  bytes: number
}

export interface CommitOptions {
  outputDir: string
  kind: 'screen' | 'window'
  label?: string | undefined
  data: Buffer
  at: Date
  random: () => string
  ops: FileSystemOps
}

/**
 * Write `data` to the first free final filename.
 *
 * A name that already exists is skipped rather than overwritten; `EEXIST` is
 * the only error that triggers another attempt.
 */
export async function commitScreenshot(options: CommitOptions): Promise<CommitResult> {
  let lastError: unknown

  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const fileName = buildFileName({
      kind: options.kind,
      ...(options.label ? { label: options.label } : {}),
      at: options.at,
      attempt,
      random: options.random(),
    })
    const absolutePath = path.join(options.outputDir, fileName)

    try {
      await options.ops.writeFileExclusive(absolutePath, options.data)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        lastError = error
        continue
      }
      throw toScreenshotError(error, 'OUTPUT_WRITE_FAILED')
    }

    const written = await options.ops.stat(absolutePath).catch(() => undefined)
    if (!written || written.size === 0) {
      await options.ops.unlink(absolutePath).catch(() => undefined)
      throw new ScreenshotError('OUTPUT_WRITE_FAILED', `The screenshot file is empty after writing: ${absolutePath}`, {
        hint: 'Check free disk space and the output directory permissions.',
      })
    }

    return { absolutePath, fileName, bytes: written.size }
  }

  throw new ScreenshotError(
    'OUTPUT_WRITE_FAILED',
    `Could not find a free filename in ${options.outputDir} after ${MAX_NAME_ATTEMPTS} attempts.`,
    { hint: 'Remove stale screenshots or choose a different output directory.', cause: lastError },
  )
}

/** Remove a partial file, ignoring the case where it never existed. */
export async function discardPartial(target: string, ops: FileSystemOps): Promise<void> {
  try {
    await ops.unlink(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      // Cleanup must never mask the original failure; the caller logs this.
      throw toScreenshotError(error, 'OUTPUT_WRITE_FAILED')
    }
  }
}

/** True when the path exists and is a regular file. */
export async function isRegularFile(target: string, ops: FileSystemOps): Promise<boolean> {
  const info = await ops.lstat(target).catch(() => undefined)
  return Boolean(info?.isFile())
}
