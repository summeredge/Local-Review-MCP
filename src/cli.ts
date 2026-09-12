import { loadSettings, parseCliArgs } from "./config/settings.js";
import { createAppContext, startApp, startupMessage } from "./app.js";
import { generateConversationRoutingExample } from "./context/conversation-routing-diagnostic.js";
import { generateReviewDeliveryExample } from "./context/review-delivery-diagnostic.js";
import { generateReviewContextExample } from "./context/review-context-diagnostic.js";
import { generateReviewVerdictExample } from "./control/review-verdict-diagnostic.js";
import { generateLoopDecisionExample } from "./control/loop-decision-diagnostic.js";
import { generateIterationDirectiveExample } from "./control/iteration-directive-diagnostic.js";
import { generateReviewSnapshotExample } from "./git/review-snapshot-diagnostic.js";
import {
  generateBrowserRouterExample,
  generateReviewDeliveryBrowserExample,
} from "./router/browser-router-diagnostic.js";
import { runGoalE2EDiagnostic } from "./control-plane/goal-e2e-diagnostic.js";
import {
  goalCliFailure,
  runGoalStatusCommand,
  runGoalSubmissionCommand,
} from "./control-plane/goal-cli.js";
import {
  parseExtensionReviewCompletionDiagnosticArgs,
  runExtensionReviewCompletionDiagnostic,
} from "./control-plane/extension-review-completion-diagnostic.js";
import {
  confirmChatGPTConnector,
  diagnoseChatGPTConnector,
  parseConnectorConfirmArgs,
} from "./control-plane/chatgpt-connector.js";
import { registeredMcpToolsMessage } from "./mcp/server.js";
import { createStartupManager } from "./supervisor/startup.js";
import { createSupervisor } from "./supervisor/supervisor.js";
import { WindowsTrayApp } from "./supervisor/tray.js";
import { WorkspaceManager } from "./workspace/manager.js";

function printErrorDetails(error: unknown, warning = false): void {
  const log = warning ? console.warn : console.error;
  if (error instanceof Error) {
    log(error.message);
    if (error.stack !== undefined) log(error.stack);
    log("Original error:", error.cause ?? error);
    return;
  }
  log("Original error:", error);
}

function connectorCommandError(error: unknown): void {
  console.log(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : "ChatGPT connector command failed",
  }));
  process.exitCode = 1;
}

