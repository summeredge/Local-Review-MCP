import { z } from "zod";

export const ROOT_ALIAS = "workspace:/" as const;
export const rootAliasSchema = z.literal(ROOT_ALIAS);
export const workspaceIdSchema = z.string().min(1);
export const workspaceNameSchema = z.string().min(1);
export const workspaceRelativePathSchema = z.string().min(1);
