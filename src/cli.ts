import { loadSettings, parseCliArgs } from "./config/settings.js";
import { createAppContext, startApp, startupMessage } from "./app.js";
import { createStartupManager } from "./supervisor/startup.js";
import { createSupervisor } from "./supervisor/supervisor.js";
import { WindowsTrayApp } from "./supervisor/tray.js";

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
    await tray.start().catch(() => undefined);
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
