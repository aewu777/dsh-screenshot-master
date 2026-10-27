#!/bin/sh
# Build the macOS ScreenCaptureKit helper.
#
# Requires the Xcode command line tools (`xcode-select --install`); no full Xcode
# installation and no Swift package manager are involved.
#
# The binary is written to native/macos/build/, which is git-ignored: compiled
# artifacts must never be committed, and they are architecture and SDK specific.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SOURCE="$ROOT/native/macos/DSHScreenshotHelper.swift"
OUTPUT_DIR="$ROOT/native/macos/build"
OUTPUT="$OUTPUT_DIR/dsh-screenshot-helper"

if [ "$(uname -s)" != "Darwin" ]; then
    echo "build-macos-helper: this script only runs on macOS (current: $(uname -s))" >&2
    exit 1
fi

if ! command -v xcrun >/dev/null 2>&1; then
    echo "build-macos-helper: xcrun is missing. Install the Xcode command line tools with 'xcode-select --install'." >&2
    exit 1
fi

ARCH=$(uname -m)
mkdir -p "$OUTPUT_DIR"

echo "build-macos-helper: compiling for $ARCH-apple-macos14.0"
xcrun --sdk macosx swiftc \
    -O \
    -target "$ARCH-apple-macos14.0" \
    -framework AppKit \
    -framework CoreGraphics \
    -framework ImageIO \
    -framework ScreenCaptureKit \
    -framework UniformTypeIdentifiers \
    -o "$OUTPUT" \
    "$SOURCE"

chmod +x "$OUTPUT"
echo "build-macos-helper: wrote $OUTPUT"
