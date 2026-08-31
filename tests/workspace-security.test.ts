import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceManager,
  WorkspacePathError,
  type WorkspaceErrorCode,
} from "../src/workspace/manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function errorCode(action: () => unknown): WorkspaceErrorCode {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) return error.code;
    throw error;
  }
  throw new Error("expected WorkspacePathError");
}

describe("workspace canonical containment", () => {
  it("rejects traversal before resolving a filesystem path", async () => {
    const root = await makeDirectory("local-review-workspace-");
    const manager = new WorkspaceManager(root);

    for (const value of ["../x", "..\\x", "a/../../x", "a\\..\\..\\x", "a/..\\..\\x", "a\\../..\\x"]) {
      expect(errorCode(() => manager.resolvePath(value))).toBe("INVALID_PATH");
    }
  });

  it("blocks file and directory symlink escapes when the platform permits symlinks", async ({ skip }) => {
    const workspace = await makeDirectory("local-review-workspace-");
    const outside = await makeDirectory("local-review-outside-");
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "secret");
    const manager = new WorkspaceManager(workspace);

    try {
      await symlink(secret, join(workspace, "file-link"), "file");
      await symlink(outside, join(workspace, "directory-link"), "dir");
    } catch (error: unknown) {
      if (process.platform === "win32") {
        skip("symlink creation is unavailable");
        return;
      }
      throw error;
    }

    expect(errorCode(() => manager.resolveExisting("file-link"))).toBe("PATH_OUTSIDE_WORKSPACE");
    expect(errorCode(() => manager.resolveExisting("directory-link/secret.txt"))).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  const windowsIt = process.platform === "win32" ? it : it.skip;
  windowsIt("blocks a Windows junction/reparse-point escape", async () => {
    const workspace = await makeDirectory("local-review-workspace-");
    const outside = await makeDirectory("local-review-outside-");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(workspace, "outside-junction"), "junction");

    const manager = new WorkspaceManager(workspace);
    expect(errorCode(() => manager.resolveExisting("outside-junction/secret.txt")))
      .toBe("PATH_OUTSIDE_WORKSPACE");
  });
});
