globalThis.LRM_DOM = (() => {
  'use strict';

  const STOP = 'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], '
    + 'button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[aria-label="Stop answering"]';
  const SEND = 'button[data-testid="send-button"], form button[aria-label^="Send" i]';
  const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function composer() {
    return document.querySelector('#prompt-textarea');
  }

  function stopButton() {
    return document.querySelector(STOP);
  }

  function sendButton() {
    return document.querySelector(SEND);
  }

  function hasComposerAttachments() {
    const box = composer();
    const host = box?.closest('form') || box?.parentElement;
    return Boolean(host?.querySelector(
      '[data-inline-file-uploading], [role="progressbar"], button[aria-label^="Remove file" i]'
    ));
  }

  function ready() {
    const box = composer();
    return Boolean(box && box.isConnected
      && compact(box.textContent) === ''
      && box.getAttribute('aria-disabled') !== 'true'
      && box.getAttribute('contenteditable') !== 'false'
      && !stopButton()
      && !hasComposerAttachments());
  }

  function insertPrompt(message) {
    const box = composer();
    if (!ready() || !box) return false;
    box.focus();
    document.execCommand('insertText', false, message);
    box.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: message
    }));
    return compact(box.textContent) === compact(message);
  }

  function clearPromptExact(message) {
    const box = composer();
    if (!box || compact(box.textContent) !== compact(message)) return false;
    box.focus();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    box.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'deleteContentBackward',
      data: null
    }));
    return compact(box.textContent) === '';
  }

  function userMessages() {
    const found = [];
    for (const node of document.querySelectorAll('[data-message-author-role="user"]')) {
      const identified = node.hasAttribute('data-message-id') ? node : node.querySelector('[data-message-id]');
      const messageId = identified?.getAttribute('data-message-id') || '';
      if (!messageId) continue;
      const parts = [...node.querySelectorAll('.whitespace-pre-wrap')]
        .map((part) => compact(part.textContent))
        .filter(Boolean);
      found.push({ message_id: messageId, text: parts.length ? parts.join('\n') : compact(node.textContent), node });
    }
    return found;
  }

  async function send(message, stillCurrent, timeoutMs = 20_000) {
    const box = composer();
    const button = sendButton();
    if (!box || !button || button.disabled || button.getAttribute('aria-disabled') === 'true'
      || !stillCurrent() || stopButton() || compact(box.textContent) !== compact(message)) {
      return { clicked: false, message_id: null };
    }
    const before = new Set(userMessages().map((entry) => entry.message_id));
    return new Promise((resolve) => {
      let observer = null;
      let timer = null;
      let done = false;
      const finish = (messageId) => {
        if (done) return;
        done = true;
        observer?.disconnect();
        clearTimeout(timer);
        resolve({ clicked: true, message_id: messageId });
      };
      const check = () => {
        if (!stillCurrent()) return finish(null);
        const receipt = userMessages().find((entry) =>
          !before.has(entry.message_id) && compact(entry.text) === compact(message));
        if (receipt) finish(receipt.message_id);
      };
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
      timer = setTimeout(() => { check(); finish(null); }, Math.max(1, Math.min(timeoutMs, 20_000)));
      button.click();
      check();
    });
  }

  return { composer, sendButton, stopButton, hasComposerAttachments, ready, insertPrompt, clearPromptExact, userMessages, send };
})();
