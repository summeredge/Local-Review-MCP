import { execFile } from "node:child_process";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")("sets up the trampoline idempotently without exposing secrets or mutating the user environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "trampoline-setup-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "scripts"));
    for (const file of ["src/DesktopBootstrapTrampoline.cs", "scripts/build.ps1", "scripts/setup.ps1"]) {
      await copyFile(resolve("tools/desktop-bootstrap-trampoline", file), join(root, file));
    }
    const script = join(root, "check.ps1");
    await writeFile(script, `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$env:PSModulePath = Join-Path $PSHOME 'Modules'
. (Join-Path $PSScriptRoot 'scripts/setup.ps1')
$env:LOCAL_REVIEW_MCP_TOKEN = $null
$before = [Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', 'User')
$config = [pscustomobject]@{ port = 12345; auth = @{ token = 'setup-test-secret' } }
$setter = { param($Path) if ($Path -ne (Join-Path $PSScriptRoot 'DesktopBootstrapTrampoline.exe')) { throw 'path mismatch' } }
Initialize-DesktopBootstrap -ConfigDocument $config -SetUserCliPath $setter
$file = Join-Path $PSScriptRoot 'trampoline.config.ini'
$mtime = (Get-Item -LiteralPath $file).LastWriteTimeUtc
$contents = [IO.File]::ReadAllText($file)
if ($contents -cne "handoffEnabled=true\nbaseUrl=http://127.0.0.1:12345\nauthToken=setup-test-secret\n") { throw 'config mismatch' }
if (-not (Get-Acl -LiteralPath $file).AreAccessRulesProtected) { throw 'unrestricted config' }
Initialize-DesktopBootstrap -ConfigDocument $config -Root $PSScriptRoot -SetUserCliPath $setter
if ((Get-Item -LiteralPath $file).LastWriteTimeUtc -ne $mtime) { throw 'non-idempotent config' }
$env:LOCAL_REVIEW_MCP_TOKEN = 'replacement-secret'
[IO.File]::AppendAllText($file, "handoffTimeoutSeconds=7\n")
Initialize-DesktopBootstrap -ConfigDocument $config -Root $PSScriptRoot -SetUserCliPath $setter
if (-not [IO.File]::ReadAllText($file).Contains('authToken=replacement-secret')) { throw 'token override mismatch' }
if (-not [IO.File]::ReadAllText($file).Contains('handoffTimeoutSeconds=7')) { throw 'existing options lost' }
$env:LOCAL_REVIEW_MCP_TOKEN = "invalid token"
$rejected = $false
try { Initialize-DesktopBootstrap -ConfigDocument $config -Root $PSScriptRoot -SetUserCliPath $setter } catch { $rejected = $true }
if (-not $rejected) { throw 'invalid token accepted' }
if ([Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', 'User') -ne $before) { throw 'user environment changed' }
$env:LRM_TRAMPOLINE_SELF_CHECK = '1'
& (Join-Path $PSScriptRoot 'DesktopBootstrapTrampoline.exe')
if ($LASTEXITCODE -ne 0) { throw 'trampoline self-check failed' }
Write-Output 'setup-check-passed'
`);
    const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      windowsHide: true, env: { ...process.env, PSModulePath: undefined },
    });
    expect(result.stdout).toContain("setup-check-passed");
    expect(result.stdout + result.stderr).not.toMatch(/setup-test-secret|replacement-secret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
