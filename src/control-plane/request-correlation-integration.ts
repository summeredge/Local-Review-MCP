import { inboundRequestId } from "../mcp/inbound.js";
import type {
  ConversationCorrelation,
  ConversationCorrelationRegistry,
} from "./conversation-correlation.js";

export function currentInboundCorrelation(
  correlations: Pick<ConversationCorrelationRegistry, "correlation">,
): ConversationCorrelation | null {
  return correlations.correlation(inboundRequestId());
}

export function awaitCurrentInboundCorrelation(
  correlations: Pick<ConversationCorrelationRegistry, "awaitCorrelation">,
  timeoutMs: number,
): Promise<ConversationCorrelation | null> {
  return correlations.awaitCorrelation(inboundRequestId(), timeoutMs);
}
