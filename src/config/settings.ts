import { readFile } from "node:fs/promises";

export const DEFAULT_HOST = "127.0.0.1" as const;
export const DEFAULT_PORT = 12080;
export const MCP_PATH = "/mcp" as const;

export interface ResolvedSettings {
  host: typeof DEFAULT_HOST;
  port: number;
}

export interface CliOptions {
  port?: string;
  configPath?: string;
}

interface ConfigFile {
  port?: unknown;
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

export function resolveSettings(options: {
  cliPort?: unknown;
  configPort?: unknown;
} = {}): ResolvedSettings {
  const port = options.cliPort !== undefined
    ? options.cliPort
    : options.configPort !== undefined
      ? options.configPort
      : DEFAULT_PORT;

  return { host: DEFAULT_HOST, port: parsePort(port) };
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--port" || argument === "--config") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--port") options.port = value;
      else options.configPath = value;
      index += 1;
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

export async function loadSettings(argv: readonly string[] = process.argv.slice(2)):
  Promise<ResolvedSettings> {
  const cli = parseCliArgs(argv);
  const config = cli.configPath === undefined ? {} : await readConfigFile(cli.configPath);
  return resolveSettings({ cliPort: cli.port, configPort: config.port });
}

export function endpoint(settings: ResolvedSettings): string {
  return `http://${settings.host}:${settings.port}${MCP_PATH}`;
}
