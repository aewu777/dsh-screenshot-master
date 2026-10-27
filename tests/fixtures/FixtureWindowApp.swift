// Test fixture: a real AppKit window with recognizable content.
//
// Used by tests/macos.integration.test.ts to prove that the plugin captures the
// requested window rather than a desktop rectangle. The window is deliberately
// two-toned (a solid body colour plus a white panel with black text) so that it
// is never mistaken for a blank capture and its dominant colour can be asserted.
//
// Compiled by the test itself with `xcrun swiftc`; the binary is written to a
// temporary directory and never committed.
//
// Configuration through the environment:
//   DSH_FIXTURE_TITLE   window title (default "DSH Screenshot Fixture")
//   DSH_FIXTURE_COLOR   body colour as #RRGGBB (default #D91BC0)
//   DSH_FIXTURE_X/Y     window origin in points
//   DSH_FIXTURE_W/H     content size in points

import AppKit
import Foundation

func parseColor(_ raw: String) -> NSColor {
    var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.hasPrefix("#") { text.removeFirst() }
    guard text.count == 6, let value = UInt32(text, radix: 16) else {
        return NSColor(red: 0.85, green: 0.11, blue: 0.75, alpha: 1.0)
    }
    return NSColor(
        red: CGFloat((value >> 16) & 0xff) / 255.0,
        green: CGFloat((value >> 8) & 0xff) / 255.0,
        blue: CGFloat(value & 0xff) / 255.0,
        alpha: 1.0
    )
}

let environment = ProcessInfo.processInfo.environment
let title = environment["DSH_FIXTURE_TITLE"] ?? "DSH Screenshot Fixture"
let bodyColor = parseColor(environment["DSH_FIXTURE_COLOR"] ?? "#D91BC0")
let originX = Double(environment["DSH_FIXTURE_X"] ?? "160") ?? 160
let originY = Double(environment["DSH_FIXTURE_Y"] ?? "160") ?? 160
let contentWidth = Double(environment["DSH_FIXTURE_W"] ?? "520") ?? 520
let contentHeight = Double(environment["DSH_FIXTURE_H"] ?? "340") ?? 340

let application = NSApplication.shared
application.setActivationPolicy(.regular)

let window = NSWindow(
    contentRect: NSRect(x: originX, y: originY, width: contentWidth, height: contentHeight),
    styleMask: [.titled, .closable],
    backing: .buffered,
    defer: false
)
window.title = title
window.backgroundColor = bodyColor
window.isReleasedWhenClosed = false

let panel = NSView(frame: NSRect(x: 24, y: 24, width: max(120, contentWidth - 48), height: 84))
panel.wantsLayer = true
panel.layer?.backgroundColor = NSColor.white.cgColor
window.contentView?.addSubview(panel)

let label = NSTextField(labelWithString: "DSH SCREENSHOT FIXTURE")
label.frame = NSRect(x: 12, y: 28, width: max(120, contentWidth - 72), height: 28)
label.font = NSFont.boldSystemFont(ofSize: 18)
label.textColor = .black
panel.addSubview(label)

window.makeKeyAndOrderFront(nil)
window.orderFrontRegardless()
application.activate(ignoringOtherApps: true)

print("{\"ready\":true,\"title\":\"\(title)\"}")
fflush(stdout)

application.run()
