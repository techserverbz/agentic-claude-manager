# ---------------------------------------------------------------------------
# New Claude Manager launcher.
#
# Runs the whole app (server 4040, frontend 5200, Excalidraw canvas 4111/5111)
# and ties its lifetime to THIS window. A detached watchdog waits for this
# launcher process to end (window closed, Ctrl+C, or crash) and then kills the
# app's process trees and frees its ports — so NO hidden node/vite instance can
# survive the window closing. Chrome is launched separately and is never killed.
#
# Called by "Start Claude Manager New.bat". Pass -NoBrowser to skip opening Chrome.
# ---------------------------------------------------------------------------
param([switch]$NoBrowser)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$ports = '4040,5200,4111,5111'

# --- 1. Open Chrome once the server is actually serving, detached (own process,
#        never killed). The server now serves the UI + API + WS on ONE port (4040),
#        so we poll /api/health (the first-run / post-update build can take ~a
#        minute) and only then open http://localhost:4040. No Vite to wait on. ---
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not $NoBrowser -and (Test-Path $chrome)) {
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    '-NoProfile','-Command',
    "for(`$i=0;`$i -lt 150;`$i++){ try{ if((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://localhost:4040/api/health').StatusCode -eq 200){break} }catch{}; Start-Sleep 1 }; Start-Process '$chrome' @('--remote-debugging-port=9222','--user-data-dir=C:/Users/Shubham(Code)/ChromeDebug','http://localhost:4040')"
  ) | Out-Null
}

# --- 2. Pre-flight: free the app ports from any earlier instance that lingered. ---
Write-Host "Checking for a running instance..."
$stale = Get-NetTCPConnection -State Listen -LocalPort 4040,5200,4111,5111 -ErrorAction SilentlyContinue |
  Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -eq 'node' } |
  Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $stale) { Write-Host "  Closing existing instance (PID $procId)"; Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
if ($stale) { Start-Sleep -Seconds 2 } else { Write-Host "  None running." }

# --- 3. First-run dependency install (Christopher + the Excalidraw canvas). ---
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host "First run - installing Christopher dependencies..."
  cmd /c "npm install"
}
if (-not (Test-Path (Join-Path $root 'excalidraw-canvas\node_modules'))) {
  Write-Host "First run - installing Excalidraw canvas dependencies..."
  cmd /c "npm --prefix `"$root\excalidraw-canvas`" install"
}

# --- 4. Excalidraw canvas (Vite 5111 + API 4111), hidden. PORT is forced to 4111
#        for the canvas API; the main server ignores PORT (uses COS_PORT/4040), so
#        this cannot affect it. -PassThru gives us the tree root to reap on close. ---
Write-Host "Starting the Excalidraw canvas (5111 / 4111)..."
$env:PORT = '4111'
$canvas = Start-Process cmd -PassThru -WindowStyle Hidden -ArgumentList '/c', "npm --prefix `"$root\excalidraw-canvas`" run dev"
$env:PORT = ''

# --- 5. Build the UI once (first run, or after a git update changed the code) so
#        the SERVER can serve it, then run the app as a SINGLE, STABLE process:
#        `node index.js` — NO --watch, NO Vite, NO concurrently. This is the "26
#        model": a restart-on-file-change or a Vite crash can no longer drop your
#        live terminal sessions (they die only if the server is actually stopped).
#        The build is skipped on plain relaunches (marker == current commit). ---
$head = (& git rev-parse HEAD 2>$null); if (-not $head) { $head = 'nogit' }
$head = $head.Trim()
$distIndex = Join-Path $root 'frontend\dist\index.html'
$marker    = Join-Path $root 'frontend\dist\.built-commit'
$built     = if (Test-Path $marker) { (Get-Content $marker -Raw -ErrorAction SilentlyContinue).Trim() } else { '' }
if ((-not (Test-Path $distIndex)) -or ($built -ne $head)) {
  Write-Host "Building the UI (first run / after an update) - this takes about a minute..."
  cmd /c "npm run build -w frontend"
  if (Test-Path $distIndex) { Set-Content -Path $marker -Value $head -NoNewline }
  else { Write-Host "  !! UI build failed - the app may not load. Check the errors above." }
}
Write-Host "Starting the app (stable single-process server on 4040)..."
$main = Start-Process cmd -PassThru -NoNewWindow -ArgumentList '/c', "npm run start -w server"

# --- 6. Detached watchdog: the moment THIS launcher process ends (window closed,
#        Ctrl+C, or crash), kill the app's process trees and free its ports. This
#        is what guarantees nothing survives the window — it does not depend on job
#        inheritance or console semantics. It runs outside this console so it lives
#        long enough to clean up, then exits. ---
$watch = @"
Wait-Process -Id $PID -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400
cmd /c "taskkill /F /T /PID $($main.Id) >nul 2>&1"
cmd /c "taskkill /F /T /PID $($canvas.Id) >nul 2>&1"
Get-NetTCPConnection -State Listen -LocalPort 4040,5200,4111,5111 -ErrorAction SilentlyContinue |
  Where-Object { (Get-Process -Id `$_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -eq 'node' } |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id `$_ -Force -ErrorAction SilentlyContinue }
"@
Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command', $watch | Out-Null

Write-Host ""
Write-Host "  New Claude Manager"
Write-Host "  UI + server http://localhost:4040   |   MCP claude-manager"
Write-Host "  Canvas http://localhost:5111   |   canvas API 4111"
Write-Host "  Close this window (or Ctrl+C) to stop the ENTIRE app - nothing is left running."
Write-Host ""

# Block here while the app runs; when the window closes this process dies and the
# watchdog reaps everything.
Wait-Process -Id $main.Id -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "  *** Dev server exited. ***"
