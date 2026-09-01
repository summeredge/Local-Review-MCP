[CmdletBinding()]
param(
    [string]$Config = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

function Get-ConfigPath([string]$Path) {
    try {
        return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    } catch {
        throw "Production config was not found: $Path"
    }
}

function Get-RequiredProperty($Object, [string]$Name, [string]$Section) {
    if ($null -eq $Object -or $null -eq $Object.PSObject.Properties[$Name]) {
        throw "Production config is missing required field '$Section.$Name'."
    }
    return $Object.PSObject.Properties[$Name].Value
}

function Get-Version([string]$CommandName, [string]$InstallHint) {
    if ($null -eq (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
        throw "$CommandName is required; install it and make '$CommandName --version' available in PATH. $InstallHint"
    }
    try {
        $version = (& $CommandName --version 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($version)) {
            throw "version command failed"
        }
        return $version
    } catch {
        throw "$CommandName is installed but '$CommandName --version' failed. $InstallHint"
    }
}

function Test-PortInUse([string]$HostName, [int]$Port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connection = $client.ConnectAsync($HostName, $Port)
        if ($connection.Wait(250) -and $client.Connected) {
            return $true
        }
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
    return $false
}

try {
    if ([string]::IsNullOrWhiteSpace($Config)) {
        $Config = Join-Path $projectRoot "config.production.json"
    }

    $configPath = Get-ConfigPath $Config
    $configDocument = $null
    try {
        $configDocument = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw "Production config is not valid JSON: $configPath"
    }
    if ($null -eq $configDocument -or $configDocument -is [array]) {
        throw "Production config must be a JSON object: $configPath"
    }

    $nodeVersion = Get-Version "node" "Install Node.js from https://nodejs.org/."
    $npmVersion = Get-Version "npm" "Install npm with Node.js."
    Write-Host "Node.js: $nodeVersion"
    Write-Host "npm: $npmVersion"

    $nodeModules = Join-Path $projectRoot "node_modules"
    if (-not (Test-Path -LiteralPath $nodeModules -PathType Container)) {
        throw "Dependencies are missing: node_modules was not found. Run npm install."
    }
    Write-Host "Dependencies: node_modules found"

    $workspace = Get-RequiredProperty $configDocument "workspace" "config"
    $auth = Get-RequiredProperty $configDocument "auth" "config"
    $remote = Get-RequiredProperty $configDocument "remote" "config"
    $supervisor = Get-RequiredProperty $configDocument "supervisor" "config"
    if ($null -eq $auth -or $auth -is [array]) { throw "Production config field 'auth' must be an object." }
    if ($null -eq $remote -or $remote -is [array]) { throw "Production config field 'remote' must be an object." }
    if ($null -eq $supervisor -or $supervisor -is [array]) { throw "Production config field 'supervisor' must be an object." }

    $configToken = Get-RequiredProperty $auth "token" "auth"
    $token = if ($null -eq $env:LOCAL_REVIEW_MCP_TOKEN) {
        $configToken
    } else {
        $env:LOCAL_REVIEW_MCP_TOKEN
    }
    if ([string]::IsNullOrWhiteSpace([string]$workspace)) {
        throw "Production config field 'workspace' must name an existing directory."
    }
    if ([string]::IsNullOrWhiteSpace([string]$token) -or [string]$token -match "\s") {
        throw "Set auth.token in the local config or LOCAL_REVIEW_MCP_TOKEN, without whitespace; do not commit the token."
    }

    try {
        $workspaceItem = Get-Item -LiteralPath ([string]$workspace) -ErrorAction Stop
        if (-not $workspaceItem.PSIsContainer) {
            throw "not a directory"
        }
        $null = Get-ChildItem -LiteralPath $workspaceItem.FullName -Force -ErrorAction Stop | Select-Object -First 1
    } catch {
        throw "Workspace is missing, not a directory, or not accessible: $workspace"
    }
    Write-Host "Workspace: accessible"

    $portValue = 12080
    if ($null -ne $configDocument.PSObject.Properties["port"]) {
        $portValue = $configDocument.PSObject.Properties["port"].Value
    }
    if ($portValue -is [bool]) {
        throw "Production config field 'port' must be an integer from 1 to 65535."
    }
    try {
        $port = [int]$portValue
    } catch {
        throw "Production config field 'port' must be an integer from 1 to 65535."
    }
    if ($port -lt 1 -or $port -gt 65535 -or [double]$portValue -ne $port) {
        throw "Production config field 'port' must be an integer from 1 to 65535."
    }
    if (Test-PortInUse "127.0.0.1" $port) {
        throw "Port 127.0.0.1:$port is already in use. Change the 'port' value in the Local Review MCP configuration."
    }
    Write-Host "Port: 127.0.0.1:$port available"

    $remoteEnabled = Get-RequiredProperty $remote "enabled" "remote"
    if ($remoteEnabled -isnot [bool]) {
        throw "Production config field 'remote.enabled' must be true or false."
    }
    if ($remoteEnabled) {
        $provider = Get-RequiredProperty $remote "provider" "remote"
        if ([string]$provider -ne "cloudflare") {
            throw "Production config field 'remote.provider' must be cloudflare when remote is enabled."
        }
        $cloudflaredVersion = Get-Version "cloudflared" "Install cloudflared and make 'cloudflared --version' available in PATH."
        Write-Host "Cloudflare Tunnel: $cloudflaredVersion"
    } else {
        Write-Host "Cloudflare Tunnel: disabled"
    }

    Write-Host "Preflight passed."
    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
