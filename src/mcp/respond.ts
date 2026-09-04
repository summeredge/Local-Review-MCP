import type { z } from "zod";

export function structuredResponse(schema: z.ZodTypeAny, data: unknown) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Structured output validation failed", { cause: parsed.error });
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(parsed.data) }],
    structuredContent: parsed.data as Record<string, unknown>,
  };
}
