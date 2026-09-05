import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright";
import { BrowserWorker } from "./worker.js";
import { BROWSER_WORKER_SERVICE } from "./config.js";
import { conversationUrl, type NavigationResult } from "./navigation/conversation-navigator.js";

export interface BrowserWorkerDiagnosticResult {
  readonly service: typeof BROWSER_WORKER_SERVICE;
  readonly status: "ready";
  readonly playwright: true;
  readonly profile: string;
  readonly context: "created";
  readonly authStatus: "UNKNOWN";
  readonly navigation: NavigationResult;
  readonly failedNavigation: NavigationResult;
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

async function postNavigation(port: number, conversationId: string): Promise<NavigationResult> {
  const response = await fetch(`http://127.0.0.1:${port}/conversation/navigate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId }),
  });
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) {
    throw new Error("Browser Worker navigation diagnostic returned an invalid response.");
  }
  return body as NavigationResult;
}

async function diagnoseConversationNavigation(): Promise<{
  readonly navigation: NavigationResult;
  readonly failedNavigation: NavigationResult;
}> {
  const requestedUrls: string[] = [];
  const page = {
    goto: async (url: string): Promise<null> => {
      requestedUrls.push(url);
      if (url.endsWith("/diagnostic-failed")) throw new Error("diagnostic navigation failed");
      return null;
    },
    close: async (): Promise<void> => undefined,
  } as unknown as Page;
  const context = {
    browser: () => undefined,
    newPage: async (): Promise<Page> => page,
    close: async (): Promise<void> => undefined,
  } as unknown as BrowserContext;
  const worker = new BrowserWorker({
    port: 0,
    profileName: "diagnostic-navigation",
    launchPersistentContext: async (): Promise<BrowserContext> => context,
  });

  try {
    await worker.start();
    const navigation = await postNavigation(worker.port, "diagnostic-conversation");
    const failedNavigation = await postNavigation(worker.port, "diagnostic-failed");
    if (navigation.status !== "NAVIGATED"
      || navigation.url !== conversationUrl("diagnostic-conversation")
      || requestedUrls[0] !== navigation.url) {
      throw new Error("Browser Worker navigation diagnostic did not navigate to the expected URL.");
    }
    if (failedNavigation.status !== "FAILED"
      || !failedNavigation.error?.includes("diagnostic navigation failed")
      || requestedUrls[1] !== conversationUrl("diagnostic-failed")) {
      throw new Error("Browser Worker navigation diagnostic did not preserve the failed status.");
    }
    return { navigation, failedNavigation };
  } finally {
    await worker.stop();
  }
}

export async function generateBrowserWorkerExample(): Promise<BrowserWorkerDiagnosticResult> {
  const port = await findFreePort();
  const entry = fileURLToPath(new URL("./cli.js", import.meta.url));
  const child = spawn(process.execPath, [entry, "--port", String(port), "--profile", "diagnostic"], {
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
    const profile = await fetchJson(`http://127.0.0.1:${port}/profile`);
    if (profile?.profile !== "diagnostic"
      || profile.context !== "created"
      || profile.authStatus !== "UNKNOWN") {
      throw new Error("Browser Worker profile check failed.");
    }
    const navigation = await diagnoseConversationNavigation();
    return {
      service: BROWSER_WORKER_SERVICE,
      status: "ready",
      playwright: true,
      profile: "diagnostic",
      context: "created",
      authStatus: "UNKNOWN",
      ...navigation,
    };
  } finally {
    await stopChild(child);
  }
}
