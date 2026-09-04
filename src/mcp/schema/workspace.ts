import { z } from "zod";
import {
  rootAliasSchema,
  workspaceContextSchema,
} from "./common.js";

export const workspaceInfoOutputSchema = workspaceContextSchema.extend({
  root_alias: rootAliasSchema,
  project_types: z.array(z.string()),
});

export type WorkspaceInfoOutput = z.infer<typeof workspaceInfoOutputSchema>;
