# Test fixture: a borderless window painted with a fully deterministic pattern.
#
# Used by the capture-pipeline regression tests. The window has no border or
# title bar, so a window capture is exactly the client area and every captured
# pixel has a known expected value.
#
# Pattern layout (default 320x240):
#   y   0..39   solid dark #101010, a 1px white rectangle outline, white text
#   y  40..79   solid light #F0F0F0
#   y  80..119  horizontal gradient  (x=0 -> #0000FF, x=W-1 -> #FF0000)
#   y 120..159  1px checkerboard alternating #FFFFFF / #000000
#   y 160..199  1px vertical white lines every 4px on #101010
#   y 200..239  8 colour swatches of W/8 px: red, green, blue, white, black,
#               magenta, cyan, yellow
#
# The fixture also writes the exact bitmap it displays to -ExpectedPath, so a
# test can compare captured pixels against the application's own rendering.

param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$ExpectedPath,
    [int]$Width = 320,
    [int]$Height = 240,
    [int]$X = 200,
    [int]$Y = 150,
    # Give the window a normal title bar and resize border. The window rectangle
    # then differs from the visible DWM frame by the invisible resize border,
    # which is exactly the situation the crop in capture.ps1 has to handle.
    [switch]$Bordered,
    # Optional path for a JSON description of the window and client geometry.
    [string]$GeometryPath = ''
)

$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# Keep the window at a 1:1 pixel size on high-DPI displays so that a capture can
# be compared against the rendered bitmap pixel for pixel.
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class PatternDpi
{
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}
'@

[void][PatternDpi]::SetProcessDPIAware()

$bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

# Fill the pattern through the raw BGRA buffer: unambiguous and fast.
$stride = $Width * 4
$pixels = New-Object byte[] ($stride * $Height)

$swatches = @(
    @(255, 0, 0), @(0, 255, 0), @(0, 0, 255), @(255, 255, 255),
    @(0, 0, 0), @(255, 0, 255), @(0, 255, 255), @(255, 255, 0)
)

for ($y = 0; $y -lt $Height; $y += 1) {
    $rowStart = $y * $stride
    for ($x = 0; $x -lt $Width; $x += 1) {
        if ($y -lt 40) {
            $r = 16; $g = 16; $b = 16
        } elseif ($y -lt 80) {
            $r = 240; $g = 240; $b = 240
        } elseif ($y -lt 120) {
            $r = [int][Math]::Round($x * 255 / ($Width - 1)); $g = 0; $b = 255 - $r
        } elseif ($y -lt 160) {
            if ((($x + $y) % 2) -eq 0) { $r = 255; $g = 255; $b = 255 } else { $r = 0; $g = 0; $b = 0 }
        } elseif ($y -lt 200) {
            if (($x % 4) -eq 0) { $r = 255; $g = 255; $b = 255 } else { $r = 16; $g = 16; $b = 16 }
        } else {
            $swatch = [int][Math]::Floor($x * 8 / $Width)
            if ($swatch -gt 7) { $swatch = 7 }
            $entry = $swatches[$swatch]
            $r = $entry[0]; $g = $entry[1]; $b = $entry[2]
        }
        $i = $rowStart + $x * 4
        $pixels[$i] = [byte]$b
        $pixels[$i + 1] = [byte]$g
        $pixels[$i + 2] = [byte]$r
        $pixels[$i + 3] = [byte]255
    }
}

$rect = New-Object System.Drawing.Rectangle(0, 0, $Width, $Height)
$locked = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
    [System.Runtime.InteropServices.Marshal]::Copy($pixels, 0, $locked.Scan0, $pixels.Length)
} finally {
    $bitmap.UnlockBits($locked)
}

# 1px white rectangle outline and high-contrast text inside the dark band.
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $whitePen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 1)
    $graphics.DrawRectangle($whitePen, 8, 8, $Width - 17, 23)
    $whitePen.Dispose()

    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $font = New-Object System.Drawing.Font('Consolas', 11, [System.Drawing.FontStyle]::Bold)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $graphics.DrawString('PIXEL-EXACT 0123456789', $font, $brush, 12, 13)
    $font.Dispose()
    $brush.Dispose()
} finally {
    $graphics.Dispose()
}

$bitmap.Save($ExpectedPath, [System.Drawing.Imaging.ImageFormat]::Png)

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.ClientSize = New-Object System.Drawing.Size($Width, $Height)
$form.BackColor = [System.Drawing.Color]::Black
$form.BackgroundImage = $bitmap
$form.BackgroundImageLayout = [System.Windows.Forms.ImageLayout]::None
$form.TopMost = $true
if ($Bordered) {
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::Sizable
} else {
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
}

$form.add_Shown({
    $origin = $form.PointToScreen([System.Drawing.Point]::Empty)
    $info = [ordered]@{
        ready       = $true
        hwnd        = $form.Handle.ToInt64()
        title       = $form.Text
        width       = $Width
        height      = $Height
        x           = $X
        y           = $Y
        bordered    = [bool]$Bordered
        clientX     = $origin.X
        clientY     = $origin.Y
        clientWidth = $form.ClientSize.Width
        clientHeight = $form.ClientSize.Height
        windowX     = $form.Left
        windowY     = $form.Top
        windowWidth = $form.Width
        windowHeight = $form.Height
    }
    if (-not [string]::IsNullOrWhiteSpace($GeometryPath)) {
        $json = $info | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText(
            $GeometryPath,
            $json,
            (New-Object System.Text.UTF8Encoding($false))
        )
    }
    [Console]::Out.WriteLine(($info | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
})

$form.Show()

while ($true) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 60
}
