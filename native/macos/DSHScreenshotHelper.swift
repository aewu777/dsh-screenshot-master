// dsh-screenshot-master native helper for macOS.
//
// A small, single-purpose command-line tool that exposes ScreenCaptureKit to the
// Node.js plugin. It owns native target enumeration and still-image capture and
// nothing else: it never opens an image, never analyses it, and never talks to
// the network.
//
// Protocol (documented in README.md): every invocation prints exactly one JSON
// object on stdout and exits 0 on success or 1 on failure.
//
//   dsh-screenshot-helper list
//   dsh-screenshot-helper capture-screen --out <path> [--display <display-id>]
//   dsh-screenshot-helper capture-window --out <path> --id <cgwindowid>
//   dsh-screenshot-helper permission
//
// Build: scripts/build-macos-helper.sh (requires the Xcode command line tools).
// Minimum supported macOS: 14.0 (SCScreenshotManager).

import AppKit
import CoreGraphics
import Dispatch
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// A failure that maps onto one of the plugin's error codes.
struct HelperFailure: Error {
    let code: String
    let message: String
}

// MARK: - JSON protocol

func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
          let line = String(data: data, encoding: .utf8) else {
        FileHandle.standardOutput.write("{\"ok\":false,\"error\":{\"code\":\"INTERNAL_ERROR\",\"message\":\"could not encode the response\"}}\n".data(using: .utf8)!)
        return
    }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func emitSuccess(_ fields: [String: Any]) -> Never {
    var payload: [String: Any] = ["ok": true, "platform": "darwin"]
    for (key, value) in fields {
        payload[key] = value
    }
    emit(payload)
    exit(0)
}

func emitFailure(_ code: String, _ message: String) -> Never {
    emit(["ok": false, "error": ["code": code, "message": message]])
    exit(1)
}

// MARK: - Argument parsing

func flag(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else {
        return nil
    }
    return arguments[index + 1]
}

// MARK: - Permissions

/// Screen Recording is a user-controlled TCC permission. This function only
/// reports and, on first use, lets the system show its own prompt; it never
/// tries to work around a denial.
func requireScreenRecordingPermission() throws {
    if CGPreflightScreenCaptureAccess() {
        return
    }
    // Triggers the standard system prompt the first time the user runs the
    // helper. It returns immediately with the current (still denied) state.
    _ = CGRequestScreenCaptureAccess()
    if CGPreflightScreenCaptureAccess() {
        return
    }
    throw HelperFailure(
        code: "PERMISSION_DENIED",
        message: "macOS Screen Recording permission is not granted to the process running DeepSeek Harness. "
            + "Open System Settings > Privacy & Security > Screen & System Audio Recording, enable the "
            + "Harness/terminal app that launched it, then restart that app."
    )
}

// MARK: - ScreenCaptureKit plumbing

/// Displays in a stable, left-to-right then top-to-bottom order. The reported
/// index is the index accepted by `--display` for a screen capture.
func orderedDisplays(_ content: SCShareableContent) -> [SCDisplay] {
    content.displays.sorted { lhs, rhs in
        let left = CGDisplayBounds(lhs.displayID)
        let right = CGDisplayBounds(rhs.displayID)
        if left.origin.x != right.origin.x { return left.origin.x < right.origin.x }
        return left.origin.y < right.origin.y
    }
}

func shareableContent() async throws -> SCShareableContent {
    do {
        return try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: false
        )
    } catch {
        throw HelperFailure(
            code: "CAPTURE_FAILED",
            message: "ScreenCaptureKit could not enumerate shareable content: \(error.localizedDescription)"
        )
    }
}

func scaleFactor(forDisplayID displayID: CGDirectDisplayID) -> Double {
    for screen in NSScreen.screens {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        if let number = screen.deviceDescription[key] as? NSNumber,
           CGDirectDisplayID(number.uint32Value) == displayID {
            return Double(screen.backingScaleFactor)
        }
    }
    return 1.0
}

func writePng(_ image: CGImage, to path: String) throws {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let destination = CGImageDestinationCreateWithURL(
        url,
        UTType.png.identifier as CFString,
        1,
        nil
    ) else {
        throw HelperFailure(
            code: "OUTPUT_WRITE_FAILED",
            message: "Could not create a PNG destination at \(path). Check that the directory exists and is writable."
        )
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw HelperFailure(code: "OUTPUT_WRITE_FAILED", message: "Could not finish writing the PNG at \(path).")
    }
}

// MARK: - Commands

