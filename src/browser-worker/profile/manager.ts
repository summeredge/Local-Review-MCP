import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext } from "playwright";
import type { BrowserProfileConfig } from "../config.js";

export const BROWSER_AUTH_STATUSES = ["UNKNOWN", "READY", "AUTH_REQUIRED"] as const;
export type BrowserAuthStatus = typeof BROWSER_AUTH_STATUSES[number];

export interface BrowserProfileState {
  readonly profile: string;
  readonly context: "created" | "not_created";
  readonly authStatus: BrowserAuthStatus;
}

export type PersistentContextLauncher = (userDataDir: string) => Promise<BrowserContext>;

function defaultLaunchPersistentContext(userDataDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, { headless: true });
}

export class BrowserProfileManager {
  private readonly launchPersistentContext: PersistentContextLauncher;
  private contextValue: BrowserContext | undefined;
  private browserValue: Browser | undefined;
  private initializing: Promise<BrowserContext> | undefined;

  public constructor(
    public readonly config: BrowserProfileConfig,
    launchPersistentContext: PersistentContextLauncher = defaultLaunchPersistentContext,
  ) {
    this.launchPersistentContext = launchPersistentContext;
  }

  public get profileName(): string {
    return this.config.profileName;
  }

  public get profilePath(): string {
    return this.config.profilePath;
  }

  public get contextInstance(): BrowserContext | undefined {
    return this.contextValue;
  }

  public get browserInstance(): Browser | undefined {
    return this.browserValue;
  }

  public get state(): BrowserProfileState {
    return {
      profile: this.profileName,
      context: this.contextValue === undefined ? "not_created" : "created",
      authStatus: "UNKNOWN",
    };
  }

  public initialize(): Promise<BrowserContext> {
    if (this.contextValue !== undefined) return Promise.resolve(this.contextValue);
    if (this.initializing !== undefined) return this.initializing;

    const promise = this.initializeInternal();
    this.initializing = promise;
    void promise.finally(() => {
      if (this.initializing === promise) this.initializing = undefined;
    }).catch(() => undefined);
    return promise;
  }

  public async close(): Promise<void> {
    await this.initializing?.catch(() => undefined);

    const context = this.contextValue;
    const browser = this.browserValue;
    this.contextValue = undefined;
    this.browserValue = undefined;
    if (context !== undefined) await context.close().catch(() => undefined);
    if (browser !== undefined) await browser.close().catch(() => undefined);
  }

  private async initializeInternal(): Promise<BrowserContext> {
    await mkdir(this.profilePath, { recursive: true });
    const context = await this.launchPersistentContext(this.profilePath);
    this.contextValue = context;
    this.browserValue = context.browser() ?? undefined;
    return context;
  }
}
