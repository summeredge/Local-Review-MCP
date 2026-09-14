import { z } from "zod";

export const ROOT_ALIAS = "workspace:/" as const;
export const rootAliasSchema = z.literal(ROOT_ALIAS);
export const correlationKeySchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  "correlation_key must be a UUID v4",
);
export const workspaceIdSchema = z.string().min(1);
export const workspaceNameSchema = z.string().min(1);
export const workspaceContextSchema = z.object({
  workspace_id: workspaceIdSchema,
  workspace_name: workspaceNameSchema,
});
export type WorkspaceContext = z.infer<typeof workspaceContextSchema>;
export const workspaceRelativePathSchema = z.string().min(1);