func commandList() async throws -> Never {
    try requireScreenRecordingPermission()
    let content = try await shareableContent()
    let frontmostPID = NSWorkspace.shared.frontmostApplication?.processIdentifier

    let displays: [[String: Any]] = orderedDisplays(content).enumerated().map { index, display in
        let bounds = CGDisplayBounds(display.displayID)
        return [
            "index": index,
            "id": String(display.displayID),
            "name": "Display \(display.displayID)",
            "primary": display.displayID == CGMainDisplayID(),
            "width": display.width,
            "height": display.height,
            "scaleFactor": scaleFactor(forDisplayID: display.displayID),
            "bounds": [
                "x": Int(bounds.origin.x),
                "y": Int(bounds.origin.y),
                "width": display.width,
                "height": display.height,
            ],
        ]
    }

    let orderedDisplaysList = orderedDisplays(content)
    let windows: [[String: Any]] = content.windows.compactMap { window in
        let app = window.owningApplication
        let frame = window.frame
        if frame.width < 1 || frame.height < 1 {
            return nil
        }

        let centerX = frame.origin.x + frame.width / 2
        let centerY = frame.origin.y + frame.height / 2
        var displayIndex: Any = NSNull()
        for (index, display) in orderedDisplaysList.enumerated() {
            let bounds = CGDisplayBounds(display.displayID)
            if centerX >= bounds.origin.x, centerX < bounds.origin.x + bounds.width,
               centerY >= bounds.origin.y, centerY < bounds.origin.y + bounds.height {
                displayIndex = index
                break
            }
        }

        var entry: [String: Any] = [
            "id": "mac:\(window.windowID)",
            "title": window.title ?? "",
            "app": app?.applicationName ?? "",
            "pid": app?.processID ?? 0,
            "bounds": [
                "x": Int(frame.origin.x),
                "y": Int(frame.origin.y),
                "width": Int(frame.width),
                "height": Int(frame.height),
            ],
            "onScreen": window.isOnScreen,
            "foreground": frontmostPID.map { $0 == app?.processID } ?? false,
            "displayIndex": displayIndex,
        ]
        // ScreenCaptureKit does not expose the minimized state; `onScreen` is
        // false for both minimized and off-screen windows.
        entry["minimized"] = NSNull()
        return entry
    }

    emitSuccess([
        "displays": displays,
        "windows": windows,
        "notes": [
            "ScreenCaptureKit does not report whether a window is minimized; onScreen is false for minimized and off-screen windows.",
        ],
    ])
}

func commandCaptureScreen(_ arguments: [String]) async throws -> Never {
    guard let out = flag("--out", in: arguments) else {
        throw HelperFailure(code: "INVALID_ARGUMENT", message: "--out is required.")
    }
    try requireScreenRecordingPermission()

    let content = try await shareableContent()
    let displays = orderedDisplays(content)
    if displays.isEmpty {
        throw HelperFailure(code: "CAPTURE_FAILED", message: "No display is available to capture.")
    }

    let target: SCDisplay
    if let selector = flag("--display", in: arguments) {
        if let numeric = CGDirectDisplayID(selector) {
            guard let match = displays.first(where: { $0.displayID == numeric }) else {
                throw HelperFailure(
                    code: "DISPLAY_NOT_FOUND",
                    message: "No display has the identifier \(selector)."
                )
            }
            target = match
        } else if let index = Int(selector), index >= 0, index < displays.count {
            target = displays[index]
        } else {
            throw HelperFailure(
                code: "DISPLAY_NOT_FOUND",
                message: "No display matches '\(selector)'. Available indices: 0..\(displays.count - 1)."
            )
        }
    } else if let main = displays.first(where: { $0.displayID == CGMainDisplayID() }) {
        target = main
    } else {
        target = displays[0]
    }

    let filter = SCContentFilter(display: target, excludingWindows: [])
    let configuration = SCStreamConfiguration()
    configuration.width = target.width
    configuration.height = target.height
    configuration.showsCursor = false
    configuration.capturesAudio = false
    configuration.captureResolution = .best
    configuration.scalesToFit = false

    let image: CGImage
    do {
        image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    } catch {
        throw HelperFailure(
            code: "CAPTURE_FAILED",
            message: "ScreenCaptureKit returned no image for display \(target.displayID): \(error.localizedDescription)"
        )
    }

    try writePng(image, to: out)

    emitSuccess([
        "mode": "screen",
        "method": "screencapturekit",
        "path": out,
        "width": image.width,
        "height": image.height,
        "displays": displays.enumerated().map { index, display in
            [
                "index": index,
                "id": String(display.displayID),
                "name": "Display \(display.displayID)",
                "primary": display.displayID == CGMainDisplayID(),
                "width": display.width,
                "height": display.height,
                "scaleFactor": scaleFactor(forDisplayID: display.displayID),
                "bounds": [
                    "x": Int(CGDisplayBounds(display.displayID).origin.x),
                    "y": Int(CGDisplayBounds(display.displayID).origin.y),
                    "width": display.width,
                    "height": display.height,
                ],
            ] as [String: Any]
        },
        "displayIndex": displays.firstIndex(where: { $0.displayID == target.displayID }) ?? 0,
        "notes": [],
    ])
}

