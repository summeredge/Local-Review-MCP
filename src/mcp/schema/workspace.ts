import { z } from "zod";
import {
  rootAliasSchema,
  workspaceContextSchema,
  workspaceIdSchema,
  workspaceNameSchema,
} from "./common.js";

export const workspaceInfoOutputSchema = workspaceContextSchema.extend({
  root_alias: rootAliasSchema,
  project_types: z.array(z.string()),
});

export type WorkspaceInfoOutput = z.infer<typeof workspaceInfoOutputSchema>;

export const workspaceListOutputSchema = z.object({
  workspaces: z.array(z.object({
    id: workspaceIdSchema,
    name: workspaceNameSchema,
  })),
});
