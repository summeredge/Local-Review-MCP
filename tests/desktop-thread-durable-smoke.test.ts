import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateDurableContinuityEvidence,
  bindingExecutorNotPersisted,
  checkCreateThreadCount,
  checkPhaseBExecutorIdentity,
  checkTargetPreserved,
  cleanupSmokeRun,
  finalizeDurableContinuityEvidence,
  formatDesktopThreadDurableSmokeResult,
  readSmokeState,
  smokeRunDirectory,
  writeSmokeState,
  type DesktopThreadDurableSmokeState,
} from "../src/desktop-sync/desktop-thread-durable-smoke.js";
import { hasAgentMessageMarker } from "../src/desktop-sync/diagnostic-marker-sequencing.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function state(workspacePath: string, runId: string): DesktopThreadDurableSmokeState {
  return {
    schema_version: 1,
    run_id: runId,
    workspace_id: "legacy-workspace",
    task_id: randomUUID(),
    session_id: randomUUID(),
    workspace_path: workspacePath,
    project_id: "project-one",
    phase_a_executor_thread_id: "executor-a",
    target_thread_id: "target-thread",
    host_id: "local",
    storage_root: smokeRunDirectory(workspacePath, runId),
    created_at: "2026-09-20T00:00:00.000Z",
  };
}

function markerPayload(item: Record<string, unknown>): CallToolResult {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ turns: [{ id: "turn-1", items: [item] }] }),
    }],
  };
}

describe("P5.2.2-C desktop durable smoke helpers", () => {
  it("writes and reloads the phase state", async () => {
    const workspacePath = await mkdtemp("p522c-state-");
    roots.push(workspacePath);
    const current = state(workspacePath, randomUUID());

    await writeSmokeState(current);

    await expect(readSmokeState(current.storage_root)).resolves.toEqual(current);
  });

  it("restores the same run identity for phase B", async () => {
    const workspacePath = await mkdtemp("p522c-restart-");
    roots.push(workspacePath);
    const current = state(workspacePath, randomUUID());
    await writeSmokeState(current);

    const restored = await readSmokeState(smokeRunDirectory(workspacePath, current.run_id));
    expect(restored.run_id).toBe(current.run_id);
    expect(restored.workspace_id).toBe(current.workspace_id);
    expect(restored.task_id).toBe(current.task_id);
    expect(restored.session_id).toBe(current.session_id);
    expect(restored.storage_root).toBe(current.storage_root);
    expect(restored.target_thread_id).toBe(current.target_thread_id);
    expect(restored.host_id).toBe(current.host_id);
  });

  it("rejects an unchanged phase B executor", () => {
    expect(checkPhaseBExecutorIdentity("executor-a", "executor-a", "target-thread")).toMatchObject({
      ok: false,
      executor_changed: false,
      failure_class: "executor_context_not_changed",
    });
  });

  it("rejects a phase B executor that is the target", () => {
    expect(checkPhaseBExecutorIdentity("executor-a", "target-thread", "target-thread")).toMatchObject({
      ok: false,
      failure_class: "thread_identity_conflict",
    });
  });

  it("rejects a non-zero phase B create count", () => {
    expect(checkCreateThreadCount(1, 0)).toEqual({
      ok: false,
      failure_class: "duplicate_create_after_restart",
    });
  });

  it("rejects a changed durable target", () => {
    expect(checkTargetPreserved("target-a", "target-b")).toEqual({
      ok: false,
      failure_class: "target_changed",
    });
  });

  it("does not accept executor or conversation data in a binding", () => {
    expect(bindingExecutorNotPersisted({
      schema_version: 1,
      target_thread_id: "target-thread",
      host_id: "local",
    })).toBe(true);
    expect(bindingExecutorNotPersisted({
      target_thread_id: "target-thread",
      executorThreadId: "executor-a",
    })).toBe(false);
    expect(bindingExecutorNotPersisted({
      target_thread_id: "target-thread",
      conversation_id: "conversation-a",
    })).toBe(false);
  });

  it("cleans only the selected smoke run", async () => {
    const workspacePath = await mkdtemp("p522c-cleanup-");
    roots.push(workspacePath);
    const selected = smokeRunDirectory(workspacePath, randomUUID());
    const sibling = smokeRunDirectory(workspacePath, randomUUID());
    await mkdir(selected, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(join(selected, "marker.txt"), "selected");
    await writeFile(join(sibling, "marker.txt"), "sibling");

    await cleanupSmokeRun(workspacePath, selected.split(/[\\/]/u).at(-1)!);

    await expect(readFile(join(selected, "marker.txt"))).rejects.toThrow();
    await expect(readFile(join(sibling, "marker.txt"), "utf8")).resolves.toBe("sibling");
  });

  it("passes structural continuity with unknown completion content and fails on target loss", () => {
    const evidence = {
      executor_changed: true,
      binding_survived_process_restart: true,
      target_preserved: true,
      host_preserved: true,
      phase_b_metadata_uses_new_executor: true,
      phase_b_arguments_use_old_target: true,
      second_turn_dispatch_verified: true,
      second_turn_same_target: true,
      binding_unchanged: true,
      executor_not_persisted: true,
      second_turn_content_verified: "unknown" as const,
      completion_observer_verified: "unknown" as const,
    };
    expect(aggregateDurableContinuityEvidence(evidence)).toMatchObject({ ok: true, result: "pass" });
    expect(aggregateDurableContinuityEvidence({ ...evidence, target_preserved: false })).toMatchObject({
      ok: false,
      result: "fail",
    });
  });

  it("accepts only an embedded agentMessage marker", () => {
    expect(hasAgentMessageMarker(markerPayload({
      type: "agentMessage",
      text: "LRM_P522C_RESUME_run",
    }), "LRM_P522C_RESUME_run")).toBe(true);
    expect(hasAgentMessageMarker(markerPayload({
      type: "functionCallOutput",
      output: { text: "LRM_P522C_RESUME_run" },
    }), "LRM_P522C_RESUME_run")).toBe(false);
  });

  it("keeps Phase A formal observer verification unknown", () => {
    const formatted = formatDesktopThreadDurableSmokeResult({
      ok: true,
      phase: "phase-a",
      result: "pass",
      first_turn_content_verified: true,
      completion_observer_verified: "unknown",
    });
    expect(formatted).toContain("first_turn_content_verified: true");
    expect(formatted).toContain("completion_observer_verified: unknown");
  });

  it("requires both Observer completion and marker content for final Phase B pass", () => {
    const evidence = {
      executor_changed: true,
      binding_survived_process_restart: true,
      target_preserved: true,
      host_preserved: true,
      phase_b_metadata_uses_new_executor: true,
      phase_b_arguments_use_old_target: true,
      second_turn_dispatch_verified: true,
      second_turn_same_target: true,
      binding_unchanged: true,
      executor_not_persisted: true,
      second_turn_content_verified: "unknown" as const,
      completion_observer_verified: true as const,
    };
    expect(finalizeDurableContinuityEvidence(evidence)).toMatchObject({ ok: false, result: "fail" });
    expect(finalizeDurableContinuityEvidence({
      ...evidence,
      second_turn_content_verified: true,
    })).toMatchObject({ ok: true, result: "pass" });
  });
});
