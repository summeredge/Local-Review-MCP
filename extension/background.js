(() => {
  'use strict';

  const PORTS = [12081, 12082, 12083, 12084, 12085];
  const SERVICE = 'local-review-control-bridge';
  const PROTOCOL = 2;
  const PROTOCOL_HEADER = 'x-lrm-bridge-protocol';
  const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/u;
  const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
  const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,256}$/u;
  const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
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
  let pairingPromise = null;
  let clientId = null;
  let deliveryAckOutbox = [];
  let deliveryInFlight = [];
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

  function serialState(task) {
    const result = stateQueue.then(task, task);
    stateQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function load() {
    if (loaded) return;
    if (!loading) {
      loading = chrome.storage.local.get([
        'port', 'token', 'tabDocuments', 'tabEpochs', 'tabConversations', 'retiredDocuments',
        'extensionClientId', 'deliveryAckOutbox', 'deliveryInFlight'
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
          deliveryAckOutbox = Array.isArray(stored.deliveryAckOutbox)
            ? stored.deliveryAckOutbox.filter(validStoredAck).slice(-200)
            : [];
          deliveryInFlight = Array.isArray(stored.deliveryInFlight)
            ? stored.deliveryInFlight.filter(validStoredInFlight).slice(-100)
            : [];
          return chrome.storage.local.set({ extensionClientId: clientId, deliveryAckOutbox, deliveryInFlight })
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
    await chrome.storage.local.set({
      extensionClientId: clientId,
      deliveryAckOutbox: nextOutbox.slice(-200),
      deliveryInFlight: nextInFlight.slice(-100)
    });
    deliveryAckOutbox = nextOutbox;
    deliveryInFlight = nextInFlight;
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
      let changed = false;
      if (requested > currentEpoch) {
        epochs[key] = requested;
        changed = true;
      }
      const conversationId = senderConversation(sender);
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

  function flushDeliveryAcks() {
    if (flushingDeliveryAcks) return flushingDeliveryAcks;
    flushingDeliveryAcks = (async () => {
      await load();
      for (const payload of [...deliveryAckOutbox]) {
        const result = await postBridge('/delivery/ack', payload);
        if (!result.ok) return result;
        await commitDeliveryState(
          deliveryAckOutbox.filter((candidate) => candidate.delivery_id !== payload.delivery_id),
          deliveryInFlight
        );
      }
      return { ok: true };
    })().finally(() => { flushingDeliveryAcks = null; });
    return flushingDeliveryAcks;
  }

  async function prepareDeliveryClaim() {
    await load();
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
  }

  async function deliverySubmitStarted(message, sender) {
    const source = senderSource(sender);
    const conversationId = senderConversation(sender);
    const requested = requestedEpoch(message);
    if (!source || requested === null || !conversationId) return { ok: false, error: 'wrong_conversation' };
    const authority = await authorizeDocument({ navigation_epoch: requested }, sender);
    if (!authority.ok || authority.conversation_id !== conversationId) return { ok: false, error: 'wrong_conversation' };
    const entry = deliveryInFlight.find((candidate) => candidate.delivery_id === message.delivery_id);
    if (!entry || entry.client_id !== clientId || entry.document_id !== source.documentId
      || entry.navigation_epoch !== requested || entry.conversation_id !== conversationId) {
      return { ok: false, error: 'delivery_not_owned' };
    }
    if (entry.deadline <= Date.now()) return { ok: false, error: 'delivery_lease_expired' };
    await commitDeliveryState(deliveryAckOutbox, deliveryInFlight.map((candidate) =>
      candidate === entry ? { ...entry, phase: 'submitting' } : candidate));
    return { ok: true };
  }

  async function receiveDeliveryAck(message, sender) {
    const source = senderSource(sender);
    const conversationId = senderConversation(sender);
    const requested = requestedEpoch(message);
    if (!source || requested === null || !conversationId) return { ok: false, error: 'wrong_conversation' };
    const authority = await authorizeDocument({ navigation_epoch: requested }, sender);
    if (!authority.ok || authority.conversation_id !== conversationId) return { ok: false, error: 'wrong_conversation' };
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
  }

  const handlers = {
    register_document: registerDocument,
    navigation: receiveNavigation,
    identity_evidence: receiveEvidence,
    delivery_claim: claimDelivery,
    delivery_submit_started: deliverySubmitStarted,
    delivery_ack: receiveDeliveryAck
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
