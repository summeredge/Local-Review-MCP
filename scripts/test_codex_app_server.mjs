import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const EXPECTED_REPLY = "CODEX_APP_SERVER_BACKEND_PASS";
const cwd = resolve(process.env.CODEX_APP_SERVER_CWD ?? process.cwd());
const requestedModel = process.env.CODEX_APP_SERVER_MODEL?.trim() || undefined;
const executable = process.env.CODEX_EXECUTABLE?.trim() || undefined;
const clientModule = new URL("../dist/src/backends/codex_app_server/client.js", import.meta.url);

let client;
let failed = false;

function pass(message) {
  console.log(`${message} PASS`);
}

function fail(message) {
  failed = true;
  console.error(`${message} FAIL`);
}

try {
  await access(clientModule, constants.R_OK);
  const { CodexAppServerClient } = await import(clientModule.href);
  client = await CodexAppServerClient.start({ cwd, executable });
  pass(`app-server started pid=${client.processInfo.process_id}`);

  await client.initialize();
  pass("initialize");
  pass("initialized");

  const models = await client.listModels();
  const selected = requestedModel === undefined
    ? models.find((model) => model.is_default === true)
    : models.find((model) => model.model === requestedModel);
  if (requestedModel !== undefined && selected === undefined) {
    throw new Error(`Requested model was not returned by model/list: ${requestedModel}`);
  }
  pass(`model/list models=${models.length}`);

  const thread = await client.startThread({
    cwd,
    ...(selected === undefined ? {} : { model: selected.model }),
  });
  pass(`thread/start thread_id=${thread.thread_id} session_id=${thread.session_id}`);

  const turn = await client.startTurn({
    threadId: thread.thread_id,
    text: `Please reply with exactly:\n${EXPECTED_REPLY}\nDo not modify files. Do not execute commands.`,
    ...(selected === undefined ? {} : {
      model: selected.model,
      ...(selected.default_effort === undefined ? {} : { effort: selected.default_effort }),
    }),
  });
  pass(`turn/start turn_id=${turn.turn_id}`);

  let deltaText = "";
  let completedText = "";
  let receivedCompleted = false;
  for await (const event of client.events()) {
    switch (event.type) {
      case "agent_message_delta":
        deltaText += event.content;
        break;
      case "agent_message_completed":
        completedText = event.content;
        break;
      case "turn_completed":
        receivedCompleted = true;
        break;
      case "turn_failed":
        throw new Error(`turn_failed${event.reason === undefined ? "" : `: ${event.reason}`}`);
      default:
        break;
    }
    if (receivedCompleted) break;
  }
  if (!receivedCompleted) throw new Error("turn/completed event was not received.");
  pass("event turn/completed");

  const reply = (deltaText || completedText).trim();
  if (reply !== EXPECTED_REPLY) {
    throw new Error(`Unexpected final output: ${JSON.stringify(reply)}`);
  }
  console.log(`output ${reply}`);
  console.log(EXPECTED_REPLY);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (client !== undefined) {
    const exit = await client.close().catch((error) => {
      fail(error instanceof Error ? error.message : String(error));
      return undefined;
    });
    if (exit !== undefined) {
      console.log(`app-server stopped status=${client.processInfo.status} stderr_chars=${exit.stderr.length}`);
    }
  }
}

if (failed) process.exitCode = 1;
