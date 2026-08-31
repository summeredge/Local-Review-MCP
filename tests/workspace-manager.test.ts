import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
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

async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), "local-review-workspace-"));
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

describe("WorkspaceManager", () => {
  it("stores a canonical root and stable 12-character workspace ID", async () => {
    const root = await makeWorkspace();
    const first = new WorkspaceManager(root);
    const second = new WorkspaceManager(join(root, "."));

    expect(first.canonicalRoot).toBe(realpathSync.native(root));
    expect(first.root).toBe(first.canonicalRoot);
    expect(first.workspaceId).toMatch(/^[0-9a-f]{12}$/u);
    expect(second.workspaceId).toBe(first.workspaceId);
  });

  it("rejects missing roots and roots that are not directories", async () => {
    const root = await makeWorkspace();
    const file = join(root, "file.txt");
    await writeFile(file, "content");

    expect(errorCode(() => new WorkspaceManager(""))).toBe("WORKSPACE_INVALID");
    expect(errorCode(() => new WorkspaceManager(join(root, "missing")))).toBe("WORKSPACE_INVALID");
    expect(errorCode(() => new WorkspaceManager(file))).toBe("WORKSPACE_INVALID");
  });

  it("normalizes remote separators and resolves existing and future paths", async () => {
    const root = await makeWorkspace();
    await mkdir(join(root, "src", "existing"), { recursive: true });
    const file = join(root, "src", "app.ts");
    await writeFile(file, "export {};");
    const manager = new WorkspaceManager(root);

    expect(manager.resolveExisting("src\\app.ts")).toEqual({
      absolutePath: realpathSync.native(file),
      relativePath: "src/app.ts",
    });
    expect(manager.resolvePath("workspace:/src/app.ts").relativePath).toBe("src/app.ts");
    expect(manager.resolveExisting(".").absolutePath).toBe(manager.canonicalRoot);

    const future = manager.resolvePath("src/existing/new-file.txt");
    expect(future.relativePath).toBe("src/existing/new-file.txt");
    expect(future.absolutePath).toBe(join(realpathSync.native(join(root, "src", "existing")), "new-file.txt"));
    expect(errorCode(() => manager.resolveExisting("src/missing.ts"))).toBe("PATH_NOT_FOUND");
  });
});
