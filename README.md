# dsh-screenshot-master

Cross-platform screenshot capture for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

The plugin captures the full screen, a single display, or one application window, writes it to a PNG file, and
returns that file's absolute path together with capture metadata. It does nothing else with the image.

## Contents

- [Scope](#scope)
- [Supported platforms](#supported-platforms)
- [Installation](#installation)
- [Configuration](#configuration)
- [Tools](#tools)
- [Output files](#output-files)
- [Native dependencies](#native-dependencies)
- [Windows behaviour and limitations](#windows-behaviour-and-limitations)
- [macOS behaviour and limitations](#macos-behaviour-and-limitations)
- [Testing](#testing)
- [Continuous integration](#continuous-integration)
- [Verification status](#verification-status)
- [The DSH API this plugin relies on](#the-dsh-api-this-plugin-relies-on)
- [Known limitations](#known-limitations)

## Scope

The plugin has exactly one job: **capture a screenshot and save it**.

It does:

- capture the full screen,
- capture one selected display where the platform supports it,
- enumerate the windows that can be captured,
- capture one window by the identifier returned from that enumeration,
- save the result as PNG,
- return the absolute path plus width, height, capture type, method and related metadata.

It deliberately does **not**:

- open, display or preview the saved image,
- analyse the image in any way, run OCR, or extract text,
- send the image to an AI model or any external service,
- attach the image to the conversation,
- upload the image or transmit it over a network,
- use the image to trigger other actions,
- delete screenshots that were saved earlier,
- run unrelated computer-use automation.

The caller decides what happens to the file afterwards. `list_windows` exists only so that a caller can pick a
capture target; it never captures an image.

The scope is enforced in code (the shared layer contains no `child_process`, `fetch`, HTTP, OCR or file-opening
calls) and by a test that scans the sources for those capabilities.

## Supported platforms

| Platform | Status | Native mechanism |
| --- | --- | --- |
| Windows 10 / 11 (x64, arm64) | Implemented and verified by real-capture tests locally and in CI on `windows-latest` | Win32 `PrintWindow` / `BitBlt` / `Graphics.CopyFromScreen` through Windows PowerShell 5.1 |
| macOS 14 (Sonoma) and newer | Implemented and verified by real-capture tests in CI on `macos-latest` (screen and window capture), see [Verification status](#verification-status) | ScreenCaptureKit (`SCShareableContent`, `SCContentFilter`, `SCScreenshotManager`) through a bundled Swift helper |
| Linux, anything else | Not supported | The tools register but every call fails with `UNSUPPORTED_PLATFORM` |

macOS 13 is **not** supported: `SCScreenshotManager.captureImage(contentFilter:configuration:)`, the API this
helper is built on, requires macOS 14.0. The helper is compiled with a `macos14.0` deployment target so that an
unavailable API cannot creep in.

## Installation

The plugin is a DSH bundle package. It is installed into the current DSH profile:

```
plugin_manager install_bundle  target: <absolute path to this directory>
```

`package.json` declares `dsh.bundle.patch`, so installing the package also applies
[`cordis.patch.yml`](./cordis.patch.yml), which inserts the plugin row. To change configuration, override that
row from the profile's own `cordis.patch.yml`.

### Building from source

Requires Node.js 22 or newer.

```bash
npm ci            # reproducible install from the committed lockfile
npm run build     # tsc -> lib/ and copies the PowerShell scripts
```

`npm run build` is required before the plugin can be loaded: the package entry point is `lib/index.js`.

### macOS: build the native helper once

Full macOS support needs a small compiled helper. It is not shipped prebuilt because a binary must match the
machine's architecture and SDK; build it on the machine that will run it (or in CI):

```bash
npm run build:native:macos     # requires the Xcode command line tools
```

That script runs `xcrun swiftc` and writes `native/macos/build/dsh-screenshot-helper`, which is git-ignored.
Only the Xcode **command line tools** are needed (`xcode-select --install`); a full Xcode installation and Swift
Package Manager are not involved, and nothing has to be installed at capture time.

If the helper is missing, the plugin still registers and still captures the **main display** through the system
`screencapture` utility, but window enumeration and display selection return
`NATIVE_HELPER_UNAVAILABLE` with build instructions.

## Configuration

All keys are optional. They may be set on the plugin row in `cordis.patch.yml` or through the environment.

| Key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `outputDir` | `DSH_SCREENSHOT_OUTPUT_DIR` | `$DSH_HOME/screenshots` (`~/.dsh/screenshots`) | Directory that receives the PNG files. Created when missing. `~`, `%VAR%` and `$VAR` are expanded. |
| `windowFallback` | `DSH_SCREENSHOT_WINDOW_FALLBACK` | `true` | Windows only: retry a failed native window capture by copying the window's rectangle off the desktop. The result is always labelled `desktop-region` and carries a warning note. |
| `allowUniformCaptures` | `DSH_SCREENSHOT_ALLOW_UNIFORM` | `false` | Accept an image whose every pixel is identical. Off by default, because a uniform frame is what a failed capture looks like. |
| `timeoutMs` | `DSH_SCREENSHOT_TIMEOUT_MS` | `30000` | Time budget for one native capture command, clamped to 1 000–300 000 ms. |
| `keepTempFiles` | `DSH_SCREENSHOT_KEEP_TEMP` | `false` | Keep the `.partial` file next to the output for debugging. |
| `powershellPath` | `DSH_SCREENSHOT_POWERSHELL` | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` | Windows only: the PowerShell used to run the capture scripts. |
| `windowsScriptDir` | `DSH_SCREENSHOT_WINDOWS_SCRIPT_DIR` | bundled `lib/platforms/scripts/windows` | Windows only: overrides where the `.ps1` scripts are read from. |
| `macosHelperPath` | `DSH_SCREENSHOT_MACOS_HELPER` | `native/macos/build/dsh-screenshot-helper` | macOS only: explicit helper binary. |
| `macosHelperDir` | – | – | Reserved for packaging layouts that relocate the helper; unused by default. |

Example override:

```yaml
# <profile>/cordis.patch.yml
- id: dsh-screenshot-master
  config:
    outputDir: D:/captures
    windowFallback: false
```

Booleans may be written as `true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off`. Unknown keys are ignored rather than
rejected, so a profile can carry configuration written for a newer version.

## Tools

Three tools are registered. All parameters are validated before any native work starts, and every failure is
reported as a typed error (see [error codes](#error-codes)).

### `screenshot_screen`

Capture the full screen, or one display of it.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `display` | integer \| string | no | Zero-based display index, or a display identifier as reported by `list_windows`. Omit it to capture the primary display. |

```json
{ "display": 1 }
```

Result:

```json
{
  "path": "/Users/me/.dsh/screenshots/screen-display0-20261027-201500-123-00-a1b2c3d4.png",
  "fileName": "screen-display0-20261027-201500-123-00-a1b2c3d4.png",
  "bytes": 836177,
  "width": 1920,
  "height": 1080,
  "captureType": "screen",
  "method": "copyfromscreen",
  "takenAt": "2026-10-27T13:15:00.123Z",
  "uniform": false,
  "fallback": false,
  "notes": [],
  "display": { "index": 0, "id": "\\\\.\\DISPLAY1", "name": "\\\\.\\DISPLAY1", "primary": true, "width": 1920, "height": 1080, "scaleFactor": 1 }
}
```

### `list_windows`

List the capture targets. Never captures an image.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `filter` | string | no | Case-insensitive substring matched against the window title, the application name and the identifier. |

```json
{ "filter": "notepad" }
```

Result:

```json
{
  "count": 2,
  "windows": [
    {
      "id": "win32:4195478",
      "title": "Untitled - Notepad",
      "app": "notepad",
      "pid": 4242,
      "bounds": { "x": 100, "y": 120, "width": 800, "height": 600 },
      "displayIndex": 0
    }
  ],
  "displays": [
    { "index": 0, "id": "\\\\.\\DISPLAY1", "name": "\\\\.\\DISPLAY1", "primary": true, "width": 1920, "height": 1080, "scaleFactor": 1 }
  ],
  "notes": []
}
```

Titles are **not** unique: several windows can all be called "Untitled - Notepad". Always use `id`, which is
derived from the native window handle (`win32:<HWND>`) or the window server identifier (`mac:<CGWindowID>`).
`pid`, `app` and `bounds` are there to disambiguate further.

### `screenshot_window`

Capture one window, identified by the `id` from `list_windows`. A window title is not accepted.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `window_id` | string | yes | The `id` returned by `list_windows`, for example `win32:4195478` or `mac:12345`. |

```json
{ "window_id": "win32:4195478" }
```

The result has `captureType: "window"` and a `window` object. Captures the window's own composited content, not
the desktop area behind it. If the platform cannot read the window, the call fails; it never returns a
substitute image.

### Error codes

| Code | Meaning |
| --- | --- |
| `UNSUPPORTED_PLATFORM` | This operating system has no capture backend. |
| `INVALID_ARGUMENT` | A parameter was missing, malformed, out of range, or an unknown key was passed. |
| `DISPLAY_NOT_FOUND` | The requested display index or identifier does not exist. |
| `WINDOW_NOT_FOUND` | The window was closed, or the handle no longer names a window. |
| `WINDOW_NOT_CAPTURABLE` | The window exists but exposes no capturable surface (protected content, hardware acceleration, hidden window, other Space). |
| `WINDOW_MINIMIZED` | The window is minimized and its desktop rectangle cannot be captured. |
| `PERMISSION_DENIED` | macOS Screen Recording permission is missing. |
| `CAPTURE_FAILED` | The native layer ran and produced nothing usable. |
| `BLANK_CAPTURE` | The image is a single uniform colour, i.e. the capture produced no content. |
| `OUTPUT_WRITE_FAILED` | The directory or file could not be written. |
| `INVALID_PNG` | The bytes written are not a decodable PNG. |
| `NATIVE_HELPER_UNAVAILABLE` | The macOS helper is missing or cannot be executed. |
| `TIMEOUT` | A native command exceeded `timeoutMs`. |

Every error carries an actionable hint that is appended to the model-facing message.

## Output files

- **Directory**: `outputDir`, created recursively when missing. An existing path that is a file is rejected, and
  a directory that cannot be written reports `OUTPUT_WRITE_FAILED` with the operating system's reason.
- **Name**: `<capture type>-<label>-<YYYYMMDD>-<HHMMSS>-<mmm>-<attempt>-<random>.png`, for example
  `window-notepad-20261027-201500-123-00-9f3c1a2b40d1.png`. Local time, fixed-width parts, so names sort
  chronologically. The label comes from the window title or application name, reduced to `[a-z0-9-]` and at most
  40 characters.
- **Absolute path**: relative paths are resolved against the process working directory; `~`, `%VAR%` and `$VAR`
  are expanded.
- **Uniqueness**: the final file is created with the `wx` flag, so an existing file is never overwritten. A name
  collision moves on to the next candidate (up to 8 attempts), which also makes concurrent captures safe.
- **Unicode**: file names are ASCII, but the directory may be any Unicode path; the native layer receives the
  path as a discrete argument, never through a shell.
- **Temporary files**: the native layer writes `<outputDir>/.dsh-screenshot-<token>.partial`; it is verified,
  copied to the final name and removed. On any failure the partial file is removed too (unless
  `keepTempFiles` is on). Nothing else in the directory is ever touched or deleted.

### What is verified before success is reported

1. The output file exists.
2. It is not empty.
3. The PNG signature, header and every chunk CRC are valid.
4. It decodes, and the decoded image has non-zero dimensions.
5. The image is not a single uniform colour (unless `allowUniformCaptures` is on).
6. If the backend reported dimensions, they match the decoded image.

A valid PNG is not proof that the right target was captured, so the real-capture tests additionally assert image
content, size and the absence of an overlapping window's colours.

## Native dependencies

| Platform | Dependency | Notes |
| --- | --- | --- |
| Windows | Windows PowerShell 5.1 | Present on every supported Windows version. The scripts use only `System.Drawing`, `System.Windows.Forms` and Win32 P/Invoke. |
| macOS | Bundled Swift helper (built once) | Requires the Xcode command line tools **only at build time**. |
| macOS (fallback) | `/usr/sbin/screencapture` | Part of macOS. Used only when the helper has not been built. |

No Node.js native addon is compiled or loaded, and there are no runtime npm dependencies.

## Windows behaviour and limitations

Screen capture uses `Graphics.CopyFromScreen` over the chosen display's physical bounds, after calling
`SetProcessDPIAware`, so the image is in real pixels rather than DPI-virtualized ones.

Window capture walks a documented chain and reports which step produced the image in `method`:

1. `PrintWindow` with `PW_RENDERFULLCONTENT` — works for most classic and composited applications.
2. `PrintWindow` without flags — older toolkits.
3. `BitBlt` from the window DC — GDI-only applications.
4. `desktop-region` — only when `windowFallback` is on: the window is brought to the foreground and its
   rectangle is copied off the desktop. Reported with `fallback: true` and a note that overlapping windows are
   included.

### Why the image is not offset by the window border

A Windows window has two rectangles: the *window rectangle* (`GetWindowRect`) and the smaller *visible frame*
(`DWMWA_EXTENDED_FRAME_BOUNDS`). They differ by the invisible resize border — typically 7 px on the left, right and
bottom of a DWM window. GDI renders `PrintWindow` and reads `BitBlt` from the window rectangle's origin, so a bitmap
sized to the visible frame but filled from that origin is shifted: it shows a strip of the invisible border instead of
the window's own left edge, and loses the same number of pixels on the right.

The backend therefore captures the whole window rectangle and crops to the visible frame (`Bitmap.Clone` with the
crop rectangle) before saving. Borderless windows, where both rectangles coincide, are unaffected.

### Why the image has no black frame

`PrintWindow` does not paint the one-pixel frame that the desktop window manager composites between the visible
frame and the client area; it leaves that ring black. The ring width is measurable: it is the gap between the client
rectangle and the visible frame on the left, the right and the bottom (the gap at the top is the title bar, which the
window paints itself and which is kept).

That ring is excluded from the saved image. A window capture is therefore exactly the area the window paints — its
title bar and client area — and can be one pixel smaller on each bordered side than the visible frame reported by
`list_windows` (for example a 1004×672 visible frame yields a 1002×671 image). Borderless windows are exactly the
size of their frame because they have no such ring.

### Why the PNG conversion never composites

Every capture buffer is written to PNG as opaque 24-bit RGB by **copying pixels, never by compositing them over a
background**.

GDI leaves the alpha byte of a capture buffer undefined. A fresh `Format32bppArgb` bitmap starts at
`ARGB(0,0,0,0)`, `CopyFromScreen`/`PrintWindow`/`BitBlt` write only the colour bytes, and any region that was never
painted keeps `alpha = 0` with black RGB. Blending such a pixel over white turns an unpainted dark pixel into a
pure-white one, so the plugin would emit white dots that were never rendered. The conversion therefore drops the
alpha channel (`Bitmap.Clone` to `Format24bppRgb`, which converts without compositing) and keeps exactly the bytes
GDI produced. `tests/windows.integration.test.ts` pins this down with a fixture whose alpha values are deliberately
wrong.

Screen captures are unaffected in practice because `CopyFromScreen` writes `alpha = 255` for every pixel; the
window paths are the ones where undefined alpha can appear.

Limitations, all reported rather than hidden:

- Hardware-accelerated applications (browsers, Electron/Chromium apps, games) commonly refuse all three
  `PrintWindow`/`BitBlt` steps and return a blank frame. The blank frame is detected, and the desktop-region
  fallback is used if enabled. On the machine this plugin was developed on, the DSH desktop window itself
  behaves exactly this way.
- Windows with `WS_EX_NOREDIRECTIONBITMAP` have no redirection surface at all; a note says so before the
  attempt is made.
- Protected content (DRM video, some banking apps) cannot be captured by any user-mode API.
- A minimized window may still yield its last composited frame through `PrintWindow`, or may yield nothing; the
  capture either produces real content or fails explicitly.
- `display` indices are the plugin's own stable order (left to right, then top to bottom). A device name such as
  `\\.\DISPLAY2` is also accepted.
- `scaleFactor` is the process-wide DPI scale, not a per-monitor value.

## macOS behaviour and limitations

The primary mechanism is the bundled Swift helper (`native/macos/DSHScreenshotHelper.swift`), a single-purpose
command-line tool that exposes ScreenCaptureKit to the plugin:

```
dsh-screenshot-helper list
dsh-screenshot-helper capture-screen --out <path> [--display <id-or-index>]
dsh-screenshot-helper capture-window --out <path> --id <cgwindowid>
dsh-screenshot-helper permission
```

Each invocation prints exactly one JSON object on stdout and exits 0 on success or 1 on failure, for example:

```json
{"ok":false,"error":{"code":"WINDOW_NOT_FOUND","message":"Window 12345 is not available to ScreenCaptureKit."}}
```

Arguments are always passed as an array to `spawn` with `shell: false`, so no value can be interpreted as shell
syntax. The Node.js side never writes the helper's output into a shell either.

How it works:

- `SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)` enumerates displays and
  windows; `SCWindow.windowID` becomes the `mac:<id>` identifier, and `SCWindow.owningApplication` provides the
  application name and pid.
- A display is captured through `SCContentFilter(display:excludingWindows:)` and a window through
  `SCContentFilter(desktopIndependentWindow:)`, both with `SCScreenshotManager.captureImage`.
- The PNG is written with ImageIO (`CGImageDestinationCreateWithURL` + `UTType.png`).
- The helper refuses to capture a window that ScreenCaptureKit reports as not on screen instead of returning a
  substitute image.

### Screen Recording permission

macOS gates screen capture behind the Screen Recording permission (TCC). It cannot be bypassed and this plugin
does not try.

- The first time the helper runs, it calls `CGRequestScreenCaptureAccess()`, which makes macOS show its own
  prompt. If the permission is still missing afterwards, the call fails with `PERMISSION_DENIED`.
- To grant it manually: **System Settings → Privacy & Security → Screen & System Audio Recording**, enable the
  application that runs DeepSeek Harness (and, when the harness is started from a terminal, that terminal app),
  then **quit and restart** that application. macOS does not apply the change to an already running process.
- A denied permission is never reported as a successful capture: the plugin returns `PERMISSION_DENIED` or, if
  the denial only manifests as a black frame, `BLANK_CAPTURE`.

### Other macOS limitations

- `SCWindow` does not expose whether a window is minimized; `onScreen` is `false` for both minimized and
  off-screen windows, and the `minimized` field is left empty instead of being guessed.
- Windows on another Space, or hidden by their own application, are not capturable.
- There is **no** desktop-region fallback for window capture on macOS: `screencapture -l <CGWindowID>` is the
  only fallback, and it is a real window capture. A display capture is never substituted for a window capture.
- Without the helper, `screencapture` can only capture the main display and cannot enumerate windows.
- `bounds` are reported in the platform's own screen coordinates: physical pixels on Windows, logical points on
  macOS. Captured image dimensions are always physical pixels.

## Testing

Two projects are configured in [`vitest.config.ts`](./vitest.config.ts):

- **unit** — deterministic, needs no screen, no permission and no native helper. Runs on any operating system.
- **integration** — performs real captures of the machine it runs on. Platform-gated by
  `describe.skipIf(process.platform !== ...)`, never by a runtime "did it work?" check.

```bash
npm run test:unit          # unit project
npm run test:integration   # integration project (real captures)
npm run typecheck          # tsc over src/ and tests/
npm run lint               # eslint
npm run check:workflow     # parse .github/workflows/tests.yml and check its structure
npm run check              # workflow check + typecheck + lint + build + unit tests
```

`check:workflow` exists because GitHub rejects the entire workflow file on a YAML
syntax error and reports the run as a failure with no jobs at all — which looks
exactly like failing tests. A `name:` value containing `": "` is enough to trigger
it, so the file is parsed and structurally checked locally before it is pushed.

What needs a real display or interactive session:

| Suite | Needs | Notes |
| --- | --- | --- |
| `tests/*.test.ts` (unit) | nothing | Uses an injected fake backend and a temporary directory. |
| `tests/windows.integration.test.ts` | Windows desktop session | Starts real WinForms fixture windows and captures them. |
| `tests/macos.integration.test.ts` | macOS 14+, WindowServer session, Screen Recording permission, Xcode CLT | Test A captures the screen; Test B compiles and starts an AppKit fixture window. |

`tests/macos.capture.test.ts` runs on **every** platform with an injected process runner. It proves the
TypeScript orchestration only — argument construction, JSON parsing, exit-status handling and error mapping. It
is not evidence that macOS capture works, and it is never described as such.

The Windows real-capture suite deliberately includes a window-overlap test: fixture B is top-most and covers part
of fixture A, so a desktop crop of A's rectangle would contain B's magenta body. A real window capture cannot.

### Pixel-fidelity tests

`tests/fixtures/pattern-window.ps1` renders a borderless window whose every pixel has a known value: flat dark and
flat light bands, a horizontal gradient, a 1px checkerboard, 1px vertical lines, eight pure colour swatches, a 1px
outline and antialiased text. The fixture also writes the exact bitmap it displays, and the tests compare the
capture against both that bitmap and an independently computed prediction of the pattern. The suite asserts:

- a window capture reproduces the pattern with **zero** differing pixels,
- single-pixel detail survives (alternating white/black checkerboard, 1px lines),
- colours are exact and not channel-swapped (pure red/green/blue/magenta/cyan/yellow swatches, gradient endpoints),
- a full-screen capture matches the same window region pixel for pixel,
- no isolated bright pixels are introduced anywhere,
- the PNG conversion ignores the capture buffer's undefined alpha channel,
- a **bordered** window, whose window rectangle is larger than its visible frame, is cropped correctly: the client
  area appears at exactly the offset implied by the window and client rectangles, so the image is not shifted by the
  invisible border, and the black 1px frame the window manager draws is not present.

`tests/fixtures/conversion-check.ps1` feeds the production conversion a bitmap whose alpha bytes are 0, 128 and
nonsense, and asserts the colours survive untouched.

## Continuous integration

[`.github/workflows/tests.yml`](./.github/workflows/tests.yml) runs on:

- every push,
- pull requests whose target branch is `master`,
- manual `workflow_dispatch`.

Jobs, kept separate on purpose:

| Job | Runner | What it proves |
| --- | --- | --- |
| `unit` (matrix: `windows-latest`, `macos-latest` × Node 22, 24) | GitHub-hosted | Lint, type check, build and the deterministic unit suite. No screen involved. |
| `windows-integration` | `windows-latest` | Real screen and window captures, including the overlap test. |
| `macos-real-capture` | `macos-latest` | Builds the Swift helper, reports the environment, then runs the real-capture suite (Test A and Test B). |

Notes:

- All tests run on **GitHub-hosted machines**, not on the developer's computer.
- Results and uploaded logs are in the repository's **Actions** tab, under the `tests` workflow.
- Unit tests passing does **not** mean native capture works.
- No job uses `continue-on-error` for a test step, and the real-capture jobs never skip their assertions. If the
  runner has no GUI session, no display, or no Screen Recording permission, the job **fails**, and the
  "Report capture environment" step shows why. That is deliberate: a blocked environment must be distinguishable
  from a passing verification.
- The only step with `continue-on-error: true` is the macOS environment report, which is diagnostics; the test
  step after it is not.

## Verification status

Last updated after the first fully green cross-platform CI run (2026-10-29).

| Claim | Evidence |
| --- | --- |
| Windows full-screen capture works | `tests/windows.integration.test.ts` — real 1920×1080 capture, decoded and measured. **Passed locally.** |
| Windows window capture works | Same suite — real WinForms windows captured by handle; the overlap test proves the window's own content is captured. **Passed locally.** |
| Windows window enumeration works | Same suite — real windows and displays enumerated with unique identifiers. **Passed locally.** |
| Capture pipeline is pixel-exact | `Windows capture fidelity` tests — 0 of 76 800 pixels differ from the fixture's own rendering, and 0 differ for the same window region inside a full-screen capture. **Passed locally.** |
| The PNG conversion does not fabricate white pixels | `converts a capture buffer without compositing it over a background` — verified to fail against the pre-fix implementation and pass after the fix. **Passed locally.** |
| A window image is aligned to the visible frame, not shifted by the invisible border | `crops a bordered window to its visible frame instead of shifting it` — verified to fail against the pre-fix implementation and pass after. On a real 1004×672 window the stray left strip went from 8 black columns to 1, and the 7 px previously missing on the right are now included. **Passed locally.** |
| A window image has no black 1px frame | Same bordered-window test — every edge line went from 241-322 pure-black pixels to 0 on a real bordered window, and a real 1004×672 window now captures as a clean 1002×671 image. **Passed locally.** |
| PNG validation, naming, uniqueness, fallback and error mapping | 175 unit tests, all passing locally and in CI. |
| macOS TypeScript orchestration | 27 unit tests with an injected runner, passing locally on Windows. |
| **macOS real full-screen capture (Test A)** | **Passed in CI** on a GitHub-hosted `macos-latest` runner: the production backend enumerated displays and captured the real screen through the ScreenCaptureKit helper (`method: screencapturekit`, decoded and measured). |
| **macOS real window capture (Test B)** | **Passed in CI.** The first run failed with a CoreGraphics abort (`CGS_REQUIRE_INIT`) while creating the window content filter, although display capture worked in the same session. After the helper was changed to initialise AppKit on the main thread and to size the capture from `SCWindow.frame` and the display pixel density, Test B passed on the same kind of runner. |
| GitHub Actions workflow | Green across all six jobs: `unit` on `windows-latest` and `macos-latest` for Node 22 and 24, `windows integration (real capture)`, and `macOS real capture (ScreenCaptureKit)`. The first attempt failed before starting any job (invalid YAML, since fixed and guarded by `npm run check:workflow`). |

Do not infer macOS support from TypeScript compilation, from unit tests, or from the existence of a workflow file. It is
verified because the real-capture job captured a real screen and a real window through ScreenCaptureKit on a
GitHub-hosted macOS runner.

## The DSH API this plugin relies on

Verified against the installed DeepSeek Harness tool registry (`@deepseek-ai/dsh-tools` 0.2.1-rc.2) rather than
assumed:

- **Entry point**: a package whose module exports `name`, `inject = ['tools']` and `apply(ctx, config)`.
- **Tool registration**: `ctx.tools.register(definition)` returns a disposer. A definition is
  `{ name, description, parameters, output: { schema, render }, execute }`, where `parameters` and
  `output.schema` are JSON Schema, `render(args, value)` returns content blocks shaped
  `[{ type: 'text', text }]`, and `execute(args, exec)` returns the declared output value. `timeoutMs` and
  `isConcurrencySafe` are optional.
- **Lifecycle**: `ctx.effect(() => disposer, label)` ties registrations to plugin load/unload.
- **Bundle**: `package.json` declares `dsh.bundle.patch`, and `cordis.patch.yml` inserts the plugin row.

The plugin does **not** import `@deepseek-ai/dsh-tools` at runtime. It builds the verified definition shape
itself in [`src/toolkit.ts`](./src/toolkit.ts), so installing the bundle does not require resolving harness peer
packages. `tests/tools.test.ts` asserts that every registered definition matches the verified contract.

## Known limitations

- macOS support is verified on GitHub-hosted `macos-latest` runners only, not on every macOS configuration. Mixed-DPI
  multi-display setups and unusual window managers are untested.
- On macOS, window capture requires a WindowServer connection and Screen Recording permission; a headless or non-GUI
  session cannot provide the former and the helper will report it rather than pretend to capture.
- Window capture cannot beat platform protection: DRM/protected windows, hardware-accelerated surfaces that
  refuse `PrintWindow`, and windows hidden by their own application are out of reach. Failures are explicit.
- A genuinely uniform image (for example a maximised all-white slide) is rejected as `BLANK_CAPTURE` unless
  `allowUniformCaptures` is enabled. This is the trade-off that makes silent blank captures impossible.
- The desktop-region fallback on Windows includes anything overlapping the window; it is labelled as such and can
  be disabled with `windowFallback: false`.
- Display ordering is the plugin's own sort order, which can differ from the numbering shown in macOS'
  Displays settings.
- No tool deletes old screenshots. Callers are responsible for pruning `outputDir`.
- The plugin registers three tools with fixed names; it does not expose configuration through a settings UI.
