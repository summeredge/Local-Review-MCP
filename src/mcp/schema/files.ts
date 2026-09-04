import { z } from "zod";
import { workspaceRelativePathSchema } from "./common.js";

export const fileEntryOutputSchema = z.object({
  path: workspaceRelativePathSchema,
  name: z.string(),
  type: z.enum(["file", "directory"]),
});

export const listFilesOutputSchema = z.object({
  path: workspaceRelativePathSchema,
  entries: z.array(fileEntryOutputSchema),
  offset: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  has_more: z.boolean(),
});

export const readFileOutputSchema = z.object({
  path: workspaceRelativePathSchema,
  start_line: z.number().int().positive(),
  end_line: z.number().int().nonnegative(),
  has_more: z.boolean(),
  content: z.string(),
  truncated: z.boolean().optional(),
});

export const searchTextResultOutputSchema = z.object({
  path: workspaceRelativePathSchema,
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  preview: z.string(),
});

export const searchTextOutputSchema = z.object({
  query: z.string().optional(),
  path: workspaceRelativePathSchema,
  regex: z.boolean(),
  case_sensitive: z.boolean(),
  results: z.array(searchTextResultOutputSchema),
  returned: z.number().int().nonnegative(),
  has_more: z.boolean(),
  engine: z.enum(["ripgrep", "node"]),
});
