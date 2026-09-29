import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// A test runtime that inherits the real process environment resolves
// defaultTaskContextStorageRoot() to the user's production directory, on Windows
// %LOCALAPPDATA%\LocalReviewMCP. Startup then runs reconcileOrphanedExecutions() against real
// state and can fail a production Execution this process does not own. Every test file therefore
// gets its own storage root before any test module is imported, so no test can reach production.
//
// Playwright resolves its downloaded Chromium through LOCALAPPDATA, so redirecting it would break
// the Browser Worker tests. PLAYWRIGHT_BROWSERS_PATH takes precedence over that lookup, so when the
// developer or CI has not chosen a browser location the real one is captured first and LOCALAPPDATA
// is then redirected. An explicit PLAYWRIGHT_BROWSERS_PATH always wins and is never overwritten.
const originalLocalAppData = process.env.LOCALAPPDATA;

if (
  process.platform === "win32"
  && process.env.PLAYWRIGHT_BROWSERS_PATH === undefined
  && originalLocalAppData !== undefined
  && originalLocalAppData !== ""
) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(originalLocalAppData, "ms-playwright");
}

const storageBase = mkdtempSync(join(tmpdir(), "lrm-test-storage-"));
const localAppData = join(storageBase, "Local");
const home = join(storageBase, "home");

process.env.LOCALAPPDATA = localAppData;
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.XDG_STATE_HOME = localAppData;

afterAll(() => {
  rmSync(storageBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
