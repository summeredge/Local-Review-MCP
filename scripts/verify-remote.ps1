[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
[void](Add-Type -AssemblyName System.Net.Http)

function Get-PropertyValue($Object, [string]$Name) {
    if ($null -eq $Object -or $null -eq $Object.PSObject.Properties[$Name]) {
        return $null
    }
    return $Object.PSObject.Properties[$Name].Value
}

function Invoke-RemoteRequest(
    [System.Net.Http.HttpClient]$Client,
    [System.Uri]$Uri,
    [string]$Method,
    [string]$Token,
    [string]$Body
) {
    $request = [System.Net.Http.HttpRequestMessage]::new(
        [System.Net.Http.HttpMethod]::new($Method),
        $Uri
    )
    try {
        $request.Headers.Accept.Add([System.Net.Http.Headers.MediaTypeWithQualityHeaderValue]::new("application/json"))
        $request.Headers.Accept.Add([System.Net.Http.Headers.MediaTypeWithQualityHeaderValue]::new("text/event-stream"))
        if (-not [string]::IsNullOrEmpty($Token)) {
            $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new(
                "Bearer",
                $Token
            )
        }
        if (-not [string]::IsNullOrEmpty($Body)) {
            $request.Content = [System.Net.Http.StringContent]::new(
                $Body,
                [System.Text.Encoding]::UTF8,
                "application/json"
            )
        }
        $response = $Client.SendAsync($request).GetAwaiter().GetResult()
        try {
            return [PSCustomObject]@{
                StatusCode = [int]$response.StatusCode
                Body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            }
        } finally {
            $response.Dispose()
        }
    } finally {
        $request.Dispose()
    }
}

function Get-JsonMessage([string]$Body) {
    $trimmed = $Body.Trim()
    if (-not [string]::IsNullOrWhiteSpace($trimmed)) {
        try {
            return $trimmed | ConvertFrom-Json -ErrorAction Stop
        } catch {
        }
    }

    foreach ($line in ($Body -split "`r?`n")) {
        if (-not $line.StartsWith("data:")) {
            continue
        }
        $data = $line.Substring(5).Trim()
        if ($data -eq "[DONE]" -or [string]::IsNullOrWhiteSpace($data)) {
            continue
        }
        try {
            return $data | ConvertFrom-Json -ErrorAction Stop
        } catch {
        }
    }
    throw "Remote response did not contain a JSON message."
}

function Assert-Status($Response, [int]$Expected, [string]$CheckName) {
    if ($Response.StatusCode -ne $Expected) {
        throw "$CheckName returned HTTP $($Response.StatusCode); expected HTTP $Expected."
    }
}

try {
    $remoteUrl = $env:LOCAL_REVIEW_MCP_REMOTE_URL
    $remoteToken = $env:LOCAL_REVIEW_MCP_REMOTE_TOKEN
    if ([string]::IsNullOrWhiteSpace($remoteUrl)) {
        throw "Set LOCAL_REVIEW_MCP_REMOTE_URL to the deployed Remote MCP endpoint."
    }
    if ([string]::IsNullOrWhiteSpace($remoteToken) -or $remoteToken -match "\s") {
        throw "Set LOCAL_REVIEW_MCP_REMOTE_TOKEN to the deployment token without whitespace."
    }

    try {
        $remoteUri = [System.Uri]::new($remoteUrl)
    } catch {
        throw "LOCAL_REVIEW_MCP_REMOTE_URL must be a valid HTTP(S) URL."
    }
    if (($remoteUri.Scheme -ne "http" -and $remoteUri.Scheme -ne "https") -or $remoteUri.UserInfo -ne "") {
        throw "LOCAL_REVIEW_MCP_REMOTE_URL must be a valid HTTP(S) URL without embedded credentials."
    }
    $healthUri = [System.Uri]::new($remoteUri, "/health")

    $handler = [System.Net.Http.HttpClientHandler]::new()
    if ($remoteUri.IsLoopback) {
        $handler.UseProxy = $false
    }
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [System.TimeSpan]::FromSeconds(15)
    try {
        $unauthenticated = Invoke-RemoteRequest $client $healthUri "GET" "" $null
        Assert-Status $unauthenticated 401 "Unauthenticated health check"

        $wrongToken = "invalid-local-review-token"
        if ($wrongToken -eq $remoteToken) {
            $wrongToken = "invalid-local-review-token-2"
        }
        $wrongAuthentication = Invoke-RemoteRequest $client $healthUri "GET" $wrongToken $null
        Assert-Status $wrongAuthentication 401 "Invalid-token health check"

        $authenticatedHealth = Invoke-RemoteRequest $client $healthUri "GET" $remoteToken $null
        Assert-Status $authenticatedHealth 200 "Authenticated health check"
        $health = Get-JsonMessage $authenticatedHealth.Body
        if ((Get-PropertyValue $health "status") -ne "ok") {
            throw "Authenticated health check did not return status=ok."
        }
        Write-Host "Health: passed (status=ok)"

        $initializeBody = @{
            jsonrpc = "2.0"
            id = 1
            method = "initialize"
            params = @{
                protocolVersion = "2025-06-18"
                capabilities = @{}
                clientInfo = @{ name = "local-review-mcp-verifier"; version = "1.0" }
            }
        } | ConvertTo-Json -Compress -Depth 5
        $initializeResponse = Invoke-RemoteRequest $client $remoteUri "POST" $remoteToken $initializeBody
        Assert-Status $initializeResponse 200 "MCP initialize"
        $initializeMessage = Get-JsonMessage $initializeResponse.Body
        if ($null -eq (Get-PropertyValue $initializeMessage "result")) {
            throw "MCP initialize did not return a result."
        }
        Write-Host "MCP initialize: passed"

        $toolsBody = @{
            jsonrpc = "2.0"
            id = 2
            method = "tools/list"
            params = @{}
        } | ConvertTo-Json -Compress -Depth 5
        $toolsResponse = Invoke-RemoteRequest $client $remoteUri "POST" $remoteToken $toolsBody
        Assert-Status $toolsResponse 200 "tools/list"
        $toolsMessage = Get-JsonMessage $toolsResponse.Body
        $toolsResult = Get-PropertyValue $toolsMessage "result"
        $tools = @(Get-PropertyValue $toolsResult "tools")
        $expectedTools = @(
            "workspace_info",
            "list_files",
            "read_file",
            "search_text",
            "git_status",
            "git_diff",
            "workspace_list"
        )
        $actualTools = @($tools | ForEach-Object { Get-PropertyValue $_ "name" })
        if ($actualTools.Count -ne $expectedTools.Count -or (($actualTools | Sort-Object) -join ",") -ne (($expectedTools | Sort-Object) -join ",")) {
            throw "tools/list returned an unexpected tool surface; expected seven read-only tools."
        }
        Write-Host "tools/list: passed (seven read-only tools)"
        Write-Host "Remote verification passed."
        exit 0
    } finally {
        $client.Dispose()
    }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
