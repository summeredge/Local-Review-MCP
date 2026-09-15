import { z } from "zod";
import { gitStatusEntryOutputSchema } from "./git.js";
import {
  rootAliasSchema,
  workspaceContextSchema,
  workspaceIdSchema,
  workspaceRelativePathSchema,
} from "./common.js";

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

export const workspaceReviewInfoOutputSchema = z.object({
  workspace_id: workspaceIdSchema,
  root: rootAliasSchema,
  branch: z.string().nullable(),
  status: z.enum(["clean", "dirty"]),
});

export const workspaceReviewListFilesOutputSchema = z.object({
  workspace_id: workspaceIdSchema,
  path: workspaceRelativePathSchema,
  files: z.array(workspaceRelativePathSchema),
  has_more: z.boolean(),
});

export const workspaceReviewReadFileOutputSchema = z.object({
  workspace_id: workspaceIdSchema,
  path: workspaceRelativePathSchema,
  content: z.string(),
  start_line: z.number().int().positive(),
  end_line: z.number().int().nonnegative(),
  truncated: z.boolean(),
  next_start_line: z.number().int().positive().optional(),
});

export const workspaceReviewSearchOutputSchema = z.object({
  workspace_id: workspaceIdSchema,
  results: z.array(z.object({
    path: workspaceRelativePathSchema,
    line: z.number().int().positive(),
    text: z.string(),
  })),
  truncated: z.boolean(),
});

export const workspaceReviewContextOutputSchema = z.object({
  workspace_id: workspaceIdSchema,
  git_status: z.object({
    branch: z.string().nullable(),
    status: z.enum(["clean", "dirty"]),
    entries: z.array(gitStatusEntryOutputSchema),
  }),
  changed_files: z.array(workspaceRelativePathSchema),
  diff_summary: diffSummarySchema,
  diff: z.object({
    staged: z.string(),
    unstaged: z.string(),
  }),
  review_candidates: z.array(z.object({
    path: workspaceRelativePathSchema,
    status: z.enum(["modified", "added", "deleted", "renamed", "untracked"]),
  })),
});

export const reviewSummaryOutputSchema = workspaceContextSchema.extend({
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
