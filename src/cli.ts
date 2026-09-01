import { loadSettings } from "./config/settings.js";
import { createAppContext, startApp, startupMessage } from "./app.js";

try {
  const settings = await loadSettings();
  const context = createAppContext(settings);
  const server = await startApp(settings, context);
  console.log(startupMessage(settings, context));
  const remote = await context.tunnel.status();
  if (remote.endpoint !== undefined) console.log(`Remote endpoint: ${remote.endpoint}`);
  const close = (): void => { void server.close(); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
