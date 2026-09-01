import { posix, win32 } from "node:path";

export const WORKSPACE_ERROR_CODES = [
  "INVALID_PATH",
  "PATH_OUTSIDE_WORKSPACE",
  "SENSITIVE_PATH",
  "PATH_NOT_FOUND",
  "WORKSPACE_INVALID",
  "PATH_NOT_DIRECTORY",
  "BINARY_FILE",
  "INVALID_REGEX",
  "SEARCH_FAILED",
  "READ_SCAN_LIMIT_EXCEEDED",
] as const;

export type WorkspaceErrorCode = typeof WORKSPACE_ERROR_CODES[number];

export class WorkspacePathError extends Error {
  public readonly code: WorkspaceErrorCode;
  public readonly relativePath?: string;

  public constructor(code: WorkspaceErrorCode, message: string, relativePath?: string) {
    super(message);
    this.name = "WorkspacePathError";
    this.code = code;
    this.relativePath = relativePath;
  }
}

function invalidPath(): WorkspacePathError {
  return new WorkspacePathError("INVALID_PATH", "Invalid workspace-relative path.");
}

export function isReservedWindowsName(segment: string): boolean {
  const withoutTrailingWindowsSpace = segment.replace(/[ .]+$/u, "");
  const name = withoutTrailingWindowsSpace.split(".", 1)[0]?.toUpperCase();
  return name === "CON"
    || name === "PRN"
    || name === "AUX"
    || name === "NUL"
    || /^COM[1-9]$/u.test(name ?? "")
    || /^LPT[1-9]$/u.test(name ?? "");
}

export function containsAdsSyntax(input: string): boolean {
  const segments = input.replaceAll("\\", "/").split("/");
  return segments.some((segment, index) =>
    segment.includes(":") && !(index === 0 && /^[A-Za-z]:$/u.test(segment)));
}

export function normalizeRemotePath(input: string): string {
  if (typeof input !== "string" || input.includes("\0")) throw invalidPath();

  let value = input;
  if (value.startsWith("workspace:/")) value = value.slice("workspace:/".length);
  if (value.includes("\0")) throw invalidPath();
  if (value === "") return ".";

  const slashPath = value.replaceAll("\\", "/");
  const lowerSlashPath = slashPath.toLowerCase();
  if (slashPath.startsWith("/")
    || slashPath.startsWith("//")
    || lowerSlashPath.startsWith("/??/")
    || lowerSlashPath === "/??"
    || win32.isAbsolute(value)
    || posix.isAbsolute(slashPath)
    || /^[A-Za-z]:/u.test(value)
    || lowerSlashPath.startsWith("//?/")
    || lowerSlashPath.startsWith("//./")) {
    throw invalidPath();
  }

  const normalizedSegments: string[] = [];
  for (const segment of slashPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." || segment.includes(":") || isReservedWindowsName(segment)) {
      throw invalidPath();
    }
    normalizedSegments.push(segment);
  }

  return normalizedSegments.length === 0 ? "." : normalizedSegments.join("/");
}

export function assertSafeRemotePathSyntax(input: string): void {
  normalizeRemotePath(input);
}

export function isContainedPath(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    const relativePath = win32.relative(root.toLowerCase(), candidate.toLowerCase());
    return relativePath === ""
      || (relativePath !== ".."
        && !relativePath.startsWith("..\\")
        && !win32.isAbsolute(relativePath));
  }

  const relativePath = posix.relative(root, candidate);
  return relativePath === ""
    || (relativePath !== ".."
      && !relativePath.startsWith("../")
      && !posix.isAbsolute(relativePath));
}
