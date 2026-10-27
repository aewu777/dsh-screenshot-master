# Shared Win32 interop for the dsh-screenshot-master Windows backend.
#
# Dot-sourced by capture.ps1 and list-windows.ps1. Nothing here writes to the
# pipeline by accident: every helper either returns a value or writes to a
# [void], because a stray object would corrupt the single JSON line each script
# prints for the Node.js side.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ('DshShotNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class DshShotNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int index);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindowDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);

    [DllImport("gdi32.dll")]
    public static extern bool BitBlt(IntPtr hdcDest, int x, int y, int width, int height, IntPtr hdcSrc, int srcX, int srcY, int rop);

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);
}
'@
}

# DWMWA_EXTENDED_FRAME_BOUNDS hides the invisible resize border.
$script:DshShotDwmaExtendedFrameBounds = 9
# DWMWA_CLOAKED marks windows the window server is hiding (other virtual
# desktops, suspended UWP apps).
$script:DshShotDwmaCloaked = 14
# WS_EX_NOREDIRECTIONBITMAP windows have no redirection surface, so neither
# PrintWindow nor BitBlt can read them.
$script:DshShotExNoRedirectionBitmap = 0x00200000
$script:DshShotGwlExStyle = -20
$script:DshShotSrcCopy = 0x00CC0020

function Get-DshShotScaleFactor {
    <# Logical-to-physical pixel scale of the current process DPI context. #>
    try {
        $graphics = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
        $scale = [math]::Round($graphics.DpiX / 96.0, 2)
        $graphics.Dispose()
        if ($scale -gt 0) { return $scale }
    } catch {
        # Fall through to 1.0 rather than failing an enumeration.
    }
    return 1.0
}

function Get-DshShotScreens {
    <#
      .SYNOPSIS
        Enumerate displays in a stable order (left-to-right, then top-to-bottom).
      .DESCRIPTION
        The index reported here is the index accepted by `capture.ps1 -Display`
        and the index returned to the model by list_windows.
    #>
    $scale = Get-DshShotScaleFactor
    $screens = @([System.Windows.Forms.Screen]::AllScreens)
    $ordered = $screens | Sort-Object -Property @{ Expression = { $_.Bounds.X } }, @{ Expression = { $_.Bounds.Y } }

    $result = New-Object System.Collections.ArrayList
    $index = 0
    foreach ($screen in $ordered) {
        $bounds = $screen.Bounds
        [void]$result.Add([pscustomobject][ordered]@{
            index       = $index
            id          = [string]$screen.DeviceName
            name        = [string]$screen.DeviceName
            primary     = [bool]$screen.Primary
            width       = [int]$bounds.Width
            height      = [int]$bounds.Height
            scaleFactor = [double]$scale
            bounds      = [pscustomobject][ordered]@{
                x      = [int]$bounds.X
                y      = [int]$bounds.Y
                width  = [int]$bounds.Width
                height = [int]$bounds.Height
            }
        })
        $index++
    }
    return $result.ToArray()
}

function Get-DshShotWindowTitle {
    param([IntPtr]$Handle)
    $length = [DshShotNative]::GetWindowTextLength($Handle)
    if ($length -le 0) { return '' }
    $builder = New-Object System.Text.StringBuilder ($length + 1)
    [void][DshShotNative]::GetWindowText($Handle, $builder, $builder.Capacity)
    return $builder.ToString()
}

function Get-DshShotWindowClass {
    param([IntPtr]$Handle)
    $builder = New-Object System.Text.StringBuilder 256
    [void][DshShotNative]::GetClassName($Handle, $builder, $builder.Capacity)
    return $builder.ToString()
}

function Test-DshShotWindowCloaked {
    param([IntPtr]$Handle)
    $cloaked = 0
    $hr = [DshShotNative]::DwmGetWindowAttribute($Handle, $script:DshShotDwmaCloaked, [ref]$cloaked, 4)
    return ($hr -eq 0 -and $cloaked -ne 0)
}

