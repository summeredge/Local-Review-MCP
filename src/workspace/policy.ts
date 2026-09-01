import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { globToRegExp } from "./glob.js";
import {
  isContainedPath,
  normalizeRemotePath,
  WorkspacePathError,
} from "./path.js";

export const MAX_IGNORE_FILE_BYTES = 256 * 1024;
export const MAX_IGNORE_RULES = 2048;

interface IgnoreRule {
  readonly pattern: string;
  readonly matcher: RegExp;
  readonly hasSlash: boolean;
}

function policyInitializationError(): WorkspacePathError {
  return new WorkspacePathError("WORKSPACE_INVALID", "Workspace access policy could not be loaded.");
}

function parseIgnoreRules(contents: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of contents.split(/\r?\n/u)) {
    const pattern = line.trim();
    if (pattern === "" || pattern.startsWith("#")) continue;
    if (rules.length >= MAX_IGNORE_RULES) throw policyInitializationError();
    if (pattern.startsWith("!")) throw policyInitializationError();

    let normalizedPattern: string;
    try {
      normalizedPattern = normalizeRemotePath(pattern);
    } catch {
      throw policyInitializationError();
    }

    rules.push({
      pattern: normalizedPattern,
      matcher: globToRegExp(normalizedPattern),
      hasSlash: normalizedPattern.includes("/"),
    });
  }
  return rules;
}

function readIgnoreRules(workspaceRoot: string): IgnoreRule[] {
  const ignorePath = join(workspaceRoot, ".localreviewignore");
  try {
    lstatSync(ignorePath);
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw policyInitializationError();
  }

  let canonicalIgnorePath: string;
  try {
    canonicalIgnorePath = realpathSync.native(ignorePath);
    if (!isContainedPath(workspaceRoot, canonicalIgnorePath)) throw policyInitializationError();
    const stats = statSync(canonicalIgnorePath);
    if (!stats.isFile() || stats.size > MAX_IGNORE_FILE_BYTES) throw policyInitializationError();
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) throw error;
    throw policyInitializationError();
  }

  try {
    return parseIgnoreRules(readFileSync(canonicalIgnorePath, "utf8"));
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) throw error;
    throw policyInitializationError();
  }
}

function comparable(value: string): string {
  return process.platform === "win32" ? value.replace(/[ .]+$/u, "").toLowerCase() : value;
}

function isDefaultSensitive(relativePath: string): boolean {
  const segments = relativePath === "." ? [] : relativePath.split("/");
  const names = segments.map(comparable);

  for (const name of names) {
    if (name === ".git" || name === ".ssh" || name === ".aws"
      || name === ".gnupg" || name === ".cloudflared") return true;

    if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) return true;

    if (name === ".npmrc" || name === ".netrc" || name === "_netrc"
      || name === ".git-credentials" || name === "credentials.json"
      || name === "secrets.json" || /^service-account.*\.json$/u.test(name)
      || name === "id_rsa" || name === "id_ed25519" || name === "id_ecdsa"
      || name === "id_dsa") return true;

    if ([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]
      .some((extension) => name.endsWith(extension))) return true;
  }

  return names.includes(".localreviewignore");
}

function matchesIgnoreRule(rule: IgnoreRule, relativePath: string): boolean {
  const segments = relativePath === "." ? [] : relativePath.split("/");
  const ancestors: string[] = [];
  for (let length = 1; length <= segments.length; length += 1) {
    ancestors.push(segments.slice(0, length).join("/"));
  }

  if (ancestors.some((ancestor) => rule.matcher.test(ancestor))) return true;
  if (!rule.hasSlash && segments.some((segment) => rule.matcher.test(segment))) return true;

  if (rule.pattern.endsWith("/**")) {
    const directory = rule.pattern.slice(0, -3);
    if (ancestors.includes(directory)) return true;
  }
  return false;
}

export class AccessPolicy {
  public readonly workspaceRoot: string;
  private readonly ignoreRules: readonly IgnoreRule[];

  public constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.ignoreRules = readIgnoreRules(workspaceRoot);
  }

  public isSensitive(relativePath: string): boolean {
    const normalizedPath = normalizeRemotePath(relativePath);
    return isDefaultSensitive(normalizedPath)
      || this.ignoreRules.some((rule) => matchesIgnoreRule(rule, normalizedPath));
  }

  public assertAllowed(relativePath: string): void {
    const normalizedPath = normalizeRemotePath(relativePath);
    if (isDefaultSensitive(normalizedPath)
      || this.ignoreRules.some((rule) => matchesIgnoreRule(rule, normalizedPath))) {
      throw new WorkspacePathError(
        "SENSITIVE_PATH",
        `Access denied for sensitive workspace path "${normalizedPath}".`,
        normalizedPath,
      );
    }
  }

}

export { WorkspacePathError } from "./path.js";
export type { WorkspaceErrorCode } from "./path.js";
