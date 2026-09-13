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
  const MAX_COMPLETION_MESSAGE_CANDIDATES = 20;
  const MAX_COMPLETION_CONTENT = 256 * 1024;
  const GOAL_HANDOFF_PROTOCOL = 'local-review-mcp.goal-handoff';
  const GOAL_HANDOFF_SCHEMA_VERSION = '2';
  const MAX_GOAL_HANDOFFS = 20;
  const MAX_GOAL_HANDOFF_TEXT = 16 * 1024;
  const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/u;
  const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
  const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
  const HANDOFF_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
  const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
  const SIGNATURE = /^[0-9a-f]{64}$/u;
  const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
  const GOAL_START = /(?:建立|创建|启动)\s*一个\s*Goal\b/iu;
  const GOAL_HANDOFF = /(?:交给|交由)\s*Codex\s*(?:(?:来|去|进行)\s*)?(?:执行|实施|实现|处理|完成|运行)|(?:让|请)\s*Codex\s*(?:(?:来|去|进行)\s*)?(?:执行|实施|实现|处理|完成|运行)|Codex\s*(?:(?:来|去|进行)\s*)?(?:执行|实施|实现|处理|完成|运行)/iu;
  const GOAL_START_EN = /(?:establish|create|start)\s+(?:a\s+)?Goal\b/iu;
  const GOAL_HANDOFF_EN = /(?:(?:hand|give|send)\s+(?:it\s+)?to\s+Codex\s+for\s+(?:execution|implementation))|(?:Codex\s+(?:to\s+)?(?:execute|implement|run))/iu;

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

  function validMessageId(value) {
    const id = str(value);
    return id && MESSAGE_ID.test(id) ? id : null;
  }

  function metadataOf(message) {
    return message && typeof message === 'object'
      && message.metadata && typeof message.metadata === 'object'
      ? message.metadata : null;
  }

  function metadataString(metadata, ...keys) {
    for (const key of keys) {
      const value = str(metadata?.[key]);
      if (value) return value;
    }
    return null;
  }

  function messageIdOf(message) {
    if (!message || typeof message !== 'object') return null;
    return validMessageId(message.id) || validMessageId(message.message_id)
      || validMessageId(message.messageId);
  }

  function stableMessageIdentityOf(message) {
    if (!message || typeof message !== 'object') return null;
    const metadata = metadataOf(message);
    const explicit = [
      [message.message_id, 'message_id'],
      [message.messageId, 'message_id'],
      [metadata?.message_id, 'metadata_message_id'],
      [metadata?.messageId, 'metadata_message_id'],
    ];
    for (const [value, source] of explicit) {
      const id = validMessageId(value);
      if (id) return { id, source, type: 'message_id' };
    }
    return null;
  }

  function turnIdentityOf(message, expectedUserMessageId) {
    if (!message || typeof message !== 'object') return null;
    const metadata = metadataOf(message);
    const value = str(message.turn_id) || str(message.turnId)
      || metadataString(metadata, 'turn_id', 'turnId');
    return value && value !== expectedUserMessageId && MESSAGE_ID.test(value)
      ? value : null;
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
    const metadata = metadataOf(message);
    const raw = message && typeof message === 'object'
      ? Number(message.create_time ?? message.createTime
        ?? metadata?.create_time ?? metadata?.createTime) : NaN;
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
      const id = messageIdOf(message);
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

  function authoredAssistantMessages(
    messages,
    budget,
    start = 0,
    end = Array.isArray(messages) ? messages.length : 0,
    expectedUserMessageId = null,
  ) {
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
      const id = messageIdOf(message);
      const textResult = authoredTextResult(message);
      const rawText = textResult.status === 'text' ? textResult.text : '';
      if ((budget && budget.remaining <= 0) || (id && seen.has(id))) continue;
      const metadata = metadataOf(message);
      const parentId = metadataString(metadata, 'parent_id', 'parentId');
      const workingTurnId = metadataString(metadata, 'working_turn_id', 'workingTurnId');
      const turnExchangeId = metadataString(metadata, 'turn_exchange_id', 'turnExchangeId');
      const createTime = authoredTime(message);
      const directIdentity = stableMessageIdentityOf(message);
      const turnIdentity = turnIdentityOf(message, expectedUserMessageId);
      const metadataTurnIdentity = (workingTurnId || turnExchangeId) && !createTime
        ? `working:${workingTurnId || ''}:${turnExchangeId || ''}` : null;
      const modelIdentity = assistantLogicalId(id, parentId, workingTurnId, turnExchangeId, createTime);
      const authoredId = directIdentity?.id
        || (modelIdentity === id && (turnIdentity || metadataTurnIdentity)
          ? `assistant:turn:${turnIdentity || metadataTurnIdentity}` : modelIdentity)
        || (turnIdentity ? `assistant:turn:${turnIdentity}` : null);
      const stableId = (workingTurnId || turnExchangeId) && createTime
        ? `assistant:${workingTurnId || ''}:${turnExchangeId || ''}:${createTime}` : null;
      const collides = authoredId !== null && logicalIds.has(authoredId);
      if (collides) {
        for (const prior of out) {
          if (prior.messageId === authoredId) prior.identityConflict = true;
        }
      }
      let logicalId = collides
        ? assistantLogicalId(id, parentId, workingTurnId, turnExchangeId, null)
        : authoredId;
      let identitySource = directIdentity?.source || (stableId !== null ? 'metadata_turn_tuple' : null);
      let identityType = directIdentity?.type || (stableId !== null ? 'turn_identity' : null);
      let stable = !collides && directIdentity !== null;
      if (!stable && !collides && stableId !== null && logicalId === stableId
        && logicalId !== id && logicalId !== parentId) stable = true;
      if (!stable && !collides && turnIdentity && logicalId === `assistant:turn:${turnIdentity}`) {
        stable = true;
        identitySource = 'message_turn_id';
        identityType = 'turn_identity';
      }
      if (!stable && !collides && metadataTurnIdentity && logicalId === `assistant:turn:${metadataTurnIdentity}`) {
        stable = true;
        identitySource = 'metadata_turn_identity';
        identityType = 'turn_identity';
      }
      if (!stable && !collides && parentId && (workingTurnId || turnExchangeId)
        && logicalId !== id && logicalId !== null) {
        stable = true;
        identitySource = 'parent_turn_tuple';
        identityType = 'fallback';
      }
      let identityConflict = collides;
      const thoughtParent = parentId ? thoughtParents.get(parentId) : null;
      if (thoughtParent) {
        const parentMetadata = metadataOf(thoughtParent);
        const parentWorking = metadataString(parentMetadata, 'working_turn_id', 'workingTurnId');
        const parentExchange = metadataString(parentMetadata, 'turn_exchange_id', 'turnExchangeId');
        if (!turnIdentityContradicts(workingTurnId, parentWorking)
          && !turnIdentityContradicts(turnExchangeId, parentExchange)) {
          if (!stable && logicalId === id) logicalId = parentId;
          if (!stable && logicalId === parentId) {
            stable = true;
            identitySource = 'thought_parent';
            identityType = 'turn_identity';
          }
        }
      }
      if (logicalId !== null && logicalIds.has(logicalId)) {
        for (const prior of out) {
          if (prior.messageId === logicalId) prior.identityConflict = true;
        }
        logicalId = id || null;
        stable = false;
        identityConflict = true;
        identitySource = 'identity_collision';
        identityType = 'none';
      }
      if (budget && rawText) budget.remaining -= Math.min(budget.remaining, rawText.length);
      if (logicalId !== null) logicalIds.add(logicalId);
      if (id) seen.add(id);
      out.push({ id, messageId: logicalId, stable, identityConflict, identitySource,
        identityType: identityType || 'none', turnIdentity, rawText, textStatus: textResult.status,
        order: index, createTime });
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

  function turnEndMessageIndex(messages, start = 0, end = Array.isArray(messages) ? messages.length : 0) {
    if (!Array.isArray(messages)) return null;
    for (let index = end - 1; index >= start; index -= 1) {
      const message = messages[index];
      if (!publicAssistantMessage(message)) continue;
      if (message.streaming === true || message.isStreaming === true) return null;
      if (message.end_turn === true && message.status === 'finished_successfully') return index;
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
    const envelopeKeys = [
      'protocol', 'schema_version', 'handoff_id', 'request_id', 'workspace_id',
      'goal', 'issued_at', 'expires_at', 'signature',
    ];
    if (!exactObject(value, envelopeKeys)
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

  function goalHandoffKey(value) {
    return JSON.stringify([
      value.protocol, value.schema_version, value.handoff_id, value.request_id,
      value.workspace_id, value.goal.title, value.goal.goal, value.goal.requirements,
      value.goal.acceptance_criteria, value.goal.max_iterations, value.issued_at,
      value.expires_at, value.signature,
    ]);
  }

  function toolNameFromPath(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2000
      || value.charAt(0) !== '/' || value.includes('?') || value.includes('#')) return null;
    const parts = value.split('/');
    if (parts.length < 2 || parts.slice(1).some((part) => part.length === 0)) return null;
    return parts[parts.length - 1];
  }

  function goalToolRequestOf(message) {
    if (!message || typeof message !== 'object' || message.author?.role !== 'assistant'
      || typeof message.recipient !== 'string' || !message.recipient.startsWith('api_tool')) return null;
    const id = validMessageId(message.id);
    if (!id) return null;
    const text = message.content && typeof message.content === 'object'
      && typeof message.content.text === 'string' ? message.content.text : '';
    const path = /^\s*\{\s*"path"\s*:\s*"([^"\\]{1,2000})"/u.exec(text)?.[1] || null;
    return { id, tool: path === null ? null : toolNameFromPath(path) };
  }

  function parseGoalResultValue(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || value.length === 0 || value.length > 512 * 1024) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function addGoalResultValue(value, candidates) {
    const parsed = parseGoalResultValue(value);
    if (!parsed || typeof parsed !== 'object') return;
    if (validGoalHandoffEnvelope(parsed)) {
      candidates.push(parsed);
      return;
    }
    if (parsed.type === 'text' && own(parsed, 'text')) {
      addGoalResultValue(parsed.text, candidates);
    }
    for (const key of ['structured_content', 'structuredContent', 'result', 'tool_result']) {
      if (own(parsed, key)) addGoalResultValue(parsed[key], candidates);
    }
  }

  function goalResultValuesOf(message) {
    if (!message || typeof message !== 'object' || message.author?.role !== 'tool') return [];
    const metadata = metadataOf(message);
    const resource = metadata?.invoked_resource;
    if (!resource || typeof resource !== 'object'
      || toolNameFromPath(resource.resource_uri) !== 'prepare_goal_handoff') return [];
    const values = [];
    const content = message.content;
    if (content && typeof content === 'object') {
      for (const key of ['structured_content', 'structuredContent', 'result', 'tool_result', 'text']) {
        if (own(content, key)) addGoalResultValue(content[key], values);
      }
      if (Array.isArray(content.parts)) {
        for (const part of content.parts) addGoalResultValue(part, values);
      } else if (Array.isArray(content)) {
        for (const part of content) addGoalResultValue(part, values);
      }
    }
    for (const key of ['structured_content', 'structuredContent', 'result', 'tool_result']) {
      if (own(message, key)) addGoalResultValue(message[key], values);
    }
    return values;
  }

  function goalToolResultOf(message) {
    if (!message || typeof message !== 'object') return null;
    const metadata = metadataOf(message);
    const parentId = validMessageId(metadata?.parent_id);
    const resource = metadata?.invoked_resource;
    if (!parentId || !resource || typeof resource !== 'object'
      || toolNameFromPath(resource.resource_uri) !== 'prepare_goal_handoff') return null;
    return {
      parentId,
      messageId: validMessageId(message.id),
      values: goalResultValuesOf(message),
    };
  }

  function userTextOf(message) {
    if (!message || typeof message !== 'object' || message.author?.role !== 'user') return null;
    const content = message.content;
    if (!content || typeof content !== 'object' || content.content_type !== 'text') return null;
    if (Array.isArray(content.parts)) {
      if (!content.parts.every((part) => typeof part === 'string')) return null;
      const text = content.parts.join('\n');
      return text.length <= MAX_GOAL_HANDOFF_TEXT ? text : null;
    }
    return typeof content.text === 'string' && content.text.length <= MAX_GOAL_HANDOFF_TEXT
      ? content.text : null;
  }

  function goalActivationOf(message) {
    const text = userTextOf(message);
    if (!text) return false;
    return (GOAL_START.test(text) && GOAL_HANDOFF.test(text))
      || (GOAL_START_EN.test(text) && GOAL_HANDOFF_EN.test(text));
  }

  function goalHandoffCandidatesOf(messages, conversationId, turnIndex) {
    if (!Array.isArray(messages)) return [];
    const requests = new Map();
    const requestConflicts = new Set();
    const userOrders = [];
    const activationOrders = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message?.author?.role === 'user') {
        userOrders.push(index);
        if (goalActivationOf(message)) activationOrders.push(index);
      }
      const request = goalToolRequestOf(message);
      if (!request) continue;
      const previous = requests.get(request.id);
      if (previous && previous.tool !== request.tool) requestConflicts.add(request.id);
      else if (!previous) requests.set(request.id, { ...request, order: index });
    }
    const candidates = [];
    for (let index = 0; index < messages.length; index += 1) {
      const result = goalToolResultOf(messages[index]);
      if (!result || requestConflicts.has(result.parentId)) continue;
      const request = requests.get(result.parentId);
      if (!request || (request.tool !== null && request.tool !== 'prepare_goal_handoff')) continue;
      if (request.order >= index) continue;
      const values = result.values;
      const unique = new Map();
      for (const value of values) unique.set(goalHandoffKey(value), value);
      if (unique.size === 0) continue;
      if (unique.size > 1) continue;
      const handoff = unique.values().next().value;
      candidates.push({
        handoff,
        fiber_conversation_id: conversationId,
        turn_index: turnIndex,
        request_message_id: request.id,
        result_message_id: result.messageId,
        request_order: request.order,
        result_order: index,
        user_orders: userOrders,
        activation_orders: activationOrders,
      });
    }

    const byRequest = new Map();
    const requestConflictingResults = new Set();
    for (const candidate of candidates) {
      const list = byRequest.get(candidate.request_message_id) ?? [];
      list.push(candidate);
      byRequest.set(candidate.request_message_id, list);
    }
    for (const [requestId, list] of byRequest) {
      const keys = new Set(list.map((candidate) => goalHandoffKey(candidate.handoff)));
      if (keys.size > 1) requestConflictingResults.add(requestId);
    }

    const byHandoff = new Map();
    const handoffConflicts = new Set();
    const kept = [];
    for (const candidate of candidates) {
      if (requestConflictingResults.has(candidate.request_message_id)) continue;
      const id = candidate.handoff.handoff_id;
      const key = goalHandoffKey(candidate.handoff);
      const previous = byHandoff.get(id);
      if (previous && previous.key !== key) handoffConflicts.add(id);
      else if (!previous) byHandoff.set(id, { key, candidate });
    }
    for (const { candidate } of byHandoff.values()) {
      if (!handoffConflicts.has(candidate.handoff.handoff_id)) kept.push(candidate);
      if (kept.length >= MAX_GOAL_HANDOFFS) break;
    }
    return kept;
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
    const handoffs = [];
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
        const conversation = fiber ? conversationEvidenceDetailsOf(fiber) : null;
        const conversationId = conversation && !conversation.conflict && !conversation.unreadable
          ? conversation.conversationId : null;
        const messages = fiber ? turnMessagesOf(fiber) : null;
        if (!conversationId || !messages) continue;
        for (const requestId of requestIdsOf(messages)) {
          const previous = byRequest.get(requestId);
          if (previous !== undefined && previous !== conversationId) conflicts.add(requestId);
          else if (previous === undefined) byRequest.set(requestId, conversationId);
        }
        if (turnIndex === turns.length - 1) {
          handoffs.push(...goalHandoffCandidatesOf(messages, conversationId, turnIndex));
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
    post({ source: REPLY, nonce, version: VERSION, evidence, handoffs }, location.origin);
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

  function attributeOf(node, name) {
    try {
      const value = node && typeof node.getAttribute === 'function' ? node.getAttribute(name) : null;
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  function queryAll(node, selector) {
    try {
      return Array.from(node?.querySelectorAll?.(selector) || []);
    } catch {
      return [];
    }
  }

  function fiberKeysOf(fiber) {
    const keys = new Set();
    for (let at = fiber, depth = 0; at && depth < MAX_CLIMB; at = at.return, depth += 1) {
      const key = validMessageId(at.key);
      if (key && !/^\d+$/u.test(key)) keys.add(key);
    }
    return [...keys];
  }

  function domAssistantIdentities(sections) {
    const identities = [];
    const seenNodes = new Set();
    for (const section of sections) {
      const nodes = [];
      if (attributeOf(section, 'data-message-author-role') === 'assistant') nodes.push(section);
      nodes.push(...queryAll(section, '[data-message-author-role="assistant"]'));
      for (const node of nodes) {
        if (!node || seenNodes.has(node)) continue;
        seenNodes.add(node);
        const id = validMessageId(attributeOf(node, 'data-message-id'))
          || validMessageId(attributeOf(queryAll(node, '[data-message-id]')[0], 'data-message-id'));
        const fiber = fiberOf(node);
        const fiberMessageId = fiber ? messageOf(fiber) : null;
        const fiberKeys = fiber ? fiberKeysOf(fiber) : [];
        const conversation = fiber ? conversationEvidenceDetailsOf(fiber) : null;
        if (!id && fiberKeys.length === 0) continue;
        identities.push({ id, fiberMessageId, fiberKeys, conversation });
      }
    }
    return identities;
  }

  function completionTurnOf(turn, diagnostic, expectedUserMessageId) {
    const visited = new Set();
    const candidates = [];
    const domIdentities = domAssistantIdentities(turn.sections);
    const addCandidate = (fiber, messages, sourcePriority, turnId, modelTurnId) => {
      if (!Array.isArray(messages) || messages.length === 0
        || candidates.length >= MAX_COMPLETION_MESSAGE_CANDIDATES) return;
      diagnostic.candidate_count += 1;
      candidates.push({ fiber, messages: messages.map((entry) => {
        const message = entry?.message ?? entry;
        return message && typeof message === 'object'
          ? { ...message, id: message.id ?? message.message_id ?? message.messageId } : message;
      }), turnId, modelTurnId, domIdentities, sourcePriority });
    };
    for (const section of turn.sections) {
      if (candidates.length >= MAX_COMPLETION_MESSAGE_CANDIDATES) break;
      const anchors = [section, ...queryAll(section, '[data-message-id]').slice(0, 100)];
      for (const anchor of anchors) {
        if (candidates.length >= MAX_COMPLETION_MESSAGE_CANDIDATES) break;
        const root = fiberOf(anchor);
        const queue = [];
        for (let at = root, depth = 0; at && depth < MAX_CLIMB; at = at.return, depth += 1) queue.push([at, false]);
        // Search only this DOM branch's descendants, never ancestor siblings or alternate trees.
        if (root?.child) queue.push([root.child, true]);
        for (let index = 0; index < queue.length && visited.size < 1000
          && candidates.length < MAX_COMPLETION_MESSAGE_CANDIDATES; index += 1) {
          const [at, descend] = queue[index];
          if (!at || visited.has(at)) continue;
          visited.add(at);
          diagnostic.fiber_scan_count += 1;
          const props = at.memoizedProps;
          const model = props?.turn;
          const fiber = descend ? at : root;
          const turnId = str(model?.id) || turn.turnId;
          const modelTurnId = str(model?.id);
          addCandidate(fiber, model?.messages, 0, turnId, modelTurnId);
          addCandidate(fiber, props?.allMessages, 1, turnId, modelTurnId);
          addCandidate(fiber, props?.messages, 2, turnId, modelTurnId);
          // Only descend below the anchor, not into unrelated conversation branches.
          if (descend) {
            if (at.child) queue.push([at.child, true]);
            if (at.sibling) queue.push([at.sibling, true]);
          }
        }
      }
    }
    let selected = null;
    let selectedRank = Infinity;
    for (const candidate of candidates) {
      const rank = candidate.messages.some((message) => message?.author?.role === 'user'
        && message.id === expectedUserMessageId) ? 0
        : candidate.turnId === expectedUserMessageId ? 1 : 2;
      if (selected === null || rank < selectedRank
        || (rank === selectedRank && candidate.sourcePriority < selected.sourcePriority)) {
        selected = candidate;
        selectedRank = rank;
      }
    }
    return selected;
  }

  function completionAssistantIdentity(
    terminal,
    match,
    assistantCandidateCount,
    expectedUserMessageId,
    conversationId,
  ) {
    if (terminal.identityType === 'message_id' && terminal.stable
      && validMessageId(terminal.messageId)) {
      return { id: terminal.messageId, source: terminal.identitySource || 'model_message_id', type: 'message_id' };
    }

    const domIdentities = Array.isArray(match.domIdentities) ? match.domIdentities : [];
    const currentConversation = (entry) => {
      const identity = entry?.conversation;
      return !identity || (!identity.conflict && !identity.unreadable
        && (!identity.conversationId || identity.conversationId === conversationId));
    };
    const currentDomIdentities = domIdentities.filter(currentConversation);
    const rawId = validMessageId(terminal.id);
    const exactDom = currentDomIdentities.filter((entry) => entry && entry.id
      && ((rawId && entry.id === rawId)
        || (rawId && entry.fiberMessageId === rawId)
        || (terminal.messageId && entry.fiberMessageId === terminal.messageId)));
    if (exactDom.length === 1) {
      return { id: exactDom[0].id, source: 'dom_message_id', type: 'message_id' };
    }
    if (assistantCandidateCount === 1 && currentDomIdentities.length === 1 && currentDomIdentities[0].id) {
      return { id: currentDomIdentities[0].id, source: 'dom_message_id', type: 'message_id' };
    }

    const exactFiberKeys = [];
    for (const entry of currentDomIdentities) {
      if (!entry || !Array.isArray(entry.fiberKeys)) continue;
      if (rawId && entry.fiberMessageId === rawId) exactFiberKeys.push(...entry.fiberKeys);
    }
    if (exactFiberKeys.length === 1) {
      return { id: exactFiberKeys[0], source: 'fiber_key', type: 'fallback' };
    }
    if (assistantCandidateCount === 1 && currentDomIdentities.length === 1
      && currentDomIdentities[0].fiberKeys?.length === 1) {
      return { id: currentDomIdentities[0].fiberKeys[0], source: 'fiber_key', type: 'fallback' };
    }

    if (terminal.stable && validMessageId(terminal.messageId)) {
      return { id: terminal.messageId, source: terminal.identitySource || 'turn_identity',
        type: terminal.identityType || 'turn_identity' };
    }
    const modelTurnId = validMessageId(match.modelTurnId);
    if (assistantCandidateCount === 1 && modelTurnId && modelTurnId !== expectedUserMessageId) {
      return { id: `assistant:turn:${modelTurnId}`, source: 'model_turn_id', type: 'turn_identity' };
    }
    return null;
  }

  function scanCompletion(nonce, completionId, conversationId, expectedUserMessageId) {
    const diagnostic = { fiber_scan_count: 0, candidate_count: 0, matched_user_turn_count: 0,
      assistant_candidate_count: 0, identity_source: 'none', selected_identity_type: 'none',
      rejection_reason: 'none', completion_state_reason: 'user_turn_not_found' };
    const reply = (status, details = {}) => completionReply(nonce, completionId, conversationId,
      expectedUserMessageId, status, { ...details, diagnostic: {
        ...diagnostic, completion_state_reason: details.error || diagnostic.completion_state_reason,
      } });
    const routeConversationId = conversationIdFromLocation();
    if (routeConversationId !== conversationId) {
      diagnostic.rejection_reason = 'conversation_conflict';
      reply('ambiguous', {
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
    const candidates = [];
    const observed = new Map();
    for (let turnIndex = first; turnIndex < turns.length; turnIndex += 1) {
      const turn = turns[turnIndex];
      try {
        const observation = completionTurnOf(turn, diagnostic, expectedUserMessageId);
        const fiber = observation?.fiber;
        const messages = observation?.messages;
        if (!fiber || !messages) continue;
        observed.set(turnIndex, observation);
        const userIndexes = [];
        let matchPriority = 0;
        for (let index = 0; index < messages.length; index += 1) {
          const message = messages[index];
          if (message && typeof message === 'object' && message.author?.role === 'user'
            && message.id === expectedUserMessageId) userIndexes.push(index);
        }
        if (userIndexes.length === 0 && (observation.turnId === expectedUserMessageId
          || turn.turnId === expectedUserMessageId)) {
          const users = messages.flatMap((message, index) => message?.author?.role === 'user' ? [index] : []);
          if (users.length === 1) {
            userIndexes.push(users[0]);
            matchPriority = 1;
          }
        }
        if (userIndexes.length === 0) {
          const domUsers = turn.sections.flatMap((section) =>
            Array.from(section.querySelectorAll?.('[data-message-author-role="user"][data-message-id]') || []));
          const users = messages.flatMap((message, index) => message?.author?.role === 'user' ? [index] : []);
          if (users.length === 1 && domUsers.length === 1
            && domUsers[0].getAttribute('data-message-id') === expectedUserMessageId) {
            userIndexes.push(users[0]);
            matchPriority = 2;
          }
        }
        if (userIndexes.length === 0) continue;
        diagnostic.matched_user_turn_count += userIndexes.length;
        const conversation = conversationEvidenceDetailsOf(fiber);
        for (const userIndex of userIndexes) {
          candidates.push({ turnId: turn.turnId, modelTurnId: observation.modelTurnId,
            domIdentities: observation.domIdentities, messages, userIndex, turnIndex,
            matchPriority, conversation });
        }
      } catch {
        // Hydration is transient; the next observer or fallback poll retries it.
      }
    }

    const priority = candidates.length > 0
      ? Math.min(...candidates.map((candidate) => candidate.matchPriority)) : null;
    const matches = priority === null ? [] : candidates.filter((candidate) => candidate.matchPriority === priority);
    const conversationConflict = matches.some((match) => match.conversation.conflict);
    const conversationUnreadable = matches.some((match) => match.conversation.unreadable);
    const conversationUnavailable = matches.some((match) => !match.conversation.conflict
      && !match.conversation.unreadable && !match.conversation.conversationId);
    const wrongConversation = matches.some((match) => !match.conversation.conflict
      && !match.conversation.unreadable && Boolean(match.conversation.conversationId)
      && match.conversation.conversationId !== conversationId);
    if (conversationConflict || wrongConversation) {
      diagnostic.rejection_reason = 'conversation_conflict';
      reply('ambiguous', {
        error: 'completion_identity_ambiguous',
      });
      return;
    }
    if (conversationUnreadable || conversationUnavailable) {
      diagnostic.completion_state_reason = 'conversation_unreadable';
      diagnostic.rejection_reason = 'conversation_unreadable';
      reply('pending');
      return;
    }
    const validMatches = matches.filter((match) => match.conversation.conversationId === conversationId);
    if (validMatches.length > 1) {
      diagnostic.rejection_reason = 'multiple_target_turns';
      reply('ambiguous', {
        error: 'completion_identity_ambiguous',
      });
      return;
    }
    if (validMatches.length === 0) {
      diagnostic.rejection_reason = 'user_turn_not_found';
      reply('pending');
      return;
    }

    const match = validMatches[0];
    // Current ChatGPT renders user and assistant as separate consecutive turn models.
    // A missing model or identity is a boundary, never permission to skip to a later answer.
    if (!match.messages.slice(match.userIndex + 1).some((message) => message?.author?.role === 'user')) {
      for (let index = match.turnIndex + 1; index < turns.length; index += 1) {
        const next = observed.get(index);
        if (!next) {
          diagnostic.completion_state_reason = 'following_turn_unreadable';
          diagnostic.rejection_reason = 'following_turn_unreadable';
          reply('pending');
          return;
        }
        const identity = conversationEvidenceDetailsOf(next.fiber);
        if (identity.conflict || identity.unreadable || identity.conversationId !== conversationId) {
          diagnostic.completion_state_reason = 'following_turn_identity_unavailable';
          diagnostic.rejection_reason = 'following_turn_identity_unavailable';
          reply('pending');
          return;
        }
        if (next.messages.some((message) => message?.author?.role === 'user')) break;
        match.messages.push(...next.messages);
        match.domIdentities.push(...next.domIdentities);
      }
    }
    let end = match.messages.length;
    for (let index = match.userIndex + 1; index < match.messages.length; index += 1) {
      if (match.messages[index]?.author?.role === 'user') {
        end = index;
        break;
      }
    }
    const terminalIndex = turnEndMessageIndex(match.messages, match.userIndex + 1, end);
    diagnostic.assistant_candidate_count = match.messages.slice(match.userIndex + 1, end)
      .filter(publicAssistantMessage).length;
    if (terminalIndex === null) {
      const reason = diagnostic.assistant_candidate_count ? 'assistant_not_terminal' : 'assistant_not_found';
      diagnostic.completion_state_reason = reason;
      diagnostic.rejection_reason = reason;
      reply('pending');
      return;
    }

    const assistants = authoredAssistantMessages(match.messages, undefined, match.userIndex + 1, end,
      expectedUserMessageId);
    const terminal = assistants.find((message) => message.order === terminalIndex);
    if (!terminal || terminal.identityConflict) {
      diagnostic.rejection_reason = terminal?.identityConflict ? 'identity_conflict' : 'terminal_unreadable';
      reply('ambiguous', {
        error: 'completion_assistant_identity_ambiguous',
      });
      return;
    }
    if (terminal.textStatus === 'too_large') {
      diagnostic.rejection_reason = 'content_too_large';
      reply('failed', {
        error: 'completion_content_too_large',
      });
      return;
    }

    const identity = completionAssistantIdentity(terminal, match, diagnostic.assistant_candidate_count,
      expectedUserMessageId, conversationId);
    if (!identity) {
      diagnostic.identity_source = terminal.identitySource || 'unavailable';
      diagnostic.selected_identity_type = terminal.identityType || 'none';
      diagnostic.rejection_reason = 'no_stable_identity';
      reply('failed', {
        error: 'completion_assistant_message_id_unavailable',
      });
      return;
    }
    if (terminal.textStatus !== 'text' || !terminal.rawText) {
      diagnostic.identity_source = identity.source;
      diagnostic.selected_identity_type = identity.type;
      diagnostic.rejection_reason = 'public_text_unavailable';
      reply('failed', {
        error: 'completion_public_text_unavailable',
      });
      return;
    }
    diagnostic.identity_source = identity.source;
    diagnostic.selected_identity_type = identity.type;
    diagnostic.completion_state_reason = 'completed';
    reply('completed', {
      assistant_message_id: identity.id,
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
        post({ source: REPLY, nonce, version: VERSION, evidence: [], handoffs: [] }, location.origin);
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
