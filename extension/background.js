(() => {
  'use strict';

  const PORTS = [12081, 12082, 12083, 12084, 12085];
  const SERVICE = 'local-review-control-bridge';
  const PROTOCOL = 1;
  const PROTOCOL_HEADER = 'x-lrm-bridge-protocol';
  const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/u;
  const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
  const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,256}$/u;
  const REQUEST_TIMEOUT_MS = 3000;

  let port = null;
  let token = null;
  let documents = {};
  let epochs = {};
  let retired = {};
  let loaded = false;
  let loading = null;
  let stateQueue = Promise.resolve();
  let pairingPromise = null;

  function serialState(task) {
    const result = stateQueue.then(task, task);
    stateQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function load() {
    if (loaded) return;
    if (!loading) {
      loading = chrome.storage.local.get(['port', 'token', 'tabDocuments', 'tabEpochs', 'retiredDocuments'])
        .then((stored) => {
          port = PORTS.includes(stored.port) ? stored.port : null;
          token = typeof stored.token === 'string' && stored.token.length > 0 ? stored.token : null;
          documents = stored.tabDocuments && typeof stored.tabDocuments === 'object' ? { ...stored.tabDocuments } : {};
          epochs = stored.tabEpochs && typeof stored.tabEpochs === 'object' ? { ...stored.tabEpochs } : {};
          retired = stored.retiredDocuments && typeof stored.retiredDocuments === 'object' ? { ...stored.retiredDocuments } : {};
          loaded = true;
        });
    }
    await loading;
  }

  async function persistBridge() {
    await chrome.storage.local.set({ port, token });
  }

  async function persistState() {
    await chrome.storage.local.set({ tabDocuments: documents, tabEpochs: epochs, retiredDocuments: retired });
  }

  function senderSource(sender) {
    if (!sender || (sender.frameId !== undefined && sender.frameId !== 0)) return null;
    const tabId = sender.tab && sender.tab.id;
    const documentId = sender.documentId;
    if (!Number.isSafeInteger(tabId) || tabId < 0 || typeof documentId !== 'string' || !DOCUMENT_ID.test(documentId)) return null;
    return { tabId, documentId };
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
      } else {
        if (requested !== 0) return { ok: false, error: 'invalid_navigation_epoch' };
        if (previous !== null) retired[key] = [...new Set([...oldDocuments, previous])].slice(-8);
        documents[key] = source.documentId;
        epochs[key] = requested;
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
      if (requested > currentEpoch) {
        epochs[key] = requested;
        await persistState();
      }
      return { ok: true, tab_id: source.tabId, document_id: source.documentId, navigation_epoch: requested };
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

  async function postEvidence(evidence, retried = false) {
    const credential = await ensureCredential();
    if (!credential.ok) return credential;
    const found = credential.found;
    const requestToken = token;
    try {
      const response = await fetchBounded(`http://127.0.0.1:${found.port}/identity-evidence`, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          [PROTOCOL_HEADER]: String(PROTOCOL),
          authorization: `Bearer ${requestToken}`
        },
        body: JSON.stringify(evidence)
      });
      if (response.status === 401) {
        if (token === requestToken) {
          token = null;
          await persistBridge();
        }
        if (retried) return { ok: false, error: 'not_paired' };
        return postEvidence(evidence, true);
      }
      return response.ok ? { ok: true } : { ok: false, error: `bridge_http_${response.status}` };
    } catch {
      return { ok: false, error: 'bridge_unavailable' };
    }
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

  const handlers = {
    register_document: registerDocument,
    navigation: receiveNavigation,
    identity_evidence: receiveEvidence
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
