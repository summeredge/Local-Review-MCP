import { readFile } from "node:fs/promises";

export const DEFAULT_HOST = "127.0.0.1" as const;
export const DEFAULT_PORT = 12080;
export const MCP_PATH = "/mcp" as const;
export const HEALTH_PATH = "/health" as const;
export const APP_VERSION = "0.1" as const;
export const DEFAULT_HEALTH_INTERVAL_SECONDS = 30;
export const DEFAULT_MAX_RESTART_ATTEMPTS = 3;
export const MAX_HEALTH_INTERVAL_SECONDS = 2_147_483;

export const REMOTE_PROVIDERS = ["cloudflare"] as const;
export type RemoteProvider = typeof REMOTE_PROVIDERS[number];

export interface AuthSettings {
  readonly token: string;
}

export interface RemoteSettings {
  readonly enabled: boolean;
  readonly provider?: RemoteProvider;
  readonly endpoint?: string;
  readonly tunnelName?: string;
}

export interface SupervisorSettings {
  readonly enabled: boolean;
  readonly healthIntervalSeconds: number;
  readonly maxRestartAttempts: number;
}

export interface ResolvedSettings {
  host: typeof DEFAULT_HOST;
  port: number;
  workspace: string;
  auth: AuthSettings;
  remote: RemoteSettings;
  supervisor: SupervisorSettings;
}

export interface CliOptions {
  port?: string;
  configPath?: string;
  workspace?: string;
  token?: string;
  runtimeOnly?: boolean;
}

interface ConfigFile {
  port?: unknown;
  workspace?: unknown;
  auth?: unknown;
  remote?: unknown;
  supervisor?: unknown;
}

