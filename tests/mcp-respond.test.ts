import { z } from "zod";
import { describe, expect, it } from "vitest";
import { structuredResponse } from "../src/mcp/respond.js";

const exampleSchema = z.object({
  value: z.string().min(1),
});

describe("structured response validation", () => {
  it("keeps text and structuredContent identical after schema parsing", () => {
    const result = structuredResponse(exampleSchema, { value: "ok" });

    expect(result.structuredContent).toEqual({ value: "ok" });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  it("rejects runtime data that does not match the output schema", () => {
    expect(() => structuredResponse(
      exampleSchema,
      { value: 42 } as unknown as { value: string },
    )).toThrow("Structured output validation failed");
  });
});
