/**
 * Configuration for the screenshot plugin.
 *
 * Values come from the Cordis row config (see `cordis.patch.yml`) and may be
 * overridden with environment variables. Everything is resolved once at plugin
 * start so that a tool call never has to guess.
 */

import os from 'node:os'
import path from 'node:path'

export interface ScreenshotConfig {
  /**
   * Directory that receives the PNG files. Absolute, or relative to the
   * workspace/current directory. Defaults to `<DSH_HOME>/screenshots`.
   */
  outputDir: string
  /** Disable the desktop-region fallback for Windows window capture. */
  windowFallback: boolean
  /** Accept a completely uniform image as a successful capture. */
  allowUniformCaptures: boolean
  /** Time budget for one native capture command. */
  timeoutMs: number
  /** Keep the intermediate `.partial` file next to the output for debugging. */
  keepTempFiles: boolean
  /** Explicit path to the macOS native helper binary. */
  macosHelperPath: string
  /** Explicit path to the PowerShell executable used by the Windows backend. */
  powershellPath: string
  /** Override the directory that holds the Windows `.ps1` capture scripts. */
  windowsScriptDir: string
  /** Directory probed for the macOS helper when no explicit path is given. */
  macosHelperDir: string
}

export const DEFAULT_TIMEOUT_MS = 30_000

export const CONFIG_KEYS: readonly (keyof ScreenshotConfig)[] = [
  'outputDir',
  'windowFallback',
  'allowUniformCaptures',
  'timeoutMs',
  'keepTempFiles',
  'macosHelperPath',
  'powershellPath',
  'windowsScriptDir',
  'macosHelperDir',
]

/** Directory the plugin writes screenshots to when nothing is configured. */
export function defaultOutputDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, 'screenshots')
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  }
  return fallback
}

/**
 * Expand `~`, quotes and `%VAR%`/`$VAR` references, then resolve against `base`.
 * Windows paths returned by a tool call may arrive quoted or with a leading
 * tilde, so both are normalised before use.
 */
export function expandPath(
  input: string,
  options: { home?: string; base?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const env = options.env ?? process.env
  const home = options.home ?? os.homedir()
  const base = options.base ?? process.cwd()

  let value = input.trim().replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1')
  if (!value) return ''

  if (value === '~') value = home
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(home, value.slice(2))

  value = value.replace(/%([^%]+)%/g, (match, name: string) => env[name] ?? match)
  value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? ''
    return env[name] ?? match
  })

  return path.resolve(base, value)
}

function clampTimeout(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  // 1s is the floor (a native capture that needs less is broken) and 5min the
  // ceiling (a hung helper must not pin a tool call forever).
  return Math.min(300_000, Math.max(1_000, Math.round(parsed)))
}

/**
 * Resolve the effective configuration.
 *
 * Unknown keys are ignored rather than rejected so that a profile can carry
 * configuration written for a newer version of the plugin.
 */
export function resolveConfig(
  raw: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): ScreenshotConfig {
  const source = raw ?? {}

  const outputDirRaw =
    pickString(source.outputDir) ||
    pickString(env.DSH_SCREENSHOT_OUTPUT_DIR) ||
    defaultOutputDir(env)

  const explicitMacosHelper =
    pickString(source.macosHelperPath) || pickString(env.DSH_SCREENSHOT_MACOS_HELPER)

  return {
    outputDir: expandPath(outputDirRaw, { env }),
    windowFallback: pickBoolean(source.windowFallback ?? env.DSH_SCREENSHOT_WINDOW_FALLBACK, true),
    allowUniformCaptures: pickBoolean(
      source.allowUniformCaptures ?? env.DSH_SCREENSHOT_ALLOW_UNIFORM,
      false,
    ),
    timeoutMs: clampTimeout(source.timeoutMs ?? env.DSH_SCREENSHOT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    keepTempFiles: pickBoolean(source.keepTempFiles ?? env.DSH_SCREENSHOT_KEEP_TEMP, false),
    macosHelperPath: explicitMacosHelper ? expandPath(explicitMacosHelper, { env }) : '',
    powershellPath: pickString(source.powershellPath) || pickString(env.DSH_SCREENSHOT_POWERSHELL),
    windowsScriptDir:
      pickString(source.windowsScriptDir) || pickString(env.DSH_SCREENSHOT_WINDOWS_SCRIPT_DIR),
    macosHelperDir: pickString(source.macosHelperDir),
  }
}
