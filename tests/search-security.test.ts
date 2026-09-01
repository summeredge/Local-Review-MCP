import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import {
  MAX_RG_ARG_BYTES,
  MAX_PREVIEW_CHARS,
  MAX_SEARCH_FILE_BYTES,
  type RipgrepRequest,
  searchText,
} from "../src/workspace/search.js";
import { WorkspaceManager } from "../src/workspace/manager.js";

const clients: Client[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-search-security-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function callSearch(workspace: string, arguments_: Record<string, unknown>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "search-security-test", version: "0.1.0" });
  clients.push(client);
  await Promise.all([
    createMcpServer({ workspace: new WorkspaceManager(workspace) }).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client.callTool({ name: "search_text", arguments: arguments_ });
}

function toolText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || typeof content[0] !== "object" || content[0] === null
    || typeof (content[0] as { text?: unknown }).text !== "string") {
    throw new Error("tool did not return text content");
  }
  return (content[0] as { text: string }).text;
}

function resultJson(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return JSON.parse(toolText(result)) as Record<string, unknown>;
}

function deterministicRipgrepRunner(workspace: string, requests: RipgrepRequest[]) {
  return async (request: RipgrepRequest) => {
    requests.push(request);
    const separator = request.args.indexOf("--");
    const query = request.args[separator + 1];
    const paths = request.args.slice(separator + 2);
    const events: string[] = [];

    for (const relativePath of paths) {
      const contents = await readFile(join(workspace, ...relativePath.split("/")), "utf8");
      for (const [index, line] of contents.split(/\r?\n/u).entries()) {
        if (!line.includes(query)) continue;
        events.push(JSON.stringify({
          type: "match",
          data: {
            path: { text: relativePath },
            lines: { text: `${line}\n` },
            line_number: index + 1,
          },
        }));
      }
    }

    return {
      output: events.join("\n"),
      exitCode: events.length === 0 ? 1 : 0,
    };
  };
}

async function createSecurityFixture(workspace: string, query: string): Promise<void> {
  await mkdir(join(workspace, ".git"));
  await mkdir(join(workspace, ".aws"));
  await mkdir(join(workspace, "private"));
  await writeFile(join(workspace, ".localreviewignore"), "private/**\n*.secret\n");
  await writeFile(join(workspace, ".env"), `${query}\n`);
  await writeFile(join(workspace, ".git", "config"), `${query}\n`);
  await writeFile(join(workspace, ".aws", "credentials"), `${query}\n`);
  await writeFile(join(workspace, "private", "a.txt"), `${query}\n`);
  await writeFile(join(workspace, "ignored.secret"), `${query}\n`);
  await writeFile(join(workspace, "binary.bin"), Buffer.from(`abc\0${query}`, "utf8"));
  await writeFile(join(workspace, ".env.example"), `${query}\n`);
  await writeFile(join(workspace, "public.ts"), `${query}\n`);
  await writeFile(join(workspace, "large.txt"), Buffer.concat([
    Buffer.alloc(MAX_SEARCH_FILE_BYTES, 0x78),
    Buffer.from(`${query}\n`, "utf8"),
  ]));
}

