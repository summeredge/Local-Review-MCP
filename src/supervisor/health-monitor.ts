import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  DEFAULT_HEALTH_INTERVAL_SECONDS,
  HEALTH_PATH,
  MAX_HEALTH_INTERVAL_SECONDS,
} from "../config/settings.js";

export const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

export interface HealthMonitorOptions {
  readonly healthUrl: string;
  readonly intervalSeconds?: number;
  readonly timeoutMs?: number;
  readonly check?: () => Promise<boolean>;
}

function validateUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Health URL must be a valid HTTP(S) URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== "") {
    throw new Error("Health URL must be a valid HTTP(S) URL");
  }
  return url;
}

function requestHealth(url: URL, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const requestOptions = {
      hostname: url.hostname,
      ...(url.port === "" ? {} : { port: Number(url.port) }),
      path: `${url.pathname || HEALTH_PATH}${url.search}`,
      method: "GET",
      timeout: timeoutMs,
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      requestOptions,
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    const finish = (): void => {
      request.destroy();
      resolve(false);
    };
    request.once("error", () => resolve(false));
    request.once("timeout", finish);
    request.end();
  });
}

export class HealthMonitor {
  private readonly healthUrl: URL;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly injectedCheck: (() => Promise<boolean>) | undefined;
  private timer: NodeJS.Timeout | undefined;

  public constructor(options: HealthMonitorOptions) {
    this.healthUrl = validateUrl(options.healthUrl);
    const intervalSeconds = options.intervalSeconds ?? DEFAULT_HEALTH_INTERVAL_SECONDS;
    if (!Number.isSafeInteger(intervalSeconds)
      || intervalSeconds < 1
      || intervalSeconds > MAX_HEALTH_INTERVAL_SECONDS) {
      throw new Error("Health interval must be a positive integer");
    }
    this.intervalMs = intervalSeconds * 1000;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("Health timeout must be a positive integer");
    }
    this.injectedCheck = options.check;
  }

  public async check(): Promise<boolean> {
    try {
      return this.injectedCheck === undefined
        ? await requestHealth(this.healthUrl, this.timeoutMs)
        : await this.injectedCheck();
    } catch {
      return false;
    }
  }

  public start(listener: (healthy: boolean) => void | Promise<void>): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.check()
        .then((healthy) => listener(healthy))
        .catch(() => undefined);
    }, this.intervalMs);
  }

  public stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  public get running(): boolean {
    return this.timer !== undefined;
  }

  public get url(): string {
    return this.healthUrl.toString();
  }
}

export { requestHealth };
