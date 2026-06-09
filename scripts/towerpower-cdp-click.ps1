param(
  [Parameter(Mandatory=$true)][string]$ViewportId,
  [Parameter(Mandatory=$true)][int]$StageX,
  [Parameter(Mandatory=$true)][int]$StageY
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

function Receive-Once() {
  $buffer = New-Object byte[] 65536
  $segment = [ArraySegment[byte]]::new($buffer)
  $result = $ws.ReceiveAsync($segment, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  return [Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
}

$expression = "(() => window.TowerPowerDebug.getPaneClientPoint('$ViewportId', { x: $StageX, y: $StageY }))()"
$evalJson = @{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $expression; returnByValue = $true } } | ConvertTo-Json -Compress -Depth 10
Send-Json $evalJson
$evalText = Receive-Once
$evalResponse = $evalText | ConvertFrom-Json
$point = $evalResponse.result.result.value
if (-not $point) {
  throw "Could not resolve click point from Tower Power tab. Raw response: $evalText"
}

$pressJson = @{ id = 2; method = 'Input.dispatchMouseEvent'; params = @{ type = 'mousePressed'; x = [double]$point.clientX; y = [double]$point.clientY; button = 'left'; clickCount = 1 } } | ConvertTo-Json -Compress -Depth 10
$releaseJson = @{ id = 3; method = 'Input.dispatchMouseEvent'; params = @{ type = 'mouseReleased'; x = [double]$point.clientX; y = [double]$point.clientY; button = 'left'; clickCount = 1 } } | ConvertTo-Json -Compress -Depth 10
Send-Json $pressJson
Start-Sleep -Milliseconds 50
Send-Json $releaseJson

$result = @{
  ok = $true
  viewportId = $ViewportId
  stageX = $StageX
  stageY = $StageY
  clientX = $point.clientX
  clientY = $point.clientY
  debuggerPageId = $page.id
}
$result | ConvertTo-Json -Compress -Depth 10

$ws.Dispose()
