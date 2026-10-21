param(
  [string[]]$Ips = @(),
  [string]$DnsName = "face-collect.local",
  [int]$Days = 825
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$certDir = Join-Path $root "certs"
New-Item -ItemType Directory -Force -Path $certDir | Out-Null

$openssl = "C:\Program Files\Git\usr\bin\openssl.exe"
if (-not (Test-Path $openssl)) {
  $cmd = Get-Command openssl -ErrorAction SilentlyContinue
  if ($cmd) { $openssl = $cmd.Source } else { throw "找不到 openssl。装 Git for Windows 后重试。" }
}

if (-not $Ips -or $Ips.Count -eq 0) {
  $Ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    Select-Object -ExpandProperty IPAddress -Unique
}

$sanParts = @("DNS:localhost", "DNS:$DnsName", "IP:127.0.0.1") + ($Ips | ForEach-Object { "IP:$_" })
$san = ($sanParts -join ",")

Write-Host "生成证书：$san"

& $openssl req -x509 -newkey rsa:2048 -sha256 -nodes `
  -keyout (Join-Path $certDir "server.key") `
  -out (Join-Path $certDir "server.crt") `
  -days $Days `
  -subj "/CN=$DnsName" `
  -addext "subjectAltName=$san" `
  -addext "basicConstraints=critical,CA:FALSE" `
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" `
  -addext "extendedKeyUsage=serverAuth"

if ($LASTEXITCODE -ne 0) { throw "openssl 生成证书失败" }

Write-Host ""
Write-Host "已生成："
Write-Host "  $certDir\server.crt"
Write-Host "  $certDir\server.key"
Write-Host ""
Write-Host "重启服务后会自动监听 HTTPS（默认 https://<本机IP>:8443）。"
Write-Host "注意：自签证书在手机浏览器里会先弹安全警告，且部分浏览器即使点了继续仍会拒绝摄像头；"
Write-Host "      正式给一群人用，建议把应用放到有受信任证书（Let's Encrypt 等）的域名下。"
