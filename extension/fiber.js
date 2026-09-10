(() => {
  'use strict';

  const VERSION = 1;
  const ASK = 'lrm-extension-identity-ask';
  const REPLY = 'lrm-extension-identity-reply';
  const COMPLETION_FIBER_VERSION = 1;
  const COMPLETION_ASK = 'lrm-extension-review-completion-ask';
  const COMPLETION_REPLY = 'lrm-extension-review-completion-reply';
  const TURN_SELECTOR = 'section[data-testid^="conversation-turn"]';
  const MAX_CLIMB = 80;
  const MAX_TURNS = 100;
  const MAX_REQUESTS = 200;
  const MAX_COMPLETION_CONTENT = 256 * 1024;
  const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/u;
  const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
  const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

  const post = window.postMessage.bind(window);

  function fiberOf(node) {
    for (const key in node) {
      if (key.startsWith('__reactFiber$')) return node[key];
    }
    return null;
  }

  function conversationEvidenceDetailsOf(fiber) {
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
        if (typeof value !== 'string' || !CONVERSATION_ID.test(value)) {
          return { conversationId: null, conflict: false, unreadable: true };
        }
        if (found !== null && found !== value) return { conversationId: null, conflict: true, unreadable: false };
        found = value;
      }
    }
    return { conversationId: found, conflict: false, unreadable: false };
  }

  function conversationEvidenceOf(fiber) {
    const evidence = conversationEvidenceDetailsOf(fiber);
    return evidence.conflict ? null : evidence.conversationId;
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

  function str(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  function utf8Length(value) {
    try {
      return encodeURIComponent(value).replace(/%[0-9a-f]{2}|./giu, 'x').length;
    } catch {
      return Infinity;
    }
  }

  function authoredTextResult(message) {
    const content = message && typeof message === 'object' ? message.content : null;
    if (!content || typeof content !== 'object' || content.content_type !== 'text') {
      return { status: 'not_text', text: '' };
    }
    if (!Array.isArray(content.parts)) return { status: 'unreadable', text: '' };
    let text = '';
    for (const part of content.parts) {
      if (typeof part !== 'string') return { status: 'unreadable', text: '' };
      if (text) text += '\n';
      text += part;
      if (utf8Length(text) > MAX_COMPLETION_CONTENT) return { status: 'too_large', text: '' };
    }
    return { status: text.length > 0 ? 'text' : 'empty', text };
  }

  function authoredText(message) {
    const result = authoredTextResult(message);
    return result.status === 'text' ? result.text : null;
  }

  function authoredTime(message) {
    const raw = message && typeof message === 'object' ? Number(message.create_time) : NaN;
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return Math.round(raw < 10_000_000_000 ? raw * 1000 : raw);
  }

  function turnIdentityContradicts(left, right) {
    return Boolean(left && right && left !== right);
  }

  function assistantLogicalId(id, parentId, workingTurnId, turnExchangeId, createTime) {
    if ((workingTurnId || turnExchangeId) && createTime) {
      const stable = `assistant:${workingTurnId || ''}:${turnExchangeId || ''}:${createTime}`;
      if (stable.length <= 190) return stable;
    }
    if (!parentId || (!workingTurnId && !turnExchangeId)) return id;
    const fallback = `assistant:${parentId}:${workingTurnId || ''}:${turnExchangeId || ''}`;
    return fallback.length <= 190 ? fallback : id;
  }

  function channelOf(message) {
    return message && typeof message === 'object' && typeof message.channel === 'string'
      ? message.channel : '';
  }

  function analysisMessage(message) {
    return channelOf(message) === 'analysis';
  }

  function neverTerminalChannel(message) {
    const channel = channelOf(message);
    return channel === 'analysis' || channel === 'commentary';
  }

  function hiddenMessage(message) {
    const metadata = message && typeof message === 'object' ? message.metadata : null;
    return Boolean(metadata && typeof metadata === 'object'
      && (metadata.is_visually_hidden_from_conversation === true || metadata.is_visually_hidden === true));
  }

  function thoughtMessage(message) {
    return Boolean(message && typeof message === 'object'
      && message.author?.role === 'assistant'
      && message.content?.content_type === 'thoughts'
      && str(message.id));
  }

  function requestOf(message) {
    return Boolean(message && typeof message === 'object'
      && message.author?.role === 'assistant'
      && typeof message.recipient === 'string'
      && message.recipient.startsWith('api_tool'));
  }

  function resultOf(message) {
    const metadata = message && typeof message === 'object' ? message.metadata : null;
    return Boolean(metadata && typeof metadata === 'object'
      && metadata.invoked_resource && typeof metadata.invoked_resource === 'object');
  }

  function messageOf(fiber) {
    let found = null;
    for (let at = fiber, depth = 0; at && depth < MAX_CLIMB; at = at.return, depth += 1) {
      const props = at.memoizedProps;
      const message = props && typeof props === 'object' ? props.message : null;
      if (!publicAssistantMessage(message)) continue;
      const id = str(message.id);
      if (!id) continue;
      if (found !== null && found !== id) return null;
      found = id;
    }
    return found;
  }

  function publicAssistantMessage(message) {
    if (!message || typeof message !== 'object' || message.author?.role !== 'assistant') return false;
    if (analysisMessage(message) || neverTerminalChannel(message) || hiddenMessage(message)
      || thoughtMessage(message) || requestOf(message) || resultOf(message)) return false;
    const content = message.content;
    return Boolean(content && typeof content === 'object'
      && ['text', 'multimodal_text', 'image'].includes(content.content_type));
  }

  function authoredAssistantMessages(messages, budget, start = 0, end = Array.isArray(messages) ? messages.length : 0) {
    const out = [];
    const seen = new Set();
    const logicalIds = new Set();
    const thoughtParents = new Map();
    if (!Array.isArray(messages)) return out;
    for (const message of messages) {
      if (thoughtMessage(message)) thoughtParents.set(str(message.id), message);
    }
    for (let index = start; index < Math.min(end, messages.length); index += 1) {
      const message = messages[index];
      if (!publicAssistantMessage(message)) continue;
      const id = str(message.id);
      const textResult = authoredTextResult(message);
      const rawText = textResult.status === 'text' ? textResult.text : '';
      if (!id || (budget && budget.remaining <= 0) || seen.has(id)) continue;
      const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
      const parentId = metadata ? str(metadata.parent_id) : null;
      const workingTurnId = metadata ? str(metadata.working_turn_id) : null;
      const turnExchangeId = metadata ? str(metadata.turn_exchange_id) : null;
      const createTime = authoredTime(message);
      const authoredId = assistantLogicalId(id, parentId, workingTurnId, turnExchangeId, createTime);
      const stableId = (workingTurnId || turnExchangeId) && createTime
        ? `assistant:${workingTurnId || ''}:${turnExchangeId || ''}:${createTime}` : null;
      const collides = logicalIds.has(authoredId);
      if (collides) {
        for (const prior of out) {
          if (prior.messageId === authoredId) prior.identityConflict = true;
        }
      }
      let logicalId = collides
        ? assistantLogicalId(id, parentId, workingTurnId, turnExchangeId, null)
        : authoredId;
      let stable = !collides && stableId !== null && logicalId === stableId
        && logicalId !== id && logicalId !== parentId;
      let identityConflict = collides;
      const thoughtParent = parentId ? thoughtParents.get(parentId) : null;
      if (thoughtParent) {
        const parentMetadata = thoughtParent.metadata && typeof thoughtParent.metadata === 'object'
          ? thoughtParent.metadata : null;
        const parentWorking = parentMetadata ? str(parentMetadata.working_turn_id) : null;
        const parentExchange = parentMetadata ? str(parentMetadata.turn_exchange_id) : null;
        if (!turnIdentityContradicts(workingTurnId, parentWorking)
          && !turnIdentityContradicts(turnExchangeId, parentExchange)) {
          if (logicalId === id) logicalId = parentId;
          stable = true;
        }
      }
      if (logicalIds.has(logicalId)) {
        for (const prior of out) {
          if (prior.messageId === logicalId) prior.identityConflict = true;
        }
        logicalId = id;
        stable = false;
        identityConflict = true;
      }
      if (budget && rawText) budget.remaining -= Math.min(budget.remaining, rawText.length);
      logicalIds.add(logicalId);
      seen.add(id);
      out.push({ id, messageId: logicalId, stable, identityConflict, rawText, textStatus: textResult.status, order: index, createTime });
    }
    return out;
  }

  function authoredUserMessages(messages, budget) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(messages)) return out;
    for (let index = 0; index < messages.length; index += 1) {
      if (budget && budget.remaining <= 0) break;
      const message = messages[index];
      if (!message || typeof message !== 'object' || message.author?.role !== 'user') continue;
      const id = str(message.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const text = authoredText(message);
      if (!text) continue;
      if (budget) budget.remaining -= Math.min(budget.remaining, text.length);
      out.push({ id, messageId: id, role: 'user', stable: true, rawText: text, order: index });
    }
    return out;
  }

  function turnEndMessageId(messages, start = 0, end = Array.isArray(messages) ? messages.length : 0) {
    if (!Array.isArray(messages)) return null;
    for (let index = end - 1; index >= start; index -= 1) {
      const message = messages[index];
      if (!publicAssistantMessage(message)) continue;
      if (message.end_turn === true && message.status === 'finished_successfully') return str(message.id);
      return null;
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

  function conversationIdFromLocation() {
    try {
      const url = new URL(location.href);
      if (url.origin !== 'https://chatgpt.com' && url.origin !== 'https://chat.openai.com') return null;
      return /^\/(?:g\/[^/]+\/)?c\/([A-Za-z0-9][A-Za-z0-9_-]{0,255})\/?$/u.exec(url.pathname)?.[1] || null;
    } catch {
      return null;
    }
  }

  function completionReply(nonce, completionId, conversationId, expectedUserMessageId, status, details = {}) {
    post({
      source: COMPLETION_REPLY,
      nonce,
      version: COMPLETION_FIBER_VERSION,
      completion_id: completionId,
      conversation_id: conversationId,
      expected_user_message_id: expectedUserMessageId,
      status,
      ...details,
    }, location.origin);
  }

  function scanCompletion(nonce, completionId, conversationId, expectedUserMessageId) {
    const routeConversationId = conversationIdFromLocation();
    if (routeConversationId !== conversationId) {
      completionReply(nonce, completionId, conversationId, expectedUserMessageId, 'ambiguous', {
        error: 'completion_conversation_conflict',
      });
      return;
    }

    let sections;
    try {
      sections = document.querySelectorAll(TURN_SELECTOR);
    } catch {
      sections = [];
    }

    const turns = turnsOf(sections);
    const first = Math.max(0, turns.length - MAX_TURNS);
    const matches = [];
    let conversationConflict = false;
    let conversationUnreadable = false;
    let wrongConversation = false;
    for (let turnIndex = first; turnIndex < turns.length; turnIndex += 1) {
      const turn = turns[turnIndex];
      try {
        const fiber = fiberOf(turn.sections[0]);
        const messages = fiber ? turnMessagesOf(fiber) : null;
        if (!fiber || !messages) continue;
        const userIndexes = [];
        for (let index = 0; index < messages.length; index += 1) {
          const message = messages[index];
          if (message && typeof message === 'object' && message.author?.role === 'user'
            && message.id === expectedUserMessageId) userIndexes.push(index);
        }
        if (userIndexes.length === 0) continue;
        const conversation = conversationEvidenceDetailsOf(fiber);
        if (conversation.conflict) {
          conversationConflict = true;
          continue;
        }
        if (conversation.unreadable) {
          conversationUnreadable = true;
          continue;
        }
        if (!conversation.conversationId) continue;
        if (conversation.conversationId !== conversationId) {
          wrongConversation = true;
          continue;
        }
        for (const userIndex of userIndexes) {
          matches.push({ turnId: turn.turnId, messages, userIndex });
        }
      } catch {
        // Hydration is transient; the next observer or fallback poll retries it.
      }
    }

    if (conversationConflict || wrongConversation || matches.length > 1) {
      completionReply(nonce, completionId, conversationId, expectedUserMessageId, 'ambiguous', {
        error: 'completion_identity_ambiguous',
      });
      return;
    }
    if (conversationUnreadable) {
      completionReply(nonce, completionId, conversationId, expectedUserMessageId, 'pending');
      return;
    }
    if (matches.length === 0) {
      completionReply(nonce, completionId, conversationId, expectedUserMessageId, 'pending');
      return;
    }

    const match = matches[0];
    let end = match.messages.length;
    for (let index = match.userIndex + 1; index < match.messages.length; index += 1) {
      if (match.messages[index]?.author?.role === 'user') {
        end = index;
        break;
      }
    }
    const terminalRawId = turnEndMessageId(match.messages, match.userIndex + 1, end);
    if (!terminalRawId) {
      completionReply(nonce, completionId, conversationId, expectedUserMessageId, 'pending');
      return;
    }

    const assistants = authoredAssistantMessages(match.messages, undefined, match.userIndex + 1, end);
    const terminal = assistants.find((message) => message.id === terminalRawId);
    if (!terminal || terminal.identityConflict) {
      completionReply(nonce, completionId, conversationId, expectedUserMessageId, 'ambiguous', {
        error: 'completion_assistant_identity_ambiguous',
      });
      return;
    }
    if (terminal.textStatus === 'too_large') {
      completionReply(nonce, completionId, conversationId, expectedUserMessageId, 'failed', {
        error: 'completion_content_too_large',
      });
      return;
    }
    if (!terminal.stable || !MESSAGE_ID.test(terminal.messageId)) {
      completionReply(nonce, completionId, conversationId, expectedUserMessageId, 'failed', {
        error: 'completion_assistant_message_id_unavailable',
      });
      return;
    }
    if (terminal.textStatus !== 'text' || !terminal.rawText) {
      completionReply(nonce, completionId, conversationId, expectedUserMessageId, 'failed', {
        error: 'completion_public_text_unavailable',
      });
      return;
    }
    completionReply(nonce, completionId, conversationId, expectedUserMessageId, 'completed', {
      assistant_message_id: terminal.messageId,
      content: terminal.rawText,
    });
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

  const completionListener = (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== COMPLETION_ASK
      || data.version !== COMPLETION_FIBER_VERSION) return;
    const nonce = typeof data.nonce === 'string' ? data.nonce.slice(0, 128) : '';
    const completionId = typeof data.completion_id === 'string' ? data.completion_id : '';
    const conversationId = typeof data.conversation_id === 'string' ? data.conversation_id : '';
    const expectedUserMessageId = typeof data.expected_user_message_id === 'string'
      ? data.expected_user_message_id : '';
    if (!nonce || !completionId || !CONVERSATION_ID.test(conversationId)
      || !MESSAGE_ID.test(expectedUserMessageId)) return;
    try {
      scanCompletion(nonce, completionId, conversationId, expectedUserMessageId);
    } catch {
      try {
        completionReply(nonce, completionId, conversationId, expectedUserMessageId, 'pending');
      } catch {
        // The isolated world retries on its next poll.
      }
    }
  };

  const priorCompletion = window.__lrmCompletionFiberHelper;
  if (priorCompletion && priorCompletion.version === COMPLETION_FIBER_VERSION
    && typeof priorCompletion.listener === 'function') {
    try {
      window.removeEventListener('message', priorCompletion.listener);
    } catch {
      // Install the current listener below.
    }
  }
  window.addEventListener('message', completionListener);
  window.__lrmCompletionFiberHelper = {
    version: COMPLETION_FIBER_VERSION,
    listener: completionListener,
  };
})();
