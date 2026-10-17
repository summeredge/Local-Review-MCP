import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccessPolicy, WorkspacePathError, type WorkspaceErrorCode } from "../src/workspace/policy.js";
import { createMcpServer } from "../src/mcp/server.js";
import { sha256 } from "../src/workspace/edit.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const runtimeConfigs = [
  "config.production.json", "config.e2e.json", "config.production.backup-20261017.json",
  "LocalReviewLauncher/launcher.config.json",
];

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
      ...runtimeConfigs,
      "workspace:/./LocalReviewLauncher\\launcher.config.json",
    ];

    for (const path of sensitivePaths) {
      expect(policy.isSensitive(path), path).toBe(true);
      expect(errorCode(() => policy.assertAllowed(path)), path).toBe("SENSITIVE_PATH");
    }
  });

  it("keeps .env.example and ordinary paths allowed", async () => {
    const policy = new AccessPolicy(await makeWorkspace());

    for (const path of [".env.example", "src/app.ts", "README.md", "config.production.example.json",
      "src/config.production.json", "src/config.e2e.json", "src/config.production.backup-test.json",
      "src/LocalReviewLauncher/launcher.config.json", "launcher.config.json",
      "LocalReviewLauncher/launcher.config.example.json"]) {
      expect(policy.isSensitive(path), path).toBe(false);
      expect(() => policy.assertAllowed(path), path).not.toThrow();
    }
  });

  it("matches sensitive names case-insensitively on Windows", async () => {
    if (process.platform !== "win32") return;
    const policy = new AccessPolicy(await makeWorkspace());

    for (const path of [".ENV", ".GIT/config", "Private.KEY", ...runtimeConfigs.map((path) => path.toUpperCase()),
      "LocalReviewLauncher. /launcher.config.json. "]) {
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

it("protects runtime configs through all Workspace tools while preserving ordinary files", async () => {
  const root = await makeWorkspace();
  const bytes = Buffer.from("RUNTIME_CONFIG_TEST_MARKER\n");
  const allowed = ["config.production.example.json", ".env.example", "README.md", "src/config.production.json"];
  await mkdir(join(root, "LocalReviewLauncher"));
  await mkdir(join(root, "src"));
  for (const path of [...runtimeConfigs, ...allowed]) await writeFile(join(root, path), bytes);
  // A directory alias must not bypass the canonical sensitive-path check.
  await symlink(join(root, "LocalReviewLauncher"), join(root, "launcher-alias"),
    process.platform === "win32" ? "junction" : "dir");
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "sensitive-config-test", version: "1" });
  await Promise.all([
    createMcpServer({ registry: WorkspaceRegistry.fromManager(new WorkspaceManager(root)) }).connect(b),
    client.connect(a),
  ]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: { workspace_id: "legacy-workspace", ...args } });
    return JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>;
  };
  try {
    const denied = [...runtimeConfigs, "workspace:/./LocalReviewLauncher\\launcher.config.json",
      "launcher-alias/launcher.config.json"];
    if (process.platform === "win32") denied.push(...runtimeConfigs.map((path) => path.toUpperCase()));
    for (const path of denied) {
      for (const name of ["workspace_read_file", "read_file", "workspace_search", "search_text",
        "workspace_list_files", "list_files", "workspace_edit_file"]) {
        expect(await call(name, { path, query: "RUNTIME_CONFIG_TEST_MARKER", expected_sha256: sha256(bytes),
          edits: [{ old_text: "RUNTIME_CONFIG_TEST_MARKER", new_text: "changed" }] }), `${name}: ${path}`)
          .toMatchObject({ error: "SENSITIVE_PATH" });
      }
    }
    for (const name of ["workspace_list_files", "list_files", "workspace_search", "search_text"]) {
      const result = await call(name, { depth: 4, query: "RUNTIME_CONFIG_TEST_MARKER" });
      const paths = name === "workspace_list_files" ? result.files
        : ((result.entries ?? result.results) as { path: string; type?: string }[])
          .filter((entry) => entry.type !== "directory").map((entry) => entry.path);
      expect((paths as string[]).sort(), name).toEqual([...allowed].sort());
    }
    for (const path of allowed) {
      for (const name of ["workspace_read_file", "read_file"]) {
        expect(await call(name, { path })).toMatchObject({ content: "RUNTIME_CONFIG_TEST_MARKER" });
      }
    }
    for (const path of runtimeConfigs) expect(await readFile(join(root, path))).toEqual(bytes);
  } finally { await client.close(); }
});
