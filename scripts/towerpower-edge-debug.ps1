param(
  [ValidateSet('ensure','reset')][string]$Mode = 'ensure'
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class TowerPowerWin32 {
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetWindowPos(
    IntPtr hWnd,
    IntPtr hWndInsertAfter,
    int X,
    int Y,
    int cx,
    int cy,
    uint uFlags
  );
}
"@

$ErrorActionPreference = 'Stop'

$port = 9222
$dir = 'C:\Temp\TowerPowerEdgeDebug'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$url = 'http://127.0.0.1:8080/'
$SW_MAXIMIZE = 3
$SW_RESTORE = 9
$HWND_TOP = [IntPtr]::Zero
$SWP_NOZORDER = 0x0004
$SWP_SHOWWINDOW = 0x0040

function Get-TargetScreen {
  $screens = [System.Windows.Forms.Screen]::AllScreens

  $leftMostNonPrimary = $screens |
    Where-Object { -not $_.Primary } |
    Sort-Object { $_.WorkingArea.X } |
    Select-Object -First 1

  if ($leftMostNonPrimary) {
    return $leftMostNonPrimary
  }

  return ($screens | Where-Object { $_.Primary } | Select-Object -First 1)
}

function Get-WindowPlacement([System.Windows.Forms.Screen]$screen) {
  $wa = $screen.WorkingArea

  return @{
    X = $wa.X
    Y = $wa.Y
    Width = $wa.Width
    Height = $wa.Height
    DeviceName = $screen.DeviceName
    WorkingArea = $wa
  }
}

function Get-TowerPowerEdgeWindow {
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    $window = Get-Process msedge -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like 'Tower Power*' } |
      Select-Object -First 1
    if ($window) {
      return $window
    }
    Start-Sleep -Milliseconds 250
  }
  return $null
}

function Move-WindowToPlacement($window, $placement) {
  $handle = [IntPtr]$window.MainWindowHandle
  [TowerPowerWin32]::ShowWindow($handle, $SW_RESTORE) | Out-Null
  Start-Sleep -Milliseconds 250
  $ok = [TowerPowerWin32]::SetWindowPos(
    $handle,
    $HWND_TOP,
    [int]$placement.X,
    [int]$placement.Y,
    [int]$placement.Width,
    [int]$placement.Height,
    $SWP_NOZORDER -bor $SWP_SHOWWINDOW
  )
  if (-not $ok) {
    throw 'Failed to position Edge window.'
  }
  Start-Sleep -Milliseconds 200
  [TowerPowerWin32]::ShowWindow($handle, $SW_MAXIMIZE) | Out-Null
}

function Open-TowerPowerWindow {
  Start-Process -FilePath $edge -ArgumentList @(
    "--remote-debugging-port=$port",
    "--user-data-dir=$dir",
    '--new-window',
    $url
  ) | Out-Null

  $window = Get-TowerPowerEdgeWindow
  if (-not $window) {
    throw 'Could not find Tower Power Edge window to position.'
  }

  Move-TowerPowerWindow
}

function Move-TowerPowerWindow {
  $screen = Get-TargetScreen
  $placement = Get-WindowPlacement $screen
  $window = Get-TowerPowerEdgeWindow
  if (-not $window) {
    throw 'Could not find Tower Power Edge window to reposition.'
  }
  Move-WindowToPlacement $window $placement
}

function Get-TowerPowerPage {
  try {
    $targets = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 3).Content | ConvertFrom-Json
    return @($targets | Where-Object { $_.type -eq 'page' -and $_.url -eq $url })[0]
  } catch {
    return $null
  }
}

if (!(Test-Path $dir)) {
  New-Item -ItemType Directory -Path $dir | Out-Null
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
  Open-TowerPowerWindow
  Start-Sleep -Seconds 4
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if (-not $listener) {
    throw 'Edge remote debugging did not start on port 9222.'
  }
  Write-Output 'EDGE_DEBUG_STARTED'
  exit 0
}

$towerPowerPage = Get-TowerPowerPage
if ($towerPowerPage) {
  if ($Mode -eq 'reset') {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/json/close/$($towerPowerPage.id)" -TimeoutSec 3 | Out-Null
      Start-Sleep -Seconds 1
    } catch {
    }
    Open-TowerPowerWindow
    Start-Sleep -Seconds 2
    Write-Output 'EDGE_DEBUG_RESET_WINDOW'
    exit 0
  }

  Write-Output 'EDGE_DEBUG_ALREADY_RUNNING'
  exit 0
}

Open-TowerPowerWindow
Start-Sleep -Seconds 2
Write-Output 'EDGE_DEBUG_REUSED_AND_OPENED_WINDOW'
