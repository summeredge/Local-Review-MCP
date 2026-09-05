import { createServer, type Server, type ServerResponse } from "node:http";
import { chromium, type Browser } from "playwright";
import {
  BROWSER_WORKER_SERVICE,
  BROWSER_WORKER_VERSION,
  resolveBrowserWorkerConfig,
  type BrowserWorkerConfigInput,
} from "./config.js";

export type BrowserWorkerStatus = "stopped" | "starting" | "ready" | "failed";

export interface BrowserWorkerState {
  readonly status: BrowserWorkerStatus;
  readonly browser: "chromium";
  readonly created_at: string;
  readonly last_error?: string;
}

export type BrowserLauncher = () => Promise<Browser>;

export interface BrowserWorkerOptions extends BrowserWorkerConfigInput {
  readonly launchBrowser?: BrowserLauncher;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 4000);
  return String(error).slice(0, 4000);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(payload));
  response.end(payload);
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function listenServer(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export class BrowserWorker {
  private readonly host: string;
  private readonly configuredPort: number;
  private readonly launchBrowser: BrowserLauncher;
  private readonly createdAt = new Date().toISOString();
  private stateValue: BrowserWorkerState = {
    status: "stopped",
    browser: "chromium",
    created_at: this.createdAt,
  };
  private browserValue: Browser | undefined;
  private server: Server | undefined;
  private starting: Promise<BrowserWorkerState> | undefined;

  public constructor(options: BrowserWorkerOptions = {}) {
    const config = resolveBrowserWorkerConfig(options);
    this.host = config.host;
    this.configuredPort = config.port;
    this.launchBrowser = options.launchBrowser ?? (() => chromium.launch({ headless: true }));
  }

  public get state(): BrowserWorkerState {
    return { ...this.stateValue };
  }

  public get port(): number {
    const address = this.server?.address();
    return address !== null && typeof address === "object" ? address.port : this.configuredPort;
  }

  public get browserInstance(): Browser | undefined {
    return this.browserValue;
  }

  public start(): Promise<BrowserWorkerState> {
    if (this.stateValue.status === "ready") return Promise.resolve(this.state);
    if (this.starting !== undefined) return this.starting;

    this.setState("starting");
    const promise = this.startInternal();
    this.starting = promise;
    void promise.finally(() => {
      if (this.starting === promise) this.starting = undefined;
    }).catch(() => undefined);
    return promise;
  }

  public async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    await this.closeResources();
    this.setState("stopped");
  }

  private async startInternal(): Promise<BrowserWorkerState> {
    console.log("Browser Worker starting");
    try {
      this.browserValue = await this.launchBrowser();
      console.log("Playwright initialized");
      this.server = createServer((request, response) => this.handleRequest(request, response));
      await listenServer(this.server, this.host, this.configuredPort);
      this.setState("ready");
      console.log("Browser Worker ready");
      return this.state;
    } catch (error: unknown) {
      await this.closeResources();
      const reason = errorMessage(error);
      this.setState("failed", reason);
      console.error("Browser Worker failed");
      console.error(`reason:\n${reason}`);
      throw error instanceof Error ? error : new Error(reason);
    }
  }

  private handleRequest(
    request: import("node:http").IncomingMessage,
    response: ServerResponse,
  ): void {
    const path = request.url?.split("?", 1)[0] ?? "/";
    if (path === "/health" || path === "/info") {
      if (request.method !== "GET") {
        request.resume();
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
    }

    if (request.method === "GET" && path === "/health") {
      const ready = this.stateValue.status === "ready";
      sendJson(response, ready ? 200 : 503, {
        status: ready ? "ok" : this.stateValue.status,
        service: BROWSER_WORKER_SERVICE,
        version: BROWSER_WORKER_VERSION,
      });
      return;
    }

    if (request.method === "GET" && path === "/info") {
      const ready = this.stateValue.status === "ready";
      sendJson(response, ready ? 200 : 503, {
        browser: "chromium",
        playwright: true,
      });
      return;
    }

    request.resume();
    sendJson(response, 404, { error: "not_found" });
  }

  private setState(status: BrowserWorkerStatus, lastError?: string): void {
    this.stateValue = {
      status,
      browser: "chromium",
      created_at: this.createdAt,
      ...(lastError === undefined ? {} : { last_error: lastError }),
    };
  }

  private async closeResources(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) await closeServer(server).catch(() => undefined);

    const browser = this.browserValue;
    this.browserValue = undefined;
    if (browser !== undefined) await browser.close().catch(() => undefined);
  }
}
