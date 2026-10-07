import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  conversationIdSchema,
  executionIdSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";
import { correlationKeySchema } from "../mcp/schema/common.js";
import {
  GoalPreflightError,
  type GoalConnectorProvenance,
  type GoalPreflightService,
} from "./goal-preflight.js";
import {
  createGoalInputSchema,
  goalTaskPlanSchema,
  goalIdSchema,
  goalOrchestrationStatusSchema,
  phaseIdSchema,
} from "./goal-orchestration.js";
import type {
  CreateGoalInput,
  GoalOrchestrationService,
} from "./goal-orchestration.js";
import { executionModeSchema } from "./execution-service.js";
import { reasoningEffortValueSchema, type ReasoningEffort } from "../models/model-catalog.js";
import { parseReasoningEffort, resolveModel } from "../models/model-resolver.js";

export const DEFAULT_GOAL_MAX_ITERATIONS = 2;
const submissionTextSchema = goalTaskPlanSchema.shape.goal;
const submissionItemsSchema = goalTaskPlanSchema.shape.requirements;

export const goalSubmissionRequestSchema = z.object({
  workspace_id: workspaceIdSchema,
  conversation_id: conversationIdSchema,
  title: submissionTextSchema,
  goal: submissionTextSchema,
  requirements: submissionItemsSchema,
  acceptance_criteria: submissionItemsSchema,
  max_iterations: z.number().int().min(1).max(10_000).default(DEFAULT_GOAL_MAX_ITERATIONS),
  execution_mode: executionModeSchema.default("batch"),
  model: z.string().min(1).max(256).optional(),
  reasoning_effort: z.string().min(1).max(64).optional(),
}).strict();

export const goalSubmissionToolInputSchema = goalSubmissionRequestSchema
  .omit({ workspace_id: true, conversation_id: true })
  .extend({ workspace_id: z.string().min(1).max(128).optional() })
  .extend({ correlation_key: correlationKeySchema })
  .strict();

export const resolvedGoalSubmissionRequestSchema = goalSubmissionRequestSchema
  .omit({ model: true, reasoning_effort: true })
  .extend({
    model_id: z.string().min(1).max(256).optional(),
    reasoning_effort: reasoningEffortValueSchema.optional(),
  })
  .strict();

export const goalSubmissionResultSchema = z.object({
  goal_id: goalIdSchema,
  phase_id: phaseIdSchema,
  task_id: taskIdSchema,
  execution_id: executionIdSchema,
  status: goalOrchestrationStatusSchema,
}).strict();

const goalSubmissionTimestampSchema = z.string().datetime({ offset: true });

export const goalSubmissionAcceptedSchema = z.object({
  accepted: z.literal(true),
  correlation_key: correlationKeySchema,
  accepted_at: goalSubmissionTimestampSchema,
  expires_at: goalSubmissionTimestampSchema,
}).strict();

export type GoalSubmissionRequest = z.input<typeof goalSubmissionRequestSchema>;
export type ResolvedGoalSubmissionRequest = z.input<typeof resolvedGoalSubmissionRequestSchema>;
export type GoalSubmissionResult = z.infer<typeof goalSubmissionResultSchema>;
export type GoalSubmissionAccepted = z.infer<typeof goalSubmissionAcceptedSchema>;
export type GoalSubmissionOrchestration = Pick<
  GoalOrchestrationService,
  "createGoal" | "startGoal"
>;
export type GoalSubmissionPreflight = Pick<GoalPreflightService, "checkGoalPreflight">;

function generatedId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function resolveGoalModelFields(
  model?: string,
  reasoning_effort?: string,
): { model_id?: string; reasoning_effort?: ReasoningEffort } {
  if (model === undefined) {
    return reasoning_effort === undefined ? {} : { reasoning_effort: parseReasoningEffort(reasoning_effort) };
  }
  const resolved = resolveModel({
    model,
    ...(reasoning_effort === undefined ? {} : { reasoning_effort }),
  });
  return {
    model_id: resolved.model_id,
    ...(resolved.reasoning_effort === undefined ? {} : { reasoning_effort: resolved.reasoning_effort }),
  };
}

function buildPlan(request: z.output<typeof resolvedGoalSubmissionRequestSchema>): CreateGoalInput {
  const phaseId = generatedId("phase");
  return createGoalInputSchema.parse({
    goal_id: generatedId("goal"),
    workspace_id: request.workspace_id,
    conversation_id: request.conversation_id,
    phases: [{
      phase_id: phaseId,
      objective: request.title,
      tasks: [{
        task_id: generatedId("task"),
        goal: request.goal,
        requirements: request.requirements,
        acceptance_criteria: request.acceptance_criteria,
        max_iterations: request.max_iterations,
      }],
    }],
    execution_mode: request.execution_mode,
    ...(request.model_id === undefined ? {} : { model_id: request.model_id }),
    ...(request.reasoning_effort === undefined ? {} : { reasoning_effort: request.reasoning_effort }),
  });
}

export class GoalSubmissionService {
  public constructor(
    private readonly orchestration: GoalSubmissionOrchestration,
    private readonly preflight: GoalSubmissionPreflight,
  ) {}

  public async submitExternalGoal(
    request: GoalSubmissionRequest,
    connectorProvenance?: GoalConnectorProvenance,
  ): Promise<GoalSubmissionResult> {
    const parsed = goalSubmissionRequestSchema.parse(request);
    const { model, reasoning_effort, ...base } = parsed;
    return this.submitGoal({
      ...base,
      ...resolveGoalModelFields(model, reasoning_effort),
    }, connectorProvenance);
  }

  public async submitGoal(
    request: ResolvedGoalSubmissionRequest,
    connectorProvenance?: GoalConnectorProvenance,
  ): Promise<GoalSubmissionResult> {
    const parsed = resolvedGoalSubmissionRequestSchema.parse(request);
    const preflightInput = {
      workspace_id: parsed.workspace_id,
      conversation_id: parsed.conversation_id,
      // The interactive Desktop route has a backend capability precondition; batch does not.
      ...(parsed.execution_mode === "interactive" ? { execution_mode: parsed.execution_mode } : {}),
    };
    const preflight = connectorProvenance === undefined
      ? await this.preflight.checkGoalPreflight(preflightInput)
      : await this.preflight.checkGoalPreflight(preflightInput, connectorProvenance);
    if (!preflight.ready) throw new GoalPreflightError(preflight);
    const plan = buildPlan(parsed);
    const created = await this.orchestration.createGoal(plan);
    const started = await this.orchestration.startGoal({ goal_id: created.goal_id });
    const phase = plan.phases[0]!;
    if (started.execution_id === undefined) {
      throw new Error(`Goal "${created.goal_id}" did not produce an Execution.`);
    }
    const result: GoalSubmissionResult = {
      goal_id: created.goal_id,
      phase_id: started.current_phase_id ?? phase.phase_id,
      task_id: started.current_task_id ?? phase.tasks[0]!.task_id,
      execution_id: started.execution_id,
      status: started.status,
    };
    return goalSubmissionResultSchema.parse(result);
  }
}
