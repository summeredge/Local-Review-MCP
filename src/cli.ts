import { loadSettings, parseCliArgs } from "./config/settings.js";
import { createAppContext, startApp, startupMessage } from "./app.js";
import { createStartupManager } from "./supervisor/startup.js";
import { createSupervisor } from "./supervisor/supervisor.js";
import { WindowsTrayApp } from "./supervisor/tray.js";

function printErrorDetails(error: unknown, warning = false): void {
  const log = warning ? console.warn : console.error;
  if (error instanceof Error) {
    log(error.message);
    if (error.stack !== undefined) log(error.stack);
    log("Original error:", error.cause ?? error);
    return;
  }
  log("Original error:", error);
}

try {
  const argv = process.argv.slice(2);
  const cli = parseCliArgs(argv);
  const settings = await loadSettings(argv);
  if (settings.supervisor?.enabled && !cli.runtimeOnly) {
    const supervisor = createSupervisor(settings, { runtimeScript: process.argv[1] });
    const tray = new WindowsTrayApp(supervisor, {
      startupManager: createStartupManager(settings, {
        configPath: cli.configPath,
        runtimeScript: process.argv[1],
      }),
    });
    await supervisor.start();
    void tray.start().catch((error: unknown) => {
      console.warn("Windows tray failed to start; continuing without tray");
      printErrorDetails(error, true);
    });
    console.log(`Local Review MCP supervisor started\nStatus: ${supervisor.state}`);
    let closing = false;
    const close = (): void => {
      if (closing) return;
      closing = true;
      void tray.stop().then(() => supervisor.stop()).catch(() => undefined);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  } else {
    const context = createAppContext(settings);
    const server = await startApp(settings, context);
    console.log(startupMessage(settings, context));
    const remote = await context.tunnel.status();
    if (remote.endpoint !== undefined) console.log(`Remote endpoint: ${remote.endpoint}`);
    const close = (): void => { void server.close(); };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  }
} catch (error: unknown) {
  printErrorDetails(error);
  process.exitCode = 1;
}
