// P5.7.2 evidence: run the migration against copies of the real user files.
//
// The copies keep the real content; only the hooks.json path inside the config copy is rewritten
// to the dry-run path, because the trust-state key is an ownership claim on one exact file.
// Nothing under ~/.codex is touched here; the real run happens through the CLI afterwards.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { migrateLrmSessionStartHookRegistration } from "../../dist/src/desktop-codex/desktop-hook-installer.js";

const realHooks = join(homedir(), ".codex", "hooks.json");
const realConfig = join(homedir(), ".codex", "config.toml");
const dir = resolve(".review/p5-7-2-hook-consolidation/dry-run");
mkdirSync(dir, { recursive: true });

const hooksFilePath = join(dir, "hooks.json");
const configPath = join(dir, "config.toml");
copyFileSync(realHooks, hooksFilePath);
copyFileSync(realConfig, configPath);

const configBefore = readFileSync(configPath, "utf8");
const rewritten = configBefore.split(realHooks).join(hooksFilePath);
if (rewritten === configBefore) throw new Error("real hooks path not found in config copy");
writeFileSync(configPath, rewritten, "utf8");

const result = migrateLrmSessionStartHookRegistration({ hooksFilePath, configPath });

const hooksAfter = JSON.parse(readFileSync(hooksFilePath, "utf8"));
const configAfter = readFileSync(configPath, "utf8");
const beforeLines = rewritten.split("\n");
const afterLines = configAfter.split("\n");
const legacyStart = beforeLines.findIndex(
  (line) => line.startsWith("[hooks.state.'") && line.includes(":session_start:"),
);
if (legacyStart < 0) throw new Error("legacy trust table not found in config copy");
const withoutLegacyBlock = [
  ...beforeLines.slice(0, legacyStart),
  ...beforeLines.slice(legacyStart + 4),
].join("\n");

const evidence = {
  result,
  hooks: {
    sessionStartCommands: (hooksAfter.hooks.SessionStart ?? []).map((e) => e.hooks[0].command),
    userPromptSubmitEntries: (hooksAfter.hooks.UserPromptSubmit ?? []).length,
    stopEntries: (hooksAfter.hooks.Stop ?? []).length,
    description: hooksAfter.description,
  },
  config: {
    lineCountBefore: beforeLines.length,
    lineCountAfter: afterLines.length,
    removedLineCount: beforeLines.length - afterLines.length,
    unchangedApartFromRemovedTable: withoutLegacyBlock === configAfter,
    remainingSessionStartKeys: configAfter
      .split("\n")
      .filter((line) => line.includes("hooks.state") && line.includes("session_start")),
  },
};
writeFileSync(join(dir, "dry-run-evidence.json"), JSON.stringify(evidence, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
