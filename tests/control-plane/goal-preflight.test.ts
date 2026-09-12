import { describe, expect, it, vi } from "vitest";
import type { ResolvedSettings } from "../../src/config/settings.js";
import {
  GoalPreflightService,
  type GoalPreflightConnectorCheck,
  type GoalPreflightExtensionStatus,
  type GoalPreflightWorkspaceRegistry,
} from "../../src/control-plane/goal-preflight.js";
import type { ChatGPTConnectorDiagnostic } from "../../src/control-plane/chatgpt-connector.js";
import type { ExtensionDeliveryReadinessCheck } from "../../src/control-plane/extension-delivery.js";

const settings: ResolvedSettings = {
  host: "127.0.0.1",
  port: 12080,
  workspace: "C:\\workspace",
  auth: { token: "token" },
  remote: { enabled: true, endpoint: "https://mcp.example.test" },
  supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
};

function registry(activeId = "workspace-a"): GoalPreflightWorkspaceRegistry {
  return {
    active: { id: activeId },
    resolve: (workspaceId) => workspaceId === activeId ? { id: activeId } : null,
  };
}

function connectorDiagnostic(
  overrides: {
    readonly ok?: boolean;
    readonly workspace_id?: string;
    readonly status?: "unconfigured" | "repair_required" | "verified";
    readonly action?: "none" | "create" | "update";
    readonly reason?: string;
    readonly remote_ready?: boolean;
    readonly oauth_ready?: boolean;
  } = {},
): ChatGPTConnectorDiagnostic {
  return {
    ok: overrides.ok ?? true,
    workspace_id: overrides.workspace_id ?? "workspace-a",
    workspace_name: "Workspace A",
    remote: {
      ready: overrides.remote_ready ?? true,
      mcp_url: "https://mcp.example.test/mcp",
      readiness: { attempts: 1, timeline: [], final_state: "ready" },
    },
    oauth: {
      ready: overrides.oauth_ready ?? true,
      pkce_s256: true,
      dynamic_registration: true,
      refresh_token: true,
      migration: "not_needed",
      reauthorization_required: false,
    },
    connector: {
      name: "Workspace A",
      status: overrides.status ?? "verified",
      action: overrides.action ?? "none",
      mcp_url: "https://mcp.example.test/mcp",
      verified_mcp_url: "https://mcp.example.test/mcp",
      reason: overrides.reason ?? "verified_endpoint_matches",
    },
    pages: {
      plugins: "https://chatgpt.com/admin/plugins",
      create_connector: "https://chatgpt.com/gpts/editor",
    },
  };
}

function extensionReadiness(ready: boolean, paired = ready): ReturnType<ExtensionDeliveryReadinessCheck> {
  return {
    ready,
    bridge_available: true,
    extension_paired: paired,
    last_seen_at: ready ? 100 : null,
    readiness_state: ready ? "ready" : paired ? "extension_not_present" : "extension_not_paired",
    ...(ready ? {} : { reason: paired ? "Extension is not connected." : "Extension is not paired." }),
  };
}

function service(options: {
  readonly runtimeReady?: () => boolean | Promise<boolean>;
  readonly connector?: GoalPreflightConnectorCheck;
  readonly extension?: ExtensionDeliveryReadinessCheck;
  readonly extensionStatus?: () => GoalPreflightExtensionStatus;
} = {}): {
  readonly service: GoalPreflightService;
  readonly connector: GoalPreflightConnectorCheck;
  readonly extension: ExtensionDeliveryReadinessCheck;
} {
  const connector = options.connector ?? vi.fn(async () => connectorDiagnostic());
  const extension = options.extension ?? vi.fn(async () => extensionReadiness(true));
  return {
    service: new GoalPreflightService({
      settings,
      registry: registry(),
      runtimeReady: options.runtimeReady ?? (() => true),
      diagnoseConnector: connector,
      extensionReadiness: extension,
      extensionStatus: options.extensionStatus,
      extensionReadyTimeoutMs: 0,
    }),
    connector,
    extension,
  };
}

describe("GoalPreflightService", () => {
  it("passes Runtime, Workspace, Connector, OAuth, and Extension readiness", async () => {
    const f = service();
    await expect(f.service.checkGoalPreflight({
      workspace_id: "workspace-a",
      conversation_id: "conversation-1",
    })).resolves.toMatchObject({
      ready: true,
      runtime: { ready: true },
      workspace: { valid: true, workspace_id: "workspace-a" },
      conversation: { valid: true, conversation_id: "conversation-1" },
      connector: {
        ready: true,
        status: "verified",
        remote_ready: true,
        oauth_ready: true,
      },
      extension: { ready: true, paired: true, present: true },
    });
    expect(f.connector).toHaveBeenCalledTimes(1);
    expect(f.extension).toHaveBeenCalledWith("conversation-1");
  });

  it("fails at Runtime before any lower readiness check", async () => {
    const f = service({ runtimeReady: () => false });
    await expect(f.service.checkGoalPreflight({
      workspace_id: "workspace-a",
      conversation_id: "conversation-1",
    })).resolves.toMatchObject({
      ready: false,
      failure_stage: "runtime",
      failure_reason: "Runtime is not ready",
    });
    expect(f.connector).not.toHaveBeenCalled();
    expect(f.extension).not.toHaveBeenCalled();
  });

  it("fails at Connector and reports its precise reason", async () => {
    const f = service({
      connector: vi.fn(async () => connectorDiagnostic({
        ok: false,
        status: "unconfigured",
        reason: "remote_not_configured",
      })),
      extension: vi.fn(async () => extensionReadiness(false, false)),
    });
    await expect(f.service.checkGoalPreflight({
      workspace_id: "workspace-a",
      conversation_id: "conversation-1",
    })).resolves.toMatchObject({
      ready: false,
      failure_stage: "connector",
      failure_reason: "remote_not_configured",
      connector: { ready: false, status: "unconfigured" },
      extension: { ready: false, paired: false },
    });
    expect(f.extension).toHaveBeenCalledTimes(1);
  });

  it("fails at Extension when pairing is missing", async () => {
    const f = service({ extension: vi.fn(async () => extensionReadiness(false, false)) });
    await expect(f.service.checkGoalPreflight({
      workspace_id: "workspace-a",
      conversation_id: "conversation-1",
    })).resolves.toMatchObject({
      ready: false,
      failure_stage: "extension",
      failure_reason: "Extension is not paired.",
      extension: { ready: false, paired: false, present: false },
    });
    expect(f.extension).toHaveBeenCalledTimes(1);
  });

  it("rejects a workspace that is not the active registered identity", async () => {
    const f = service();
    await expect(f.service.checkGoalPreflight({
      workspace_id: "workspace-b",
      conversation_id: "conversation-1",
    })).resolves.toMatchObject({
      ready: false,
      failure_stage: "workspace",
      workspace: { valid: false, workspace_id: "workspace-b" },
    });
    expect(f.connector).not.toHaveBeenCalled();
    expect(f.extension).not.toHaveBeenCalled();
  });

  it("rejects a blank Chat conversation before readiness checks", async () => {
    const f = service();
    await expect(f.service.checkGoalPreflight({
      workspace_id: "workspace-a",
      conversation_id: " ",
    })).resolves.toMatchObject({
      ready: false,
      failure_stage: "conversation",
      failure_reason: "conversation_id must be a non-empty value",
      conversation: { valid: false },
    });
    expect(f.connector).not.toHaveBeenCalled();
    expect(f.extension).not.toHaveBeenCalled();
  });
});
