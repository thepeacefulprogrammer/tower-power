param(
  [Parameter(Mandatory=$true)][string]$ViewportId,
  [Parameter(Mandatory=$true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$targets = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9222/json/list').Content | ConvertFrom-Json
$page = @($targets | Where-Object {
  $_.type -eq 'page' -and $_.url -eq 'http://127.0.0.1:8080/'
})[0]

if (-not $page) {
  throw 'Could not find open Tower Power tab on Edge remote debugger.'
}

$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$null = $ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()

function Send-Json([string]$Json) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Json)
  $segment = [ArraySegment[byte]]::new($bytes)
  $null = $ws.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
}

function Receive-UntilId([int]$TargetId) {
  $buffer = New-Object byte[] 262144
  while ($true) {
    $segment = [ArraySegment[byte]]::new($buffer)
    $builder = New-Object System.Text.StringBuilder
    do {
      $result = $ws.ReceiveAsync($segment, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      if ($result.Count -gt 0) {
        $null = $builder.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count))
      }
    } while (-not $result.EndOfMessage)

    $text = $builder.ToString()
    if (-not $text) {
      continue
    }

    $json = $text | ConvertFrom-Json
    if ($json.id -eq $TargetId) {
      return $json
    }
  }
}

$expression = @"
(() => {
  document.documentElement.setAttribute('data-cdp-capture', 'true');
  const viewport = document.getElementById('$ViewportId');
  const stage = viewport?.querySelector('.pane-stage');
  const debugPoint = window.TowerPowerDebug?.getPaneClientPoint('$ViewportId', { x: 0, y: 0 });
  if (!viewport || !stage || !debugPoint) {
    return null;
  }
  const rect = stage.getBoundingClientRect();
  return {
    viewportId: '$ViewportId',
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    lockedWidth: debugPoint.lockedWidth,
    lockedHeight: debugPoint.lockedHeight,
    stageScale: debugPoint.scale,
    devicePixelRatio: window.devicePixelRatio || 1
  };
})()
"@
$evalJson = @{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $expression; returnByValue = $true } } | ConvertTo-Json -Compress -Depth 20
Send-Json $evalJson
$evalResponse = Receive-UntilId 1
$stage = $evalResponse.result.result.value
if (-not $stage) {
  throw "Could not resolve stage rect for $ViewportId"
}

$directory = Split-Path -Parent $OutputPath
if ($directory -and -not (Test-Path $directory)) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

$captureJson = @{
  id = 2
  method = 'Page.captureScreenshot'
  params = @{
    format = 'png'
    clip = @{
      x = [double]$stage.left
      y = [double]$stage.top
      width = [double]$stage.width
      height = [double]$stage.height
      scale = 1
    }
    fromSurface = $true
    captureBeyondViewport = $true
  }
} | ConvertTo-Json -Compress -Depth 20
Send-Json $captureJson
$captureResponse = Receive-UntilId 2
$data = $captureResponse.result.data
if (-not $data) {
  throw 'Page.captureScreenshot did not return image data.'
}

[IO.File]::WriteAllBytes($OutputPath, [Convert]::FromBase64String($data))

$cleanupJson = @{ id = 3; method = 'Runtime.evaluate'; params = @{ expression = "document.documentElement.removeAttribute('data-cdp-capture')"; returnByValue = $true } } | ConvertTo-Json -Compress -Depth 20
Send-Json $cleanupJson
$null = Receive-UntilId 3

$result = @{
  ok = $true
  viewportId = $ViewportId
  screenshotPath = $OutputPath
  renderedWidth = $stage.width
  renderedHeight = $stage.height
  lockedWidth = $stage.lockedWidth
  lockedHeight = $stage.lockedHeight
  stageScale = $stage.stageScale
  devicePixelRatio = $stage.devicePixelRatio
  debuggerPageId = $page.id
}
$result | ConvertTo-Json -Compress -Depth 20

$ws.Dispose()
