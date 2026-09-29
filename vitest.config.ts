import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runs once per test file, in that file's own worker, before the file is imported. It gives
    // every test file an isolated LRM storage root so a test runtime can never read, reconcile, or
    // write the user's real %LOCALAPPDATA%\LocalReviewMCP state.
    setupFiles: ["./tests/setup/storage-isolation.ts"],
  },
});
