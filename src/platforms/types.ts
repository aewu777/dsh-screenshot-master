/**
 * The contract between the shared screenshot service and a platform backend.
 *
 * Backends own everything that is platform specific: how targets are
 * enumerated, which native calls produce pixels, and which identifiers are
 * stable. They write a PNG to a path handed to them and report what they did.
 * They never decide on file names, never validate the image, and never talk to
 * the tool layer.
 */

export type BackendPlatform = 'win32' | 'darwin'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayInfo {
  /** Zero-based index in the backend's stable enumeration order. */
  index: number
  /** Native identifier: a device name on Windows, a display id on macOS. */
  id: string
  name: string
  primary: boolean
  /** Pixel dimensions, not logical points. */
  width: number
  height: number
  /** Physical pixels per logical point. */
  scaleFactor: number
  bounds: Bounds
}

export interface WindowInfo {
  /** Stable-per-session identifier, e.g. `win32:4195478` or `mac:12345`. */
  id: string
  title: string
  /** Owning application name, or the process name when no app name exists. */
  app: string
  pid: number
  bounds: Bounds
  /**
   * Windows reports whether the window is minimized. ScreenCaptureKit cannot
   * distinguish a minimized window from an off-screen one, so macOS leaves this
   * undefined instead of guessing.
   */
  minimized?: boolean
  /** Visible, not minimized, and not hidden by the window server. */
  onScreen: boolean
  foreground: boolean
  /** Index into the matching `DisplayInfo.index`, when known. */
  displayIndex?: number
}

export type CaptureMethod =
  | 'copyfromscreen'
  | 'printwindow'
  | 'bitblt'
  | 'desktop-region'
  | 'screencapturekit'
  | 'screencapture-cli'

export interface CaptureOutcome {
  /**
   * Pixel dimensions the native layer reports for the file it wrote. Omitted by
   * mechanisms that cannot report them (the macOS `screencapture` fallback); the
   * service always measures the decoded PNG itself.
   */
  width?: number
  height?: number
  method: CaptureMethod
  /** Human-readable diagnostics; surfaced to the caller as `notes`. */
  notes: string[]
  display?: DisplayInfo
  window?: WindowInfo
  /** True when a non-primary mechanism produced the image. */
  fallback?: boolean
}

export interface ListTargetsOptions {
  signal?: AbortSignal
}

export interface ListTargetsResult {
  windows: WindowInfo[]
  displays: DisplayInfo[]
  notes: string[]
}

export interface CaptureScreenOptions {
  /** Zero-based display index or a backend-native identifier. */
  display?: number | string
  outPath: string
  signal?: AbortSignal
}

export interface CaptureWindowOptions {
  windowId: string
  outPath: string
  /**
   * `native` asks the platform for the window's own composited content.
   * `desktop` reads the window's rectangle off the desktop; it is only offered
   * where the platform supports it and is always reported in `method`.
   */
  strategy: 'native' | 'desktop'
  signal?: AbortSignal
}

export interface ScreenBackend {
  readonly platform: BackendPlatform
  /** Name shown in errors, e.g. "Windows (PrintWindow/BitBlt)". */
  readonly displayName: string
  /** Whether `strategy: 'desktop'` is implemented. */
  readonly supportsDesktopWindowFallback: boolean
  listTargets(options?: ListTargetsOptions): Promise<ListTargetsResult>
  captureScreen(options: CaptureScreenOptions): Promise<CaptureOutcome>
  captureWindow(options: CaptureWindowOptions): Promise<CaptureOutcome>
}

/** Normalise a numeric-or-string display selector coming from a tool call. */
export function normalizeDisplaySelector(value: unknown): number | string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed
  }
  return undefined
}
