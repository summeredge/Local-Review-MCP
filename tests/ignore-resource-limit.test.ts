import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_IGNORE_FILE_BYTES,
  MAX_IGNORE_RULES,
  WorkspacePathError,
} from "../src/workspace/policy.js";
import { WorkspaceManager } from "../src/workspace/manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-ignore-"));
  temporaryDirectories.push(directory);
  return directory;
}

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) return error.code;
    throw error;
  }
  throw new Error("expected workspace initialization to fail");
}

describe(".localreviewignore resource limits", () => {
  it("fails workspace initialization when the ignore file is too large", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, ".localreviewignore"), Buffer.alloc(MAX_IGNORE_FILE_BYTES + 1, 0x61));

    expect(errorCode(() => new WorkspaceManager(workspace))).toBe("WORKSPACE_INVALID");
  });

  it("fails workspace initialization when the ignore rule count is too large", async () => {
    const workspace = await makeWorkspace();
    await writeFile(
      join(workspace, ".localreviewignore"),
      Array.from({ length: MAX_IGNORE_RULES + 1 }, (_, index) => `ignored-${index}`).join("\n"),
    );

    expect(errorCode(() => new WorkspaceManager(workspace))).toBe("WORKSPACE_INVALID");
  });
});
