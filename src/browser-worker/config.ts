export const BROWSER_WORKER_SERVICE = "browser-worker" as const;
export const BROWSER_WORKER_VERSION = "0.1" as const;
export const DEFAULT_BROWSER_WORKER_HOST = "127.0.0.1" as const;
export const DEFAULT_BROWSER_WORKER_PORT = 12081;

export interface BrowserWorkerConfigInput {
  readonly host?: string;
  readonly port?: number;
}

export interface BrowserWorkerConfig {
  readonly host: typeof DEFAULT_BROWSER_WORKER_HOST;
  readonly port: number;
}

export function resolveBrowserWorkerConfig(
  input: BrowserWorkerConfigInput = {},
): BrowserWorkerConfig {
  const host = input.host ?? DEFAULT_BROWSER_WORKER_HOST;
  if (host !== DEFAULT_BROWSER_WORKER_HOST) {
    throw new Error(`Browser Worker only binds to ${DEFAULT_BROWSER_WORKER_HOST}.`);
  }

  const port = input.port ?? DEFAULT_BROWSER_WORKER_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Browser Worker port must be an integer from 0 to 65535: ${String(port)}`);
  }

  return { host, port };
}
