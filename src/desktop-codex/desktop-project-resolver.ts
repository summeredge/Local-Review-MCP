import { isAbsolute, resolve, win32 } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CodexAppRuntimeError } from "./codex-app-runtime.js";

export interface DesktopProject {
  readonly projectId: string;
  readonly hostId: string;
  readonly path: string;
}

export interface DesktopProjectRecord {
  readonly projectId: string;
  readonly path: string;
  readonly projectKind: string;
  readonly hostId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function safeIdentity(value: unknown): string | undefined {
  const text = nonEmpty(value);
  return text !== undefined && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(text) ? text : undefined;
}

function absolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function normalizedPath(value: string): string {
  return resolve(value).replace(/[\\/]+/gu, "\\").replace(/\\$/u, "").toLowerCase();
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!(text.startsWith("{") || text.startsWith("["))) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function projectRecordsFromSource(source: unknown): readonly Record<string, unknown>[] | undefined {
  if (typeof source === "string") return projectRecordsFromSource(parseJsonText(source));
  if (!isRecord(source) || !Array.isArray(source.projects)) return undefined;
  if (!source.projects.every(isRecord)) throw new CodexAppRuntimeError(
    "invalid_project_result",
    "list_projects returned an invalid project record.",
  );
  return source.projects;
}

function projectRecords(result: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(result)) {
    throw new CodexAppRuntimeError("invalid_project_result", "list_projects returned an invalid result.");
  }
  if (result.isError === true) {
    throw new CodexAppRuntimeError("tool_call_failed", "list_projects returned an error.", { cause: result });
  }

  const sources: unknown[] = [result];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isRecord(item) || item.type !== "text") continue;
      sources.push(item.text);
    }
  }
  if (result.structuredContent !== undefined) sources.push(result.structuredContent);

  for (const source of sources) {
    const records = projectRecordsFromSource(source);
    if (records !== undefined) return records;
  }
  throw new CodexAppRuntimeError("invalid_project_result", "list_projects returned no project list.");
}

function parseProject(record: Record<string, unknown>): DesktopProjectRecord {
  const projectId = safeIdentity(record.projectId);
  const path = nonEmpty(record.path);
  const projectKind = nonEmpty(record.projectKind);
  const hostId = safeIdentity(record.hostId);
  if (projectId === undefined || path === undefined || projectKind === undefined || hostId === undefined
    || !absolutePath(path)) {
    throw new CodexAppRuntimeError("invalid_project_result", "list_projects returned an invalid project record.");
  }
  return { projectId, path, projectKind, hostId };
}

export function parseDesktopProjects(result: CallToolResult): readonly DesktopProjectRecord[] {
  return projectRecords(result).map(parseProject);
}

export function resolveDesktopProject(
  result: CallToolResult,
  workspacePath: string,
): DesktopProject {
  const expectedPath = normalizedPath(workspacePath);
  const matches = projectRecords(result)
    .filter((record) => nonEmpty(record.projectKind) === "local")
    .map(parseProject)
    .filter((project) => project.hostId === "local")
    .filter((project) => normalizedPath(project.path) === expectedPath);
  if (matches.length === 0) {
    throw new CodexAppRuntimeError("project_not_found", "No exact local Desktop project matched the workspace.");
  }
  if (matches.length > 1) {
    throw new CodexAppRuntimeError("project_ambiguous", "More than one exact local Desktop project matched the workspace.");
  }
  const match = matches[0]!;
  return {
    projectId: match.projectId,
    hostId: match.hostId,
    path: resolve(match.path),
  };
}
