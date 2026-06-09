param(
  [Parameter(Mandatory=$true)][string]$ViewportId,
  [Parameter(Mandatory=$true)][int]$MenuX,
  [Parameter(Mandatory=$true)][int]$MenuY,
  [Parameter(Mandatory=$true)][int]$ActionX,
  [Parameter(Mandatory=$true)][int]$ActionY,
  [Parameter(Mandatory=$true)][int]$CloseX,
  [Parameter(Mandatory=$true)][int]$CloseY,
  [int]$StepDelayMs = 800
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
  $buffer = New-Object byte[] 65536
  while ($true) {
    $segment = [ArraySegment[byte]]::new($buffer)
    $result = $ws.ReceiveAsync($segment, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
    $json = $text | ConvertFrom-Json
    if ($json.id -eq $TargetId) {
      return $text
    }
  }
}

function Get-ClientPoint([int]$Id, [int]$StageX, [int]$StageY) {
  $expression = "(() => window.TowerPowerDebug.getPaneClientPoint('$ViewportId', { x: $StageX, y: $StageY }))()"
  $json = @{ id = $Id; method = 'Runtime.evaluate'; params = @{ expression = $expression; returnByValue = $true } } | ConvertTo-Json -Compress -Depth 10
  Send-Json $json
  $responseText = Receive-UntilId $Id
  $response = $responseText | ConvertFrom-Json
  $point = $response.result.result.value
  if (-not $point) {
    throw "Could not resolve point ($StageX, $StageY). Raw response: $responseText"
  }
  return $point
}

function Click-Point([int]$PressId, [int]$ReleaseId, $Point) {
  $pressJson = @{ id = $PressId; method = 'Input.dispatchMouseEvent'; params = @{ type = 'mousePressed'; x = [double]$Point.clientX; y = [double]$Point.clientY; button = 'left'; clickCount = 1 } } | ConvertTo-Json -Compress -Depth 10
  $releaseJson = @{ id = $ReleaseId; method = 'Input.dispatchMouseEvent'; params = @{ type = 'mouseReleased'; x = [double]$Point.clientX; y = [double]$Point.clientY; button = 'left'; clickCount = 1 } } | ConvertTo-Json -Compress -Depth 10
  Send-Json $pressJson
  $null = Receive-UntilId $PressId
  Start-Sleep -Milliseconds 50
  Send-Json $releaseJson
  $null = Receive-UntilId $ReleaseId
}

$menuPoint = Get-ClientPoint 1 $MenuX $MenuY
$actionPoint = Get-ClientPoint 2 $ActionX $ActionY
$closePoint = Get-ClientPoint 3 $CloseX $CloseY

Click-Point 4 5 $menuPoint
Start-Sleep -Milliseconds $StepDelayMs
Click-Point 6 7 $actionPoint
Start-Sleep -Milliseconds $StepDelayMs
Click-Point 8 9 $closePoint

$result = @{
  ok = $true
  viewportId = $ViewportId
  menuClientX = $menuPoint.clientX
  menuClientY = $menuPoint.clientY
  actionClientX = $actionPoint.clientX
  actionClientY = $actionPoint.clientY
  closeClientX = $closePoint.clientX
  closeClientY = $closePoint.clientY
  debuggerPageId = $page.id
  stepDelayMs = $StepDelayMs
}
$result | ConvertTo-Json -Compress -Depth 10

$ws.Dispose()
