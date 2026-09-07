import { describe, expect, it } from "vitest";
import { inboundRequestId, requestIdFromHeader, withInboundRequestId } from "../src/mcp/inbound.js";

describe("MCP inbound request id boundary", () => {
  it("normalizes and rejects ambiguous or invalid x-request-id values", () => {
    expect(requestIdFromHeader("wfr_01a014bdd7cd7a15b6b533d3ce2b42f2/relay-suffix")).toBe(
      "wfr_01a014bdd7cd7a15b6b533d3ce2b42f2",
    );
    expect(requestIdFromHeader("  wfr_abc_123/relay-hop  ")).toBe("wfr_abc_123");
    expect(requestIdFromHeader(["wfr_only/a"])).toBe("wfr_only");
    expect(requestIdFromHeader(["wfr_first/a", "wfr_second/b"])).toBeNull();

    expect(requestIdFromHeader("")).toBeNull();
    expect(requestIdFromHeader("/missing-base")).toBeNull();
    expect(requestIdFromHeader("wfr.bad/suffix")).toBeNull();
    expect(requestIdFromHeader("wfr_K/suffix")).toBeNull();
    expect(requestIdFromHeader("x".repeat(101))).toBeNull();
    expect(requestIdFromHeader(undefined)).toBeNull();
  });

  it("keeps normalized ids isolated across concurrent async requests", async () => {
    const seen = await Promise.all([
      withInboundRequestId("wfr_a", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return inboundRequestId();
      }),
      withInboundRequestId("wfr_b", async () => {
        await Promise.resolve();
        return inboundRequestId();
      }),
    ]);

    expect(seen).toEqual(["wfr_a", "wfr_b"]);
    expect(inboundRequestId()).toBeNull();
  });
});
