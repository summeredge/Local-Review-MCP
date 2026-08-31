import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccessPolicy, WorkspacePathError, type WorkspaceErrorCode } from "../src/workspace/policy.js";

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

describe("AccessPolicy sensitive paths", () => {
  it("hard-denies the default sensitive path set", async () => {
    const policy = new AccessPolicy(await makeWorkspace());
    const sensitivePaths = [
      ".git/config",
      ".env",
      ".env.local",
      ".env.production",
      "private.pem",
      "private.key",
      "cert.p12",
      "cert.pfx",
      "store.jks",
      "store.keystore",
      ".ssh/id_rsa",
      ".aws/credentials",
      ".gnupg/private-keys-v1.d/x",
      ".cloudflared/cert.pem",
      ".npmrc",
      ".netrc",
      "_netrc",
      ".git-credentials",
      "credentials.json",
      "service-account-prod.json",
      "secrets.json",
      ".localreviewignore",
    ];

    for (const path of sensitivePaths) {
      expect(policy.isSensitive(path), path).toBe(true);
      expect(errorCode(() => policy.assertAllowed(path)), path).toBe("SENSITIVE_PATH");
    }
  });

  it("keeps .env.example and ordinary paths allowed", async () => {
    const policy = new AccessPolicy(await makeWorkspace());

    for (const path of [".env.example", "src/app.ts", "README.md"]) {
      expect(policy.isSensitive(path), path).toBe(false);
      expect(() => policy.assertAllowed(path), path).not.toThrow();
    }
  });

  it("matches sensitive names case-insensitively on Windows", async () => {
    if (process.platform !== "win32") return;
    const policy = new AccessPolicy(await makeWorkspace());

    for (const path of [".ENV", ".GIT/config", "Private.KEY"]) {
      expect(policy.isSensitive(path), path).toBe(true);
    }
  });

  it("loads deny-only .localreviewignore glob rules", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, ".localreviewignore"), [
      "# comment",
      "",
      "private/**",
      "*.secret",
      "generated/internal.txt",
    ].join("\n"));
    const policy = new AccessPolicy(workspace);

    for (const path of ["private", "private/a.txt", "nested/a.secret", "generated/internal.txt"]) {
      expect(policy.isSensitive(path), path).toBe(true);
    }
    for (const path of ["private-public/a.txt", "src/app.ts", "README.md"]) {
      expect(policy.isSensitive(path), path).toBe(false);
    }

    if (process.platform === "win32") {
      expect(policy.isSensitive("PRIVATE/UPPER.SECRET")).toBe(true);
    }
  });

  it("fails closed when .localreviewignore is unreadable or invalid", async () => {
    const unreadableWorkspace = await makeWorkspace();
    await mkdir(join(unreadableWorkspace, ".localreviewignore"));
    expect(errorCode(() => new AccessPolicy(unreadableWorkspace))).toBe("WORKSPACE_INVALID");

    const invalidWorkspace = await makeWorkspace();
    await writeFile(join(invalidWorkspace, ".localreviewignore"), "!public/**\n");
    expect(errorCode(() => new AccessPolicy(invalidWorkspace))).toBe("WORKSPACE_INVALID");
  });
});
