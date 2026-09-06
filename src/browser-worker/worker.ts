import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Browser, type BrowserContext } from "playwright";
import { z } from "zod";
import {
  BROWSER_WORKER_SERVICE,
  BROWSER_WORKER_VERSION,
  resolveBrowserWorkerConfig,
  type BrowserWorkerConfigInput,
} from "./config.js";
import { ChatGPTCompletionDetector } from "./completion/detector.js";
import type { ReviewCompletionDetector, ReviewResultExtractor } from "./completion/types.js";
import { ChatGPTResultExtractor } from "./completion/extractor.js";
import { ChatGPTInteraction } from "./interaction/chatgpt-interaction.js";
import { conversationUrl, ConversationNavigator } from "./navigation/conversation-navigator.js";
import type { NavigationSessionResult } from "./navigation/conversation-navigator.js";
import type { BrowserCompletionResult, BrowserDeliveryResult } from "./protocol.js";
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
  readonly interaction?: Pick<ChatGPTInteraction, "submitMessage">;
  readonly completionDetector?: ReviewCompletionDetector;
  readonly resultExtractor?: ReviewResultExtractor;
  readonly completionTimeoutMs?: number;
  readonly completionPollIntervalMs?: number;
}

export const MAX_CONVERSATION_NAVIGATION_REQUEST_BYTES = 16 * 1024;
export const MAX_CONVERSATION_DELIVERY_REQUEST_BYTES = 128 * 1024;
export const MAX_CONVERSATION_COMPLETION_REQUEST_BYTES = 16 * 1024;

const conversationNavigationRequestSchema = z.object({
  conversationId: z.string().min(1).max(256),
}).strict();

const conversationDeliveryRequestSchema = z.object({
  conversationId: z.string().min(1).max(256),
  message: z.string().min(1).max(64 * 1024),
}).strict();

const conversationCompletionRequestSchema = z.object({
  conversationId: z.string().min(1).max(256),
  reviewRequestId: z.string().min(1).max(128),
}).strict();

class RequestBodyTooLargeError extends Error {
  public constructor() {
    super("Browser Worker request body exceeds the maximum allowed size.");
    this.name = "RequestBodyTooLargeError";
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

async function parseJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string"
    && Number.isFinite(Number(contentLength))
    && Number(contentLength) > maxBytes) {
    request.resume();
    throw new RequestBodyTooLargeError();
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      request.resume();
      throw new RequestBodyTooLargeError();
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

function navigationResponse(result: NavigationSessionResult): Record<string, unknown> {
  if (result.status === "NAVIGATED") {
    const { page: _page, ...response } = result;
    return response;
  }
  const { failureCode: _failureCode, ...response } = result;
  return response;
}

function navigationFailureResult(
  conversationId: string,
  result: Extract<NavigationSessionResult, { status: "FAILED" }>,
): BrowserDeliveryResult {
  const status = result.failureCode === "AUTH_REQUIRED"
    ? "AUTH_REQUIRED"
    : result.failureCode === "CONVERSATION_NOT_FOUND"
      ? "CONVERSATION_NOT_FOUND"
      : "SUBMIT_FAILED";
  return {
    conversationId,
    ...(result.url === undefined ? {} : { url: result.url }),
    status,
    error: result.error ?? "Conversation navigation failed.",
  };
}

function completionFailureResult(
  conversationId: string,
  status: Exclude<BrowserCompletionResult["status"], "COMPLETED">,
  error: string,
  url?: string,
): BrowserCompletionResult {
  return {
    conversationId,
    ...(url === undefined ? {} : { url }),
    status,
    error,
  };
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
  private readonly interaction: Pick<ChatGPTInteraction, "submitMessage">;
  private readonly completionDetector: ReviewCompletionDetector;
  private readonly resultExtractor: ReviewResultExtractor;
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
    this.interaction = options.interaction ?? new ChatGPTInteraction();
    this.completionDetector = options.completionDetector ?? new ChatGPTCompletionDetector({
      timeoutMs: options.completionTimeoutMs,
      pollIntervalMs: options.completionPollIntervalMs,
    });
    this.resultExtractor = options.resultExtractor ?? new ChatGPTResultExtractor();
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

    if ((path === "/conversation/navigate"
      || path === "/conversation/deliver"
      || path === "/conversation/completion")
      && request.method !== "POST") {
      request.resume();
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }

    if (request.method === "POST" && path === "/conversation/navigate") {
      void this.handleConversationNavigation(request, response);
      return;
    }

    if (request.method === "POST" && path === "/conversation/deliver") {
      void this.handleConversationDelivery(request, response);
      return;
    }

    if (request.method === "POST" && path === "/conversation/completion") {
      void this.handleConversationCompletion(request, response);
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
      body = await parseJsonBody(request, MAX_CONVERSATION_NAVIGATION_REQUEST_BYTES);
    } catch (error: unknown) {
      sendJson(response, error instanceof RequestBodyTooLargeError ? 413 : 400, {
        status: "FAILED",
        error: error instanceof RequestBodyTooLargeError
          ? "conversation navigation request is too large"
          : "invalid_json_body",
      });
      return;
    }

    const parsed = conversationNavigationRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(response, 400, {
        status: "FAILED",
        error: "conversationId and reviewRequestId must be non-empty strings.",
      });
      return;
    }

    try {
      const result = await this.conversationNavigator.navigate(parsed.data.conversationId);
      const navigation = navigationResponse(result);
      try {
        sendJson(response, result.status === "FAILED" && result.url === undefined ? 400 : 200, navigation);
      } finally {
        if (result.status === "NAVIGATED" && typeof result.page.close === "function") {
          await result.page.close().catch(() => undefined);
        }
      }
    } catch (error: unknown) {
      sendJson(response, 500, {
        status: "FAILED",
        error: errorMessage(error),
      });
    }
  }

