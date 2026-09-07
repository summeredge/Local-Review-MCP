(() => {
  'use strict';

  const VERSION = 1;
  const ASK = 'lrm-extension-identity-ask';
  const REPLY = 'lrm-extension-identity-reply';
  const TURN_SELECTOR = 'section[data-testid^="conversation-turn"]';
  const MAX_CLIMB = 80;
  const MAX_TURNS = 100;
  const MAX_REQUESTS = 200;
  const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/u;
  const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;

  const post = window.postMessage.bind(window);

  function fiberOf(node) {
    for (const key in node) {
      if (key.startsWith('__reactFiber$')) return node[key];
    }
    return null;
  }

  function conversationEvidenceOf(fiber) {
    let found = null;
    for (let at = fiber, depth = 0; at && depth < MAX_CLIMB; at = at.return, depth += 1) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const turn = props.turn && typeof props.turn === 'object' ? props.turn : null;
      // Current ChatGPT turn fibers carry the conversation model beside `turn`; older
      // shapes expose one of the flat/thread fields below. All readable identities must agree.
      const conversation = props.conversation && typeof props.conversation === 'object' ? props.conversation : null;
      const values = [
        props.clientThreadId,
        props.conversationId,
        turn?.clientThreadId,
        turn?.conversationId,
        conversation?.id,
      ];
      for (const value of values) {
        if (value === null || value === undefined) continue;
        if (typeof value !== 'string' || !CONVERSATION_ID.test(value)) return null;
        if (found !== null && found !== value) return null;
        found = value;
      }
    }
    return found;
  }

  function turnMessagesOf(fiber) {
    for (let at = fiber, depth = 0; at && depth < MAX_CLIMB; at = at.return, depth += 1) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      if (props.turn && typeof props.turn === 'object' && Array.isArray(props.turn.messages)) {
        return props.turn.messages;
      }
      if (Array.isArray(props.allMessages)) return props.allMessages;
    }
    return null;
  }

  function requestIdsOf(messages) {
    if (!Array.isArray(messages)) return [];
    const ids = [];
    const seen = new Set();
    for (let index = 0; index < messages.length && ids.length < MAX_REQUESTS; index += 1) {
      const message = messages[index];
      if (!message || typeof message !== 'object') continue;
      const metadata = message.metadata;
      const requestId = metadata && typeof metadata === 'object' ? metadata.request_id : null;
      if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId) || seen.has(requestId)) continue;
      seen.add(requestId);
      ids.push(requestId);
    }
    return ids;
  }

  function turnsOf(sections) {
    const groups = [];
    for (let index = 0; index < sections.length; index += 1) {
      const section = sections[index];
      let turnId = null;
      try {
        const value = section && typeof section.getAttribute === 'function'
          ? section.getAttribute('data-turn-id')
          : null;
        turnId = typeof value === 'string' && value.length > 0 ? value : null;
      } catch {
        turnId = null;
      }
      const previous = groups[groups.length - 1];
      if (turnId && previous && previous.turnId === turnId) previous.sections.push(section);
      else groups.push({ turnId, sections: [section] });
    }
    return groups;
  }

  function scan(nonce) {
    const byRequest = new Map();
    const conflicts = new Set();
    let sections;
    try {
      sections = document.querySelectorAll(TURN_SELECTOR);
    } catch {
      sections = [];
    }

    const turns = turnsOf(sections);
    const first = Math.max(0, turns.length - MAX_TURNS);
    for (let turnIndex = first; turnIndex < turns.length; turnIndex += 1) {
      const turn = turns[turnIndex];
      try {
        const fiber = fiberOf(turn.sections[0]);
        const conversationId = fiber ? conversationEvidenceOf(fiber) : null;
        const messages = fiber ? turnMessagesOf(fiber) : null;
        if (!conversationId || !messages) continue;
        for (const requestId of requestIdsOf(messages)) {
          const previous = byRequest.get(requestId);
          if (previous !== undefined && previous !== conversationId) conflicts.add(requestId);
          else if (previous === undefined) byRequest.set(requestId, conversationId);
        }
      } catch {
        // One unreadable turn must not turn into guessed identity evidence.
      }
    }

    const evidence = [];
    for (const [requestId, conversationId] of byRequest) {
      if (conflicts.has(requestId)) continue;
      evidence.push({ request_id: requestId, fiber_conversation_id: conversationId });
    }
    post({ source: REPLY, nonce, version: VERSION, evidence }, location.origin);
  }

  const listener = (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== ASK) return;
    const nonce = typeof data.nonce === 'string' ? data.nonce.slice(0, 128) : '';
    if (!nonce) return;
    try {
      scan(nonce);
    } catch {
      try {
        post({ source: REPLY, nonce, version: VERSION, evidence: [] }, location.origin);
      } catch {
        // The isolated world will fail closed on timeout.
      }
    }
  };

  const prior = window.__lrmIdentityFiberHelper;
  if (prior && prior.version === VERSION && typeof prior.listener === 'function') {
    try {
      window.removeEventListener('message', prior.listener);
    } catch {
      // Install the current listener below.
    }
  }
  window.addEventListener('message', listener);
  window.__lrmIdentityFiberHelper = { version: VERSION, listener };
})();
