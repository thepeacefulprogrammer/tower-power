param(
  [int]$Port = 8080,
  [string]$DistroName = "",
  [string]$RuleName = "Tower Power 8080",
  [string]$StatusFile = ""
)

$ErrorActionPreference = 'Stop'

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Status {
  param([string[]]$Lines)

  if ($StatusFile) {
    Set-Content -Path $StatusFile -Value $Lines -Encoding UTF8
  } else {
    $Lines | ForEach-Object { Write-Host $_ }
  }
}

function Get-WslIp {
  param([string]$TargetDistro)

  $arguments = @()
  if ($TargetDistro) {
    $arguments += @('-d', $TargetDistro)
  }
  $arguments += @('bash', '-lc', 'ip -4 -o addr show dev eth0')

  $output = & wsl.exe @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to resolve WSL IP for distro '$TargetDistro'."
  }

  $addresses = ($output -split '\s+') |
    ForEach-Object { ($_ -split '/')[0] } |
    Where-Object {
      $_ -match '^\d+\.\d+\.\d+\.\d+$' -and
      $_ -notlike '127.*' -and
      $_ -notlike '169.254.*'
    }

  $address = $addresses | Select-Object -First 1
  if (-not $address) {
    throw 'Could not find a usable WSL IPv4 address.'
  }

  return $address
}

function Get-LanIps {
  Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254.*' -and
      $_.InterfaceAlias -notmatch 'Loopback|vEthernet|WSL|Hyper-V|Docker'
    } |
    Sort-Object InterfaceMetric, SkipAsSource |
    Select-Object -ExpandProperty IPAddress -Unique
}

if (-not (Test-IsAdministrator)) {
  if (-not $StatusFile) {
    $StatusFile = [System.IO.Path]::GetTempFileName()
  }

  $argumentList = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', ('"' + $PSCommandPath + '"'),
    '-Port', $Port,
    '-StatusFile', ('"' + $StatusFile + '"')
  )
  if ($DistroName) {
    $argumentList += @('-DistroName', ('"' + $DistroName + '"'))
  }
  if ($RuleName) {
    $argumentList += @('-RuleName', ('"' + $RuleName + '"'))
  }

  $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argumentList -Wait -PassThru
  if (Test-Path $StatusFile) {
    Get-Content -Path $StatusFile
    Remove-Item -Path $StatusFile -Force -ErrorAction SilentlyContinue
  }
  exit $process.ExitCode
}

try {
  $wslIp = Get-WslIp -TargetDistro $DistroName

  & netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 | Out-Null
  & netsh interface portproxy add v4tov4 listenport=$Port listenaddress=0.0.0.0 connectport=$Port connectaddress=$wslIp | Out-Null

  $existingRule = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
  if ($existingRule) {
    Set-NetFirewallRule -DisplayName $RuleName -Enabled True -Direction Inbound -Action Allow | Out-Null
  } else {
    New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
  }

  $lanIps = @(Get-LanIps)
  $lines = @(
    'Tower Power phone access is configured.',
    "WSL IP: $wslIp",
    "Port: $Port"
  )
  if ($lanIps.Count -gt 0) {
    $lines += 'Try these URLs from another device on your LAN:'
    foreach ($ip in $lanIps) {
      $lines += "  http://${ip}:$Port"
    }
  } else {
    $lines += 'No LAN IPv4 addresses detected on Windows.'
  }
  Write-Status -Lines $lines
}
catch {
  Write-Status -Lines @("Tower Power phone access setup failed: $($_.Exception.Message)")
  throw
}
