import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  conversationIdSchema,
  executionIdSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";
import {
  GoalPreflightError,
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
}).strict();

export const goalSubmissionResultSchema = z.object({
  goal_id: goalIdSchema,
  phase_id: phaseIdSchema,
  task_id: taskIdSchema,
  execution_id: executionIdSchema,
  status: goalOrchestrationStatusSchema,
}).strict();

export type GoalSubmissionRequest = z.input<typeof goalSubmissionRequestSchema>;
export type GoalSubmissionResult = z.infer<typeof goalSubmissionResultSchema>;
export type GoalSubmissionOrchestration = Pick<
  GoalOrchestrationService,
  "createGoal" | "startGoal"
>;
export type GoalSubmissionPreflight = Pick<GoalPreflightService, "checkGoalPreflight">;

function generatedId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function buildPlan(request: z.output<typeof goalSubmissionRequestSchema>): CreateGoalInput {
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
  });
}

export class GoalSubmissionService {
  public constructor(
    private readonly orchestration: GoalSubmissionOrchestration,
    private readonly preflight: GoalSubmissionPreflight,
  ) {}

  public async submitGoal(request: GoalSubmissionRequest): Promise<GoalSubmissionResult> {
    const parsed = goalSubmissionRequestSchema.parse(request);
    const preflight = await this.preflight.checkGoalPreflight({
      workspace_id: parsed.workspace_id,
      conversation_id: parsed.conversation_id,
    });
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
