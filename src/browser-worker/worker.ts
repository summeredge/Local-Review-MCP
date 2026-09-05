import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Browser, type BrowserContext } from "playwright";
import { z } from "zod";
import {
  BROWSER_WORKER_SERVICE,
  BROWSER_WORKER_VERSION,
  resolveBrowserWorkerConfig,
  type BrowserWorkerConfigInput,
} from "./config.js";
import { ConversationNavigator } from "./navigation/conversation-navigator.js";
import { BrowserProfileManager, type PersistentContextLauncher } from "./profile/manager.js";

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
  readonly launchPersistentContext?: PersistentContextLauncher;
}

export const MAX_CONVERSATION_NAVIGATION_REQUEST_BYTES = 16 * 1024;

const conversationNavigationRequestSchema = z.object({
  conversationId: z.string().min(1).max(256),
}).strict();

class ConversationNavigationBodyTooLargeError extends Error {
  public constructor() {
    super("Conversation navigation request body exceeds the maximum allowed size.");
    this.name = "ConversationNavigationBodyTooLargeError";
  }
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

async function parseJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string"
    && Number.isFinite(Number(contentLength))
    && Number(contentLength) > MAX_CONVERSATION_NAVIGATION_REQUEST_BYTES) {
    request.resume();
    throw new ConversationNavigationBodyTooLargeError();
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_CONVERSATION_NAVIGATION_REQUEST_BYTES) {
      request.resume();
      throw new ConversationNavigationBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
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
  private readonly profileManager: BrowserProfileManager;
  private readonly conversationNavigator: ConversationNavigator;
  private readonly createdAt = new Date().toISOString();
  private stateValue: BrowserWorkerState = {
    status: "stopped",
    browser: "chromium",
    created_at: this.createdAt,
  };
  private server: Server | undefined;
  private starting: Promise<BrowserWorkerState> | undefined;

  public constructor(options: BrowserWorkerOptions = {}) {
    const config = resolveBrowserWorkerConfig(options);
    this.host = config.host;
    this.configuredPort = config.port;
    const legacyLauncher = options.launchBrowser;
    const launchContext = options.launchPersistentContext
      ?? (legacyLauncher === undefined
        ? undefined
        : async (): Promise<BrowserContext> => (await legacyLauncher()).newContext());
    this.profileManager = new BrowserProfileManager(config.profile, launchContext);
    this.conversationNavigator = new ConversationNavigator(this.profileManager);
  }

  public get state(): BrowserWorkerState {
    return { ...this.stateValue };
  }

  public get port(): number {
    const address = this.server?.address();
    return address !== null && typeof address === "object" ? address.port : this.configuredPort;
  }

  public get browserInstance(): Browser | undefined {
    return this.profileManager.browserInstance;
  }

  public get contextInstance(): BrowserContext | undefined {
    return this.profileManager.contextInstance;
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
      await this.profileManager.initialize();
      console.log("Browser Profile initialized");
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
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const path = request.url?.split("?", 1)[0] ?? "/";
    if (path === "/health" || path === "/info" || path === "/profile") {
      if (request.method !== "GET") {
        request.resume();
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
    }

    if (path === "/conversation/navigate" && request.method !== "POST") {
      request.resume();
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }

    if (request.method === "POST" && path === "/conversation/navigate") {
      void this.handleConversationNavigation(request, response);
      return;
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

    if (request.method === "GET" && path === "/profile") {
      sendJson(response, 200, this.profileManager.state);
      return;
    }

    request.resume();
    sendJson(response, 404, { error: "not_found" });
  }

  private async handleConversationNavigation(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await parseJsonBody(request);
    } catch (error: unknown) {
      sendJson(response, error instanceof ConversationNavigationBodyTooLargeError ? 413 : 400, {
        status: "FAILED",
        error: error instanceof ConversationNavigationBodyTooLargeError
          ? "conversation navigation request is too large"
          : "invalid_json_body",
      });
      return;
    }

    const parsed = conversationNavigationRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(response, 400, {
        status: "FAILED",
        error: "conversationId must be a non-empty string.",
      });
      return;
    }

    try {
      const result = await this.conversationNavigator.navigate(parsed.data.conversationId);
      sendJson(response, result.status === "FAILED" && result.url === undefined ? 400 : 200, result);
    } catch (error: unknown) {
      sendJson(response, 500, {
        status: "FAILED",
        error: errorMessage(error),
      });
    }
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
    await this.profileManager.close();

    const server = this.server;
    this.server = undefined;
    if (server !== undefined) await closeServer(server).catch(() => undefined);
  }
}
