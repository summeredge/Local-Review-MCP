const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;

export function conversationUrl(conversationId: string): string {
  if (typeof conversationId !== "string" || !CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw new Error("conversation_id must contain only safe Conversation ID characters.");
  }
  return `https://chatgpt.com/c/${conversationId}`;
}
