# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# One-command setup for a self-hosted openmw-web server, on Windows.
# macOS and Linux have setup.sh next to this file.
#
#   .\setup.ps1            start the server and open the admin dashboard
#   .\setup.ps1 -Update    pull a newer version and restart
#   .\setup.ps1 -Stop      stop everything (your data is kept)
#
# If Windows refuses to run this ("running scripts is disabled"), start it with:
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# Windows PowerShell 5.1 compatible on purpose - that is what ships with Windows, and
# requiring an install before the install would defeat the point.
#
# KEEP THIS FILE PURE ASCII. PowerShell 5.1 reads a .ps1 with no byte-order mark as ANSI,
# not UTF-8, so a single curly quote or em dash arrives as mojibake mid-string and the
# parser then loses track of where the string ends. The failure is reported as an unrelated
# syntax error dozens of lines later, which is a miserable thing to debug on someone else's
# machine. A BOM would also fix it, but BOMs travel badly through diffs and editors.

[CmdletBinding()]
param(
  [switch]$Update,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Write-Step { param($m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Warn { param($m) Write-Host "!  $m" -ForegroundColor Yellow }
function Write-Fail { param($m) Write-Host "x  $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------------------
Write-Step "Checking Docker"

$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCmd) {
  Write-Warn "Docker is not installed."
  Write-Host ""
  Write-Host "Docker Desktop is the only thing you need to install by hand:"
  Write-Host "  https://docs.docker.com/desktop/install/windows-install/"
  Write-Host ""
  Write-Host "It will also set up WSL2, which Docker needs on Windows. Then run this again."
  Start-Process "https://docs.docker.com/desktop/install/windows-install/"
  exit 1
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Fail "Docker is installed but not running. Start Docker Desktop, wait for it to say 'Engine running', then try again."
}

# Compose ships two ways: the v2 plugin (`docker compose`) and the older standalone
# `docker-compose.exe`. Both are still out there, so detect instead of assuming.
docker compose version *> $null
if ($LASTEXITCODE -eq 0) {
  $DC = @('docker', 'compose')
} elseif (Get-Command docker-compose -ErrorAction SilentlyContinue) {
  $DC = @('docker-compose')
  Write-Warn "Using the older docker-compose. It works, but updating Docker Desktop is worth doing."
} else {
  Write-Fail "Docker Compose is missing. Update Docker Desktop."
}
Write-Host "Docker is ready ($($DC -join ' '))."

function Invoke-Compose {
  param([Parameter(ValueFromRemainingArguments = $true)]$Args)
  & $DC[0] @($DC[1..($DC.Count - 1)] + $Args)
}

# ---------------------------------------------------------------------------------------
if ($Stop) {
  Write-Step "Stopping"
  Invoke-Compose down
  Write-Host "Stopped. Your data in .\data is untouched; run .\setup.ps1 to start again."
  exit 0
}

# Docker Desktop on Windows bind-mounts through WSL2, and a drive that has not been shared
# fails at container start with a message that does not name the cause. Say it up front.
$drive = (Get-Item $PSScriptRoot).PSDrive.Name
Write-Host "Project is on drive ${drive}: - if the containers fail to start with a mount error," -ForegroundColor DarkGray
Write-Host "check Docker Desktop > Settings > Resources > File sharing includes this drive." -ForegroundColor DarkGray

# ---------------------------------------------------------------------------------------
Write-Step "Checking ports"

$busy = @()
foreach ($p in 80, 443) {
  $inUse = $null
  try {
    # Get-NetTCPConnection is the reliable one, but it is absent on some editions.
    $inUse = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  } catch {
    $inUse = $null
  }
  if ($inUse) { $busy += $p }
}
if ($busy.Count -gt 0) {
  Write-Warn "Something is already listening on: $($busy -join ', ')"
  Write-Host ""
  Write-Host "That is usually IIS, another web server, or a previous copy of this stack."
  Write-Host "Stop it, or edit docker-compose.yml to use different ports."
  Write-Host ""
  $answer = Read-Host "Try to start anyway? [y/N]"
  if ($answer -notmatch '^[yY]') { exit 1 }
}

# ---------------------------------------------------------------------------------------
Write-Step "Preparing folders"

foreach ($d in 'data', 'gamedata', 'client') {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null }
}

if (-not (Test-Path '.env')) {
  # UTF8 without BOM: a BOM on the first line makes docker compose read the first variable
  # name with an invisible prefix, and it then silently does not apply.
  $envText = @'
# Settings the containers read at startup. Safe to edit; re-run .\setup.ps1 afterwards.

# A domain pointed at this machine, or "localhost" if you do not have one. With a real
# domain you get a real HTTPS certificate automatically; localhost gets a self-signed one.
SERVER_DOMAIN=localhost
# Leave as-is for localhost; blank this line out once you set a real domain above.
TLS_MODE=tls internal

# Object storage for player uploads, only if you choose S3 in the setup wizard.
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
'@
  [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot '.env'), $envText, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "Created .env with default settings."
}

if (-not (Get-ChildItem 'gamedata' -ErrorAction SilentlyContinue)) {
  Write-Warn ".\gamedata is empty."
  Write-Host "   Copy your Morrowind files there (Morrowind.esm and Morrowind.bsa at minimum)."
  Write-Host "   You can do that later - the server will start and tell you what is missing."
}

# ---------------------------------------------------------------------------------------
if ($Update) {
  Write-Step "Updating"
  Invoke-Compose pull
  Invoke-Compose build --pull
} else {
  Write-Step "Building"
  Invoke-Compose build
}

Write-Step "Starting"
Invoke-Compose up -d
if ($LASTEXITCODE -ne 0) { Write-Fail "Could not start the containers. The output above says why." }

# ---------------------------------------------------------------------------------------
Write-Step "Waiting for the server"

# Poll the container's own healthcheck rather than sleeping a fixed amount: a first build on
# a slow machine takes a while, and a fixed wait is either wrong or wasteful.
# WAIT FOR THE DASHBOARD, NOT FOR "healthy". A server with no Morrowind files answers
# /healthz with 503 on purpose - running, but unable to host players - and that is the normal
# state of a first run. Waiting for 'healthy' waits for something that will never happen on
# the very run this script exists to support. So poll what we are about to open instead.
$ready = $false
$configured = $false

# Self-signed certificate by default: accept it for this loopback check only. PowerShell 5.1
# has no -SkipCertificateCheck, so the callback is the available lever.
try {
  Add-Type -TypeDefinition @'
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class OmwCertBypass {
  public static void Enable() {
    ServicePointManager.ServerCertificateValidationCallback =
      delegate(object s, X509Certificate c, X509Chain ch, System.Net.Security.SslPolicyErrors e) { return true; };
    ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
  }
}
'@ -ErrorAction SilentlyContinue
  [OmwCertBypass]::Enable()
} catch { }

for ($i = 0; $i -lt 90; $i++) {
  $running = docker inspect -f '{{.State.Running}}' openmw-web 2>$null
  if ($running -ne 'true') {
    Write-Warn "The server stopped. Its last words:"
    Invoke-Compose logs --tail 30 openmw-web
    Write-Fail "Server did not stay up. The log above says why."
  }
  try {
    $resp = Invoke-WebRequest -Uri 'https://localhost/admin' -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    if ($resp.StatusCode -eq 200) {
      $ready = $true
      $h = docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' openmw-web 2>$null
      if ($h -eq 'healthy') { $configured = $true }
      break
    }
  } catch { }
  Write-Host -NoNewline '.'
  Start-Sleep -Seconds 1
}
Write-Host ''

if (-not $ready) {
  Write-Warn "The dashboard did not come up. Recent log:"
  Invoke-Compose logs --tail 20 openmw-web
  Write-Host ""
  Write-Host "The containers are running, so this may just be slow. Try https://localhost/admin"
  Write-Host "in a moment, or run:  $($DC -join ' ') logs -f openmw-web"
  exit 1
}

# ---------------------------------------------------------------------------------------
$domain = ''
if (Test-Path '.env') {
  $line = Select-String -Path '.env' -Pattern '^SERVER_DOMAIN=(.*)$' -ErrorAction SilentlyContinue
  if ($line) { $domain = $line.Matches[0].Groups[1].Value.Trim() }
}
if ($domain -eq 'localhost') { $domain = '' }
$url = if ($domain) { "https://$domain/admin" } else { 'https://localhost/admin' }

Write-Step "Ready"
Write-Host ""
Write-Host "  Admin dashboard:  $url" -ForegroundColor Green
Write-Host ""
if (-not $configured) {
  Write-Host "  The server is up but has no Morrowind files yet, so players cannot join. That is"
  Write-Host "  expected on a first run - the dashboard walks you through adding them."
  Write-Host ""
}
# The setup key proves whoever claims the first admin account can read this machine's files.
# Passing it in the URL means the documented path never has to go looking for it.
if (Test-Path 'data/setup-token') {
  $setupKey = (Get-Content 'data/setup-token' -Raw).Trim()
  if ($setupKey) {
    $url = "$url#setup=$setupKey"
    Write-Host "  Opening with your one-time setup key. If you need it again it is in"
    Write-Host "  data\setup-token, and in the server log."
    Write-Host ""
  }
}
if (-not $domain) {
  Write-Host "  Your browser will warn that the connection is not private. That is expected -"
  Write-Host "  the certificate is one this server signed itself, because no domain is configured."
  Write-Host "  Click Advanced, then Proceed. Set SERVER_DOMAIN in .env to remove the warning."
  Write-Host ""
}
Write-Host "  The first thing it asks for is an administrator account. After that a short wizard"
Write-Host "  sets the server up. Nothing else needs a terminal."
Write-Host ""
Write-Host "  Logs:    $($DC -join ' ') logs -f openmw-web"
Write-Host "  Stop:    .\setup.ps1 -Stop"
Write-Host "  Update:  .\setup.ps1 -Update"
Write-Host ""

Start-Process $url
