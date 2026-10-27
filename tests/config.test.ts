import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { expandPath, defaultOutputDir, resolveConfig } from '../src/config.js'

describe('config defaults', () => {
  it('writes to <DSH_HOME>/screenshots by default', () => {
    const config = resolveConfig({}, { DSH_HOME: path.join(os.tmpdir(), 'dshhome') })
    expect(config.outputDir).toBe(path.join(os.tmpdir(), 'dshhome', 'screenshots'))
  })

  it('falls back to ~/.dsh/screenshots without DSH_HOME', () => {
    expect(defaultOutputDir({})).toBe(path.join(os.homedir(), '.dsh', 'screenshots'))
  })

  it('enables the window fallback and rejects uniform images by default', () => {
    const config = resolveConfig({}, {})
    expect(config.windowFallback).toBe(true)
    expect(config.allowUniformCaptures).toBe(false)
    expect(config.keepTempFiles).toBe(false)
    expect(config.timeoutMs).toBe(30_000)
  })
})

describe('config overrides', () => {
  it('takes outputDir from the row configuration', () => {
    const config = resolveConfig({ outputDir: path.join(os.tmpdir(), 'shots') }, {})
    expect(config.outputDir).toBe(path.join(os.tmpdir(), 'shots'))
  })

  it('takes outputDir from the environment', () => {
    const config = resolveConfig({}, { DSH_SCREENSHOT_OUTPUT_DIR: path.join(os.tmpdir(), 'env-shots') })
    expect(config.outputDir).toBe(path.join(os.tmpdir(), 'env-shots'))
  })

  it('prefers the row configuration over the environment', () => {
    const config = resolveConfig(
      { outputDir: path.join(os.tmpdir(), 'from-row') },
      { DSH_SCREENSHOT_OUTPUT_DIR: path.join(os.tmpdir(), 'from-env') },
    )
    expect(config.outputDir).toBe(path.join(os.tmpdir(), 'from-row'))
  })

  it('parses booleans written as strings', () => {
    const config = resolveConfig(
      { windowFallback: 'false', allowUniformCaptures: 'true', keepTempFiles: 'yes' },
      {},
    )
    expect(config.windowFallback).toBe(false)
    expect(config.allowUniformCaptures).toBe(true)
    expect(config.keepTempFiles).toBe(true)
  })

  it('clamps the timeout into a sane window', () => {
    expect(resolveConfig({ timeoutMs: 10 }, {}).timeoutMs).toBe(1_000)
    expect(resolveConfig({ timeoutMs: 10_000_000 }, {}).timeoutMs).toBe(300_000)
    expect(resolveConfig({ timeoutMs: 'not a number' }, {}).timeoutMs).toBe(30_000)
  })

  it('ignores unknown keys instead of failing', () => {
    const config = resolveConfig({ somethingFromTheFuture: true, outputDir: path.join(os.tmpdir(), 'x') }, {})
    expect(config.outputDir).toBe(path.join(os.tmpdir(), 'x'))
  })

  it('resolves the Windows script directory and PowerShell overrides', () => {
    const config = resolveConfig(
      { windowsScriptDir: '/custom/scripts', powershellPath: 'C:/PowerShell/pwsh.exe' },
      {},
    )
    expect(config.windowsScriptDir).toBe('/custom/scripts')
    expect(config.powershellPath).toBe('C:/PowerShell/pwsh.exe')
  })

  it('accepts the macOS helper path from the environment', () => {
    const config = resolveConfig({}, { DSH_SCREENSHOT_MACOS_HELPER: '/opt/bin/helper' })
    expect(config.macosHelperPath).toBe(path.resolve('/opt/bin/helper'))
  })
})

describe('path expansion', () => {
  const env = { HOME_DIR: '/env/home', USER_NAME: 'aeshii' }

  it('strips surrounding quotes', () => {
    expect(expandPath('"/tmp/a b"', { env, base: '/base' })).toBe(path.resolve('/tmp/a b'))
  })

  it('expands a leading tilde', () => {
    const home = path.join(os.tmpdir(), 'fakehome')
    expect(expandPath('~/shots', { env, home, base: '/' })).toBe(path.join(home, 'shots'))
    expect(expandPath('~', { env, home, base: '/' })).toBe(home)
  })

  it('expands %VAR% and $VAR references', () => {
    expect(expandPath('%HOME_DIR%/shots', { env, base: '/' })).toBe(path.resolve('/env/home/shots'))
    expect(expandPath('${HOME_DIR}/shots', { env, base: '/' })).toBe(path.resolve('/env/home/shots'))
    expect(expandPath('$USER_NAME/shots', { env, base: '/' })).toBe(path.resolve('/aeshii/shots'))
  })

  it('leaves an unknown variable untouched', () => {
    expect(expandPath('%NOPE%/x', { env, base: '/' })).toBe(path.resolve('/%NOPE%/x'))
  })

  it('makes the path absolute', () => {
    expect(path.isAbsolute(expandPath('relative/dir', { env, base: os.tmpdir() }))).toBe(true)
  })
})
