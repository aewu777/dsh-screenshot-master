# Capture the whole screen, one display, or one window to a PNG file.
#
# Prints exactly one compact JSON object on stdout. Exits 0 when a file was
# written and 1 otherwise. The Node.js side validates the PNG itself, so this
# script only reports what it did.
#
# Capture chain for windows:
#   1. PrintWindow with PW_RENDERFULLCONTENT (works for most composited apps),
#   2. PrintWindow without flags (older toolkits),
#   3. BitBlt from the window DC (GDI-only apps),
#   4. --strategy desktop: bring the window forward and copy its rectangle off
#      the desktop (the only option for windows that expose no surface at all).
# Steps 1-4 are all reported through the `method` field; a desktop-region
# capture is never presented as a native window capture.

param(
    [Parameter(Mandatory = $true)][ValidateSet('screen', 'window')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Display = '',
    [string]$WindowId = '',
    [ValidateSet('native', 'desktop')][string]$Strategy = 'native'
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

. (Join-Path $PSScriptRoot 'native.ps1')

$PW_RENDERFULLCONTENT = 2

function Resolve-DshShotDisplay {
    param([object[]]$Screens, [string]$Selector)

    if ([string]::IsNullOrWhiteSpace($Selector)) {
        $primary = $Screens | Where-Object { $_.primary } | Select-Object -First 1
        if ($null -eq $primary) { return $Screens | Select-Object -First 1 }
        return $primary
    }
    if ($Selector -match '^\d+$') {
        return $Screens | Where-Object { $_.index -eq [int]$Selector } | Select-Object -First 1
    }
    return $Screens | Where-Object { $_.id -eq $Selector -or $_.name -eq $Selector } | Select-Object -First 1
}

function Resolve-DshShotWindowHandle {
    param([string]$Identifier)

    if ($Identifier -match '^win32:(\d+)$') { $handle = [IntPtr]([int64]$Matches[1]) }
    elseif ($Identifier -match '^0x([0-9a-fA-F]+)$') { $handle = [IntPtr][int64][Convert]::ToInt64($Matches[1], 16) }
    elseif ($Identifier -match '^(\d+)$') { $handle = [IntPtr]([int64]$Matches[1]) }
    else {
        Exit-DshShotFailure -Code 'INVALID_ARGUMENT' -Message ("window_id '{0}' is not a Windows window identifier (expected 'win32:<handle>')." -f $Identifier)
    }
    return $handle
}

function New-DshShotBitmap {
    param([int]$Width, [int]$Height)
    return New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
}

function Invoke-DshShotPrintWindow {
    param([IntPtr]$Handle, [int]$Width, [int]$Height, [uint32]$Flags)
    $bitmap = New-DshShotBitmap -Width $Width -Height $Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    try {
        $ok = [DshShotNative]::PrintWindow($Handle, $hdc, $Flags)
    } finally {
        $graphics.ReleaseHdc($hdc)
        $graphics.Dispose()
    }
    return [pscustomobject]@{ ok = [bool]$ok; bitmap = $bitmap }
}

function Invoke-DshShotBitBlt {
    param([IntPtr]$Handle, [int]$Width, [int]$Height)
    $bitmap = New-DshShotBitmap -Width $Width -Height $Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $targetDc = $graphics.GetHdc()
    $sourceDc = [DshShotNative]::GetWindowDC($Handle)
    try {
        if ($sourceDc -eq [IntPtr]::Zero) {
            $ok = $false
        } else {
            $ok = [DshShotNative]::BitBlt($targetDc, 0, 0, $Width, $Height, $sourceDc, 0, 0, $script:DshShotSrcCopy)
        }
    } finally {
        if ($sourceDc -ne [IntPtr]::Zero) { [void][DshShotNative]::ReleaseDC($Handle, $sourceDc) }
        $graphics.ReleaseHdc($targetDc)
        $graphics.Dispose()
    }
    return [pscustomobject]@{ ok = [bool]$ok; bitmap = $bitmap }
}

try {
    # Physical pixels, not DPI-virtualized coordinates.
    [void][DshShotNative]::SetProcessDPIAware()

    $outDirectory = Split-Path -Parent $Out
    if (-not [string]::IsNullOrWhiteSpace($outDirectory) -and -not (Test-Path -LiteralPath $outDirectory)) {
        Exit-DshShotFailure -Code 'OUTPUT_WRITE_FAILED' -Message ("Output directory does not exist: {0}" -f $outDirectory)
    }

    $notes = New-Object System.Collections.ArrayList
    $method = ''
    $captured = $null
    $crop = $null
    $displayInfo = $null
    $windowInfo = $null

    if ($Mode -eq 'screen') {
        $screens = @(Get-DshShotScreens)
        if ($screens.Count -eq 0) {
            Exit-DshShotFailure -Code 'CAPTURE_FAILED' -Message 'No display is available; there may be no interactive desktop session.'
        }

        $target = Resolve-DshShotDisplay -Screens $screens -Selector $Display
        if ($null -eq $target) {
            Exit-DshShotFailure -Code 'DISPLAY_NOT_FOUND' -Message ("No display matches '{0}'. Available indices: {1}." -f $Display, (($screens | ForEach-Object { $_.index }) -join ', '))
        }

        $bounds = $target.bounds
        $bitmap = New-DshShotBitmap -Width $bounds.width -Height $bounds.height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen($bounds.x, $bounds.y, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
        } finally {
            $graphics.Dispose()
        }
        $captured = $bitmap
        $method = 'copyfromscreen'
        $displayInfo = $target
    }
    else {
        if ([string]::IsNullOrWhiteSpace($WindowId)) {
            Exit-DshShotFailure -Code 'INVALID_ARGUMENT' -Message 'window_id is required for a window capture.'
        }

        $handle = Resolve-DshShotWindowHandle -Identifier $WindowId
        if (-not [DshShotNative]::IsWindow($handle)) {
            Exit-DshShotFailure -Code 'WINDOW_NOT_FOUND' -Message ("Window {0} does not exist any more." -f $WindowId)
        }

        $minimized = [DshShotNative]::IsIconic($handle)
        $title = Get-DshShotWindowTitle $handle
        if ([string]::IsNullOrWhiteSpace($title)) { $title = '' }

        $bounds = Get-DshShotWindowBounds -Handle $handle
        if ($null -eq $bounds -or $bounds.width -le 0 -or $bounds.height -le 0) {
            Exit-DshShotFailure -Code 'WINDOW_NOT_CAPTURABLE' -Message ("Window {0} has no usable bounds (it may be hidden or have zero size)." -f $WindowId)
        }

        $pidValue = 0
        [void][DshShotNative]::GetWindowThreadProcessId($handle, [ref]$pidValue)
        $appName = ''
        try { $appName = [string](Get-Process -Id $pidValue -ErrorAction Stop).ProcessName } catch { $appName = '' }

        $windowInfo = [pscustomobject][ordered]@{
            id           = ('win32:{0}' -f $handle.ToInt64())
            title        = [string]$title
            app          = [string]$appName
            pid          = [int]$pidValue
            bounds       = $bounds
            minimized    = [bool]$minimized
            onScreen     = [bool](-not $minimized)
            foreground   = [bool]($handle.ToInt64() -eq [DshShotNative]::GetForegroundWindow().ToInt64())
        }

        if ($minimized) {
            [void]$notes.Add('The window is minimized; the captured content may be unavailable or stale.')
        }

        if ($Strategy -eq 'desktop') {
            if ($minimized) {
                Exit-DshShotFailure -Code 'WINDOW_MINIMIZED' -Message ("Window {0} is minimized, so its desktop rectangle cannot be captured." -f $WindowId)
            }
            [void][DshShotNative]::SetForegroundWindow($handle)
            Start-Sleep -Milliseconds 250
            $bounds = Get-DshShotWindowBounds -Handle $handle
            if ($null -eq $bounds -or $bounds.width -le 0 -or $bounds.height -le 0) {
                Exit-DshShotFailure -Code 'WINDOW_NOT_CAPTURABLE' -Message ("Window {0} lost its bounds before the desktop capture." -f $WindowId)
            }
            $bitmap = New-DshShotBitmap -Width $bounds.width -Height $bounds.height
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.CopyFromScreen($bounds.x, $bounds.y, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
            } finally {
                $graphics.Dispose()
            }
            $captured = $bitmap
            $method = 'desktop-region'
            [void]$notes.Add('Desktop-region capture: anything overlapping the window rectangle is included.')
            $windowInfo.bounds = $bounds
        }
        else {
            $exStyle = Get-DshShotWindowExStyle $handle
            if (($exStyle -band $script:DshShotExNoRedirectionBitmap) -ne 0) {
                [void]$notes.Add('This window has no redirection surface (WS_EX_NOREDIRECTIONBITMAP); native capture usually returns nothing.')
            }

            # GDI renders into, and reads from, a DC whose origin is the *window
            # rectangle*, which includes the invisible resize border. The visible
            # frame is the smaller DWM rectangle, so capture the whole window
            # rectangle here and crop to the visible frame before saving.
            # Without this the image is shifted by the border and shows a strip of
            # it instead of the window's own left and bottom edge.
            $windowRect = Get-DshShotWindowRect -Handle $handle
            if ($null -eq $windowRect -or $windowRect.width -le 0 -or $windowRect.height -le 0) {
                $windowRect = $bounds
            }
            $captureWidth = [int]$windowRect.width
            $captureHeight = [int]$windowRect.height
            $crop = New-Object System.Drawing.Rectangle(
                ([int]($bounds.x - $windowRect.x)),
                ([int]($bounds.y - $windowRect.y)),
                ([int]$bounds.width),
                ([int]$bounds.height))

            $attempt = Invoke-DshShotPrintWindow -Handle $handle -Width $captureWidth -Height $captureHeight -Flags $PW_RENDERFULLCONTENT
            if ($attempt.ok) {
                $captured = $attempt.bitmap
                $method = 'printwindow'
            } else {
                $attempt.bitmap.Dispose()

                $attempt = Invoke-DshShotPrintWindow -Handle $handle -Width $captureWidth -Height $captureHeight -Flags 0
                if ($attempt.ok) {
                    $captured = $attempt.bitmap
                    $method = 'printwindow'
                    [void]$notes.Add('PW_RENDERFULLCONTENT was rejected; captured with PrintWindow flags 0.')
                } else {
                    $attempt.bitmap.Dispose()

                    $attempt = Invoke-DshShotBitBlt -Handle $handle -Width $captureWidth -Height $captureHeight
                    if ($attempt.ok) {
                        $captured = $attempt.bitmap
                        $method = 'bitblt'
                        [void]$notes.Add('PrintWindow was rejected; captured the window DC with BitBlt.')
                    } else {
                        $attempt.bitmap.Dispose()
                        Exit-DshShotFailure -Code 'WINDOW_NOT_CAPTURABLE' -Message ("PrintWindow and BitBlt both failed for window {0}." -f $WindowId)
                    }
                }
            }
        }
    }

    if ($null -eq $captured) {
        Exit-DshShotFailure -Code 'CAPTURE_FAILED' -Message 'The capture produced no bitmap.'
    }

    try {
        $saved = Save-DshShotBitmap -Bitmap $captured -Path $Out -Crop $crop
    } finally {
        $captured.Dispose()
    }

    Write-DshShotJson ([ordered]@{
        ok         = $true
        platform   = 'win32'
        mode       = $Mode
        strategy   = $Strategy
        method     = $method
        path       = $Out
        width      = $saved.width
        height     = $saved.height
        capturedAt = (Get-Date).ToString('o')
        display    = $displayInfo
        window     = $windowInfo
        notes      = @($notes.ToArray())
    })
    exit 0
} catch {
    Exit-DshShotFailure -Code 'CAPTURE_FAILED' -Message ("Capture failed: " + $_.Exception.Message)
}
