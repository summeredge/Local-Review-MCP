(() => {
  'use strict';

  const FIBER_ASK = 'lrm-extension-identity-ask';
  const FIBER_REPLY = 'lrm-extension-identity-reply';
  const FIBER_VERSION = 1;
  const CONTENT_REVISION = '0.1.5';
  const COMPLETION_FIBER_ASK = 'lrm-extension-review-completion-ask';
  const COMPLETION_FIBER_REPLY = 'lrm-extension-review-completion-reply';
  const COMPLETION_FIBER_VERSION = 1;
  const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/u;
  const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
  const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
  const VERDICT_FIELDS = ['tool_name', 'connector', 'workspace_id', 'review_request_id',
    'expected_user_message_id', 'tool_call_id', 'verdict'];
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
  let currentConversation = null;
  let identityScan = null;
  let completionInFlight = null;
  let completionScanTimer = null;
  const sent = new Map();
  let scanSequence = 0;
  const diagnosticStates = new Map();
  function identityDiagnostic(stage, scanId, details = {}) {
    // State changes plus a thirty-second heartbeat; no text or arbitrary objects.
    try {
      const { observed_at: observedAt, ...state } = details;
      const signature = JSON.stringify([navigationEpoch, currentConversation, state]);
      const prior = diagnosticStates.get(stage);
      if (prior?.signature === signature && Date.now() - prior.at < 30000) return;
      diagnosticStates.set(stage, { signature, at: Date.now() });
      void sendToWorker({ type: 'identity_diagnostic', stage, scan_id: scanId,
        navigation_epoch: navigationEpoch, ...identityFields(), ...state,
        content_revision: CONTENT_REVISION, observed_at: observedAt ?? new Date().toISOString() });
    } catch { /* Observations must not affect scanning. */ }
  }

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

  function identityFields() {
    return { conversation_id: currentConversation, identity_source: 'fiber' };
  }

  async function resolveConversation(scan = null) {
    const epoch = navigationEpoch;
    const href = location.href;
    if (!scan) {
      if (!identityScan) identityScan = fiberScan().finally(() => { identityScan = null; });
      scan = await identityScan;
    }
    if (epoch !== navigationEpoch || href !== location.href) return null;
    const route = routeConversation(href);
    const canonical = scan.conversation_id;
    const url = new URL(href);
    const allowed = ['https://chatgpt.com', 'https://chat.openai.com'].includes(url.origin)
      && (route || url.pathname === '/' || /^\/g\/[^/]+\/?$/u.test(url.pathname));
    const next = allowed && canonical && (!route || canonical === route) ? canonical : null;
    if (currentConversation && next !== currentConversation) {
      navigationEpoch += 1;
      sent.clear();
    }
    currentConversation = next;
    return currentConversation;
  }

  async function registerDocument() {
    if (registeredEpoch >= navigationEpoch) return true;
    if (registration) {
      const previous = await registration;
      return previous && registeredEpoch < navigationEpoch ? registerDocument() : previous;
    }
    const requestedEpoch = navigationEpoch;
    registration = sendToWorker({ type: 'register_document', navigation_epoch: requestedEpoch, ...identityFields() })
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
    deliveryInFlight = (async () => {
      const epoch = navigationEpoch;
      const href = location.href;
      const conversationId = await resolveConversation();
      if (!conversationId || !(await registerDocument())) return;
      const stillCurrent = () => alive
        && navigationEpoch === epoch
        && location.href === href
        && currentConversation === conversationId;
      if (!stillCurrent() || !LRM_DOM.ready()) return;
      const claimed = await sendToWorker({
        type: 'delivery_claim',
        conversation_id: conversationId,
        identity_source: 'fiber',
        navigation_epoch: epoch
      });
      const command = claimed?.ok === true ? claimed.command : null;
      if (!command) return;
      const acknowledge = (status, details) => sendToWorker({
        type: 'delivery_ack',
        delivery_id: command.delivery_id,
        navigation_epoch: epoch,
        status,
        ...identityFields(),
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
        ...identityFields(),
        navigation_epoch: epoch
      });
      if (armed?.ok !== true) {
        LRM_DOM.clearPromptExact(command.message);
        return;
      }
      if (await resolveConversation() !== conversationId || !stillCurrent()) {
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

  function sameJson(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
      || Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
      && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && sameJson(left[key], right[key]));
  }

  function validVerdictEvidence(entry) {
    return VERDICT_FIELDS.every(key => Object.prototype.hasOwnProperty.call(entry, key))
      && entry.tool_name === 'submit_review_verdict' && entry.connector === 'Local MCP Connector'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(entry.request_id)
      && typeof entry.workspace_id === 'string' && Boolean(entry.workspace_id.trim())
      && typeof entry.review_request_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry.review_request_id)
      && typeof entry.expected_user_message_id === 'string' && MESSAGE_ID.test(entry.expected_user_message_id)
      && typeof entry.tool_call_id === 'string' && MESSAGE_ID.test(entry.tool_call_id)
      && entry.verdict && typeof entry.verdict === 'object' && !Array.isArray(entry.verdict)
      && entry.verdict.review_request_id === entry.review_request_id
      && JSON.stringify(entry.verdict).length <= 512 * 1024;
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
            || typeof entry.request_id !== 'string'
            || typeof entry.fiber_conversation_id !== 'string'
            || !REQUEST_ID.test(entry.request_id)
            || !CONVERSATION_ID.test(entry.fiber_conversation_id)) continue;
          const verdictEvidence = VERDICT_FIELDS.some(key => Object.prototype.hasOwnProperty.call(entry, key));
          if (Object.keys(entry).length !== (verdictEvidence ? 9 : 2)
            || (verdictEvidence && !validVerdictEvidence(entry))) {
            conflicts.add(entry.request_id);
            continue;
          }
          const previous = byRequest.get(entry.request_id);
          if (previous !== undefined && !sameJson(previous, entry)) conflicts.add(entry.request_id);
          else if (previous === undefined) byRequest.set(entry.request_id, entry);
        }
        const diagnostic = {};
        const observation = data.scan_diagnostic;
        if (typeof observation?.observed_at === 'string'
          && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(observation.observed_at)
          && Number.isFinite(Date.parse(observation.observed_at))) diagnostic.observed_at = observation.observed_at;
        diagnostic.fiber_revision = observation?.fiber_revision === '0.1.5' ? observation.fiber_revision : 'unknown';
        for (const [key, values] of [
          ['snapshot_path', ['timeline', 'legacy', 'unknown']],
          ['anchor_state', ['stable', 'unstable', 'absent', 'unknown']],
          ['selection_reason', ['tool_absent', 'tool_out_of_scope', 'tool_unsupported', 'selected',
            'invalid_submit_arguments', 'user_boundary', 'snapshot_unreadable', 'user_conflict',
            'historical_viewport', 'no_current_turn', 'scan_exception', 'unknown']],
        ]) if (values.includes(observation?.[key])) diagnostic[key] = observation[key];
        if (typeof observation?.most_recent === 'boolean' || observation?.most_recent === 'unknown') {
          diagnostic.most_recent = observation.most_recent;
        }
        for (const key of ['candidate_turn_count', 'searched_turn_count', 'structured_tool_count',
          'recognized_submit_count', 'excluded_tool_count']) {
          const value = observation?.[key];
          if (value === 'unknown' || (Number.isSafeInteger(value) && value >= 0 && value <= 100000)) diagnostic[key] = value;
        }
        const snapshotReason = data.scan_diagnostic?.snapshot_selection_reason;
        if (['selected', 'no_current_turn', 'historical_viewport', 'snapshot_unreadable',
          'user_conflict', 'user_boundary', 'no_submit_goal', 'scan_exception'].includes(snapshotReason)) {
          diagnostic.snapshot_selection_reason = snapshotReason;
        }
        for (const key of ['current_turn_present', 'fiber_root_detected', 'messages_found',
          'submit_goal_found', 'correlation_key_found', 'current_key_found',
          'conversation_id_found', 'conversation_conflict', 'conversation_unreadable']) {
          if (typeof data.scan_diagnostic?.[key] === 'boolean') diagnostic[key] = data.scan_diagnostic[key];
        }
        const submitGoalReason = data.scan_diagnostic?.submit_goal_reason;
        if (['recipient_mismatch', 'unsupported_content_type', 'missing_tool_payload',
          'invalid_json', 'missing_correlation_key', 'invalid_correlation_key'].includes(submitGoalReason)) {
          diagnostic.submit_goal_reason = submitGoalReason;
        }
        const count = data.scan_diagnostic?.assistant_tool_calls_found;
        if (Number.isSafeInteger(count) && count >= 0 && count <= 100000) diagnostic.assistant_tool_calls_found = count;
        const key = data.scan_diagnostic?.correlation_key;
        if (typeof key === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(key)) diagnostic.correlation_key = key;
        const canonical = data.conversation_id;
        finish({ diagnostic, fiber_reply_received: true,
          conversation_id: typeof canonical === 'string' && CONVERSATION_ID.test(canonical) ? canonical : null,
          evidence: [...byRequest].filter(([requestId]) => !conflicts.has(requestId)).map(([, entry]) => entry) });
      };
      timer = setTimeout(() => finish({ evidence: [], conversation_id: null, fiber_reply_received: false }), FIBER_TIMEOUT_MS);
      window.addEventListener('message', listener);
      try {
        window.postMessage({ source: FIBER_ASK, nonce }, location.origin);
      } catch {
        finish({ evidence: [], conversation_id: null });
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
      const conversationId = await resolveConversation();
      if (!conversationId || !(await registerDocument())) return;
      const stillCurrent = () => alive
        && navigationEpoch === epoch
        && location.href === href
        && currentConversation === conversationId;
      if (!stillCurrent()) return;
      const claimed = await sendToWorker({
        type: 'completion_claim',
        ...identityFields(),
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
        ...identityFields(),
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
    if (!alive || scanInFlight) {
      identityDiagnostic('scan_busy', scanSequence, { scan_in_flight: Boolean(scanInFlight) });
      return scanInFlight;
    }
    const scanId = ++scanSequence;
    scanInFlight = (async () => {
      const askedEpoch = navigationEpoch;
      const askedUrl = location.href;
      identityDiagnostic('scan_started', scanId, { route_conversation_present: Boolean(routeConversation(askedUrl)) });
      const scan = await fiberScan();
      identityDiagnostic('fiber_scanned', scanId, { ...scan.diagnostic,
        fiber_reply_received: scan.fiber_reply_received === true,
        fiber_evidence_count: scan.evidence.length, evidence_generated: scan.evidence.length > 0,
        navigation_epoch_unchanged: askedEpoch === navigationEpoch && askedUrl === location.href });
      if (askedEpoch !== navigationEpoch || askedUrl !== location.href) return;
      // Current tool evidence has its own validated identity; history still gates Delivery.
      const conversationId = await resolveConversation(!scan.conversation_id && scan.evidence.length === 1
        ? { ...scan, conversation_id: scan.evidence[0].fiber_conversation_id } : scan);
      if (!conversationId) return;
      const registered = await registerDocument();
      identityDiagnostic('document_registered', scanId, { register_document_ok: registered });
      if (!registered) return;
      const stillCurrent = () => askedEpoch === navigationEpoch
        && askedUrl === location.href
        && currentConversation === conversationId;
      if (!stillCurrent()) return;
      for (const entry of scan.evidence) {
        if (!stillCurrent()) return;
        const details = { correlation_key: entry.request_id, fiber_route_match: entry.fiber_conversation_id === conversationId };
        identityDiagnostic('route_checked', scanId, details);
        if (entry.fiber_conversation_id !== conversationId) continue;
        const key = `${askedEpoch}\u0000${conversationId}\u0000${entry.request_id}`;
        if (sent.has(key) && (!entry.tool_name || sameJson(sent.get(key), entry))) {
          identityDiagnostic('deduplicated', scanId, details); continue;
        }
        identityDiagnostic('worker_send_attempted', scanId, details);
        const reply = await sendToWorker({
          type: 'identity_evidence',
          ...identityFields(),
          request_id: entry.request_id,
          conversation_id: conversationId,
          ...(entry.tool_name ? Object.fromEntries(VERDICT_FIELDS.map(field => [field, entry[field]])) : {}),
          navigation_epoch: askedEpoch
        });
        identityDiagnostic('worker_send_finished', scanId, { ...details, worker_reply_ok: reply?.ok === true });
        if (reply?.ok === true) sent.set(key, entry);
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
    currentConversation = null;
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
  const reportPresence = () => { void sendToWorker({ type: 'presence' }); };
  reportPresence();
  setInterval(reportPresence, 3000);
  window.addEventListener('focus', reportPresence);
  window.addEventListener('pageshow', reportPresence);
  document.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'visible') reportPresence();
  });
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
  chrome.runtime.onMessage?.addListener((message, _sender, respond) => {
    if (message?.type === 'presence_probe') {
      reportPresence();
      respond({ ok: true });
      return false;
    }
    if (message?.type !== 'delivery_probe') return false;
    resolveConversation().then(async conversationId => {
      const registered = await registerDocument();
      respond({ ok: registered, conversation_id: conversationId });
      void pollDelivery();
    }, () => respond({ ok: false }));
    return true;
  });
  scheduleScan();
  void pollDelivery();
  void pollCompletion();
})();
