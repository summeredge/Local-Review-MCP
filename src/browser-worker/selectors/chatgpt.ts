export const CHATGPT_ASSISTANT_MESSAGE_SELECTOR =
  '[data-message-author-role="assistant"]' as const;

export const CHATGPT_GENERATING_SELECTORS = [
  '[data-message-author-role="assistant"][aria-busy="true"]',
  '[data-testid="stop-button"]',
  'button[aria-label="Stop generating" i]',
] as const;
