# Regression fixture: exercise the production PNG conversion with a bitmap whose
# alpha channel is deliberately meaningless.
#
# GDI capture buffers carry an undefined alpha byte: 0 wherever nothing was
# painted. The production conversion must ignore that byte and keep the colour
# values, because compositing over any background would invent pixels.
#
# Writes the converted PNG to -Out and prints the source pixels as JSON so a test
# can compare them with the decoded PNG.

param(
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$NativeScript = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($NativeScript)) {
    $NativeScript = Join-Path $PSScriptRoot '..\..\src\platforms\scripts\windows\native.ps1'
}

. (Resolve-Path $NativeScript)

Add-Type -AssemblyName System.Drawing

# BGRA samples: the alpha byte is intentionally wrong in several ways.
$samples = @(
    @(10, 20, 30, 0),    # opaque-looking colour but alpha 0  -> must stay 10,20,30
    @(40, 50, 60, 0),    # alpha 0                            -> must stay 40,50,60
    @(0, 0, 0, 0),       # unpainted region                   -> must stay black, NOT white
    @(255, 255, 255, 255),
    @(16, 16, 16, 0),    # the exact case that used to become pure white
    @(255, 0, 0, 255),
    @(0, 255, 0, 128),   # semi-transparent                  -> colour must survive
    @(1, 2, 3, 7),       # nonsense alpha                    -> colour must survive
    @(200, 200, 200, 0),
    @(0, 0, 0, 255),
    @(128, 64, 32, 64),
    @(250, 240, 230, 1)
)

$width = 4
$height = 3
$format = [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
$bitmap = New-Object System.Drawing.Bitmap($width, $height, $format)

$rect = New-Object System.Drawing.Rectangle(0, 0, $width, $height)
$locked = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $format)
try {
    $bytes = New-Object byte[] ($width * $height * 4)
    for ($i = 0; $i -lt $samples.Count; $i += 1) {
        $b, $g, $r, $a = $samples[$i]
        $offset = $i * 4
        $bytes[$offset] = [byte]$b
        $bytes[$offset + 1] = [byte]$g
        $bytes[$offset + 2] = [byte]$r
        $bytes[$offset + 3] = [byte]$a
    }
    [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $locked.Scan0, $bytes.Length)
} finally {
    $bitmap.UnlockBits($locked)
}

$info = Save-DshShotBitmap -Bitmap $bitmap -Path $Out
$bitmap.Dispose()

$expected = @()
foreach ($sample in $samples) {
    $expected += , @($sample[2], $sample[1], $sample[0])
}

[ordered]@{
    ok       = $true
    width    = $info.width
    height   = $info.height
    expected = $expected
} | ConvertTo-Json -Depth 5 -Compress