describe("search_text security and bounds", () => {
  it("filters sensitive, ignored, binary, and oversized files", async () => {
    const workspace = await makeWorkspace();
    await mkdir(join(workspace, ".git"));
    await mkdir(join(workspace, ".aws"));
    await mkdir(join(workspace, "private"));
    await writeFile(join(workspace, ".localreviewignore"), "private/**\n*.secret\n");
    await writeFile(join(workspace, ".env"), "TOP_SECRET_MATCH\n");
    await writeFile(join(workspace, ".git", "config"), "TOP_SECRET_MATCH\n");
    await writeFile(join(workspace, ".aws", "credentials"), "TOP_SECRET_MATCH\n");
    await writeFile(join(workspace, "private", "a.txt"), "TOP_SECRET_MATCH\n");
    await writeFile(join(workspace, "ignored.secret"), "TOP_SECRET_MATCH\n");
    await writeFile(join(workspace, "binary.bin"), Buffer.from("abc\0TOP_SECRET_MATCH", "utf8"));
    await writeFile(join(workspace, ".env.example"), "TOP_SECRET_MATCH\n");
    await writeFile(join(workspace, "public.ts"), "TOP_SECRET_MATCH\n");
    await writeFile(join(workspace, "large.txt"), Buffer.concat([
      Buffer.alloc(MAX_SEARCH_FILE_BYTES, 0x78),
      Buffer.from("TOP_SECRET_MATCH\n", "utf8"),
    ]));

    const result = resultJson(await callSearch(workspace, { query: "TOP_SECRET_MATCH" }));
    expect((result.results as { path: string }[]).map((item) => item.path)).toEqual([
      ".env.example",
      "public.ts",
    ]);
    expect(result.returned).toBe(2);
    const serialized = JSON.stringify(result);
    for (const hidden of [
      ".env\n",
      ".git",
      ".aws",
      "private",
      "ignored.secret",
      "binary.bin",
      "large.txt",
      "TOP_SECRET_MATCH",
    ]) {
      if (hidden === "TOP_SECRET_MATCH") continue;
      expect(serialized).not.toContain(hidden);
    }
  });

  it("passes only safe candidates to the deterministic ripgrep runner", async () => {
    const workspace = await makeWorkspace();
    const query = "CANDIDATE_GATE";
    await createSecurityFixture(workspace, query);
    const requests: RipgrepRequest[] = [];
    const options = {
      query,
      path: ".",
      regex: false,
      caseSensitive: false,
      limit: 100,
    } as const;

    const manager = new WorkspaceManager(workspace);
    const fast = await searchText(manager, options, {
      runRipgrep: deterministicRipgrepRunner(workspace, requests),
      maxRgBatchFiles: 1,
      maxRgArgBytes: MAX_RG_ARG_BYTES,
    });
    const node = await searchText(new WorkspaceManager(workspace), options, { disableRipgrep: true });

    expect(fast.engine).toBe("ripgrep");
    expect(fast.results).toEqual(node.results);
    expect(fast.results.map((item) => item.path)).toEqual([".env.example", "public.ts"]);
    expect(requests.length).toBe(2);
    expect(requests.every((request) => request.cwd === manager.canonicalRoot)).toBe(true);
    expect(requests.every((request) => !request.args.includes("--hidden"))).toBe(true);
    expect(requests.every((request) => !request.args.includes("--no-ignore"))).toBe(true);

    const candidatePaths = requests.flatMap((request) => {
      const separator = request.args.indexOf("--");
      const paths = request.args.slice(separator + 2);
      expect(paths.length).toBeLessThanOrEqual(1);
      expect(Buffer.byteLength(request.args.join("\0"), "utf8")).toBeLessThanOrEqual(MAX_RG_ARG_BYTES);
      return paths;
    });
    expect(candidatePaths).toEqual([".env.example", "public.ts"]);
    for (const blocked of [
      ".env",
      ".git/config",
      ".aws/credentials",
      ".localreviewignore",
      "private/a.txt",
      "ignored.secret",
      "binary.bin",
      "large.txt",
      "outside-junction/secret.txt",
    ]) {
      expect(candidatePaths).not.toContain(blocked);
    }

    const singleRequests: RipgrepRequest[] = [];
    const single = await searchText(manager, { ...options, path: "public.ts" }, {
      runRipgrep: deterministicRipgrepRunner(workspace, singleRequests),
    });
    const singleSeparator = singleRequests[0]?.args.indexOf("--") ?? -1;
    expect(single.results.map((item) => item.path)).toEqual(["public.ts"]);
    expect(singleRequests[0]?.args.slice(singleSeparator + 2)).toEqual(["public.ts"]);
  });

  it("propagates candidate and result truncation to has_more", async () => {
    const workspace = await makeWorkspace();
    await Promise.all([
      writeFile(join(workspace, "a.txt"), "MATCH\n"),
      writeFile(join(workspace, "b.txt"), "MATCH\n"),
      writeFile(join(workspace, "c.txt"), "MATCH\n"),
    ]);
    const options = {
      query: "MATCH",
      path: ".",
      regex: false,
      caseSensitive: false,
      limit: 200,
    } as const;

    const node = await searchText(new WorkspaceManager(workspace), options, {
      disableRipgrep: true,
      maxVisitedEntries: 2,
    });
    const requests: RipgrepRequest[] = [];
    const fast = await searchText(new WorkspaceManager(workspace), options, {
      maxVisitedEntries: 2,
      runRipgrep: deterministicRipgrepRunner(workspace, requests),
    });

    expect(node.returned).toBe(2);
    expect(node.has_more).toBe(true);
    expect(fast.results).toEqual(node.results);
    expect(fast.has_more).toBe(true);
  });

  it("bounds result count and preview size", async () => {
    const workspace = await makeWorkspace();
    await Promise.all(Array.from({ length: 300 }, (_, index) => writeFile(
      join(workspace, `match-${String(index).padStart(3, "0")}.txt`),
      `MATCH_ME ${index}\n`,
    )));
    await writeFile(join(workspace, "long.txt"), `${"x".repeat(MAX_PREVIEW_CHARS + 100)}MATCH_ME\n`);

    const result = resultJson(await callSearch(workspace, { query: "MATCH_ME", limit: 20 }));
    const node = await searchText(new WorkspaceManager(workspace), {
      query: "MATCH_ME",
      path: ".",
      regex: false,
      caseSensitive: false,
      limit: 20,
    }, { disableRipgrep: true });
    for (const bounded of [result, node]) {
      expect(bounded.returned).toBe(20);
      expect(bounded.has_more).toBe(true);
      expect((bounded.results as { preview: string }[]).every((item) => item.preview.length <= MAX_PREVIEW_CHARS)).toBe(true);
    }
  });

  it("reports a safely truncated ripgrep output as has_more", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, "app.ts"), "MATCH\n");
    const result = await searchText(new WorkspaceManager(workspace), {
      query: "MATCH",
      path: ".",
      regex: false,
      caseSensitive: false,
      limit: 100,
    }, {
      runRipgrep: async () => ({
        output: JSON.stringify({
          type: "match",
          data: {
            path: { text: "app.ts" },
            lines: { text: "MATCH\n" },
            line_number: 1,
          },
        }),
        exitCode: 0,
        signal: "SIGTERM",
        outputTruncated: true,
      }),
    });

    expect(result.engine).toBe("ripgrep");
    expect(result.returned).toBe(1);
    expect(result.has_more).toBe(true);
  });

  it("keeps ripgrep timeout as SEARCH_FAILED", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, "app.ts"), "MATCH\n");

    await expect(searchText(new WorkspaceManager(workspace), {
      query: "MATCH",
      path: ".",
      regex: false,
      caseSensitive: false,
      limit: 100,
    }, {
      runRipgrep: async () => ({
        output: "",
        exitCode: null,
        timedOut: true,
      }),
    })).rejects.toMatchObject({ code: "SEARCH_FAILED" });
  });

  it("rejects an external ordinary symlink", async ({ skip }) => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    await writeFile(join(outside, "secret.txt"), "SYMLINK_SECRET\n");
    try {
      await symlink(outside, join(workspace, "outside-link"), "dir");
    } catch (error: unknown) {
      if (process.platform === "win32") {
        skip("symlink creation is unavailable");
        return;
      }
      throw error;
    }

    const result = resultJson(await callSearch(workspace, { query: "SYMLINK_SECRET" }));
    expect(result.results).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("outside-link");
    expect(JSON.stringify(result)).not.toContain("secret.txt");
  });

  const windowsIt = process.platform === "win32" ? it : it.skip;
  windowsIt("rejects a Windows Junction escape", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    await writeFile(join(outside, "secret.txt"), "JUNCTION_SECRET\n");
    await symlink(outside, join(workspace, "outside-junction"), "junction");

    const options = {
      query: "JUNCTION_SECRET",
      path: ".",
      regex: false,
      caseSensitive: false,
      limit: 100,
    } as const;
    const node = await searchText(new WorkspaceManager(workspace), options, { disableRipgrep: true });
    const requests: RipgrepRequest[] = [];
    const fast = await searchText(new WorkspaceManager(workspace), options, {
      runRipgrep: deterministicRipgrepRunner(workspace, requests),
    });

    expect(node.engine).toBe("node");
    expect(fast.engine).toBe("ripgrep");
    expect(node.results).toEqual([]);
    expect(fast.results).toEqual([]);
    for (const result of [node, fast]) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("outside-junction");
      expect(serialized).not.toContain("secret.txt");
      expect(serialized).not.toContain("JUNCTION_SECRET");
      expect(serialized).not.toContain(outside);
    }
    const candidatePaths = requests.flatMap((request) => {
      const separator = request.args.indexOf("--");
      return request.args.slice(separator + 2);
    });
    expect(candidatePaths).not.toContain("outside-junction");
    expect(candidatePaths).not.toContain("outside-junction/secret.txt");
  });

  it("keeps the Node fallback on the same security boundary", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, ".env"), "FALLBACK_SECRET\n");
    await writeFile(join(workspace, "public.txt"), "FALLBACK_SECRET\n");

    const result = await searchText(new WorkspaceManager(workspace), {
      query: "FALLBACK_SECRET",
      path: ".",
      regex: false,
      caseSensitive: false,
      limit: 100,
    }, { disableRipgrep: true });

    expect(result.engine).toBe("node");
    expect(result.results.map((item) => item.path)).toEqual(["public.txt"]);
  });
});
