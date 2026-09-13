(() => {
  'use strict';

  const PORTS = [12081, 12082, 12083, 12084, 12085];
  const SERVICE = 'local-review-control-bridge';
  const PROTOCOL = 3;
  const PROTOCOL_HEADER = 'x-lrm-bridge-protocol';
  const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/u;
  const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
  const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,256}$/u;
  const GOAL_HANDOFF_PROTOCOL = 'local-review-mcp.goal-handoff';
  const GOAL_HANDOFF_SCHEMA_VERSION = '2';
  const HANDOFF_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
  const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
  const SIGNATURE = /^[0-9a-f]{64}$/u;
  const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
  const MAX_GOAL_TEXT = 16 * 1024;
  const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const COMPLETION_ID = DELIVERY_ID;
  const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
  const MAX_COMPLETION_CONTENT = 256 * 1024;
  const REQUEST_TIMEOUT_MS = 3000;
  const PORT_TRUST_MS = 10_000;

  let port = null;
  let token = null;
  let documents = {};
  let epochs = {};
  let conversations = {};
  let retired = {};
  let loaded = false;
  let loading = null;
  let stateQueue = Promise.resolve();
  let deliveryStateQueue = Promise.resolve();
  let completionStateQueue = Promise.resolve();
  let pairingPromise = null;
  let clientId = null;
  let deliveryAckOutbox = [];
  let deliveryInFlight = [];
  let deliveryRecoveryBlocked = false;
  let deliveryRecoveryWarningEmitted = false;
  let completionAckOutbox = [];
  let completionInFlight = [];
  let completionRecoveryBlocked = false;
  let completionRecoveryWarningEmitted = false;
  let trustedUntil = 0;

  function validDeliveryOwner(entry) {
    return entry && typeof entry === 'object'
      && typeof entry.delivery_id === 'string' && DELIVERY_ID.test(entry.delivery_id)
      && typeof entry.conversation_id === 'string' && CONVERSATION_ID.test(entry.conversation_id)
      && typeof entry.client_id === 'string' && DOCUMENT_ID.test(entry.client_id)
      && typeof entry.document_id === 'string' && DOCUMENT_ID.test(entry.document_id)
      && Number.isSafeInteger(entry.navigation_epoch) && entry.navigation_epoch >= 0;
  }

  function validStoredAck(entry) {
    if (!validDeliveryOwner(entry) || !['sent', 'not_sent', 'ambiguous'].includes(entry.status)) return false;
    const details = entry.status === 'sent'
      ? typeof entry.message_id === 'string' && DOCUMENT_ID.test(entry.message_id)
      : typeof entry.error === 'string' && entry.error.length > 0 && entry.error.length <= 500;
    return details && Object.keys(entry).length === 7;
  }

  function validStoredInFlight(entry) {
    return validDeliveryOwner(entry)
      && ['claimed', 'submitting'].includes(entry.phase)
      && Number.isSafeInteger(entry.deadline)
      && entry.deadline >= 0
      && Object.keys(entry).length === 7;
  }

  function validCompletionOwner(entry) {
    return entry && typeof entry === 'object'
      && typeof entry.completion_id === 'string' && COMPLETION_ID.test(entry.completion_id)
      && typeof entry.conversation_id === 'string' && CONVERSATION_ID.test(entry.conversation_id)
      && typeof entry.client_id === 'string' && DOCUMENT_ID.test(entry.client_id)
      && typeof entry.document_id === 'string' && DOCUMENT_ID.test(entry.document_id)
      && Number.isSafeInteger(entry.navigation_epoch) && entry.navigation_epoch >= 0;
  }

  function validStoredCompletionAck(entry) {
    if (!validCompletionOwner(entry) || !['completed', 'failed', 'ambiguous'].includes(entry.status)) return false;
    const details = entry.status === 'completed'
      ? typeof entry.assistant_message_id === 'string' && MESSAGE_ID.test(entry.assistant_message_id)
        && validCompletionContent(entry.content)
      : typeof entry.error === 'string' && entry.error.length > 0 && entry.error.length <= 500;
    return details && Object.keys(entry).length === (entry.status === 'completed' ? 8 : 7);
  }

  function utf8Length(value) {
    try {
      return encodeURIComponent(value).replace(/%[0-9a-f]{2}|./giu, 'x').length;
    } catch {
      return Infinity;
    }
  }

  function validCompletionContent(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_COMPLETION_CONTENT
      && utf8Length(value) <= MAX_COMPLETION_CONTENT;
  }

  function validStoredCompletionInFlight(entry) {
    return validCompletionOwner(entry)
      && typeof entry.review_request_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry.review_request_id)
      && typeof entry.expected_user_message_id === 'string' && MESSAGE_ID.test(entry.expected_user_message_id)
      && entry.phase === 'claimed'
      && Number.isSafeInteger(entry.deadline)
      && entry.deadline >= 0
      && Object.keys(entry).length === 9;
  }

  function validGoalHandoffEnvelope(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 9
      || !['protocol', 'schema_version', 'handoff_id', 'request_id', 'workspace_id',
        'goal', 'issued_at', 'expires_at', 'signature'].every((key) =>
        Object.prototype.hasOwnProperty.call(value, key))
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
    if (!goal || typeof goal !== 'object' || Array.isArray(goal) || Object.keys(goal).length !== 5
      || !['title', 'goal', 'requirements', 'acceptance_criteria', 'max_iterations'].every((key) =>
        Object.prototype.hasOwnProperty.call(goal, key))
      || typeof goal.title !== 'string' || goal.title.length < 1 || goal.title.length > MAX_GOAL_TEXT
      || typeof goal.goal !== 'string' || goal.goal.length < 1 || goal.goal.length > MAX_GOAL_TEXT
      || !Array.isArray(goal.requirements) || goal.requirements.length < 1 || goal.requirements.length > 1000
      || !Array.isArray(goal.acceptance_criteria) || goal.acceptance_criteria.length < 1
      || goal.acceptance_criteria.length > 1000
      || !Number.isSafeInteger(goal.max_iterations) || goal.max_iterations < 1
      || goal.max_iterations > 10_000) return false;
    return goal.requirements.every((item) => typeof item === 'string'
      && item.length >= 1 && item.length <= MAX_GOAL_TEXT)
      && goal.acceptance_criteria.every((item) => typeof item === 'string'
        && item.length >= 1 && item.length <= MAX_GOAL_TEXT);
  }

  function serialState(task) {
    const result = stateQueue.then(task, task);
    stateQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function serialDeliveryState(task) {
    const result = deliveryStateQueue.then(task, task);
    deliveryStateQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function serialCompletionState(task) {
    const result = completionStateQueue.then(task, task);
    completionStateQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function validStoredDeliveryEntries(value, validator, limit, idKey = 'delivery_id') {
    if (!Array.isArray(value) || value.length > limit) return false;
    const ids = new Set();
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index) || !validator(value[index])) return false;
      const id = value[index][idKey];
      if (ids.has(id)) return false;
      ids.add(id);
    }
    return true;
  }

  async function load() {
    if (loaded) return;
    if (!loading) {
      loading = chrome.storage.local.get([
        'port', 'token', 'tabDocuments', 'tabEpochs', 'tabConversations', 'retiredDocuments',
        'extensionClientId', 'deliveryAckOutbox', 'deliveryInFlight',
        'completionAckOutbox', 'completionInFlight'
      ])
        .then((stored) => {
          port = PORTS.includes(stored.port) ? stored.port : null;
          token = typeof stored.token === 'string' && stored.token.length > 0 ? stored.token : null;
          documents = stored.tabDocuments && typeof stored.tabDocuments === 'object' ? { ...stored.tabDocuments } : {};
          epochs = stored.tabEpochs && typeof stored.tabEpochs === 'object' ? { ...stored.tabEpochs } : {};
          conversations = stored.tabConversations && typeof stored.tabConversations === 'object' ? { ...stored.tabConversations } : {};
          retired = stored.retiredDocuments && typeof stored.retiredDocuments === 'object' ? { ...stored.retiredDocuments } : {};
          clientId = typeof stored.extensionClientId === 'string' && DOCUMENT_ID.test(stored.extensionClientId)
            ? stored.extensionClientId
            : (globalThis.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`);
          const hasStoredAcks = Object.prototype.hasOwnProperty.call(stored, 'deliveryAckOutbox');
          const hasStoredInFlight = Object.prototype.hasOwnProperty.call(stored, 'deliveryInFlight');
          const storedAcks = stored.deliveryAckOutbox;
          const storedInFlight = stored.deliveryInFlight;
          const validAcks = !hasStoredAcks || validStoredDeliveryEntries(storedAcks, validStoredAck, 200);
          const validInFlight = !hasStoredInFlight || validStoredDeliveryEntries(storedInFlight, validStoredInFlight, 100);
          const ackIds = validAcks && hasStoredAcks ? new Set(storedAcks.map((entry) => entry.delivery_id)) : new Set();
          const noOverlappingDelivery = !hasStoredAcks || !hasStoredInFlight || !validAcks || !validInFlight
            || storedInFlight.every((entry) => !ackIds.has(entry.delivery_id));
          deliveryRecoveryBlocked = !validAcks || !validInFlight || !noOverlappingDelivery;
          if (deliveryRecoveryBlocked) {
            if (!deliveryRecoveryWarningEmitted) {
              console.warn('Extension delivery state is malformed; delivery recovery is blocked');
              deliveryRecoveryWarningEmitted = true;
            }
            deliveryAckOutbox = [];
            deliveryInFlight = [];
          } else {
            deliveryAckOutbox = hasStoredAcks ? storedAcks.slice() : [];
            deliveryInFlight = hasStoredInFlight ? storedInFlight.slice() : [];
          }
          const initialState = { extensionClientId: clientId };
          if (!deliveryRecoveryBlocked) {
            initialState.deliveryAckOutbox = deliveryAckOutbox;
            initialState.deliveryInFlight = deliveryInFlight;
          }
          const hasStoredCompletionAcks = Object.prototype.hasOwnProperty.call(stored, 'completionAckOutbox');
          const hasStoredCompletionInFlight = Object.prototype.hasOwnProperty.call(stored, 'completionInFlight');
          const storedCompletionAcks = stored.completionAckOutbox;
          const storedCompletionInFlight = stored.completionInFlight;
          const validCompletionAcks = !hasStoredCompletionAcks
            || validStoredDeliveryEntries(storedCompletionAcks, validStoredCompletionAck, 200, 'completion_id');
          const validCompletionInFlight = !hasStoredCompletionInFlight
            || validStoredDeliveryEntries(storedCompletionInFlight, validStoredCompletionInFlight, 100, 'completion_id');
          const completionAckIds = validCompletionAcks && hasStoredCompletionAcks
            ? new Set(storedCompletionAcks.map((entry) => entry.completion_id))
            : new Set();
          const noOverlappingCompletion = !hasStoredCompletionAcks || !hasStoredCompletionInFlight
            || !validCompletionAcks || !validCompletionInFlight
            || storedCompletionInFlight.every((entry) => !completionAckIds.has(entry.completion_id));
          completionRecoveryBlocked = !validCompletionAcks || !validCompletionInFlight || !noOverlappingCompletion;
          if (completionRecoveryBlocked) {
            if (!completionRecoveryWarningEmitted) {
              console.warn('Extension review completion state is malformed; completion recovery is blocked');
              completionRecoveryWarningEmitted = true;
            }
            completionAckOutbox = [];
            completionInFlight = [];
          } else {
            completionAckOutbox = hasStoredCompletionAcks ? storedCompletionAcks.slice() : [];
            completionInFlight = hasStoredCompletionInFlight ? storedCompletionInFlight.slice() : [];
          }
          if (!completionRecoveryBlocked) {
            initialState.completionAckOutbox = completionAckOutbox;
            initialState.completionInFlight = completionInFlight;
          }
          return chrome.storage.local.set(initialState)
            .then(() => { loaded = true; });
        });
      loading = loading.catch((error) => {
        loading = null;
        throw error;
      });
    }
    await loading;
  }

  async function persistBridge() {
    await chrome.storage.local.set({ port, token });
  }

  async function persistState() {
    await chrome.storage.local.set({
      tabDocuments: documents,
      tabEpochs: epochs,
      tabConversations: conversations,
      retiredDocuments: retired
    });
  }

  async function commitDeliveryState(nextOutbox, nextInFlight) {
    const persistedOutbox = nextOutbox.slice(-200);
    const persistedInFlight = nextInFlight.slice(-100);
    await chrome.storage.local.set({
      extensionClientId: clientId,
      deliveryAckOutbox: persistedOutbox,
      deliveryInFlight: persistedInFlight
    });
    deliveryAckOutbox = persistedOutbox;
    deliveryInFlight = persistedInFlight;
  }

  async function commitCompletionState(nextOutbox, nextInFlight) {
    const persistedOutbox = nextOutbox.slice(-200);
    const persistedInFlight = nextInFlight.slice(-100);
    await chrome.storage.local.set({
      extensionClientId: clientId,
      completionAckOutbox: persistedOutbox,
      completionInFlight: persistedInFlight
    });
    completionAckOutbox = persistedOutbox;
    completionInFlight = persistedInFlight;
  }

  function senderSource(sender) {
    if (!sender || (sender.frameId !== undefined && sender.frameId !== 0)) return null;
    const tabId = sender.tab && sender.tab.id;
    const documentId = sender.documentId;
    if (!Number.isSafeInteger(tabId) || tabId < 0 || typeof documentId !== 'string' || !DOCUMENT_ID.test(documentId)) return null;
    return { tabId, documentId };
  }

  function senderConversation(sender) {
    try {
      const url = new URL(sender?.url || '');
      if (url.origin !== 'https://chatgpt.com' && url.origin !== 'https://chat.openai.com') return null;
      return /^\/(?:g\/[^/]+\/)?c\/([A-Za-z0-9][A-Za-z0-9_-]{0,255})\/?$/.exec(url.pathname)?.[1] || null;
    } catch {
      return null;
    }
  }

  function requestedEpoch(message) {
    const value = message && message.navigation_epoch;
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  async function registerDocument(message, sender) {
    const source = senderSource(sender);
    const requested = requestedEpoch(message);
    if (!source || requested === null) return { ok: false, error: 'document_identity_missing' };
    await load();
    return serialState(async () => {
      const key = String(source.tabId);
      const previous = typeof documents[key] === 'string' ? documents[key] : null;
      const oldDocuments = Array.isArray(retired[key]) ? retired[key] : [];
      if (oldDocuments.includes(source.documentId)) return { ok: false, error: 'stale_document' };
      if (previous === source.documentId) {
        const currentEpoch = Number.isSafeInteger(epochs[key]) ? epochs[key] : 0;
        if (requested < currentEpoch) return { ok: false, error: 'stale_navigation' };
        epochs[key] = requested;
        conversations[key] = senderConversation(sender);
      } else {
        if (requested !== 0) return { ok: false, error: 'invalid_navigation_epoch' };
        if (previous !== null) retired[key] = [...new Set([...oldDocuments, previous])].slice(-8);
        documents[key] = source.documentId;
        epochs[key] = requested;
        conversations[key] = senderConversation(sender);
      }
      await persistState();
      return { ok: true, document_id: source.documentId, navigation_epoch: epochs[key] };
    });
  }

  async function authorizeDocument(message, sender) {
    const source = senderSource(sender);
    const requested = requestedEpoch(message);
    if (!source || requested === null) return { ok: false, error: 'document_identity_missing' };
    await load();
    return serialState(async () => {
      const key = String(source.tabId);
      const oldDocuments = Array.isArray(retired[key]) ? retired[key] : [];
      if (oldDocuments.includes(source.documentId)) return { ok: false, error: 'stale_document' };
      if (documents[key] !== source.documentId) return { ok: false, error: 'document_unregistered' };
      const currentEpoch = Number.isSafeInteger(epochs[key]) ? epochs[key] : 0;
      if (requested < currentEpoch) return { ok: false, error: 'stale_navigation' };
      const currentConversation = conversations[key];
      const senderConversationId = senderConversation(sender);
      if (requested === currentEpoch && currentConversation !== undefined
        && currentConversation !== null && currentConversation !== senderConversationId) {
        return { ok: false, error: 'conversation_changed' };
      }
      let changed = false;
      if (requested > currentEpoch) {
        epochs[key] = requested;
        changed = true;
      }
      const conversationId = senderConversationId;
      if (conversations[key] !== conversationId) {
        conversations[key] = conversationId;
        changed = true;
      }
      if (changed) await persistState();
      return {
        ok: true,
        tab_id: source.tabId,
        document_id: source.documentId,
        navigation_epoch: requested,
        conversation_id: conversationId
      };
    });
  }

  function evidenceFromMessage(message, documentId, navigationEpoch) {
    const raw = message && message.evidence && typeof message.evidence === 'object' ? message.evidence : message;
    if (!raw || typeof raw !== 'object'
      || typeof raw.request_id !== 'string'
      || typeof raw.conversation_id !== 'string'
      || !REQUEST_ID.test(raw.request_id)
      || !CONVERSATION_ID.test(raw.conversation_id)
      || !DOCUMENT_ID.test(documentId)) return null;
    return {
      request_id: raw.request_id,
      conversation_id: raw.conversation_id,
      document_id: documentId,
      navigation_epoch: navigationEpoch
    };
  }

  function fetchBounded(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  async function hello(candidate) {
    try {
      const response = await fetchBounded(`http://127.0.0.1:${candidate}/hello`, {
        cache: 'no-store'
      });
      if (!response.ok) return null;
      const body = await response.json();
      return body && body.service === SERVICE && body.protocol === PROTOCOL ? body : null;
    } catch {
      return null;
    }
  }

  async function discover() {
    await load();
    if (port !== null) {
      const known = await hello(port);
      if (known) return { port, body: known };
    }
    for (const candidate of PORTS) {
      const body = await hello(candidate);
      if (!body) continue;
      if (port !== candidate) {
        port = candidate;
        await persistBridge();
      }
      return { port: candidate, body };
    }
    if (port !== null) {
      port = null;
      await persistBridge();
    }
    return null;
  }

  async function pair(candidate) {
    try {
      const response = await fetchBounded(`http://127.0.0.1:${candidate}/pair`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', [PROTOCOL_HEADER]: String(PROTOCOL) },
        body: '{}'
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body.token !== 'string' || body.token.length === 0) return false;
      if (token !== body.token) {
        token = body.token;
        await persistBridge();
      }
      return true;
    } catch {
      return false;
    }
  }

  function ensureCredential() {
    if (pairingPromise) return pairingPromise;
    const work = (async () => {
      await load();
      if (port !== null && token !== null && Date.now() < trustedUntil) {
        return { ok: true, found: { port, body: { paired: true } } };
      }
      const found = await discover();
      if (!found) return { ok: false, error: 'bridge_unavailable' };
      if (found.body.paired === false && token !== null) {
        token = null;
        await persistBridge();
      }
      if (!token && !(await pair(found.port))) return { ok: false, error: 'pair_failed' };
      return { ok: true, found };
    })();
    const tracked = work.finally(() => {
      if (pairingPromise === tracked) pairingPromise = null;
    });
    pairingPromise = tracked;
    return tracked;
  }

  async function postBridge(path, body, retried = false) {
    const credential = await ensureCredential();
    if (!credential.ok) return credential;
    const found = credential.found;
    const requestToken = token;
    try {
      const response = await fetchBounded(`http://127.0.0.1:${found.port}${path}`, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          [PROTOCOL_HEADER]: String(PROTOCOL),
          authorization: `Bearer ${requestToken}`
        },
        body: JSON.stringify(body)
      });
      if (response.status === 401) {
        if (token === requestToken) {
          token = null;
          await persistBridge();
        }
        if (retried) return { ok: false, error: 'not_paired' };
        trustedUntil = 0;
        return postBridge(path, body, true);
      }
      const data = await response.json().catch(() => null);
      if (response.ok) trustedUntil = Date.now() + PORT_TRUST_MS;
      return response.ok
        ? { ok: true, status: response.status, data }
        : { ok: false, status: response.status, error: `bridge_http_${response.status}`, data };
    } catch {
      trustedUntil = 0;
      if (!retried) {
        port = null;
        await persistBridge();
        return postBridge(path, body, true);
      }
      return { ok: false, error: 'bridge_unavailable' };
    }
  }

  function postEvidence(evidence) {
    return postBridge('/identity-evidence', evidence);
  }

  async function receiveNavigation(message, sender) {
    return authorizeDocument(message, sender);
  }

  async function receiveEvidence(message, sender) {
    const source = senderSource(sender);
    const raw = message && message.evidence && typeof message.evidence === 'object' ? message.evidence : message;
    const requested = requestedEpoch(raw);
    if (!source || requested === null) return { ok: false, error: 'invalid_evidence' };
    const authority = await authorizeDocument({ navigation_epoch: requested }, sender);
    if (!authority.ok) return authority;
    const evidence = evidenceFromMessage(message, source.documentId, authority.navigation_epoch);
    if (!evidence) return { ok: false, error: 'invalid_evidence' };
    const delivered = await postEvidence(evidence);
    return delivered.ok ? { ok: true, evidence } : delivered;
  }

  async function receiveGoalHandoffCapture(message, sender) {
    const source = senderSource(sender);
    const conversationId = senderConversation(sender);
    const requested = requestedEpoch(message);
    const handoff = message && message.handoff;
    if (!source || requested === null || !conversationId
      || message.conversation_id !== conversationId
      || !validGoalHandoffEnvelope(handoff)) {
      return { ok: false, error: 'invalid_goal_handoff_capture' };
    }
    const authority = await authorizeDocument({ navigation_epoch: requested }, sender);
    if (!authority.ok || authority.conversation_id !== conversationId) {
      return { ok: false, error: authority.error || 'wrong_conversation' };
    }
    await load();
    const key = String(source.tabId);
    if (documents[key] !== source.documentId || epochs[key] !== requested
      || conversations[key] !== conversationId
      || (Array.isArray(retired[key]) && retired[key].includes(source.documentId))) {
      return { ok: false, error: 'document_identity_changed' };
    }
    const capture = {
      handoff,
      conversation_id: conversationId,
      document_id: source.documentId,
      navigation_epoch: requested,
    };
    const delivered = await postBridge('/goal-handoff-capture', capture);
    return delivered.ok ? { ok: true, capture, bridge: delivered.data } : delivered;
  }

  let flushingDeliveryAcks = null;

  function ackFor(entry, status, details = {}) {
    return {
      delivery_id: entry.delivery_id,
      conversation_id: entry.conversation_id,
      client_id: entry.client_id,
      document_id: entry.document_id,
      navigation_epoch: entry.navigation_epoch,
      status,
      ...details
    };
  }

  async function queueDeliveryAck(entry, status, details) {
    const payload = ackFor(entry, status, details);
    const previous = deliveryAckOutbox.find((candidate) => candidate.delivery_id === entry.delivery_id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(payload)) {
      return { ok: false, error: 'conflicting_delivery_ack' };
    }
    let nextOutbox = deliveryAckOutbox;
    if (!previous) {
      if (deliveryAckOutbox.length >= 200) return { ok: false, error: 'delivery_ack_outbox_full' };
      nextOutbox = [...deliveryAckOutbox, payload];
    }
    const nextInFlight = deliveryInFlight.filter((candidate) => candidate.delivery_id !== entry.delivery_id);
    await commitDeliveryState(nextOutbox, nextInFlight);
    return { ok: true, payload };
  }

  async function flushDeliveryAcksUnsafe() {
    await load();
    if (deliveryRecoveryBlocked) return { ok: false, error: 'delivery_state_corrupt' };
    for (const payload of [...deliveryAckOutbox]) {
      const result = await postBridge('/delivery/ack', payload);
      if (!result.ok) return result;
      await commitDeliveryState(
        deliveryAckOutbox.filter((candidate) => candidate.delivery_id !== payload.delivery_id),
        deliveryInFlight
      );
    }
    return { ok: true };
  }

  function flushDeliveryAcks() {
    if (flushingDeliveryAcks) return flushingDeliveryAcks;
    flushingDeliveryAcks = flushDeliveryAcksUnsafe().finally(() => { flushingDeliveryAcks = null; });
    return flushingDeliveryAcks;
  }

  async function prepareDeliveryClaim() {
    await load();
    if (deliveryRecoveryBlocked) return { ok: false, error: 'delivery_state_corrupt' };
    const now = Date.now();
    for (const entry of [...deliveryInFlight]) {
      if (entry.phase !== 'submitting' || entry.deadline > now) continue;
      const queued = await queueDeliveryAck(entry, 'ambiguous', { error: 'submit result lost before receipt' });
      if (!queued.ok) return queued;
    }
    const flushed = await flushDeliveryAcks();
    if (!flushed.ok || deliveryAckOutbox.length > 0) return { ok: false, error: 'delivery_ack_pending' };
    const pending = deliveryInFlight.find((entry) => entry.deadline > now);
    if (pending) return { ok: true, blocked: true };
    if (deliveryInFlight.length > 0) {
      await commitDeliveryState(
        deliveryAckOutbox,
        deliveryInFlight.filter((entry) => entry.deadline > now)
      );
    }
    return { ok: true, blocked: false };
  }

  async function claimDelivery(message, sender) {
    const source = senderSource(sender);
    const conversationId = senderConversation(sender);
    const requested = requestedEpoch(message);
    if (!source || requested === null || !conversationId || message.conversation_id !== conversationId) {
      return { ok: false, error: 'wrong_conversation' };
    }
    const authority = await authorizeDocument({ navigation_epoch: requested }, sender);
    if (!authority.ok || authority.conversation_id !== conversationId) return { ok: false, error: 'wrong_conversation' };
    return serialDeliveryState(async () => {
      if (deliveryRecoveryBlocked) return { ok: false, error: 'delivery_state_corrupt' };
      const ready = await prepareDeliveryClaim();
      if (!ready.ok) return ready;
      if (ready.blocked) return { ok: true, command: null };
      const claim = {
        conversation_id: conversationId,
        client_id: clientId,
        document_id: source.documentId,
        navigation_epoch: requested
      };
      const result = await postBridge('/delivery/claim', claim);
      if (!result.ok) return result;
      const command = result.data?.command;
      if (command === null) return { ok: true, command: null };
      if (!command || typeof command.delivery_id !== 'string' || !DELIVERY_ID.test(command.delivery_id)
        || typeof command.message !== 'string' || command.message.length === 0 || command.message.length > 48 * 1024
        || command.conversation_id !== conversationId || !Number.isSafeInteger(command.deadline)
        || command.deadline <= Date.now()) {
        return { ok: false, error: 'invalid_delivery_command' };
      }
      await commitDeliveryState(deliveryAckOutbox, [...deliveryInFlight, {
        delivery_id: command.delivery_id,
        ...claim,
        deadline: command.deadline,
        phase: 'claimed'
      }]);
      return { ok: true, command };
    });
  }

  async function deliverySubmitStarted(message, sender) {
    const source = senderSource(sender);
    const conversationId = senderConversation(sender);
    const requested = requestedEpoch(message);
    if (!source || requested === null || !conversationId) return { ok: false, error: 'wrong_conversation' };
    const authority = await authorizeDocument({ navigation_epoch: requested }, sender);
    if (!authority.ok || authority.conversation_id !== conversationId) return { ok: false, error: 'wrong_conversation' };
    return serialDeliveryState(async () => {
      if (deliveryRecoveryBlocked) return { ok: false, error: 'delivery_state_corrupt' };
      const entry = deliveryInFlight.find((candidate) => candidate.delivery_id === message.delivery_id);
      if (!entry || entry.client_id !== clientId || entry.document_id !== source.documentId
        || entry.navigation_epoch !== requested || entry.conversation_id !== conversationId) {
        return { ok: false, error: 'delivery_not_owned' };
      }
      if (entry.deadline <= Date.now()) return { ok: false, error: 'delivery_lease_expired' };
      await commitDeliveryState(deliveryAckOutbox, deliveryInFlight.map((candidate) =>
        candidate === entry ? { ...entry, phase: 'submitting' } : candidate));
      return { ok: true };
    });
  }

  async function receiveDeliveryAck(message, sender) {
    const source = senderSource(sender);
    const conversationId = senderConversation(sender);
    const requested = requestedEpoch(message);
    if (!source || requested === null || !conversationId) return { ok: false, error: 'wrong_conversation' };
    const authority = await authorizeDocument({ navigation_epoch: requested }, sender);
    if (!authority.ok || authority.conversation_id !== conversationId) return { ok: false, error: 'wrong_conversation' };
    return serialDeliveryState(async () => {
      if (deliveryRecoveryBlocked) return { ok: false, error: 'delivery_state_corrupt' };
      const entry = deliveryInFlight.find((candidate) => candidate.delivery_id === message.delivery_id);
      if (!entry) {
        const queued = deliveryAckOutbox.find((candidate) => candidate.delivery_id === message.delivery_id);
        if (!queued) return { ok: false, error: 'delivery_not_owned' };
        return flushDeliveryAcks();
      }
      if (entry.client_id !== clientId || entry.document_id !== source.documentId
        || entry.navigation_epoch !== requested || entry.conversation_id !== conversationId) {
        return { ok: false, error: 'delivery_not_owned' };
      }
      let queued;
      if (message.status === 'sent' && typeof message.message_id === 'string' && DOCUMENT_ID.test(message.message_id)) {
        queued = await queueDeliveryAck(entry, 'sent', { message_id: message.message_id });
      } else if ((message.status === 'not_sent' || message.status === 'ambiguous') && typeof message.error === 'string') {
        queued = await queueDeliveryAck(entry, message.status, { error: message.error.slice(0, 500) });
      } else {
        return { ok: false, error: 'invalid_delivery_ack' };
      }
      if (!queued.ok) return queued;
      const flushed = await flushDeliveryAcks();
      return flushed.ok ? { ok: true, queued: deliveryAckOutbox.length > 0 } : flushed;
    });
  }

  let flushingCompletionAcks = null;

  function completionAckFor(entry, status, details = {}) {
    return {
      completion_id: entry.completion_id,
      conversation_id: entry.conversation_id,
      client_id: entry.client_id,
      document_id: entry.document_id,
      navigation_epoch: entry.navigation_epoch,
      status,
      ...details
    };
  }

  function sameCompletionAck(payload, message, source, conversationId, navigationEpoch) {
    return payload.completion_id === message.completion_id
      && payload.conversation_id === conversationId
      && payload.client_id === clientId
      && payload.document_id === source.documentId
      && payload.navigation_epoch === navigationEpoch
      && payload.status === message.status
      && (message.status === 'completed'
        ? payload.assistant_message_id === message.assistant_message_id && payload.content === message.content
        : payload.error === message.error);
  }

  async function queueCompletionAck(entry, status, details) {
    const payload = completionAckFor(entry, status, details);
    const previous = completionAckOutbox.find((candidate) => candidate.completion_id === entry.completion_id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(payload)) {
      return { ok: false, error: 'conflicting_completion_ack' };
    }
    let nextOutbox = completionAckOutbox;
    if (!previous) {
      if (completionAckOutbox.length >= 200) return { ok: false, error: 'completion_ack_outbox_full' };
      nextOutbox = [...completionAckOutbox, payload];
    }
    const nextInFlight = completionInFlight.filter((candidate) => candidate.completion_id !== entry.completion_id);
    await commitCompletionState(nextOutbox, nextInFlight);
    return { ok: true, payload };
  }

  async function flushCompletionAcksUnsafe() {
    await load();
    if (completionRecoveryBlocked) return { ok: false, error: 'completion_state_corrupt' };
    for (const payload of [...completionAckOutbox]) {
      const result = await postBridge('/completion/ack', payload);
      if (!result.ok) return result;
      await commitCompletionState(
        completionAckOutbox.filter((candidate) => candidate.completion_id !== payload.completion_id),
        completionInFlight
      );
    }
    return { ok: true };
  }

  function flushCompletionAcks() {
    if (flushingCompletionAcks) return flushingCompletionAcks;
    flushingCompletionAcks = flushCompletionAcksUnsafe().finally(() => { flushingCompletionAcks = null; });
    return flushingCompletionAcks;
  }

  async function prepareCompletionClaim() {
    await load();
    if (completionRecoveryBlocked) return { ok: false, error: 'completion_state_corrupt' };
    const flushed = await flushCompletionAcks();
    if (!flushed.ok || completionAckOutbox.length > 0) return { ok: false, error: 'completion_ack_pending' };
    const now = Date.now();
    const live = completionInFlight.filter((entry) => entry.deadline > now);
    if (live.length !== completionInFlight.length) await commitCompletionState(completionAckOutbox, live);
    return { ok: true };
  }

  function validCompletionWatch(value, conversationId) {
    return value && typeof value === 'object'
      && typeof value.completion_id === 'string' && COMPLETION_ID.test(value.completion_id)
      && typeof value.conversation_id === 'string' && value.conversation_id === conversationId
      && typeof value.review_request_id === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.review_request_id)
      && typeof value.expected_user_message_id === 'string'
      && MESSAGE_ID.test(value.expected_user_message_id)
      && Number.isSafeInteger(value.deadline)
      && value.deadline > Date.now();
  }

  async function claimCompletion(message, sender) {
    const source = senderSource(sender);
    const conversationId = senderConversation(sender);
    const requested = requestedEpoch(message);
    if (!source || requested === null || !conversationId || message.conversation_id !== conversationId) {
      return { ok: false, error: 'wrong_conversation' };
    }
    const authority = await authorizeDocument({ navigation_epoch: requested }, sender);
    if (!authority.ok || authority.conversation_id !== conversationId) return { ok: false, error: 'wrong_conversation' };
    return serialCompletionState(async () => {
      if (completionRecoveryBlocked) return { ok: false, error: 'completion_state_corrupt' };
      const ready = await prepareCompletionClaim();
      if (!ready.ok) return ready;
      const claim = {
        conversation_id: conversationId,
        client_id: clientId,
        document_id: source.documentId,
        navigation_epoch: requested
      };
      const result = await postBridge('/completion/claim', claim);
      if (!result.ok) return result;
      if (result.data?.command === null) return { ok: true, command: null };
      const watch = result.data?.completion_id ? result.data : result.data?.command;
      if (!validCompletionWatch(watch, conversationId)) {
        return { ok: false, error: 'invalid_completion_watch' };
      }
      if (completionInFlight.length >= 100
        && !completionInFlight.some((entry) => entry.completion_id === watch.completion_id)) {
        return { ok: false, error: 'completion_in_flight_full' };
      }
      const inFlight = {
        completion_id: watch.completion_id,
        conversation_id: watch.conversation_id,
        review_request_id: watch.review_request_id,
        expected_user_message_id: watch.expected_user_message_id,
        client_id: clientId,
        document_id: source.documentId,
        navigation_epoch: requested,
        deadline: watch.deadline,
        phase: 'claimed'
      };
      await commitCompletionState(
        completionAckOutbox,
        [...completionInFlight.filter((entry) => entry.completion_id !== watch.completion_id), inFlight]
      );
      return { ok: true, ...watch };
    });
  }

  async function receiveCompletionAck(message, sender) {
    const source = senderSource(sender);
    const conversationId = senderConversation(sender);
    const requested = requestedEpoch(message);
    if (!source || requested === null || !conversationId) return { ok: false, error: 'wrong_conversation' };
    const authority = await authorizeDocument({ navigation_epoch: requested }, sender);
    if (!authority.ok || authority.conversation_id !== conversationId) return { ok: false, error: 'wrong_conversation' };
    return serialCompletionState(async () => {
      if (completionRecoveryBlocked) return { ok: false, error: 'completion_state_corrupt' };
      const entry = completionInFlight.find((candidate) => candidate.completion_id === message.completion_id);
      const queued = completionAckOutbox.find((candidate) => candidate.completion_id === message.completion_id);
      if (!entry) {
        if (!queued) return { ok: false, error: 'completion_not_owned' };
        if (!sameCompletionAck(queued, message, source, conversationId, requested)) {
          return { ok: false, error: 'conflicting_completion_ack' };
        }
        const flushed = await flushCompletionAcks();
        return flushed.ok ? { ok: true, queued: completionAckOutbox.length > 0 } : flushed;
      }
      if (entry.client_id !== clientId || entry.document_id !== source.documentId
        || entry.navigation_epoch !== requested || entry.conversation_id !== conversationId) {
        return { ok: false, error: 'completion_not_owned' };
      }
      if (entry.deadline <= Date.now()) return { ok: false, error: 'completion_lease_expired' };
      let status;
      let details;
      if (message.status === 'completed'
        && typeof message.assistant_message_id === 'string'
        && MESSAGE_ID.test(message.assistant_message_id)
        && validCompletionContent(message.content)) {
        status = 'completed';
        details = { assistant_message_id: message.assistant_message_id, content: message.content };
      } else if ((message.status === 'failed' || message.status === 'ambiguous')
        && typeof message.error === 'string'
        && message.error.length > 0
        && message.error.length <= 500) {
        status = message.status;
        details = { error: message.error };
      } else {
        return { ok: false, error: 'invalid_completion_ack' };
      }
      const queuedAck = await queueCompletionAck(entry, status, details);
      if (!queuedAck.ok) return queuedAck;
      const flushed = await flushCompletionAcks();
      return flushed.ok ? { ok: true, queued: completionAckOutbox.length > 0 } : flushed;
    });
  }

  const handlers = {
    register_document: registerDocument,
    navigation: receiveNavigation,
    identity_evidence: receiveEvidence,
    goal_handoff_capture: receiveGoalHandoffCapture,
    delivery_claim: claimDelivery,
    delivery_submit_started: deliverySubmitStarted,
    delivery_ack: receiveDeliveryAck,
    completion_claim: claimCompletion,
    completion_ack: receiveCompletionAck
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = message && typeof message.type === 'string'
      && Object.prototype.hasOwnProperty.call(handlers, message.type)
      ? handlers[message.type]
      : null;
    if (!handler) {
      sendResponse({ ok: false, error: 'unknown_message' });
      return false;
    }
    Promise.resolve(handler(message, sender)).then(sendResponse, () => sendResponse({ ok: false, error: 'internal_error' }));
    return true;
  });
})();
