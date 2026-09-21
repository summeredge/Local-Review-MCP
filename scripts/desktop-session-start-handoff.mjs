import { runDesktopSessionStartHandoff } from "../dist/src/desktop-codex/desktop-session-start-runner.js";

await runDesktopSessionStartHandoff(process.argv.slice(2));
