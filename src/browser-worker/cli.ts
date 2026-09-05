import { fileURLToPath } from "node:url";
import { BrowserWorker } from "./worker.js";

interface BrowserWorkerCliOptions {
  readonly host?: string;
  readonly port?: number;
  readonly profileName?: string;
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function parseArgs(args: readonly string[]): BrowserWorkerCliOptions {
  const options: { host?: string; port?: number; profileName?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--host") {
      options.host = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--port") {
      options.port = Number(requiredValue(args, index, arg));
      index += 1;
    } else if (arg === "--profile") {
      options.profileName = requiredValue(args, index, arg);
      index += 1;
    } else {
      throw new Error(`Unknown Browser Worker option: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  let worker: BrowserWorker | undefined;
  try {
    worker = new BrowserWorker(parseArgs(process.argv.slice(2)));
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void worker?.stop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await worker.start();
  } catch (error: unknown) {
    if (worker?.state.status !== "failed") {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
