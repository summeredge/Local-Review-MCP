import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CodexAppRuntimeError } from "./codex-app-runtime.js";

type JsonSchema = Readonly<Record<string, unknown>>;

interface ToolContract {
  readonly name: string;
  readonly inputSchema: JsonSchema;
}

export interface CreateThreadArguments {
  readonly [key: string]: unknown;
  readonly prompt: string;
  readonly target: {
    readonly type: "project";
    readonly projectId: string;
    readonly environment: { readonly type: "local" };
  };
}

export interface SendMessageToThreadArguments {
  readonly [key: string]: unknown;
  readonly threadId: string;
  readonly hostId: string;
  readonly prompt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaRecord(value: unknown): JsonSchema | undefined {
  return isRecord(value) ? value : undefined;
}

function schemaProperties(schema: JsonSchema): Record<string, JsonSchema> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const result: Record<string, JsonSchema> = {};
  for (const [name, value] of Object.entries(properties)) {
    const property = schemaRecord(value);
    if (property !== undefined) result[name] = property;
  }
  return result;
}

function requiredFields(schema: JsonSchema): readonly string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
}

function requirementsWithin(schema: JsonSchema, allowed: ReadonlySet<string>): boolean {
  return requiredFields(schema).every((field) => allowed.has(field));
}

function schemaBranches(schema: JsonSchema): readonly JsonSchema[] {
  const branches: JsonSchema[] = [schema];
  for (const key of ["anyOf", "oneOf"] as const) {
    if (!Array.isArray(schema[key])) continue;
    for (const value of schema[key]) {
      const branch = schemaRecord(value);
      if (branch !== undefined) branches.push(...schemaBranches(branch));
    }
  }
  return branches;
}

function schemaType(schema: JsonSchema, expected: string): boolean {
  return schema.type === expected
    || (Array.isArray(schema.type) && schema.type.includes(expected));
}

function isStringSchema(schema: JsonSchema | undefined): boolean {
  if (schema === undefined) return false;
  if (schemaType(schema, "string")) return true;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.every((value) => typeof value === "string");
  }
  return schemaBranches(schema).some((branch) => branch !== schema && isStringSchema(branch));
}

function acceptsLiteral(schema: JsonSchema | undefined, value: string): boolean {
  if (schema === undefined) return false;
  return schema.const === value || (Array.isArray(schema.enum) && schema.enum.includes(value));
}

function variantForType(schema: JsonSchema | undefined, value: string): JsonSchema | undefined {
  if (schema === undefined) return undefined;
  for (const branch of schemaBranches(schema)) {
    if (acceptsLiteral(schemaProperties(branch).type, value)) return branch;
  }
  return undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function toolContracts(tools: readonly Tool[]): Map<string, ToolContract> {
  const result = new Map<string, ToolContract>();
  for (const tool of tools) {
    const name = nonEmpty(tool.name);
    const inputSchema = schemaRecord(tool.inputSchema);
    if (name !== undefined && inputSchema !== undefined) result.set(name, { name, inputSchema });
  }
  return result;
}

function incompatible(name: string): CodexAppRuntimeError {
  return new CodexAppRuntimeError("tool_contract_incompatible", `${name} tool contract is incompatible.`);
}

export class CodexAppToolContracts {
  public constructor(private readonly tools: ReadonlyMap<string, ToolContract>) {}

  public requireListProjects(): void {
    const tool = this.tools.get("list_projects");
    if (tool === undefined || requiredFields(tool.inputSchema).length !== 0) {
      throw incompatible("list_projects");
    }
  }

  public createThreadArguments(prompt: string, projectId: string): CreateThreadArguments {
    const tool = this.tools.get("create_thread");
    if (tool === undefined) throw incompatible("create_thread");
    const schema = tool.inputSchema;
    const properties = schemaProperties(schema);
    if (!requirementsWithin(schema, new Set(["prompt", "target"]))) throw incompatible("create_thread");
    if (!isStringSchema(properties.prompt)) throw incompatible("create_thread");

    const projectTarget = variantForType(properties.target, "project");
    if (projectTarget === undefined) throw incompatible("create_thread");
    const targetProperties = schemaProperties(projectTarget);
    if (!requirementsWithin(projectTarget, new Set(["type", "projectId", "environment"]))) {
      throw incompatible("create_thread");
    }
    if (!isStringSchema(targetProperties.projectId)) throw incompatible("create_thread");
    const localEnvironment = variantForType(targetProperties.environment, "local");
    if (localEnvironment === undefined || !requirementsWithin(localEnvironment, new Set(["type"]))) {
      throw incompatible("create_thread");
    }
    return {
      prompt,
      target: {
        type: "project",
        projectId,
        environment: { type: "local" },
      },
    };
  }

  public sendMessageToThreadArguments(
    threadId: string,
    hostId: string,
    prompt: string,
  ): SendMessageToThreadArguments {
    const tool = this.tools.get("send_message_to_thread");
    if (tool === undefined) throw incompatible("send_message_to_thread");
    const schema = tool.inputSchema;
    const properties = schemaProperties(schema);
    if (!requirementsWithin(schema, new Set(["threadId", "hostId", "prompt"]))) {
      throw incompatible("send_message_to_thread");
    }
    if (!isStringSchema(properties.threadId)
      || !isStringSchema(properties.hostId)
      || !isStringSchema(properties.prompt)) {
      throw incompatible("send_message_to_thread");
    }
    return { threadId, hostId, prompt };
  }
}

export function createCodexAppToolContracts(tools: readonly Tool[]): CodexAppToolContracts {
  return new CodexAppToolContracts(toolContracts(tools));
}
