/**
 * Subprocess plumbing shared by the platform backends.
 *
 * Both backends drive a native program (PowerShell on Windows, the ScreenCaptureKit
 * helper or `screencapture` on macOS). Arguments are always passed as an array
 * so no shell is involved and no caller-supplied string can be interpreted as
 * shell syntax.
 */

import { spawn } from 'node:child_process'

export interface RunRequest {
  command: string
  args: string[]
  timeoutMs: number
  signal?: AbortSignal | undefined
  cwd?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
}

export interface RunResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  /** Populated when the process could not be started at all. */
  spawnError?: Error
}

export type ProcessRunner = (request: RunRequest) => Promise<RunResult>

/**
 * Spawn a process and collect its output.
 *
 * Never rejects for a non-zero exit code: callers decide what a failure means.
 * A timeout kills the process and reports `timedOut`, and an already-aborted
 * signal reports `code: null` with no output.
 */
export function createProcessRunner(): ProcessRunner {
  return (request) =>
    new Promise<RunResult>((resolve) => {
      if (request.signal?.aborted) {
        resolve({ stdout: '', stderr: 'aborted before start', code: null, timedOut: false })
        return
      }

      let child: ReturnType<typeof spawn>
      try {
        child = spawn(request.command, request.args, {
          cwd: request.cwd,
          env: request.env ?? process.env,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        resolve({
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          code: null,
          timedOut: false,
          spawnError: error instanceof Error ? error : new Error(String(error)),
        })
        return
      }

      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let timedOut = false
      let settled = false

      const finish = (result: RunResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, Math.max(1, request.timeoutMs))
      timer.unref?.()

      const onAbort = (): void => {
        child.kill('SIGKILL')
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

      child.on('error', (error) => {
        finish({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          code: null,
          timedOut,
          spawnError: error,
        })
      })

      child.on('close', (code) => {
        finish({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          code,
          timedOut,
        })
      })
    })
}

/**
 * Pull a JSON object out of command output.
 *
 * The native programs print exactly one JSON line, but a runtime may prepend
 * unrelated banner text, so the last line that parses as an object wins.
 */
export function parseJsonLine<T>(stdout: string): T | undefined {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line) as T
    } catch {
      // keep scanning upwards
    }
  }
  return undefined
}
