import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupDesktopCompletionContractProbeRun,
  desktopCompletionContractProbeRunDirectory,
  parseDesktopCompletionContractProbeArgs,
  writeDesktopCompletionContractProbeToolArtifact,
} from "../src/desktop-sync/desktop-completion-contract-probe.js";

describe("P5.3.0-B contract probe plumbing", () => {
  it("parses bounded effectful probe arguments without starting the probe", () => {
    expect(parseDesktopCompletionContractProbeArgs([
      "--confirm-effectful",
      "--timeout-ms",
      "5000",
      "--server",
      "C:/server.mjs",
      "--pipe",
      "\\\\.\\pipe\\codex-ipc",
    ], "C:/workspace/Local-Review-MCP")).toEqual({
      confirmEffectful: true,
      timeoutMs: 5000,
      workspacePath: "C:\\workspace\\Local-Review-MCP",
      serverPath: "C:/server.mjs",
      pipePath: "\\\\.\\pipe\\codex-ipc",
    });
    expect(() => parseDesktopCompletionContractProbeArgs(["--timeout-ms", "0"])).toThrow();
  });

  it("keeps run artifacts isolated to a UUID directory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "p530b-path-"));
    try {
      const runId = "019d1c2a-8c46-7b1b-8ab1-123456789abc";
      const runDirectory = desktopCompletionContractProbeRunDirectory(workspace, runId);
      expect(runDirectory).toBe(join(workspace, ".review", "p5-3-0-b-contract-probe", runId));
      expect(() => desktopCompletionContractProbeRunDirectory(workspace, "..\\escape")).toThrow();

      await writeFile(join(workspace, "keep.txt"), "keep", "utf8");
      await cleanupDesktopCompletionContractProbeRun(workspace, runId);
      await expect(readFile(join(workspace, "keep.txt"), "utf8")).resolves.toBe("keep");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("saves the complete tool object without reducing its schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "p530b-tool-"));
    try {
      const tool = {
        name: "read_thread",
        description: "raw description",
        inputSchema: { type: "object", properties: { cursor: { type: "string" } } },
        outputSchema: { type: "object", properties: { turns: { type: "array" } } },
        annotations: { readOnlyHint: true },
        customField: { preserved: true },
      } as unknown as import("@modelcontextprotocol/sdk/types.js").Tool;
      await writeDesktopCompletionContractProbeToolArtifact(root, "read_thread", tool);
      await expect(readFile(join(root, "tool-read_thread.json"), "utf8").then(JSON.parse)).resolves.toEqual(tool);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
