/**
 * Platform selection for the screenshot backends.
 *
 * Supported platforms are Windows 10/11 and macOS 14+. Anything else gets a
 * backend that fails every call with `UNSUPPORTED_PLATFORM`, so the tools stay
 * visible and explain the situation instead of disappearing.
 */

import type { ScreenshotConfig } from '../config.js'
import { ScreenshotError } from '../errors.js'
import { createMacosBackendFromConfig } from './macos.js'
import type { ScreenBackend } from './types.js'
import { createWindowsBackendFromConfig } from './windows.js'

export const SUPPORTED_PLATFORMS = ['win32', 'darwin'] as const

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number]

export function isSupportedPlatform(platform: string): platform is SupportedPlatform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(platform)
}

export function unsupportedPlatformError(platform: string): ScreenshotError {
  return new ScreenshotError(
    'UNSUPPORTED_PLATFORM',
    `Screenshot capture is not supported on this platform (${platform}).`,
    {
      hint: `Supported platforms are Windows 10/11 (win32) and macOS 14 or newer (darwin).`,
      details: { platform, supported: [...SUPPORTED_PLATFORMS] },
    },
  )
}

/** A backend used on unsupported platforms: every operation fails clearly. */
export function createUnsupportedBackend(platform: string): ScreenBackend {
  const fail = (): never => {
    throw unsupportedPlatformError(platform)
  }
  return {
    platform: 'win32',
    displayName: `unsupported platform (${platform})`,
    supportsDesktopWindowFallback: false,
    listTargets: async () => fail(),
    captureScreen: async () => fail(),
    captureWindow: async () => fail(),
  }
}

export function createBackendForPlatform(
  config: ScreenshotConfig,
  platform: string = process.platform,
): ScreenBackend {
  if (platform === 'win32') return createWindowsBackendFromConfig(config)
  if (platform === 'darwin') return createMacosBackendFromConfig(config)
  return createUnsupportedBackend(platform)
}

export type { ScreenBackend } from './types.js'
