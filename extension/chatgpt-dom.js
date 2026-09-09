globalThis.LRM_DOM = (() => {
  'use strict';

  const STOP = 'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], '
    + 'button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[aria-label="Stop answering"]';
  const SEND = 'button[data-testid="send-button"], form button[aria-label^="Send" i]';
  const BLOCK_ELEMENTS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
    'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
    'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
  ]);

  const canonicalText = (value) => String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\u00a0/gu, ' ');

  function domText(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue ?? node.textContent ?? '';
    if (typeof node.innerText === 'string' && (node.innerText !== '' || !node.textContent)) return node.innerText;
    const name = String(node.nodeName || '').toUpperCase();
    if (name === 'BR') return '\n';
    if (!node.childNodes) return node.textContent || '';

    const children = [...node.childNodes];
    let value = '';
    for (const [index, child] of children.entries()) {
      value += domText(child);
      if (BLOCK_ELEMENTS.has(String(child.nodeName || '').toUpperCase()) && index < children.length - 1) {
        value += '\n';
      }
    }
    return value;
  }

  const plainText = (node) => canonicalText(domText(node));
  const sameText = (actual, expected) => canonicalText(actual) === canonicalText(expected);

  function composer() {
    return document.querySelector('#prompt-textarea');
  }

  function stopButton() {
    return document.querySelector(STOP);
  }

  function sendButton() {
    return document.querySelector(SEND);
  }

  function composerText(box = composer()) {
    return plainText(box);
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
      && composerText(box) === ''
      && box.getAttribute('aria-disabled') !== 'true'
      && box.getAttribute('contenteditable') !== 'false'
      && !stopButton()
      && !hasComposerAttachments());
  }

  async function insertPrompt(message) {
    const box = composer();
    if (!ready() || !box) return false;
    box.focus();
    document.execCommand('insertText', false, message);
    box.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: message
    }));
    if (sameText(composerText(), message)) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return sameText(composerText(), message);
  }

  function clearPromptExact(message) {
    const box = composer();
    if (!box || !sameText(composerText(box), message)) return false;
    box.focus();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    box.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'deleteContentBackward',
      data: null
    }));
    return composerText(box) === '';
  }

  function userMessages() {
    const found = [];
    for (const node of document.querySelectorAll('[data-message-author-role="user"]')) {
      const identified = node.hasAttribute('data-message-id') ? node : node.querySelector('[data-message-id]');
      const messageId = identified?.getAttribute('data-message-id') || '';
      if (!messageId) continue;
      const parts = [...node.querySelectorAll('.whitespace-pre-wrap')]
        .map((part) => plainText(part));
      found.push({ message_id: messageId, text: parts.length ? parts.join('\n') : plainText(node), node });
    }
    return found;
  }

  async function send(message, stillCurrent, timeoutMs = 20_000) {
    const box = composer();
    const button = sendButton();
    const canSend = () => box && composer() === box && box.isConnected
      && button && button.isConnected !== false
      && box.getAttribute('aria-disabled') !== 'true'
      && box.getAttribute('contenteditable') !== 'false'
      && !button.disabled && button.getAttribute('aria-disabled') !== 'true'
      && stillCurrent() && !stopButton() && !hasComposerAttachments()
      && sameText(composerText(box), message);
    if (!canSend()) {
      return { clicked: false, message_id: null };
    }
    const before = new Set(userMessages().map((entry) => entry.message_id));
    return new Promise((resolve) => {
      let observer = null;
      let timer = null;
      let done = false;
      let clicked = false;
      const finish = (messageId, didClick = clicked) => {
        if (done) return;
        done = true;
        observer?.disconnect();
        clearTimeout(timer);
        resolve({ clicked: didClick, message_id: messageId });
      };
      const check = () => {
        if (!stillCurrent()) return finish(null);
        const receipt = userMessages().find((entry) =>
          !before.has(entry.message_id) && sameText(entry.text, message));
        if (receipt) finish(receipt.message_id);
      };
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
      timer = setTimeout(() => { check(); finish(null); }, Math.max(1, Math.min(timeoutMs, 20_000)));
      if (!canSend()) return finish(null, false);
      clicked = true;
      button.click();
      check();
    });
  }

  return { composer, sendButton, stopButton, hasComposerAttachments, ready, insertPrompt, clearPromptExact, userMessages, send };
})();
