import {
  MODEL_CATALOG,
  REASONING_EFFORTS,
  type ModelCatalogEntry,
  type ReasoningEffort,
} from "./model-catalog.js";

export interface ResolveModelInput {
  readonly model: string;
  readonly reasoning_effort?: string;
}

export interface ResolvedModel {
  readonly model_id: string;
  readonly display_name: string;
  readonly reasoning_effort?: ReasoningEffort;
  readonly match_type: "canonical" | "normalized" | "alias" | "fuzzy";
}

export type ModelResolutionErrorCode =
  | "model_empty"
  | "model_unknown"
  | "model_ambiguous"
  | "reasoning_effort_invalid"
  | "reasoning_effort_unsupported";

export interface ModelResolutionErrorDetails {
  readonly code: ModelResolutionErrorCode;
  readonly input: string;
  readonly candidates?: readonly string[];
  readonly reasoning_effort?: string;
}

export class ModelResolutionError extends Error {
  public constructor(public readonly details: ModelResolutionErrorDetails) {
    super(errorMessage(details));
    this.name = "ModelResolutionError";
  }
}

function errorMessage(details: ModelResolutionErrorDetails): string {
  switch (details.code) {
    case "model_empty": return "Model is required.";
    case "model_unknown": return `Unknown model: ${details.input}`;
    case "model_ambiguous": return `Model is ambiguous: ${details.input}`;
    case "reasoning_effort_invalid": return `Invalid reasoning_effort: ${details.reasoning_effort}`;
    case "reasoning_effort_unsupported": {
      return `Reasoning effort ${details.reasoning_effort} is not supported by ${details.input}.`;
    }
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function fail(details: ModelResolutionErrorDetails): never {
  throw new ModelResolutionError(details);
}

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function parseReasoningEffort(
  reasoning_effort: string,
  model?: ModelCatalogEntry,
  input = "",
): ReasoningEffort {
  const normalized = reasoning_effort.trim().toLowerCase();
  if (!isReasoningEffort(normalized)) {
    return fail({ code: "reasoning_effort_invalid", input, reasoning_effort });
  }
  if (model !== undefined && !model.reasoning_efforts.includes(normalized)) {
    return fail({ code: "reasoning_effort_unsupported", input, reasoning_effort: normalized });
  }
  return normalized;
}

function ambiguous(input: string, entries: readonly ModelCatalogEntry[]): never {
  return fail({
    code: "model_ambiguous",
    input,
    candidates: entries.map(({ model_id }) => model_id),
  });
}

export function resolveModel(input: ResolveModelInput): ResolvedModel {
  const value = input.model.trim();
  if (value === "") return fail({ code: "model_empty", input: input.model });

  const exactCanonical = MODEL_CATALOG.find((entry) => entry.model_id === value);
  const effortSuffix = exactCanonical === undefined
    ? value.match(/^(.*?)[\s._-]+(none|minimal|low|medium|high|xhigh|max|ultra)$/iu)
    : null;
  const modelName = (effortSuffix?.[1] ?? value).trim();
  const inferredEffort = effortSuffix?.[2];
  const candidates = (query: string): ModelCatalogEntry[] => {
    const normalizedQuery = normalize(query);
    const matches = MODEL_CATALOG.filter((entry) =>
      [entry.model_id, entry.display_name, ...entry.aliases]
        .some((name) => normalize(name).includes(normalizedQuery)));
    return matches;
  };

  let model = exactCanonical;
  let match_type: ResolvedModel["match_type"] = "canonical";
  let ambiguousSuffixBase = false;

  if (model === undefined) {
    const normalizedName = normalize(modelName);
    const normalizedMatches = MODEL_CATALOG.filter((entry) =>
      normalize(entry.model_id) === normalizedName || normalize(entry.display_name) === normalizedName);
    if (normalizedMatches.length > 1) {
      if (effortSuffix === null) ambiguous(value, normalizedMatches);
      ambiguousSuffixBase = true;
    } else {
      model = normalizedMatches[0];
      if (model !== undefined) match_type = "normalized";
    }
  }

  if (model === undefined && !ambiguousSuffixBase) {
    const normalizedName = normalize(modelName);
    const aliasMatches = MODEL_CATALOG.filter((entry) =>
      entry.aliases.some((alias) => normalize(alias) === normalizedName));
    if (aliasMatches.length > 1) {
      if (effortSuffix === null) ambiguous(value, aliasMatches);
      ambiguousSuffixBase = true;
    } else {
      model = aliasMatches[0];
      if (model !== undefined) match_type = "alias";
    }
  }

  if (model === undefined && !ambiguousSuffixBase && normalize(modelName).length >= 3) {
    const fuzzyMatches = candidates(modelName);
    if (fuzzyMatches.length > 1) {
      if (effortSuffix === null) ambiguous(value, fuzzyMatches);
      ambiguousSuffixBase = true;
    } else {
      model = fuzzyMatches[0];
      if (model !== undefined) match_type = "fuzzy";
    }
  }

  // Provider catalogs validate opaque canonical IDs later through model/list.
  const dynamicModel = model === undefined;
  const resolvedModelName = dynamicModel ? value : modelName;

  const effortValue = input.reasoning_effort ?? (dynamicModel ? undefined : inferredEffort);
  const reasoning_effort = effortValue === undefined
    ? undefined
    : parseReasoningEffort(effortValue, model, value);
  return {
    model_id: model?.model_id ?? resolvedModelName,
    display_name: model?.display_name ?? resolvedModelName,
    ...(reasoning_effort === undefined ? {} : { reasoning_effort }),
    match_type: dynamicModel ? "canonical" : match_type,
  };
}

/** Converts records written before model_id became the persisted domain field. */
export function migrateLegacyModelIdFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(migrateLegacyModelIdFields);
  if (typeof value !== "object" || value === null) return value;

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key !== "model") result[key] = migrateLegacyModelIdFields(child);
  }
  if (source.model_id === undefined && typeof source.model === "string") {
    try {
      result.model_id = resolveModel({ model: source.model }).model_id;
    } catch {
      result.model_id = source.model;
    }
  }
  return result;
}