  private async handleConversationDelivery(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await parseJsonBody(request, MAX_CONVERSATION_DELIVERY_REQUEST_BYTES);
    } catch (error: unknown) {
      sendJson(response, error instanceof RequestBodyTooLargeError ? 413 : 400, {
        status: "SUBMIT_FAILED",
        error: error instanceof RequestBodyTooLargeError
          ? "conversation delivery request is too large"
          : "invalid_json_body",
      });
      return;
    }

    const parsed = conversationDeliveryRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(response, 400, {
        status: "SUBMIT_FAILED",
        error: "conversationId and a non-empty message are required.",
      });
      return;
    }

    try {
      conversationUrl(parsed.data.conversationId);
    } catch {
      sendJson(response, 400, {
        status: "SUBMIT_FAILED",
        error: "conversationId is invalid.",
      });
      return;
    }

    let navigation: NavigationSessionResult;
    try {
      navigation = await this.conversationNavigator.navigate(parsed.data.conversationId);
    } catch (error: unknown) {
      sendJson(response, 500, {
        status: "SUBMIT_FAILED",
        error: errorMessage(error),
      });
      return;
    }

    if (navigation.status === "FAILED") {
      const result = navigationFailureResult(parsed.data.conversationId, navigation);
      this.updateAuthStatus(result.status);
      sendJson(response, 200, result);
      return;
    }

    try {
      const interaction = await this.interaction.submitMessage(navigation.page, parsed.data.message);
      const result: BrowserDeliveryResult = {
        conversationId: parsed.data.conversationId,
        url: navigation.url,
        ...interaction,
      } as BrowserDeliveryResult;
      this.updateAuthStatus(result.status);
      sendJson(response, 200, result);
    } catch {
      this.profileManager.setAuthStatus("UNKNOWN");
      sendJson(response, 200, {
        conversationId: parsed.data.conversationId,
        url: navigation.url,
        status: "SUBMIT_FAILED",
        error: "ChatGPT review message submission failed.",
      });
    } finally {
      if (typeof navigation.page.close === "function") {
        await navigation.page.close().catch(() => undefined);
      }
    }
  }

  private async handleConversationCompletion(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await parseJsonBody(request, MAX_CONVERSATION_COMPLETION_REQUEST_BYTES);
    } catch (error: unknown) {
      sendJson(response, error instanceof RequestBodyTooLargeError ? 413 : 400, {
        status: "FAILED",
        error: error instanceof RequestBodyTooLargeError
          ? "conversation completion request is too large"
          : "invalid_json_body",
      });
      return;
    }

    const parsed = conversationCompletionRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(response, 400, {
        status: "FAILED",
        error: "conversationId must be a non-empty string.",
      });
      return;
    }

    let navigation: NavigationSessionResult;
    try {
      navigation = await this.conversationNavigator.navigate(parsed.data.conversationId);
    } catch (error: unknown) {
      sendJson(response, 500, completionFailureResult(
        parsed.data.conversationId,
        "FAILED",
        errorMessage(error),
      ));
      return;
    }

    if (navigation.status === "FAILED") {
      if (navigation.failureCode === "AUTH_REQUIRED") {
        this.profileManager.setAuthStatus("AUTH_REQUIRED");
      }
      const result = completionFailureResult(
        parsed.data.conversationId,
        "FAILED",
        navigation.error ?? "Conversation navigation failed.",
        navigation.url,
      );
      sendJson(response, navigation.url === undefined ? 400 : 200, result);
      return;
    }

    let result: BrowserCompletionResult;
    try {
      const detected = await this.completionDetector.waitForCompletion(navigation.page, {
        reviewRequestId: parsed.data.reviewRequestId,
      });
      if (detected.status === "COMPLETED") {
        const extracted = await this.resultExtractor.extract(navigation.page, {
          reviewRequestId: parsed.data.reviewRequestId,
          assistantMessageIndex: detected.assistantMessageIndex,
        });
        if (extracted.status !== "COMPLETED" || extracted.content.trim() === "") {
          throw new Error("ChatGPT assistant response extraction returned no content.");
        }
        result = {
          conversationId: parsed.data.conversationId,
          url: navigation.url,
          status: "COMPLETED",
          content: extracted.content,
          extractedAt: extracted.extractedAt,
        };
      } else if (detected.status === "TIMEOUT" || detected.status === "FAILED") {
        result = completionFailureResult(
          parsed.data.conversationId,
          detected.status,
          detected.error,
          navigation.url,
        );
      } else {
        result = completionFailureResult(
          parsed.data.conversationId,
          "FAILED",
          "Completion detector returned a non-terminal state.",
          navigation.url,
        );
      }
    } catch (error: unknown) {
      result = completionFailureResult(
        parsed.data.conversationId,
        "FAILED",
        errorMessage(error),
        navigation.url,
      );
    } finally {
      if (typeof navigation.page.close === "function") {
        await navigation.page.close().catch(() => undefined);
      }
    }
    sendJson(response, 200, result);
  }

  private updateAuthStatus(status: BrowserDeliveryResult["status"]): void {
    if (status === "AUTH_REQUIRED") this.profileManager.setAuthStatus("AUTH_REQUIRED");
    if (status === "SUBMITTED") this.profileManager.setAuthStatus("READY");
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
