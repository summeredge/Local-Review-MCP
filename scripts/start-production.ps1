[CmdletBinding()]
param(
    [string]$Config = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

try {
    if ([string]::IsNullOrWhiteSpace($Config)) {
        $Config = Join-Path $projectRoot "config.production.json"
    }
    $configPath = (Resolve-Path -LiteralPath $Config -ErrorAction Stop).Path
    $configDocument = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -ErrorAction Stop

    & (Join-Path $PSScriptRoot "preflight-check.ps1") -Config $configPath
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    Write-Host "Starting Local Review MCP..."
    if ($configDocument.supervisor.enabled -eq $true) {
        Write-Host "Supervisor: enabled (started by the Local Review MCP runtime)"
    } else {
        Write-Host "Supervisor: disabled"
    }
    if ($configDocument.remote.enabled -eq $true) {
        Write-Host "Cloudflare Tunnel: enabled (started by the Local Review MCP runtime)"
    } else {
        Write-Host "Cloudflare Tunnel: disabled"
    }

    Push-Location $projectRoot
    try {
        & npm start -- --config $configPath
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($exitCode -ne 0) {
        exit $exitCode
    }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
