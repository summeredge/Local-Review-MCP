function Initialize-DesktopBootstrap {
    param(
        [Parameter(Mandatory = $true)]$ConfigDocument,
        [string]$Root = (Split-Path -Parent $PSScriptRoot),
        [scriptblock]$SetUserCliPath = { param($Path) [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $Path, 'User') }
    )

    $token = if ($null -ne $env:LOCAL_REVIEW_MCP_TOKEN) { $env:LOCAL_REVIEW_MCP_TOKEN } else { [string]$ConfigDocument.auth.token }
    $port = if ($null -eq $ConfigDocument.port) { 12080 } else { [int]$ConfigDocument.port }
    if ([string]::IsNullOrWhiteSpace($token) -or $token -match '\s' -or $port -lt 1 -or $port -gt 65535) {
        throw 'Desktop bootstrap 配置无效。'
    }
    $executable = Join-Path $Root 'DesktopBootstrapTrampoline.exe'
    $source = Join-Path $Root 'src\DesktopBootstrapTrampoline.cs'
    if (-not (Test-Path -LiteralPath $executable) -or
        (Get-Item -LiteralPath $source).LastWriteTimeUtc -gt (Get-Item -LiteralPath $executable).LastWriteTimeUtc) {
        & (Join-Path $Root 'scripts\build.ps1') | Out-Null
    }
    if (-not (Test-Path -LiteralPath $executable)) { throw 'Desktop bootstrap 构建输出缺失。' }
    $configPath = Join-Path $Root 'trampoline.config.ini'
    $preserved = @(if (Test-Path -LiteralPath $configPath) {
        [IO.File]::ReadAllLines($configPath) | Where-Object { $_ -notmatch '^\s*(handoffEnabled|baseUrl|authToken)\s*=' }
    })
    $contents = ((@($preserved) + @('handoffEnabled=true', "baseUrl=http://127.0.0.1:$port", "authToken=$token")) -join "`n") + "`n"
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')))
    if (-not (Test-Path -LiteralPath $configPath) -or
        [IO.File]::ReadAllText($configPath) -cne $contents -or
        -not (Get-Acl -LiteralPath $configPath).AreAccessRulesProtected) {
        # Write a restricted temporary file before publishing the token-bearing config.
        $temporary = Join-Path $Root ('trampoline-' + [Guid]::NewGuid().ToString('N') + '.tmp')
        try {
            [IO.File]::WriteAllText($temporary, '', (New-Object Text.UTF8Encoding($false)))
            Set-Acl -LiteralPath $temporary -AclObject $acl
            [IO.File]::WriteAllText($temporary, $contents, (New-Object Text.UTF8Encoding($false)))
            Move-Item -LiteralPath $temporary -Destination $configPath -Force
        } finally {
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        }
    }
    $executable = [IO.Path]::GetFullPath($executable)
    if ([Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', 'User') -ne $executable) {
        & $SetUserCliPath $executable
        Write-Host 'Desktop bootstrap 已配置；已运行的 Codex Desktop 需完整退出后重新启动以加载环境。'
    }
    $env:CODEX_CLI_PATH = $executable
}
