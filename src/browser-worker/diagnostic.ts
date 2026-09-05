import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BROWSER_WORKER_SERVICE } from "./config.js";

export interface BrowserWorkerDiagnosticResult {
  readonly service: typeof BROWSER_WORKER_SERVICE;
  readonly status: "ready";
  readonly playwright: true;
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Could not determine a free Browser Worker port.");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null
      ? body as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

async function waitForHealth(child: ChildProcess, port: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  const errors: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => errors.push(chunk));
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Browser Worker exited before becoming ready.${errors.join("")}`);
    }
    const health = await fetchJson(`http://127.0.0.1:${port}/health`);
    if (health?.service === BROWSER_WORKER_SERVICE && health.status === "ok") return health;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Browser Worker did not become healthy within 30s.${errors.join("")}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, 2_000);
    child.once("close", finish);
    child.kill("SIGTERM");
  });
}

export async function generateBrowserWorkerExample(): Promise<BrowserWorkerDiagnosticResult> {
  const port = await findFreePort();
  const entry = fileURLToPath(new URL("./cli.js", import.meta.url));
  const child = spawn(process.execPath, [entry, "--port", String(port)], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    await waitForHealth(child, port);
    const info = await fetchJson(`http://127.0.0.1:${port}/info`);
    if (info?.browser !== "chromium" || info.playwright !== true) {
      throw new Error("Browser Worker info check failed.");
    }
    return {
      service: BROWSER_WORKER_SERVICE,
      status: "ready",
      playwright: true,
    };
  } finally {
    await stopChild(child);
  }
}
