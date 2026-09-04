import { z } from "zod";
import { workspaceRelativePathSchema } from "./common.js";

export const gitChangeStatusSchema = z.enum([
  "modified",
  "added",
  "deleted",
  "renamed",
  "untracked",
]);

export const gitStatusEntryOutputSchema = z.object({
  path: workspaceRelativePathSchema,
  index: z.string(),
  worktree: z.string(),
  status: gitChangeStatusSchema,
  original_path: workspaceRelativePathSchema.optional(),
});

export const gitStatusOutputSchema = z.object({
  branch: z.string().nullable(),
  entries: z.array(gitStatusEntryOutputSchema),
});

export const gitDiffOutputSchema = z.object({
  path: workspaceRelativePathSchema,
  stat: z.boolean(),
  diff: z.string(),
  files: z.array(workspaceRelativePathSchema),
  binary: z.boolean(),
  binary_paths: z.array(workspaceRelativePathSchema).optional(),
});

export type GitStatusOutput = z.infer<typeof gitStatusOutputSchema>;
export type GitDiffOutput = z.infer<typeof gitDiffOutputSchema>;
