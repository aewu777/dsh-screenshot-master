# Test fixture: a real, visible WinForms window with recognizable content.
#
# Used by tests/windows.integration.test.ts to prove that the plugin captures a
# specific window rather than the desktop rectangle that happens to contain it.
#
# The window is deliberately two-toned (a solid body colour plus a white panel
# with black text) so that it is never mistaken for a blank capture, and so that
# its dominant colour can be asserted after capture.
#
# Prints one JSON line describing the window, then pumps its message loop until
# the process is killed.

param(
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$Color = '#D91BC0',
    [int]$Width = 520,
    [int]$Height = 380,
    [int]$X = 80,
    [int]$Y = 120,
    [switch]$TopMost,
    [switch]$Minimized
)

$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.ClientSize = New-Object System.Drawing.Size($Width, $Height)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.BackColor = [System.Drawing.ColorTranslator]::FromHtml($Color)
$form.TopMost = [bool]$TopMost

$panel = New-Object System.Windows.Forms.Panel
$panel.Location = New-Object System.Drawing.Point(24, 24)
$panel.Size = New-Object System.Drawing.Size([Math]::Max(120, $Width - 48), 84)
$panel.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($panel)

$label = New-Object System.Windows.Forms.Label
$label.Text = 'DSH SCREENSHOT FIXTURE'
$label.ForeColor = [System.Drawing.Color]::Black
$label.Font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(10, 26)
$panel.Controls.Add($label)

$form.add_Shown({
    $info = [ordered]@{
        ready  = $true
        hwnd   = $form.Handle.ToInt64()
        title  = $form.Text
        width  = $form.Width
        height = $form.Height
        pid    = $PID
    }
    [Console]::Out.WriteLine(($info | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
})

$form.Show()

if ($Minimized) {
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
}

while ($true) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 60
}