export function parsePort(value: unknown): number {
  const port = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${String(value)}`);
  }

  return port;
}

export function parseWorkspace(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("workspace is required");
  }
  return value;
}

export function parseToken(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || /\s/u.test(value)) {
    throw new Error("auth.token must be a non-empty token without whitespace");
  }
  return value;
}

export function parseRemoteEnabled(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error("remote.enabled must be a boolean");
  return value;
}

export function parseRemoteProvider(value: unknown, enabled = false): RemoteProvider | undefined {
  if (value === undefined) {
    if (enabled) throw new Error("remote.provider is required when remote is enabled");
    return undefined;
  }
  if (typeof value !== "string" || !REMOTE_PROVIDERS.includes(value as RemoteProvider)) {
    throw new Error(`remote.provider must be one of: ${REMOTE_PROVIDERS.join(", ")}`);
  }
  return value as RemoteProvider;
}

export function parseRemoteEndpoint(value: unknown, enabled = false): string {
  if (value === undefined) {
    if (enabled) throw new Error("remote.endpoint is required when remote is enabled");
    return "";
  }
  if (typeof value !== "string") throw new Error("remote.endpoint must be a valid HTTPS URL");

  const endpointValue = value.trim();
  if (endpointValue === "") {
    if (enabled) throw new Error("remote.endpoint is required when remote is enabled");
    return "";
  }

  let parsed: URL;
  try {
    parsed = new URL(endpointValue);
  } catch {
    throw new Error("remote.endpoint must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:"
    || parsed.username !== "" || parsed.password !== "") {
    throw new Error("remote.endpoint must be a valid HTTPS URL");
  }
  return endpointValue;
}

export function parseRemoteTunnelName(value: unknown, enabled = false): string | undefined {
  if (value === undefined) {
    if (enabled) throw new Error("remote.tunnelName is required when remote is enabled");
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "" || /\s/u.test(value)) {
    throw new Error("remote.tunnelName must be a non-empty name or UUID without whitespace");
  }
  return value.trim();
}

export function parseSupervisorEnabled(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error("supervisor.enabled must be a boolean");
  return value;
}

export function parseHealthIntervalSeconds(value: unknown): number {
  if (value === undefined) return DEFAULT_HEALTH_INTERVAL_SECONDS;
  if (!Number.isSafeInteger(value)
    || (value as number) < 1
    || (value as number) > MAX_HEALTH_INTERVAL_SECONDS) {
    throw new Error("supervisor.healthIntervalSeconds must be a positive integer");
  }
  return value as number;
}

export function parseMaxRestartAttempts(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_RESTART_ATTEMPTS;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("supervisor.maxRestartAttempts must be a non-negative integer");
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sectionValue(section: unknown, name: string, key: string): unknown {
  if (section === undefined) return undefined;
  if (!isRecord(section)) throw new Error(`invalid ${name} configuration`);
  return section[key];
}

export function resolveSettings(options: {
  cliPort?: unknown;
  configPort?: unknown;
  cliWorkspace?: unknown;
  configWorkspace?: unknown;
  cliToken?: unknown;
  envToken?: unknown;
  configToken?: unknown;
  configAuth?: unknown;
  configRemoteEnabled?: unknown;
  configRemoteProvider?: unknown;
  configRemoteEndpoint?: unknown;
  configRemoteTunnelName?: unknown;
  envRemoteEndpoint?: unknown;
  configRemote?: unknown;
  configSupervisorEnabled?: unknown;
  configHealthIntervalSeconds?: unknown;
  configMaxRestartAttempts?: unknown;
  configSupervisor?: unknown;
} = {}): ResolvedSettings {
  const port = options.cliPort !== undefined
    ? options.cliPort
    : options.configPort !== undefined
      ? options.configPort
      : DEFAULT_PORT;
  const workspace = options.cliWorkspace !== undefined
    ? options.cliWorkspace
    : options.configWorkspace;
  const resolvedPort = parsePort(port);
  const resolvedWorkspace = parseWorkspace(workspace);
  const configToken = options.configToken !== undefined
    ? options.configToken
    : sectionValue(options.configAuth, "auth", "token");
  const tokenValue = options.cliToken !== undefined
    ? options.cliToken
    : options.envToken !== undefined
      ? options.envToken
      : configToken;
  const enabledValue = options.configRemoteEnabled !== undefined
    ? options.configRemoteEnabled
    : sectionValue(options.configRemote, "remote", "enabled");
  const remoteEnabled = parseRemoteEnabled(enabledValue);
  const remoteProvider = parseRemoteProvider(
    options.configRemoteProvider !== undefined
      ? options.configRemoteProvider
      : sectionValue(options.configRemote, "remote", "provider"),
    remoteEnabled,
  );
  const remoteEndpoint = options.configRemoteEndpoint !== undefined
    ? options.configRemoteEndpoint
    : sectionValue(options.configRemote, "remote", "endpoint")
      ?? (remoteEnabled ? options.envRemoteEndpoint : undefined);
  const remoteTunnelName = options.configRemoteTunnelName !== undefined
    ? options.configRemoteTunnelName
    : sectionValue(options.configRemote, "remote", "tunnelName");
  const parsedRemoteEndpoint = parseRemoteEndpoint(remoteEndpoint, remoteEnabled);
  const parsedRemoteTunnelName = parseRemoteTunnelName(remoteTunnelName, remoteEnabled);
  const supervisorEnabled = options.configSupervisorEnabled !== undefined
    ? options.configSupervisorEnabled
    : sectionValue(options.configSupervisor, "supervisor", "enabled");
  const healthIntervalSeconds = options.configHealthIntervalSeconds !== undefined
    ? options.configHealthIntervalSeconds
    : sectionValue(options.configSupervisor, "supervisor", "healthIntervalSeconds");
  const maxRestartAttempts = options.configMaxRestartAttempts !== undefined
    ? options.configMaxRestartAttempts
    : sectionValue(options.configSupervisor, "supervisor", "maxRestartAttempts");

  return {
    host: DEFAULT_HOST,
    port: resolvedPort,
    workspace: resolvedWorkspace,
    auth: { token: parseToken(tokenValue) },
    remote: {
      enabled: remoteEnabled,
      ...(remoteProvider === undefined ? {} : { provider: remoteProvider }),
      ...(parsedRemoteTunnelName === undefined
        ? {}
        : { tunnelName: parsedRemoteTunnelName }),
      endpoint: parsedRemoteEndpoint,
    },
    supervisor: {
      enabled: parseSupervisorEnabled(supervisorEnabled),
      healthIntervalSeconds: parseHealthIntervalSeconds(healthIntervalSeconds),
      maxRestartAttempts: parseMaxRestartAttempts(maxRestartAttempts),
    },
  };
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--port" || argument === "--config"
      || argument === "--workspace" || argument === "--token") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--port") options.port = value;
      else if (argument === "--config") options.configPath = value;
      else if (argument === "--workspace") options.workspace = value;
      else options.token = value;
      index += 1;
    } else if (argument === "--runtime") {
      options.runtimeOnly = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  return options;
}

export async function readConfigFile(path: string): Promise<ConfigFile> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid config: expected a JSON object");
  }

  return parsed as ConfigFile;
}

export async function loadSettings(
  argv: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
):
  Promise<ResolvedSettings> {
  const cli = parseCliArgs(argv);
  const config = cli.configPath === undefined ? {} : await readConfigFile(cli.configPath);
  return resolveSettings({
    cliPort: cli.port,
    configPort: config.port,
    cliWorkspace: cli.workspace,
    configWorkspace: config.workspace,
    cliToken: cli.token,
    envToken: environment.LOCAL_REVIEW_MCP_TOKEN,
    configAuth: config.auth,
    envRemoteEndpoint: environment.CLOUDFLARE_TUNNEL_ENDPOINT,
    configRemote: config.remote,
    configSupervisor: config.supervisor,
  });
}

export function endpoint(settings: ResolvedSettings): string {
  return `http://${settings.host}:${settings.port}${MCP_PATH}`;
}

export function localOrigin(settings: ResolvedSettings): string {
  return `http://${settings.host}:${settings.port}`;
}
