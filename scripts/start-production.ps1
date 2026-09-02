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

    $remoteProperty = $configDocument.PSObject.Properties["remote"]
    $remote = if ($null -eq $remoteProperty) { $null } else { $remoteProperty.Value }
    $remoteEnabled = $false
    if ($null -ne $remote) {
        $enabledProperty = $remote.PSObject.Properties["enabled"]
        $remoteEnabled = $null -ne $enabledProperty -and $enabledProperty.Value -eq $true
    }
    $tunnelMode = $null
    $preflightConfigPath = $configPath
    $temporaryPreflightConfigPath = $null

    if ($remoteEnabled) {
        $hasTunnelName = $null -ne $remote.PSObject.Properties["tunnelName"]
        $hasToken = $null -ne $remote.PSObject.Properties["token"]
        if (-not $hasTunnelName -and -not $hasToken) {
            throw "Production config requires remote.tunnelName or remote.token"
        }
        $tunnelMode = if ($hasToken -and -not $hasTunnelName) { "token" } else { "named" }

        if ($tunnelMode -eq "token") {
            $preflightConfig = $configDocument | ConvertTo-Json -Depth 20 | ConvertFrom-Json
            $preflightRemote = $preflightConfig.PSObject.Properties["remote"].Value
            $preflightRemote | Add-Member -MemberType NoteProperty -Name "tunnelName" -Value "__token_mode__"
            $preflightRemote.PSObject.Properties.Remove("token")

            $preflightAuth = $preflightConfig.PSObject.Properties["auth"].Value
            $preflightAuthToken = if ($null -eq $preflightAuth) {
                $null
            } else {
                $preflightAuth.PSObject.Properties["token"]
            }
            if ($null -ne $preflightAuthToken) {
                $preflightAuthToken.Value = if ([string]::IsNullOrWhiteSpace([string]$preflightAuthToken.Value)) {
                    ""
                } elseif ([string]$preflightAuthToken.Value -match "\s") {
                    "invalid token"
                } else {
                    "preflight-placeholder"
                }
            }

            $temporaryPreflightConfigPath = Join-Path ([System.IO.Path]::GetTempPath()) ("local-review-mcp-preflight-" + [Guid]::NewGuid().ToString("N") + ".json")
            $preflightConfig | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $temporaryPreflightConfigPath -Encoding UTF8 -NoNewline
            $preflightConfigPath = $temporaryPreflightConfigPath
        }
    }

    try {
        & (Join-Path $PSScriptRoot "preflight-check.ps1") -Config $preflightConfigPath
        $preflightExitCode = $LASTEXITCODE
    } finally {
        if ($null -ne $temporaryPreflightConfigPath) {
            Remove-Item -LiteralPath $temporaryPreflightConfigPath -Force -ErrorAction SilentlyContinue
        }
    }
    if ($preflightExitCode -ne 0) {
        exit $preflightExitCode
    }

    Write-Host "Starting Local Review MCP..."
    if ($configDocument.supervisor.enabled -eq $true) {
        Write-Host "Supervisor: enabled (started by the Local Review MCP runtime)"
    } else {
        Write-Host "Supervisor: disabled"
    }
    if ($remoteEnabled) {
        Write-Host "Cloudflare Tunnel mode: $tunnelMode"
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
