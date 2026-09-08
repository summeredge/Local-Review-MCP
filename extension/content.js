(() => {
  'use strict';

  const FIBER_ASK = 'lrm-extension-identity-ask';
  const FIBER_REPLY = 'lrm-extension-identity-reply';
  const FIBER_VERSION = 1;
  const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/u;
  const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
  const FIBER_TIMEOUT_MS = 1500;
  const SCAN_DELAY_MS = 150;

  let alive = true;
  let navigationEpoch = 0;
  let lastUrl = location.href;
  let registeredEpoch = -1;
  let registration = null;
  let scanTimer = null;
  let scanInFlight = null;
  let nonceCounter = 0;
  let deliveryInFlight = null;
  const sent = new Set();

  function routeConversation(href = location.href) {
    try {
      const url = new URL(href);
      if (url.origin !== 'https://chatgpt.com' && url.origin !== 'https://chat.openai.com') return null;
      const match = /^\/(?:g\/[^/]+\/)?c\/([A-Za-z0-9][A-Za-z0-9_-]{0,255})\/?$/.exec(url.pathname);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function sendToWorker(message) {
    return new Promise((resolve) => {
      if (!alive || !globalThis.chrome?.runtime?.sendMessage) {
        resolve(null);
        return;
      }
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value || null);
      };
      try {
        const result = chrome.runtime.sendMessage(message, finish);
        if (result && typeof result.then === 'function') result.then(finish, () => finish(null));
      } catch {
        finish(null);
      }
    });
  }

  async function registerDocument() {
    if (registeredEpoch >= navigationEpoch) return true;
    if (registration) return registration;
    const requestedEpoch = navigationEpoch;
    registration = sendToWorker({ type: 'register_document', navigation_epoch: requestedEpoch })
      .then((reply) => {
        if (reply?.ok !== true) return false;
        registeredEpoch = Math.max(registeredEpoch, requestedEpoch);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        registration = null;
      });
    return registration;
  }

  async function pollDelivery() {
    if (!alive || deliveryInFlight || !globalThis.LRM_DOM?.ready?.()) return;
    const epoch = navigationEpoch;
    const href = location.href;
    const conversationId = routeConversation(href);
    if (!conversationId || !(await registerDocument())) return;
    const stillCurrent = () => alive
      && navigationEpoch === epoch
      && location.href === href
      && routeConversation() === conversationId;
    if (!stillCurrent() || !LRM_DOM.ready()) return;
    deliveryInFlight = (async () => {
      const claimed = await sendToWorker({
        type: 'delivery_claim',
        conversation_id: conversationId,
        navigation_epoch: epoch
      });
      const command = claimed?.ok === true ? claimed.command : null;
      if (!command) return;
      const acknowledge = (status, details) => sendToWorker({
        type: 'delivery_ack',
        delivery_id: command.delivery_id,
        navigation_epoch: epoch,
        status,
        ...details
      });
      if (command.conversation_id !== conversationId || !stillCurrent()) {
        await acknowledge('not_sent', { error: 'document identity changed before send' });
        return;
      }
      if (!LRM_DOM.ready()) {
        await acknowledge('not_sent', { error: 'composer_busy' });
        return;
      }
      if (!LRM_DOM.insertPrompt(command.message)) {
        await acknowledge('not_sent', { error: 'composer refused exact message' });
        return;
      }
      const armed = await sendToWorker({
        type: 'delivery_submit_started',
        delivery_id: command.delivery_id,
        navigation_epoch: epoch
      });
      if (armed?.ok !== true) {
        LRM_DOM.clearPromptExact(command.message);
        return;
      }
      if (!stillCurrent()) {
        LRM_DOM.clearPromptExact(command.message);
        await acknowledge('not_sent', { error: 'document identity changed before submit' });
        return;
      }
      const result = await LRM_DOM.send(command.message, stillCurrent);
      if (!result.clicked) {
        LRM_DOM.clearPromptExact(command.message);
        await acknowledge('not_sent', { error: 'send control unavailable' });
      } else if (result.message_id) {
        await acknowledge('sent', { message_id: result.message_id });
      } else {
        await acknowledge('ambiguous', { error: 'submit occurred without a stable message receipt' });
      }
    })().finally(() => { deliveryInFlight = null; });
    await deliveryInFlight;
  }

  function fiberScan() {
    return new Promise((resolve) => {
      const nonce = `${++nonceCounter}-${Math.random().toString(36).slice(2)}`;
      let settled = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', listener);
        resolve(value);
      };
      const listener = (event) => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || typeof data !== 'object'
          || data.source !== FIBER_REPLY
          || data.nonce !== nonce
          || data.version !== FIBER_VERSION
          || !Array.isArray(data.evidence)) return;

        const byRequest = new Map();
        const conflicts = new Set();
        for (const entry of data.evidence.slice(0, 200)) {
          if (!entry || typeof entry !== 'object'
            || Object.keys(entry).length !== 2
            || typeof entry.request_id !== 'string'
            || typeof entry.fiber_conversation_id !== 'string'
            || !REQUEST_ID.test(entry.request_id)
            || !CONVERSATION_ID.test(entry.fiber_conversation_id)) continue;
          const previous = byRequest.get(entry.request_id);
          if (previous !== undefined && previous !== entry.fiber_conversation_id) conflicts.add(entry.request_id);
          else if (previous === undefined) byRequest.set(entry.request_id, entry.fiber_conversation_id);
        }
        finish([...byRequest].filter(([requestId]) => !conflicts.has(requestId))
          .map(([request_id, fiber_conversation_id]) => ({ request_id, fiber_conversation_id })));
      };
      timer = setTimeout(() => finish([]), FIBER_TIMEOUT_MS);
      window.addEventListener('message', listener);
      try {
        window.postMessage({ source: FIBER_ASK, nonce }, location.origin);
      } catch {
        finish([]);
      }
    });
  }

  async function publishEvidence() {
    if (!alive || scanInFlight) return scanInFlight;
    scanInFlight = (async () => {
      const askedEpoch = navigationEpoch;
      const askedUrl = location.href;
      const conversationId = routeConversation(askedUrl);
      if (!conversationId || !(await registerDocument())) return;
      const entries = await fiberScan();
      if (askedEpoch !== navigationEpoch || askedUrl !== location.href) return;
      for (const entry of entries) {
        if (askedEpoch !== navigationEpoch || askedUrl !== location.href) return;
        if (entry.fiber_conversation_id !== conversationId) continue;
        const key = `${askedEpoch}\u0000${conversationId}\u0000${entry.request_id}`;
        if (sent.has(key)) continue;
        const reply = await sendToWorker({
          type: 'identity_evidence',
          request_id: entry.request_id,
          conversation_id: conversationId,
          navigation_epoch: askedEpoch
        });
        if (reply?.ok === true) sent.add(key);
      }
    })().finally(() => {
      scanInFlight = null;
    });
    return scanInFlight;
  }

  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      void publishEvidence();
    }, SCAN_DELAY_MS);
  }

  function routeChanged() {
    const nextUrl = location.href;
    if (nextUrl === lastUrl) return;
    lastUrl = nextUrl;
    navigationEpoch += 1;
    sent.clear();
    void registerDocument();
    scheduleScan();
  }

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    if (typeof original !== 'function') continue;
    history[method] = function (...args) {
      const result = original.apply(this, args);
      routeChanged();
      return result;
    };
  }
  window.addEventListener('popstate', routeChanged);
  window.addEventListener('hashchange', routeChanged);
  setInterval(routeChanged, 250);
  setInterval(scheduleScan, 1000);
  setInterval(() => { void pollDelivery(); }, 1500);

  if (typeof MutationObserver === 'function' && document.documentElement) {
    new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  }
  void registerDocument();
  scheduleScan();
  void pollDelivery();
})();
