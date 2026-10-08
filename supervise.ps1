# Keeps the data server running in a visible console.
#
#   - crash (non-zero exit)      -> restart, with backoff if it keeps dying fast
#   - alive but /health silent   -> kill and restart (a hung process never exits)
#   - Ctrl+C / clean exit (0)    -> stop; the server flushes its archive first
#
# The server's own output stays in this window. Supervisor events (starts,
# crashes, restarts) are also appended to logs\supervisor.log so you can see
# what happened overnight. Started by start-server.cmd at the repo root.

param(
  [int]$Port = 8787,
  [int]$StartupGraceSec = 90,   # store load + first warm-up before health counts
  [int]$HealthEverySec = 30,
  [int]$HealthFailLimit = 3     # consecutive misses before a hung server is killed
)

$ErrorActionPreference = 'Stop'
$serverDir = $PSScriptRoot
$logDir = Join-Path $serverDir 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$logFile = Join-Path $logDir 'supervisor.log'
$healthUrl = "http://127.0.0.1:$Port/health"

function Log([string]$msg, [string]$color = 'Cyan') {
  $line = "[supervisor $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
  Write-Host $line -ForegroundColor $color
  Add-Content -Path $logFile -Value $line
}

function PortHolder {
  $c = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" } else { $null }
}

function Healthy {
  try {
    $r = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
    return ($r.StatusCode -eq 200 -and $r.Content -match '"status":"ok"')
  } catch { return $false }
}

$host.UI.RawUI.WindowTitle = "VibeScreener server :$Port (supervised)"
$env:PORT = "$Port"
$restarts = 0
$quickFails = 0
$proc = $null

try {
  while ($true) {
    # Someone else on the port would make every start die with EADDRINUSE.
    $holder = PortHolder
    if ($holder) {
      Log "port $Port is held by PID $($holder.ProcessId): $($holder.CommandLine) - waiting for it to free up" 'Yellow'
      Start-Sleep -Seconds 10
      continue
    }

    Log "starting server (restart #$restarts) on port $Port" 'Green'
    $started = Get-Date
    $proc = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $serverDir -NoNewWindow -PassThru
    # Windows PowerShell only records ExitCode if the handle is opened now;
    # without this a clean Ctrl+C exit reads as $null and looks like a crash.
    $null = $proc.Handle
    $misses = 0
    $nextCheck = $started.AddSeconds($StartupGraceSec)

    while (-not $proc.HasExited) {
      Start-Sleep -Seconds 2
      if ((Get-Date) -lt $nextCheck) { continue }
      $nextCheck = (Get-Date).AddSeconds($HealthEverySec)
      if (Healthy) { $misses = 0; continue }
      $misses++
      Log "health check failed ($misses/$HealthFailLimit)" 'Yellow'
      if ($misses -ge $HealthFailLimit) {
        Log "server is not answering - killing PID $($proc.Id)" 'Red'
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        $proc.WaitForExit(10000) | Out-Null
      }
    }

    $code = $proc.ExitCode
    $ranFor = [int]((Get-Date) - $started).TotalSeconds
    if ($code -eq 0 -and $misses -lt $HealthFailLimit) {
      Log "server exited cleanly - supervisor stopping" 'Green'
      break
    }

    $restarts++
    # Dying within a minute means something is wrong at startup; back off
    # instead of spinning. A server that ran a while restarts almost at once.
    if ($ranFor -lt 60) { $quickFails++ } else { $quickFails = 0 }
    $delay = if ($quickFails -gt 0) { [Math]::Min(60, 5 * $quickFails) } else { 3 }
    Log "server stopped (exit $code after ${ranFor}s) - restarting in ${delay}s" 'Red'
    Start-Sleep -Seconds $delay
  }
}
finally {
  # Ctrl+C reaches node too; give it time to flush the archive before forcing.
  if ($proc -and -not $proc.HasExited) {
    if (-not $proc.WaitForExit(15000)) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  }
  Log "supervisor exited" 'Cyan'
}