func commandCaptureWindow(_ arguments: [String]) async throws -> Never {
    guard let out = flag("--out", in: arguments) else {
        throw HelperFailure(code: "INVALID_ARGUMENT", message: "--out is required.")
    }
    guard let rawID = flag("--id", in: arguments), let windowID = UInt32(rawID) else {
        throw HelperFailure(
            code: "INVALID_ARGUMENT",
            message: "--id must be a numeric CGWindowID as returned by list."
        )
    }
    try requireScreenRecordingPermission()

    let content = try await shareableContent()
    guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
        throw HelperFailure(
            code: "WINDOW_NOT_FOUND",
            message: "Window \(windowID) is not available to ScreenCaptureKit. It may have been closed, "
                + "or it may be hidden from capture by the owning application."
        )
    }
    if !window.isOnScreen {
        throw HelperFailure(
            code: "WINDOW_NOT_CAPTURABLE",
            message: "Window \(windowID) is not on screen (minimized, hidden, or on another Space), "
                + "so ScreenCaptureKit cannot capture it."
        )
    }

    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    let contentRect = filter.contentRect
    let scale = CGFloat(filter.pointPixelScale)
    configuration.width = max(1, Int((contentRect.width * scale).rounded()))
    configuration.height = max(1, Int((contentRect.height * scale).rounded()))
    configuration.showsCursor = false
    configuration.capturesAudio = false
    configuration.captureResolution = .best
    configuration.scalesToFit = false

    let image: CGImage
    do {
        image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    } catch {
        throw HelperFailure(
            code: "CAPTURE_FAILED",
            message: "ScreenCaptureKit returned no image for window \(windowID): \(error.localizedDescription)"
        )
    }

    try writePng(image, to: out)

    let frame = window.frame
    emitSuccess([
        "mode": "window",
        "method": "screencapturekit",
        "path": out,
        "width": image.width,
        "height": image.height,
        "window": [
            "id": "mac:\(window.windowID)",
            "title": window.title ?? "",
            "app": window.owningApplication?.applicationName ?? "",
            "pid": window.owningApplication?.processID ?? 0,
            "bounds": [
                "x": Int(frame.origin.x),
                "y": Int(frame.origin.y),
                "width": Int(frame.width),
                "height": Int(frame.height),
            ],
            "onScreen": window.isOnScreen,
            "foreground": NSWorkspace.shared.frontmostApplication?.processIdentifier == window.owningApplication?.processID,
        ] as [String: Any],
        "notes": [],
    ])
}

// MARK: - Entry point

func runHelper(arguments: [String]) async {
    guard let command = arguments.first else {
        emitFailure(
            "INVALID_ARGUMENT",
            "usage: dsh-screenshot-helper <list|capture-screen|capture-window|permission> [options]"
        )
    }

    do {
        switch command {
        case "list":
            try await commandList()
        case "capture-screen":
            try await commandCaptureScreen(arguments)
        case "capture-window":
            try await commandCaptureWindow(arguments)
        case "permission":
            let granted = CGPreflightScreenCaptureAccess()
            emitSuccess(["screenRecording": granted])
        default:
            emitFailure("INVALID_ARGUMENT", "unknown command '\(command)'")
        }
    } catch let failure as HelperFailure {
        emitFailure(failure.code, failure.message)
    } catch {
        emitFailure("CAPTURE_FAILED", "\(error)")
    }
}

let helperArguments = Array(CommandLine.arguments.dropFirst())
Task.detached(priority: .userInitiated) {
    await runHelper(arguments: helperArguments)
}
// ScreenCaptureKit's async APIs run on the cooperative pool; park the main
// thread so the process stays alive until the task finishes and exits.
dispatchMain()
