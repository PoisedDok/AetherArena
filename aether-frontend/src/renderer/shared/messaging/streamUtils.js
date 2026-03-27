/**
 * @.architecture
 *
 * Incoming: StreamHandler.processChunk(), stream payloads --- {stream_chunk, string}
 * Processing: Deduplicate assistant chunks, parse <thinking>/<think> segments, track state --- {3 jobs: JOB_ACCUMULATE_TEXT, JOB_DEDUPLICATE_CHUNK, JOB_PARSE_THINK_TAGS}
 * Outgoing: Parsed chunk data ({visible, thinking, isInThinkingTag, state}) --- {Dict, json}
 */

'use strict';

function shouldProcessChunk({ content = '', lastContent = '', lastTimestamp = 0, now = Date.now(), windowMs = 50 }) {
  if (!content) {
    return {
      process: false,
      lastContent,
      lastTimestamp,
    };
  }

  const timeDiff = now - lastTimestamp;

  if (timeDiff < windowMs && lastContent === content) {
    return {
      process: false,
      lastContent,
      lastTimestamp,
    };
  }

  return {
    process: true,
    lastContent: content,
    lastTimestamp: now,
  };
}

function parseStreamChunk({ chunk = '', state = null } = {}) {
  // Streaming-safe thinking tag parser.
  // - Supports both <thinking>...</thinking> and <think>...</think>
  // - Supports nesting (depth counter)
  // - Supports tags split across chunks (carry buffer)
  // - Caller is expected to pass back `result.state` on the next call
  const result = {
    visible: '',
    thinking: '',
    isInThinkingTag: false,
    state: null,
  };

  const nextState = {
    depth: 0,
    carry: '',
    ...(state && typeof state === 'object' ? state : {}),
  };
  nextState.depth = typeof nextState.depth === 'number' ? nextState.depth : 0;
  nextState.carry = typeof nextState.carry === 'string' ? nextState.carry : '';

  if (!chunk) {
    result.isInThinkingTag = nextState.depth > 0;
    result.state = nextState;
    return result;
  }

  const OPEN_TAGS = ['<thinking>', '<think>'];
  const CLOSE_TAGS = ['</thinking>', '</think>'];
  const ALL_TAGS = OPEN_TAGS.concat(CLOSE_TAGS);

  const isPrefixOfAnyTag = (tail) => {
    if (!tail || tail[0] !== '<') return false;
    for (const tag of ALL_TAGS) {
      if (tag.startsWith(tail)) return true;
    }
    return false;
  };

  const input = (nextState.carry || '') + chunk;
  nextState.carry = '';

  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    if (ch !== '<') {
      if (nextState.depth > 0) result.thinking += ch;
      else result.visible += ch;
      i += 1;
      continue;
    }

    // Fast path: full tag match
    let matched = null;
    for (const tag of ALL_TAGS) {
      if (input.startsWith(tag, i)) {
        matched = tag;
        break;
      }
    }

    if (matched) {
      if (OPEN_TAGS.includes(matched)) nextState.depth += 1;
      else nextState.depth = Math.max(0, nextState.depth - 1);
      i += matched.length;
      continue;
    }

    // Partial tag at end-of-chunk (carry it forward)
    const tail = input.substring(i);
    if (isPrefixOfAnyTag(tail)) {
      nextState.carry = tail;
      break;
    }

    // Not a tag: treat as literal '<'
    if (nextState.depth > 0) result.thinking += '<';
    else result.visible += '<';
    i += 1;
  }

  result.isInThinkingTag = nextState.depth > 0;
  result.state = nextState;
  return result;
}

module.exports = {
  shouldProcessChunk,
  parseStreamChunk,
};
