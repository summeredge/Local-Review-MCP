import { spawn } from "node:child_process";
import { dirname, parse } from "node:path";

// Windows directory handles without FILE_SHARE_DELETE prevent ancestor redirection.
const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class EditDirectoryLease {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool MoveFileEx(string source, string destination, uint flags);
}
'@
$handles = @()
try {
  $paths = ConvertFrom-Json ([Console]::ReadLine())
  foreach ($path in $paths) {
    $handle = [EditDirectoryLease]::CreateFile($path, 2147483648, 3, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
    if ($handle.IsInvalid) { throw 'Cannot lease edit directory' }
    $handles += $handle
  }
  [Console]::WriteLine('READY')
  [Console]::Out.Flush()
  $command = [Console]::ReadLine()
  if ($command) {
    $write = ConvertFrom-Json $command
    try {
      $stream = [System.IO.File]::Open($write.temporary, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      try {
        $bytes = [Convert]::FromBase64String($write.contents)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
      } finally { $stream.Dispose() }
      if (-not [EditDirectoryLease]::MoveFileEx($write.temporary, $write.file, 9)) { throw 'Atomic file replacement failed' }
      [Console]::WriteLine('COMMITTED')
    } finally { if ([System.IO.File]::Exists($write.temporary)) { [System.IO.File]::Delete($write.temporary) } }
  }
} finally { foreach ($handle in $handles) { $handle.Dispose() } }
`;

export async function leaseEditDirectory(file: string): Promise<{ commit(temporary: string, contents: Buffer): Promise<void>; release(): Promise<void> }> {
  if (process.platform !== "win32") throw new Error("Secure editing currently requires Windows directory leases.");
  const directories: string[] = [];
  for (let directory = dirname(file); directory !== parse(directory).root; directory = dirname(directory)) {
    directories.unshift(directory);
  }
  const child = spawn(`${process.env.WINDIR ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  // Fixed helper code; paths are JSON data on stdin, never shell source.
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Directory lease timed out")); }, 15000);
      child.stdout.on("data", () => {
        if (output.includes("READY")) { clearTimeout(timer); resolve(); }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Directory lease failed")); });
      child.stdin.on("error", reject);
      child.stderr.resume();
      child.stdin.write(JSON.stringify(directories) + "\n");
    });
  } catch (error) { child.kill(); await closed; throw error; }
  return {
    async commit(temporary, contents) {
      child.stdin.end(JSON.stringify({ file, temporary, contents: contents.toString("base64") }) + "\n");
      const code = await closed;
      if (code !== 0 || !output.includes("COMMITTED")) throw new Error("Atomic file replacement failed");
    },
    async release() { if (child.exitCode === null) child.stdin.end("\n"); await closed; },
  };
}
