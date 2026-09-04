import { z } from "zod";
import { workspaceIdSchema, workspaceNameSchema } from "./common.js";

const gitStatusSummarySchema = z.object({
  modified: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
});

const diffSummarySchema = z.object({
  files_changed: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const reviewSummaryOutputSchema = z.object({
  workspace_id: workspaceIdSchema,
  workspace_name: workspaceNameSchema,
  git_branch: z.string().nullable(),
  git_status_summary: gitStatusSummarySchema,
  diff_summary: diffSummarySchema,
});

export type ReviewSummaryOutput = z.infer<typeof reviewSummaryOutputSchema>;

export const executionOutputOutputSchema = z.object({
  available: z.boolean().optional(),
  timestamp: z.string().optional(),
  command: z.string().optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
}).passthrough();

export type ExecutionOutputOutput = z.infer<typeof executionOutputOutputSchema>;