try {
  const argv = process.argv.slice(2);
  if (argv[0] === "diagnose-chatgpt-connector") {
    try {
      const settings = await loadSettings(argv.slice(1));
      const result = await diagnoseChatGPTConnector(settings);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } catch (error: unknown) {
      connectorCommandError(error);
    }
  } else if (argv[0] === "confirm-chatgpt-connector") {
    try {
      const args = parseConnectorConfirmArgs(argv.slice(1));
      const settings = await loadSettings(args.settingsArgs);
      const binding = await confirmChatGPTConnector(
        settings,
        args.requestId,
        undefined,
        args.connectorName,
      );
      console.log(JSON.stringify({ ok: true, connector: binding }, null, 2));
    } catch (error: unknown) {
      connectorCommandError(error);
    }
  } else if (argv[0] === "diagnose-review-context") {
    const diagnosticArgs = argv.slice(1);
    const diagnosticCli = parseCliArgs(diagnosticArgs);
    const diagnosticSettings = diagnosticCli.configPath === undefined
      ? undefined
      : await loadSettings(diagnosticArgs);
    const identity = diagnosticSettings?.workspaceIdentity
      ?? diagnosticSettings?.workspaces?.find((entry) => entry.path === diagnosticSettings.workspace)
      ?? (diagnosticSettings === undefined
        ? undefined
        : new WorkspaceManager(diagnosticSettings.workspace).identity);
    console.log(JSON.stringify(await generateReviewContextExample(identity), null, 2));
  } else if (argv[0] === "diagnose-review-delivery") {
    console.log(JSON.stringify(await generateReviewDeliveryExample(), null, 2));
  } else if (argv[0] === "diagnose-browser-router") {
    console.log(JSON.stringify(await generateBrowserRouterExample(), null, 2));
  } else if (argv[0] === "diagnose-review-delivery-browser") {
    console.log(JSON.stringify(await generateReviewDeliveryBrowserExample(), null, 2));
  } else if (argv[0] === "diagnose-browser-worker") {
    const { generateBrowserWorkerExample } = await import("./browser-worker/diagnostic.js");
    console.log(JSON.stringify(await generateBrowserWorkerExample(), null, 2));
  } else if (argv[0] === "diagnose-review-submission") {
    const { generateReviewSubmissionExample } = await import("./browser-worker/review-submission-diagnostic.js");
    console.log(JSON.stringify(await generateReviewSubmissionExample(), null, 2));
  } else if (argv[0] === "diagnose-review-completion") {
    const { generateReviewCompletionExample } = await import("./browser-worker/review-completion-diagnostic.js");
    console.log(JSON.stringify(await generateReviewCompletionExample(), null, 2));
  } else if (argv[0] === "diagnose-extension-review-completion") {
    const diagnostic = await runExtensionReviewCompletionDiagnostic(
      parseExtensionReviewCompletionDiagnosticArgs(argv.slice(1)),
    );
    console.log(JSON.stringify(diagnostic, null, 2));
    if (!diagnostic.ok) process.exitCode = 1;
  } else if (argv[0] === "diagnose-review-verdict") {
    console.log(JSON.stringify(generateReviewVerdictExample(), null, 2));
  } else if (argv[0] === "diagnose-loop-decision") {
    console.log(JSON.stringify(generateLoopDecisionExample(), null, 2));
  } else if (argv[0] === "diagnose-iteration-directive") {
    console.log(JSON.stringify(generateIterationDirectiveExample(), null, 2));
  } else if (argv[0] === "diagnose-review-snapshot") {
    console.log(JSON.stringify(await generateReviewSnapshotExample(), null, 2));
  } else if (argv[0] === "diagnose-conversation-routing") {
    const diagnosticArgs = argv.slice(1);
    const diagnosticCli = parseCliArgs(diagnosticArgs);
    const diagnosticSettings = diagnosticCli.configPath === undefined
      ? undefined
      : await loadSettings(diagnosticArgs);
    const identity = diagnosticSettings?.workspaceIdentity
      ?? diagnosticSettings?.workspaces?.find((entry) => entry.path === diagnosticSettings.workspace)
      ?? (diagnosticSettings === undefined
        ? undefined
        : new WorkspaceManager(diagnosticSettings.workspace).identity);
    console.log(JSON.stringify(await generateConversationRoutingExample(identity), null, 2));
  } else if (argv[0] === "diagnose-goal-e2e") {
    await runGoalE2EDiagnostic(argv.slice(1));
  } else if (argv[0] === "submit-goal") {
    try {
      console.log(JSON.stringify(await runGoalSubmissionCommand(argv.slice(1)), null, 2));
    } catch (error: unknown) {
      console.log(JSON.stringify(goalCliFailure(error), null, 2));
      process.exitCode = 1;
    }
  } else if (argv[0] === "goal-status") {
    try {
      console.log(JSON.stringify(await runGoalStatusCommand(argv.slice(1)), null, 2));
    } catch (error: unknown) {
      console.log(JSON.stringify(goalCliFailure(error, "status"), null, 2));
      process.exitCode = 1;
    }
  } else {
    const cli = parseCliArgs(argv);
    const settings = await loadSettings(argv);
    if (settings.supervisor?.enabled && !cli.runtimeOnly) {
      const supervisor = createSupervisor(settings, {
        runtimeScript: process.argv[1],
        runtimeConfigPath: cli.configPath,
      });
      const tray = new WindowsTrayApp(supervisor, {
        startupManager: createStartupManager(settings, {
          configPath: cli.configPath,
          runtimeScript: process.argv[1],
        }),
      });
      await supervisor.start();
      void tray.start().catch((error: unknown) => {
        console.warn("Windows tray failed to start; continuing without tray");
        printErrorDetails(error, true);
      });
      const workspace = settings.workspaceIdentity
        ?? settings.workspaces?.find((entry) => entry.path === settings.workspace);
      console.log([
        "Local Review MCP supervisor started",
        `Status: ${supervisor.state}`,
        `Workspace ID: ${workspace?.id ?? "unknown"}`,
        `Workspace Name: ${workspace?.name ?? "unknown"}`,
        registeredMcpToolsMessage(),
      ].join("\n"));
      let closing = false;
      const close = (): void => {
        if (closing) return;
        closing = true;
        void tray.stop().then(() => supervisor.stop()).catch(() => undefined);
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    } else {
      const context = createAppContext(settings);
      const server = await startApp(settings, context);
      console.log(startupMessage(settings, context));
      const remote = await context.tunnel.status();
      if (remote.endpoint !== undefined) console.log(`Remote endpoint: ${remote.endpoint}`);
      const close = (): void => { void server.close(); };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    }
  }
} catch (error: unknown) {
  printErrorDetails(error);
  process.exitCode = 1;
}
