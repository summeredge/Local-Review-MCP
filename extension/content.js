(() => {
  'use strict';

  const FIBER_ASK = 'lrm-extension-identity-ask';
  const FIBER_REPLY = 'lrm-extension-identity-reply';
  const FIBER_VERSION = 1;
  const GOAL_HANDOFF_PROTOCOL = 'local-review-mcp.goal-handoff';
  const GOAL_HANDOFF_SCHEMA_VERSION = '2';
  const MAX_GOAL_HANDOFF_TEXT = 16 * 1024;
  const HANDOFF_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
  const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
  const SIGNATURE = /^[0-9a-f]{64}$/u;
  const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
  const COMPLETION_FIBER_ASK = 'lrm-extension-review-completion-ask';
  const COMPLETION_FIBER_REPLY = 'lrm-extension-review-completion-reply';
  const COMPLETION_FIBER_VERSION = 1;
  const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/u;
  const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
  const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
  const COMPLETION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const MAX_COMPLETION_CONTENT = 256 * 1024;
  const FIBER_TIMEOUT_MS = 1500;
  const SCAN_DELAY_MS = 150;

  let alive = true;
  let navigationEpoch = 0;
  let lastUrl = location.href;
  let registeredEpoch = -1;
  let registeredDocumentId = null;
  let lastCompletionDiagnostic = '';
  let registration = null;
  let scanTimer = null;
  let scanInFlight = null;
  let nonceCounter = 0;
  let deliveryInFlight = null;
  let completionInFlight = null;
  let completionScanTimer = null;
  const sent = new Set();
  const sentHandoffs = new Set();

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
    if (registration) {
      const previous = await registration;
      return previous && registeredEpoch < navigationEpoch ? registerDocument() : previous;
    }
    const requestedEpoch = navigationEpoch;
    registration = sendToWorker({ type: 'register_document', navigation_epoch: requestedEpoch })
      .then((reply) => {
        if (reply?.ok !== true) return false;
        registeredDocumentId = typeof reply.document_id === 'string' ? reply.document_id : null;
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
      if (!(await LRM_DOM.insertPrompt(command.message))) {
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

  function own(value, key) {
    return Boolean(value && typeof value === 'object'
      && Object.prototype.hasOwnProperty.call(value, key));
  }

  function exactObject(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value);
    return actual.length === keys.length && keys.every((key) => own(value, key));
  }

  function validGoalText(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= MAX_GOAL_HANDOFF_TEXT;
  }

  function validGoalHandoffEnvelope(value) {
    if (!exactObject(value, [
      'protocol', 'schema_version', 'handoff_id', 'request_id', 'workspace_id',
      'goal', 'issued_at', 'expires_at', 'signature',
    ])
      || value.protocol !== GOAL_HANDOFF_PROTOCOL
      || value.schema_version !== GOAL_HANDOFF_SCHEMA_VERSION
      || typeof value.handoff_id !== 'string' || !HANDOFF_ID.test(value.handoff_id)
      || typeof value.request_id !== 'string' || !REQUEST_ID.test(value.request_id)
      || typeof value.workspace_id !== 'string' || !WORKSPACE_ID.test(value.workspace_id)
      || typeof value.issued_at !== 'string' || !ISO_TIMESTAMP.test(value.issued_at)
      || !Number.isFinite(Date.parse(value.issued_at))
      || typeof value.expires_at !== 'string' || !ISO_TIMESTAMP.test(value.expires_at)
      || !Number.isFinite(Date.parse(value.expires_at))
      || typeof value.signature !== 'string' || !SIGNATURE.test(value.signature)) return false;
    const goal = value.goal;
    if (!exactObject(goal, ['title', 'goal', 'requirements', 'acceptance_criteria', 'max_iterations'])
      || !validGoalText(goal.title) || !validGoalText(goal.goal)
      || !Array.isArray(goal.requirements) || goal.requirements.length < 1 || goal.requirements.length > 1000
      || !Array.isArray(goal.acceptance_criteria) || goal.acceptance_criteria.length < 1
      || goal.acceptance_criteria.length > 1000
      || !Number.isSafeInteger(goal.max_iterations) || goal.max_iterations < 1
      || goal.max_iterations > 10_000) return false;
    return goal.requirements.every(validGoalText) && goal.acceptance_criteria.every(validGoalText);
  }

  function validGoalHandoffCandidate(value) {
    if (!exactObject(value, [
      'handoff', 'fiber_conversation_id', 'turn_index', 'request_message_id',
      'result_message_id', 'request_order', 'result_order', 'user_orders', 'activation_orders',
    ])
      || !validGoalHandoffEnvelope(value.handoff)
      || typeof value.fiber_conversation_id !== 'string'
      || !CONVERSATION_ID.test(value.fiber_conversation_id)
      || !Number.isSafeInteger(value.turn_index) || value.turn_index < 0
      || typeof value.request_message_id !== 'string' || !MESSAGE_ID.test(value.request_message_id)
      || (value.result_message_id !== null
        && (typeof value.result_message_id !== 'string' || !MESSAGE_ID.test(value.result_message_id)))
      || !Number.isSafeInteger(value.request_order) || value.request_order < 0
      || !Number.isSafeInteger(value.result_order) || value.result_order < 0
      || value.result_order <= value.request_order
      || !Array.isArray(value.user_orders) || value.user_orders.length > 100
      || !Array.isArray(value.activation_orders) || value.activation_orders.length > 100) return false;
    const orders = new Set();
    for (const order of value.user_orders) {
      if (!Number.isSafeInteger(order) || order < 0 || orders.has(order)) return false;
      orders.add(order);
    }
    for (const order of value.activation_orders) {
      if (!Number.isSafeInteger(order) || order < 0 || !orders.has(order)) return false;
    }
    return true;
  }

  function goalHandoffKey(value) {
    return JSON.stringify([
      value.protocol, value.schema_version, value.handoff_id, value.request_id,
      value.workspace_id, value.goal.title, value.goal.goal, value.goal.requirements,
      value.goal.acceptance_criteria, value.goal.max_iterations, value.issued_at,
      value.expires_at, value.signature,
    ]);
  }

  function activationAllowed(candidate) {
    let latestUserOrder = -1;
    for (const order of candidate.user_orders) {
      if (order < candidate.request_order && order > latestUserOrder) latestUserOrder = order;
    }
    return latestUserOrder >= 0 && candidate.activation_orders.includes(latestUserOrder);
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
        const handoffById = new Map();
        const handoffConflicts = new Set();
        if (Array.isArray(data.handoffs)) {
          for (const candidate of data.handoffs.slice(0, 20)) {
            if (!validGoalHandoffCandidate(candidate)) continue;
            const id = candidate.handoff.handoff_id;
            const key = goalHandoffKey(candidate.handoff);
            const previous = handoffById.get(id);
            if (previous && previous.key !== key) handoffConflicts.add(id);
            else if (!previous) handoffById.set(id, { key, candidate });
          }
        }
        finish({
          evidence: [...byRequest].filter(([requestId]) => !conflicts.has(requestId))
            .map(([request_id, fiber_conversation_id]) => ({ request_id, fiber_conversation_id })),
          handoffs: [...handoffById.values()]
            .filter(({ candidate }) => !handoffConflicts.has(candidate.handoff.handoff_id))
            .map(({ candidate }) => candidate),
        });
      };
      timer = setTimeout(() => finish({ evidence: [], handoffs: [] }), FIBER_TIMEOUT_MS);
      window.addEventListener('message', listener);
      try {
        window.postMessage({ source: FIBER_ASK, nonce }, location.origin);
      } catch {
        finish({ evidence: [], handoffs: [] });
      }
    });
  }

  function utf8Length(value) {
    try {
      return encodeURIComponent(value).replace(/%[0-9a-f]{2}|./giu, 'x').length;
    } catch {
      return Infinity;
    }
  }

  function diagnosticLabel(value) {
    return typeof value === 'string' && /^[a-z_]{1,100}$/u.test(value) ? value : 'unknown';
  }

  function completedIdentityDiagnostic(value) {
    return value && typeof value === 'object'
      && diagnosticLabel(value.identity_source) !== 'unknown'
      && diagnosticLabel(value.selected_identity_type) !== 'unknown'
      && value.identity_source !== 'none'
      && value.selected_identity_type !== 'none';
  }

  function completionFiberScan(conversationId, expectedUserMessageId, completionId) {
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
          || data.source !== COMPLETION_FIBER_REPLY
          || data.nonce !== nonce
          || data.version !== COMPLETION_FIBER_VERSION
          || data.completion_id !== completionId
          || data.conversation_id !== conversationId
          || data.expected_user_message_id !== expectedUserMessageId) return;
        if (data.diagnostic && typeof data.diagnostic === 'object') {
          const diagnostic = { conversation_id: conversationId, document_id: registeredDocumentId,
            navigation_epoch: navigationEpoch, completion_id: completionId };
          for (const key of ['fiber_scan_count', 'candidate_count', 'matched_user_turn_count', 'assistant_candidate_count']) {
            const value = data.diagnostic[key];
            diagnostic[key] = Number.isSafeInteger(value) && value >= 0 ? value : 0;
          }
          for (const key of ['identity_source', 'selected_identity_type', 'rejection_reason', 'completion_state_reason']) {
            diagnostic[key] = diagnosticLabel(data.diagnostic[key]);
          }
          const serialized = JSON.stringify(diagnostic);
          if (serialized !== lastCompletionDiagnostic) {
            console.debug('[LRM completion]', serialized);
            lastCompletionDiagnostic = serialized;
          }
        }
        if (data.status === 'pending') {
          finish({ status: 'pending' });
          return;
        }
        if ((data.status === 'ambiguous' || data.status === 'failed')
          && typeof data.error === 'string' && data.error.length > 0 && data.error.length <= 500) {
          finish({ status: data.status, error: data.error });
          return;
        }
        if (data.status === 'completed'
          && completedIdentityDiagnostic(data.diagnostic)
          && typeof data.assistant_message_id === 'string'
          && MESSAGE_ID.test(data.assistant_message_id)
          && typeof data.content === 'string'
          && data.content.length > 0
          && data.content.length <= MAX_COMPLETION_CONTENT
          && utf8Length(data.content) <= MAX_COMPLETION_CONTENT) {
          finish({
            status: 'completed',
            assistant_message_id: data.assistant_message_id,
            content: data.content,
          });
        }
      };
      timer = setTimeout(() => finish({ status: 'pending' }), FIBER_TIMEOUT_MS);
      window.addEventListener('message', listener);
      try {
        window.postMessage({
          source: COMPLETION_FIBER_ASK,
          nonce,
          version: COMPLETION_FIBER_VERSION,
          completion_id: completionId,
          conversation_id: conversationId,
          expected_user_message_id: expectedUserMessageId,
        }, location.origin);
      } catch {
        finish({ status: 'pending' });
      }
    });
  }

  async function pollCompletion() {
    if (!alive || completionInFlight) return completionInFlight;
    completionInFlight = (async () => {
      const epoch = navigationEpoch;
      const href = location.href;
      const conversationId = routeConversation(href);
      if (!conversationId || !(await registerDocument())) return;
      const stillCurrent = () => alive
        && navigationEpoch === epoch
        && location.href === href
        && routeConversation() === conversationId;
      if (!stillCurrent()) return;
      const claimed = await sendToWorker({
        type: 'completion_claim',
        conversation_id: conversationId,
        navigation_epoch: epoch,
      });
      const watch = claimed?.ok === true
        ? (claimed.completion_id ? claimed : claimed.command)
        : null;
      if (!watch || watch.conversation_id !== conversationId
        || typeof watch.completion_id !== 'string' || !COMPLETION_ID.test(watch.completion_id)
        || typeof watch.expected_user_message_id !== 'string'
        || !MESSAGE_ID.test(watch.expected_user_message_id)
        || !Number.isSafeInteger(watch.deadline) || watch.deadline <= Date.now()) return;
      if (!stillCurrent()) return;
      const result = await completionFiberScan(
        conversationId,
        watch.expected_user_message_id,
        watch.completion_id,
      );
      if (!stillCurrent() || result.status === 'pending') return;
      const details = result.status === 'completed'
        ? { assistant_message_id: result.assistant_message_id, content: result.content }
        : { error: result.error };
      await sendToWorker({
        type: 'completion_ack',
        completion_id: watch.completion_id,
        conversation_id: conversationId,
        navigation_epoch: epoch,
        status: result.status,
        ...details,
      });
    })().finally(() => {
      completionInFlight = null;
    });
    await completionInFlight;
  }

  async function publishEvidence() {
    if (!alive || scanInFlight) return scanInFlight;
    scanInFlight = (async () => {
      const askedEpoch = navigationEpoch;
      const askedUrl = location.href;
      const conversationId = routeConversation(askedUrl);
      if (!conversationId || !(await registerDocument())) return;
      const scan = await fiberScan();
      const stillCurrent = () => askedEpoch === navigationEpoch
        && askedUrl === location.href
        && routeConversation() === conversationId;
      if (!stillCurrent()) return;
      for (const entry of scan.evidence) {
        if (!stillCurrent()) return;
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
      for (const candidate of scan.handoffs) {
        if (!stillCurrent()) return;
        if (candidate.fiber_conversation_id !== conversationId || !activationAllowed(candidate)) continue;
        const key = candidate.handoff.handoff_id;
        if (sentHandoffs.has(key)) continue;
        const reply = await sendToWorker({
          type: 'goal_handoff_capture',
          handoff: candidate.handoff,
          conversation_id: conversationId,
          navigation_epoch: askedEpoch,
        });
        if (reply?.ok === true) sentHandoffs.add(key);
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

  function scheduleCompletionScan() {
    if (completionScanTimer !== null) return;
    completionScanTimer = setTimeout(() => {
      completionScanTimer = null;
      void pollCompletion();
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
    if (completionScanTimer !== null) {
      clearTimeout(completionScanTimer);
      completionScanTimer = null;
    }
    scheduleCompletionScan();
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
  setInterval(() => { void pollCompletion(); }, 1000);

  if (typeof MutationObserver === 'function' && document.documentElement) {
    new MutationObserver(() => {
      scheduleScan();
      scheduleCompletionScan();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  void registerDocument();
  scheduleScan();
  void pollDelivery();
  void pollCompletion();
})();
