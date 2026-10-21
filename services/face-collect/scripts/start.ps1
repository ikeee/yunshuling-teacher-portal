param(
  [int]$Port = 8090,
  [int]$HttpsPort = 8443
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:PORT = "$Port"
$env:HTTPS_PORT = "$HttpsPort"

Write-Host "启动 face-collect ..."
node server.js