function Get-DshShotWindowBounds {
    <#
      .SYNOPSIS
        Visible bounds of a window, preferring the DWM frame that excludes the
        invisible resize border.
    #>
    param([IntPtr]$Handle)

    $rect = New-Object DshShotNative+RECT
    $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'DshShotNative+RECT')
    $hr = [DshShotNative]::DwmGetWindowAttribute($Handle, $script:DshShotDwmaExtendedFrameBounds, [ref]$rect, $size)

    if ($hr -ne 0 -or ($rect.Right - $rect.Left) -le 0 -or ($rect.Bottom - $rect.Top) -le 0) {
        $rect = New-Object DshShotNative+RECT
        if (-not [DshShotNative]::GetWindowRect($Handle, [ref]$rect)) {
            return $null
        }
    }

    return [pscustomobject][ordered]@{
        x      = [int]$rect.Left
        y      = [int]$rect.Top
        width  = [int]($rect.Right - $rect.Left)
        height = [int]($rect.Bottom - $rect.Top)
    }
}

function Get-DshShotWindowExStyle {
    param([IntPtr]$Handle)
    return [DshShotNative]::GetWindowLong($Handle, $script:DshShotGwlExStyle)
}

function Get-DshShotWindowInfo {
    <# Metadata for one window, or $null when it should not be offered. #>
    param(
        [IntPtr]$Handle,
        [int]$ForegroundHandle,
        [object[]]$Screens,
        [hashtable]$ProcessNames
    )

    if (-not [DshShotNative]::IsWindow($Handle)) { return $null }
    if (-not [DshShotNative]::IsWindowVisible($Handle)) { return $null }
    if (Test-DshShotWindowCloaked $Handle) { return $null }

    $bounds = Get-DshShotWindowBounds $Handle
    if ($null -eq $bounds) { return $null }
    if ($bounds.width -le 0 -or $bounds.height -le 0) { return $null }

    $pidValue = 0
    [void][DshShotNative]::GetWindowThreadProcessId($Handle, [ref]$pidValue)
    if ($pidValue -eq 0) { return $null }

    $title = Get-DshShotWindowTitle $Handle
    $className = Get-DshShotWindowClass $Handle

    # Shell plumbing (the taskbar, the desktop, hidden message-only helpers) has
    # no title and cannot be meaningfully captured as "a window".
    if ([string]::IsNullOrWhiteSpace($title)) {
        if ($className -in @('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow')) {
            return $null
        }
    }

    $app = $ProcessNames[[int]$pidValue]
    if ([string]::IsNullOrWhiteSpace($app)) {
        # The process table is not always readable (elevated or sandboxed
        # callers); the window class is still a useful disambiguator.
        if ([string]::IsNullOrWhiteSpace($className)) { $app = "pid $pidValue" }
        else { $app = "pid $pidValue ($className)" }
    }

    $exStyle = Get-DshShotWindowExStyle $Handle
    $minimized = [DshShotNative]::IsIconic($Handle)
    $noRedirectionBitmap = (($exStyle -band $script:DshShotExNoRedirectionBitmap) -ne 0)

    $displayIndex = $null
    if ($null -ne $Screens -and $Screens.Count -gt 0) {
        $centerX = $bounds.x + [int]($bounds.width / 2)
        $centerY = $bounds.y + [int]($bounds.height / 2)
        foreach ($screen in $Screens) {
            $b = $screen.bounds
            if ($centerX -ge $b.x -and $centerX -lt ($b.x + $b.width) -and $centerY -ge $b.y -and $centerY -lt ($b.y + $b.height)) {
                $displayIndex = $screen.index
                break
            }
        }
    }

    return [pscustomobject][ordered]@{
        id                   = ('win32:{0}' -f $Handle.ToInt64())
        handle               = $Handle.ToInt64()
        title                = [string]$title
        app                  = [string]$app
        pid                  = [int]$pidValue
        className            = [string]$className
        bounds               = $bounds
        displayIndex         = $displayIndex
        minimized            = [bool]$minimized
        onScreen             = [bool](-not $minimized)
        foreground           = [bool]($Handle.ToInt64() -eq $ForegroundHandle)
        noRedirectionBitmap  = [bool]$noRedirectionBitmap
    }
}

