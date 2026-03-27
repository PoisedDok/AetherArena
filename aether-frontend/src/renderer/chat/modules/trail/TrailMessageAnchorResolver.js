'use strict';

/**
 * @.architecture
 *
 * Incoming: renderer/chat/modules/trail/TrailContainerManager.js::_renderHistoricTrails --- {dom_types.chat_content_container, HTMLElement}
 * Processing: Resolve message DOM anchors for a trail group using backend-provided message TEXT (not IDs) --- {3 jobs: JOB_VALIDATE_SCHEMA, JOB_ROUTE_BY_TYPE, JOB_UPDATE_STATE}
 * Outgoing: Anchor DOM elements for deterministic trail insertion (user entry + next assistant entry) --- {dom_types.chat_entry_element, HTMLElement}
 *
 * Notes:
 * - Backend schema stores groups.user_message / groups.agent_message as TEXT (see contracts/README.md for trail invariants).
 * - Chat DOM stores message IDs separately in data-message-id; do NOT treat group.user_message as a message id.
 * - Placement rule: restored trail containers should render ABOVE the assistant response for that turn.
 */

function _normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function _getRoleTextElement(entry) {
  if (!entry || typeof entry.querySelector !== 'function') return null;
  const role = entry.dataset?.role || '';
  if (role === 'user') return entry.querySelector('.chat-text.user');
  if (role === 'assistant') return entry.querySelector('.chat-text.assistant');
  return entry.querySelector('.chat-text');
}

function _getEntryText(entry) {
  const el = _getRoleTextElement(entry);
  const text = el ? el.textContent : entry?.textContent;
  return _normalizeText(text || '');
}

/**
 * Find the user chat-entry DOM element that best matches the group.user_message text.
 * Uses a forward-only cursor to avoid matching the same user entry multiple times.
 */
function findUserEntryForGroup({ userEntries, groupUserMessage, startIndex = 0 }) {
  const expected = _normalizeText(groupUserMessage || '');
  if (!expected || !Array.isArray(userEntries)) {
    return { entry: null, index: -1, match: null };
  }
  
  // ARCHITECTURAL FIX: Two-pass matching to prevent false positives from substring matches
  // Pass 1: Exact and prefix matches only (strict)
  for (let i = Math.max(0, startIndex); i < userEntries.length; i += 1) {
    const entry = userEntries[i];
    const actual = _getEntryText(entry);
    if (!actual) continue;
    
    // Exact match - highest confidence
    if (actual === expected) {
      return { entry, index: i, match: 'exact' };
    }
    // Prefix match - handles backend truncation (but both directions must be substantial)
    if (actual.startsWith(expected) && expected.length > 3) {
      return { entry, index: i, match: 'prefix' };
    }
    if (expected.startsWith(actual) && actual.length > 3) {
      return { entry, index: i, match: 'prefix' };
    }
  }
  
  // Pass 2: Fuzzy includes match ONLY if pass 1 failed (degraded confidence)
  // CRITICAL: Only match if expected is LONGER than actual (prevents "hey" matching "say hey in html")
  for (let i = Math.max(0, startIndex); i < userEntries.length; i += 1) {
    const entry = userEntries[i];
    const actual = _getEntryText(entry);
    if (!actual) continue;
    
    // Only allow includes if the longer string contains the shorter, and longer is substantially longer
    if (expected.length > actual.length && expected.length > 10 && expected.includes(actual)) {
      return { entry, index: i, match: 'includes' };
    }
    if (actual.length > expected.length && actual.length > 10 && actual.includes(expected)) {
      return { entry, index: i, match: 'includes' };
    }
  }
  
  return { entry: null, index: -1, match: null };
}

/**
 * Find the next assistant message entry after a given entry.
 * This is used as the insertion anchor so trails land above the assistant response.
 */
function findNextAssistantEntry(afterEntry) {
  let cursor = afterEntry?.nextElementSibling || null;
  while (cursor) {
    if (cursor.classList?.contains('chat-entry') && cursor.dataset?.role === 'assistant') {
      return cursor;
    }
    cursor = cursor.nextElementSibling;
  }
  return null;
}

module.exports = {
  findUserEntryForGroup,
  findNextAssistantEntry,
  _normalizeText,
  _getEntryText
};
