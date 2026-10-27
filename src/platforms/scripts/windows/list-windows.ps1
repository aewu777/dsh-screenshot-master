# Enumerate the windows and displays the Windows backend can capture.
#
# Prints exactly one compact JSON object on stdout and exits 0 on success or 1
# on failure, so the Node.js side can parse the result without a second channel.
# This script never captures an image.

param()

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

. (Join-Path $PSScriptRoot 'native.ps1')

try {
    # Physical pixels, not DPI-virtualized coordinates.
    [void][DshShotNative]::SetProcessDPIAware()

    $displays = @(Get-DshShotScreens)
    $windows = @(Get-DshShotWindows)

    $notes = New-Object System.Collections.ArrayList
    if ($displays.Count -eq 0) {
        [void]$notes.Add('No display was reported; there may be no interactive desktop session.')
    }
    if ($windows.Count -eq 0) {
        [void]$notes.Add('No visible top-level window was found.')
    }

    Write-DshShotJson ([ordered]@{
        ok         = $true
        platform   = 'win32'
        capturedAt = (Get-Date).ToString('o')
        displays   = $displays
        windows    = $windows
        notes      = @($notes.ToArray())
    })
    exit 0
} catch {
    Exit-DshShotFailure -Code 'CAPTURE_FAILED' -Message ("Window enumeration failed: " + $_.Exception.Message)
}