function Get-DshShotProcessNames {
    param([int[]]$ProcessIds)
    $names = @{}
    foreach ($processId in ($ProcessIds | Sort-Object -Unique)) {
        try {
            $process = Get-Process -Id $processId -ErrorAction Stop
            $names[$processId] = [string]$process.ProcessName
        } catch {
            $names[$processId] = ''
        }
    }
    return $names
}

function Get-DshShotWindows {
    <#
      .SYNOPSIS
        Enumerate visible top-level windows.
      .DESCRIPTION
        Uses EnumWindows, then discards windows the window server is hiding.
        Window titles are never used as identifiers; the HWND is.
    #>
    $screens = @(Get-DshShotScreens)
    $foregroundHandle = [DshShotNative]::GetForegroundWindow().ToInt64()
    $handles = New-Object System.Collections.ArrayList

    $callback = [DshShotNative+EnumWindowsProc] {
        param([IntPtr]$handle, [IntPtr]$lParam)
        try {
            if ([DshShotNative]::IsWindowVisible($handle) -and [DshShotNative]::IsWindow($handle)) {
                [void]$handles.Add($handle)
            }
        } catch {
            # A single misbehaving window must not abort the enumeration.
        }
        return $true
    }
    [void][DshShotNative]::EnumWindows($callback, [IntPtr]::Zero)

    $pids = New-Object System.Collections.ArrayList
    foreach ($handle in $handles) {
        $processId = 0
        [void][DshShotNative]::GetWindowThreadProcessId($handle, [ref]$processId)
        if ($processId -gt 0) {
            [void]$pids.Add([int]$processId)
        }
    }

    $names = Get-DshShotProcessNames -ProcessIds @($pids.ToArray())

    $windows = New-Object System.Collections.ArrayList
    foreach ($handle in $handles) {
        $info = Get-DshShotWindowInfo -Handle $handle -ForegroundHandle $foregroundHandle -Screens $screens -ProcessNames $names
        if ($null -ne $info) { [void]$windows.Add($info) }
    }
    return $windows.ToArray()
}

function Save-DshShotBitmap {
    <#
      .SYNOPSIS
        Write a captured bitmap to PNG as opaque 24-bit RGB.
      .DESCRIPTION
        The conversion copies pixels and ignores the source alpha channel.

        Every GDI capture API used here (CopyFromScreen, PrintWindow, BitBlt)
        leaves the alpha byte of a 32bpp destination undefined: a freshly created
        Format32bppArgb bitmap starts at ARGB(0,0,0,0), GDI writes only the colour
        bytes, and any region that was never painted keeps alpha 0 with black RGB.
        Blending such a pixel over a background therefore invents colour that was
        never rendered - a dark pixel with alpha 0 turns into pure white. That is
        a capture artifact, not image content.

        `Bitmap.Clone` performs a format conversion only; it does not composite,
        so the colour values that GDI actually produced are preserved and the
        meaningless alpha byte is dropped.
    #>
    param(
        [System.Drawing.Bitmap]$Bitmap,
        [string]$Path
    )

    $width = $Bitmap.Width
    $height = $Bitmap.Height
    $targetFormat = [System.Drawing.Imaging.PixelFormat]::Format24bppRgb

    if ($Bitmap.PixelFormat -eq $targetFormat) {
        $owned = $false
        $output = $Bitmap
    } else {
        $rect = New-Object System.Drawing.Rectangle(0, 0, $width, $height)
        $output = $Bitmap.Clone($rect, $targetFormat)
        $owned = $true
    }

    try {
        $output.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        if ($owned) { $output.Dispose() }
    }

    return [pscustomobject][ordered]@{ width = $width; height = $height }
}

function Write-DshShotJson {
    param([object]$Payload)
    ($Payload | ConvertTo-Json -Depth 12 -Compress)
}

function Exit-DshShotFailure {
    param([string]$Code, [string]$Message)
    Write-DshShotJson ([ordered]@{
        ok     = $false
        error  = [ordered]@{ code = $Code; message = $Message }
    })
    exit 1
}
