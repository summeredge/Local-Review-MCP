import { loadSettings } from "./config/settings.js";
import { startApp, startupMessage } from "./app.js";

try {
  const settings = await loadSettings();
  const server = await startApp(settings);
  console.log(startupMessage(settings));
  const close = (): void => { void server.close(); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
