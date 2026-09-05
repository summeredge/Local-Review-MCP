import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const BROWSER_WORKER_SERVICE = "browser-worker" as const;
export const BROWSER_WORKER_VERSION = "0.1" as const;
export const DEFAULT_BROWSER_WORKER_HOST = "127.0.0.1" as const;
export const DEFAULT_BROWSER_WORKER_PORT = 12081;
export const DEFAULT_BROWSER_PROFILE_NAME = "default" as const;

export interface BrowserProfileConfig {
  readonly profileName: string;
  readonly profilePath: string;
}

export interface BrowserWorkerConfigInput {
  readonly host?: string;
  readonly port?: number;
  readonly profileName?: string;
}

export interface BrowserWorkerConfig {
  readonly host: typeof DEFAULT_BROWSER_WORKER_HOST;
  readonly port: number;
  readonly profile: BrowserProfileConfig;
}

export function defaultBrowserProfileRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const home = homedir();
  if (process.platform === "win32") {
    return join(
      environment.LOCALAPPDATA ?? join(home, "AppData", "Local"),
      "LocalReviewMCP",
      "browser-worker",
      "profiles",
    );
  }
  if (process.platform === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "LocalReviewMCP",
      "browser-worker",
      "profiles",
    );
  }
  return join(
    environment.XDG_STATE_HOME ?? join(home, ".local", "state"),
    "LocalReviewMCP",
    "browser-worker",
    "profiles",
  );
}

export function resolveBrowserProfileConfig(
  input: Pick<BrowserWorkerConfigInput, "profileName"> = {},
  environment: NodeJS.ProcessEnv = process.env,
): BrowserProfileConfig {
  const configuredName = input.profileName;
  const profileName = configuredName === undefined
    ? DEFAULT_BROWSER_PROFILE_NAME
    : configuredName;
  if (typeof profileName !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profileName)) {
    throw new Error(
      "Browser Worker profileName must be 1-64 characters using letters, numbers, ., _, or -.",
    );
  }

  const profileRoot = resolve(defaultBrowserProfileRoot(environment));
  const profilePath = resolve(profileRoot, profileName);
  const relativePath = relative(profileRoot, profilePath);
  if (relativePath === "" || relativePath === ".."
    || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    || isAbsolute(relativePath)) {
    throw new Error("Browser Worker profile path must remain inside its managed directory.");
  }

  return { profileName, profilePath };
}

export function resolveBrowserWorkerConfig(
  input: BrowserWorkerConfigInput = {},
  environment: NodeJS.ProcessEnv = process.env,
): BrowserWorkerConfig {
  const host = input.host ?? DEFAULT_BROWSER_WORKER_HOST;
  if (host !== DEFAULT_BROWSER_WORKER_HOST) {
    throw new Error(`Browser Worker only binds to ${DEFAULT_BROWSER_WORKER_HOST}.`);
  }

  const port = input.port ?? DEFAULT_BROWSER_WORKER_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Browser Worker port must be an integer from 0 to 65535: ${String(port)}`);
  }

  return {
    host,
    port,
    profile: resolveBrowserProfileConfig(input, environment),
  };
}
