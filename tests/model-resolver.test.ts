import { describe, expect, it } from "vitest";
import type { Session } from "../src/context/types.js";
import type { ActuationAuthorizationInput } from "../src/control-plane/controlled-actuation.js";
import type { ExecutionBackendStartRequest } from "../src/control-plane/execution-service.js";
import type { PendingGoalSubmissionInput } from "../src/control-plane/pending-goal-submission.js";
import type { ResolvedGoalSubmissionRequest } from "../src/control-plane/goal-submission.js";
import type { CreateThreadInput } from "../src/desktop-codex/thread-commands.js";
import type { CreateOrReuseThreadInput } from "../src/desktop-codex/desktop-thread-coordinator.js";
import { MODEL_CATALOG } from "../src/models/model-catalog.js";
import { ModelResolutionError, resolveModel } from "../src/models/model-resolver.js";

type Assert<T extends true> = T;
type NoCamelModelFields<T> = Extract<keyof T, "modelId" | "reasoningEffort"> extends never ? true : false;
export type InternalModelFieldsStaySnakeCase = Assert<
  NoCamelModelFields<Session>
  & NoCamelModelFields<ActuationAuthorizationInput>
  & NoCamelModelFields<ExecutionBackendStartRequest>
  & NoCamelModelFields<PendingGoalSubmissionInput>
  & NoCamelModelFields<ResolvedGoalSubmissionRequest>
  & NoCamelModelFields<CreateThreadInput>
  & NoCamelModelFields<CreateOrReuseThreadInput>
>;

describe("model catalog and resolver", () => {
  it("registers the current canonical model IDs", () => {
    expect(MODEL_CATALOG.map(({ model_id, display_name }) => [model_id, display_name])).toEqual([
      ["gpt-5.6-luna", "GPT-5.6 Luna"],
      ["gpt-6-luna", "GPT-6 Luna"],
      ["gpt-6-astra", "GPT-6 Astra"],
      ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ]);
  });

  it("resolves normalized names and a reasoning suffix", () => {
    expect(resolveModel({ model: "GPT-6 Luna Max" })).toEqual({
      model_id: "gpt-6-luna",
      display_name: "GPT-6 Luna",
      reasoning_effort: "max",
      match_type: "normalized",
    });
  });

  it("uses an explicit reasoning effort over the model-name suffix", () => {
    expect(resolveModel({ model: "GPT-6 Luna Max", reasoning_effort: "high" })).toMatchObject({
      model_id: "gpt-6-luna",
      reasoning_effort: "high",
      match_type: "normalized",
    });
  });

  it("supports aliases and reports fuzzy ambiguity", () => {
    expect(resolveModel({ model: "luna" })).toMatchObject({ model_id: "gpt-6-luna", match_type: "alias" });
    expect(() => resolveModel({ model: "GPT-6" })).toThrowError(expect.objectContaining({
      name: "ModelResolutionError",
      details: { code: "model_ambiguous", input: "GPT-6", candidates: ["gpt-6-luna", "gpt-6-astra", "gpt-6.1-sol"] },
    }));
  });

  it.each([
    ["", "model_empty"],
  ] as const)("rejects invalid model input %j", (model, code) => {
    try {
      resolveModel({ model });
      throw new Error("Expected model resolution to fail.");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ModelResolutionError);
      expect((error as ModelResolutionError).details.code).toBe(code);
    }
  });

  it("distinguishes invalid and unsupported reasoning effort", () => {
    expect(() => resolveModel({ model: "gpt-6-luna", reasoning_effort: "reasoning-plus" }))
      .toThrowError(expect.objectContaining({
        details: { code: "reasoning_effort_invalid", input: "gpt-6-luna", reasoning_effort: "reasoning-plus" },
      }));
    expect(() => resolveModel({ model: "gpt-5.6-luna", reasoning_effort: "ultra" }))
      .toThrowError(expect.objectContaining({
        details: { code: "reasoning_effort_unsupported", input: "gpt-5.6-luna", reasoning_effort: "ultra" },
      }));
  });
});
