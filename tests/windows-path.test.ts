import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  containsAdsSyntax,
  isContainedPath,
  isReservedWindowsName,
  normalizeRemotePath,
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

describe("remote Windows path validation", () => {
  it.each([
    "../x",
    "..\\x",
    "a/../../x",
    "a\\..\\..\\x",
    "a/..\\..\\x",
    "a\\../..\\x",
    "C:\\x",
    "C:/x",
    "D:\\x",
    "/x",
    "\\x",
    "C:foo",
    "C:..\\foo",
    "D:src\\file.ts",
    "\\\\server\\share\\x",
    "//server/share/x",
    "\\\\?\\C:\\x",
    "\\\\.\\C:\\x",
    "\\??\\C:\\x",
    "abc\0def",
    "file.txt:secret",
    "foo:bar",
    "dir\\file.js:stream",
    "CON",
    "con.txt",
    "NUL",
    "nul.json",
    "PRN",
    "AUX",
    "COM1",
    "COM9.txt",
    "LPT1",
    "LPT9.log",
    "src/CON.txt",
  ])("rejects %s", (value) => {
    expect(errorCode(() => normalizeRemotePath(value))).toBe("INVALID_PATH");
  });

  it("normalizes allowed relative paths and the optional workspace alias", () => {
    expect(normalizeRemotePath(".")).toBe(".");
    expect(normalizeRemotePath("src\\app.ts")).toBe("src/app.ts");
    expect(normalizeRemotePath("src/./nested\\file.txt")).toBe("src/nested/file.txt");
    expect(normalizeRemotePath("workspace:/src\\app.ts")).toBe("src/app.ts");
    expect(normalizeRemotePath("workspace:/")).toBe(".");
  });

  it("exposes focused ADS, reserved-name, and containment checks", async () => {
    expect(containsAdsSyntax("C:/repo/file.txt")).toBe(false);
    expect(containsAdsSyntax("file.txt:secret")).toBe(true);
    expect(isReservedWindowsName("CON.txt")).toBe(true);
    expect(isReservedWindowsName("COM10.txt")).toBe(false);

    expect(isContainedPath("C:\\repo", "C:\\repo\\src", "win32")).toBe(true);
    expect(isContainedPath("C:\\Repo", "c:\\REPO\\src", "win32")).toBe(true);
    expect(isContainedPath("C:\\repo", "C:\\repo-other", "win32")).toBe(false);
    expect(isContainedPath("C:\\repo", "D:\\repo\\src", "win32")).toBe(false);

    const root = await makeWorkspace();
    const manager = new WorkspaceManager(root);
    expect(errorCode(() => manager.resolvePath(root))).toBe("INVALID_PATH");
  });
});
