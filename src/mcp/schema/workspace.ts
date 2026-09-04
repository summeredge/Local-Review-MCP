import { z } from "zod";
import {
  rootAliasSchema,
  workspaceIdSchema,
  workspaceNameSchema,
} from "./common.js";

export const workspaceInfoOutputSchema = z.object({
  workspace_id: workspaceIdSchema,
  workspace_name: workspaceNameSchema,
  root_alias: rootAliasSchema,
  project_types: z.array(z.string()),
});

export type WorkspaceInfoOutput = z.infer<typeof workspaceInfoOutputSchema>;
