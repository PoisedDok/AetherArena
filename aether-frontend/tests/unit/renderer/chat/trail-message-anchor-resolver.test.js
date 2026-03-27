'use strict';

// ---------------------------------------------------------------------------
// TrailMessageAnchorResolver — pure functions, DOM-based anchor resolution
// No external dependencies. Uses jsdom for DOM element creation.
// ---------------------------------------------------------------------------

const {
  findUserEntryForGroup,
  findNextAssistantEntry,
  _normalizeText,
  _getEntryText,
} = require('../../../../src/renderer/chat/modules/trail/TrailMessageAnchorResolver');

// ---------------------------------------------------------------------------
// Helpers — DOM element factories
// ---------------------------------------------------------------------------

/**
 * Create a mock chat-entry element with role, text content, and optional dataset.
 * Uses real DOM elements in jsdom for accurate querySelector/classList behavior.
 */
function makeChatEntry({ role = 'user', text = '', dataset = {} } = {}) {
  const entry = document.createElement('div');
  entry.classList.add('chat-entry');
  entry.dataset.role = role;

  // Add role-specific text element matching the source's querySelector pattern
  const textEl = document.createElement('span');
  if (role === 'user') {
    textEl.className = 'chat-text user';
  } else if (role === 'assistant') {
    textEl.className = 'chat-text assistant';
  } else {
    textEl.className = 'chat-text';
  }
  textEl.textContent = text;
  entry.appendChild(textEl);

  // Apply extra dataset attributes
  for (const [key, value] of Object.entries(dataset)) {
    entry.dataset[key] = value;
  }
  return entry;
}

/**
 * Create a plain entry with textContent but no .chat-text child (tests fallback path).
 */
function makePlainEntry({ text = '', role = '' } = {}) {
  const entry = document.createElement('div');
  entry.classList.add('chat-entry');
  if (role) entry.dataset.role = role;
  entry.textContent = text;
  return entry;
}

/**
 * Build a linked sibling chain from an array of elements.
 * jsdom sets nextElementSibling automatically when appended to a parent.
 */
function buildSiblingChain(elements) {
  const container = document.createElement('div');
  for (const el of elements) {
    container.appendChild(el);
  }
  return container;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrailMessageAnchorResolver', () => {

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // =========================================================================
  // _normalizeText
  // =========================================================================

  describe('_normalizeText', () => {
    it('returns empty string for undefined', () => {
      expect(_normalizeText(undefined)).toBe('');
    });

    it('returns empty string for null', () => {
      expect(_normalizeText(null)).toBe('');
    });

    it('returns empty string for number input', () => {
      expect(_normalizeText(42)).toBe('');
    });

    it('returns empty string for boolean input', () => {
      expect(_normalizeText(true)).toBe('');
    });

    it('returns empty string for object input', () => {
      expect(_normalizeText({})).toBe('');
    });

    it('returns empty string for array input', () => {
      expect(_normalizeText([])).toBe('');
    });

    it('trims leading and trailing whitespace', () => {
      expect(_normalizeText('  hello  ')).toBe('hello');
    });

    it('collapses multiple spaces to single space', () => {
      expect(_normalizeText('hello   world')).toBe('hello world');
    });

    it('collapses tabs and newlines to single space', () => {
      expect(_normalizeText('hello\t\n\r  world')).toBe('hello world');
    });

    it('handles string with only whitespace', () => {
      expect(_normalizeText('   \t\n   ')).toBe('');
    });

    it('passes through clean string unchanged', () => {
      expect(_normalizeText('hello world')).toBe('hello world');
    });

    it('handles empty string', () => {
      expect(_normalizeText('')).toBe('');
    });

    it('handles single character', () => {
      expect(_normalizeText('a')).toBe('a');
    });

    it('normalizes complex multi-whitespace string', () => {
      expect(_normalizeText('  the   quick  \n brown   fox  ')).toBe('the quick brown fox');
    });
  });

  // =========================================================================
  // _getEntryText (exercises _getRoleTextElement internally)
  // =========================================================================

  describe('_getEntryText', () => {
    it('returns empty string for null entry', () => {
      expect(_getEntryText(null)).toBe('');
    });

    it('returns empty string for undefined entry', () => {
      expect(_getEntryText(undefined)).toBe('');
    });

    it('extracts text from user role entry via .chat-text.user', () => {
      const entry = makeChatEntry({ role: 'user', text: 'Hello world' });
      expect(_getEntryText(entry)).toBe('Hello world');
    });

    it('extracts text from assistant role entry via .chat-text.assistant', () => {
      const entry = makeChatEntry({ role: 'assistant', text: 'I can help' });
      expect(_getEntryText(entry)).toBe('I can help');
    });

    it('extracts text from unknown role entry via .chat-text', () => {
      const entry = makeChatEntry({ role: 'system', text: 'System message' });
      expect(_getEntryText(entry)).toBe('System message');
    });

    it('normalizes whitespace in extracted text', () => {
      const entry = makeChatEntry({ role: 'user', text: '  hello   world  ' });
      expect(_getEntryText(entry)).toBe('hello world');
    });

    it('falls back to entry.textContent when no .chat-text child for role', () => {
      // Create entry with role=user but no .chat-text.user element
      const entry = document.createElement('div');
      entry.classList.add('chat-entry');
      entry.dataset.role = 'user';
      // No child matching .chat-text.user, so _getRoleTextElement returns null
      // Falls back to entry.textContent
      entry.textContent = 'Fallback text';
      expect(_getEntryText(entry)).toBe('Fallback text');
    });

    it('falls back to entry.textContent when entry has no dataset.role', () => {
      const entry = makePlainEntry({ text: 'No role text' });
      // dataset.role is '' → falls to default querySelector('.chat-text')
      // No .chat-text child → _getRoleTextElement returns null
      // Falls back to entry.textContent
      expect(_getEntryText(entry)).toBe('No role text');
    });

    it('returns empty string for entry with empty textContent and no .chat-text', () => {
      const entry = document.createElement('div');
      entry.classList.add('chat-entry');
      entry.textContent = '';
      expect(_getEntryText(entry)).toBe('');
    });

    it('handles entry without querySelector function', () => {
      // Object that looks entry-like but has no querySelector
      const fakeEntry = { textContent: 'plain text', dataset: { role: 'user' } };
      expect(_getEntryText(fakeEntry)).toBe('plain text');
    });

    it('returns empty string for entry without querySelector and no textContent', () => {
      const fakeEntry = {};
      expect(_getEntryText(fakeEntry)).toBe('');
    });
  });

  // =========================================================================
  // findUserEntryForGroup
  // =========================================================================

  describe('findUserEntryForGroup', () => {

    // ---- Edge cases: no match possible ----

    it('returns null result when groupUserMessage is empty string', () => {
      const entries = [makeChatEntry({ text: 'Hello' })];
      const result = findUserEntryForGroup({ userEntries: entries, groupUserMessage: '' });
      expect(result).toEqual({ entry: null, index: -1, match: null });
    });

    it('returns null result when groupUserMessage is null', () => {
      const entries = [makeChatEntry({ text: 'Hello' })];
      const result = findUserEntryForGroup({ userEntries: entries, groupUserMessage: null });
      expect(result).toEqual({ entry: null, index: -1, match: null });
    });

    it('returns null result when groupUserMessage is undefined', () => {
      const entries = [makeChatEntry({ text: 'Hello' })];
      const result = findUserEntryForGroup({ userEntries: entries, groupUserMessage: undefined });
      expect(result).toEqual({ entry: null, index: -1, match: null });
    });

    it('returns null result when groupUserMessage is whitespace only', () => {
      const entries = [makeChatEntry({ text: 'Hello' })];
      const result = findUserEntryForGroup({ userEntries: entries, groupUserMessage: '   ' });
      expect(result).toEqual({ entry: null, index: -1, match: null });
    });

    it('returns null result when userEntries is null', () => {
      const result = findUserEntryForGroup({ userEntries: null, groupUserMessage: 'Hello' });
      expect(result).toEqual({ entry: null, index: -1, match: null });
    });

    it('returns null result when userEntries is undefined', () => {
      const result = findUserEntryForGroup({ userEntries: undefined, groupUserMessage: 'Hello' });
      expect(result).toEqual({ entry: null, index: -1, match: null });
    });

    it('returns null result when userEntries is not an array', () => {
      const result = findUserEntryForGroup({ userEntries: 'bad', groupUserMessage: 'Hello' });
      expect(result).toEqual({ entry: null, index: -1, match: null });
    });

    it('returns null result when userEntries is empty array', () => {
      const result = findUserEntryForGroup({ userEntries: [], groupUserMessage: 'Hello' });
      expect(result).toEqual({ entry: null, index: -1, match: null });
    });

    it('returns null result when no entries match', () => {
      const entries = [
        makeChatEntry({ text: 'Completely different message' }),
        makeChatEntry({ text: 'Another unrelated text' }),
      ];
      const result = findUserEntryForGroup({ userEntries: entries, groupUserMessage: 'Hello' });
      expect(result).toEqual({ entry: null, index: -1, match: null });
    });

    // ---- Pass 1: Exact matches ----

    it('returns exact match for identical text', () => {
      const entry = makeChatEntry({ text: 'Hello world' });
      const result = findUserEntryForGroup({
        userEntries: [entry],
        groupUserMessage: 'Hello world',
      });
      expect(result).toEqual({ entry, index: 0, match: 'exact' });
    });

    it('returns exact match with whitespace normalization', () => {
      const entry = makeChatEntry({ text: '  Hello   world  ' });
      const result = findUserEntryForGroup({
        userEntries: [entry],
        groupUserMessage: '  Hello   world  ',
      });
      // Both normalize to 'Hello world' → exact match
      expect(result).toEqual({ entry, index: 0, match: 'exact' });
    });

    it('returns first exact match among multiple candidates', () => {
      const entry1 = makeChatEntry({ text: 'Hello world' });
      const entry2 = makeChatEntry({ text: 'Hello world' });
      const result = findUserEntryForGroup({
        userEntries: [entry1, entry2],
        groupUserMessage: 'Hello world',
      });
      expect(result.entry).toBe(entry1);
      expect(result.index).toBe(0);
      expect(result.match).toBe('exact');
    });

    it('returns correct index for match at position > 0', () => {
      const entries = [
        makeChatEntry({ text: 'First message' }),
        makeChatEntry({ text: 'Second message' }),
        makeChatEntry({ text: 'Target message' }),
      ];
      const result = findUserEntryForGroup({
        userEntries: entries,
        groupUserMessage: 'Target message',
      });
      expect(result).toEqual({ entry: entries[2], index: 2, match: 'exact' });
    });

    // ---- Pass 1: Prefix matches ----

    it('returns prefix match when actual starts with expected (expected.length > 3)', () => {
      const entry = makeChatEntry({ text: 'Hello world extended text here' });
      const result = findUserEntryForGroup({
        userEntries: [entry],
        groupUserMessage: 'Hello world',
      });
      // actual.startsWith(expected) → 'Hello world extended text here'.startsWith('Hello world')
      // expected.length = 11 > 3 → prefix match
      expect(result.match).toBe('prefix');
      expect(result.entry).toBe(entry);
      expect(result.index).toBe(0);
    });

    it('returns prefix match when expected starts with actual (actual.length > 3)', () => {
      const entry = makeChatEntry({ text: 'Hello world' });
      const result = findUserEntryForGroup({
        userEntries: [entry],
        groupUserMessage: 'Hello world with more context from backend',
      });
      // expected.startsWith(actual) → 'Hello world with more...'.startsWith('Hello world')
      // actual.length = 11 > 3 → prefix match
      expect(result.match).toBe('prefix');
      expect(result.entry).toBe(entry);
    });

    it('does NOT prefix match when expected.length <= 3 but falls through to includes if actual is long', () => {
      const entry = makeChatEntry({ text: 'Hey there friend' });
      const result = findUserEntryForGroup({
        userEntries: [entry],
        groupUserMessage: 'Hey',
      });
      // actual.startsWith('Hey') is true BUT expected.length = 3, not > 3 → no prefix
      // Pass 2: actual.length(16) > expected.length(3) AND actual.length > 10 AND actual.includes('Hey') → includes
      expect(result.match).toBe('includes');
      expect(result.entry).toBe(entry);
    });

    it('no match at all when both strings are short and no prefix/includes qualifies', () => {
      const entry = makeChatEntry({ text: 'Hey world' });
      const result = findUserEntryForGroup({
        userEntries: [entry],
        groupUserMessage: 'Hola',
      });
      // No exact, no prefix, no includes (strings don't contain each other)
      expect(result).toEqual({ entry: null, index: -1, match: null });
    });

    it('does NOT prefix match when actual.length <= 3 (expected starts with actual)', () => {
      const entry = makeChatEntry({ text: 'Hey' });
      const result = findUserEntryForGroup({
        userEntries: [entry],
        groupUserMessage: 'Hey there friend',
      });
      // expected.startsWith('Hey') is true BUT actual.length = 3, not > 3
      // Falls to pass 2: expected.length=16 > actual.length=3, expected.length > 10
      // expected.includes(actual) → 'Hey there friend'.includes('Hey') = true → includes match
      expect(result.match).toBe('includes');
    });

    it('prefers exact match over prefix match', () => {
      const exactEntry = makeChatEntry({ text: 'Hello' });
      const prefixEntry = makeChatEntry({ text: 'Hello world' });
      const result = findUserEntryForGroup({
        userEntries: [prefixEntry, exactEntry],
        groupUserMessage: 'Hello',
      });
      // prefixEntry: actual='Hello world', expected='Hello' → actual.startsWith(expected) but expected.length=5>3 → prefix
      // BUT wait, 'Hello' length is 5 > 3, so prefix match at index 0
      // Actually exact match requires actual === expected. 'Hello world' !== 'Hello'
      // So prefixEntry matches as prefix at index 0
      expect(result.index).toBe(0);
      expect(result.match).toBe('prefix');
    });

    it('exact match wins over prefix when exact appears first', () => {
      const exactEntry = makeChatEntry({ text: 'Hello' });
      const prefixEntry = makeChatEntry({ text: 'Hello world extended' });
      const result = findUserEntryForGroup({
        userEntries: [exactEntry, prefixEntry],
        groupUserMessage: 'Hello',
      });
      expect(result.entry).toBe(exactEntry);
      expect(result.match).toBe('exact');
    });

    // ---- Pass 2: Includes matches ----

    it('returns includes match when expected contains actual and expected.length > 10', () => {
      const entry = makeChatEntry({ text: 'code review' });
      const result = findUserEntryForGroup({
        userEntries: [entry],
        groupUserMessage: 'Please do a code review of my changes',
      });
      // Pass 1: no exact, no prefix
      // Pass 2: expected.length(37) > actual.length(11), expected.length > 10, expected.includes('code review') → true
      expect(result.match).toBe('includes');
      expect(result.entry).toBe(entry);
    });

    it('returns includes match when actual contains expected and actual.length > 10', () => {
      const entry = makeChatEntry({ text: 'Please do a code review of my changes' });
      const result = findUserEntryForGroup({
        userEntries: [entry],
        groupUserMessage: 'code review',
      });
      // Pass 1: no exact, no prefix
      // Pass 2: actual.length(37) > expected.length(11), actual.length > 10, actual.includes('code review') → true
      expect(result.match).toBe('includes');
      expect(result.entry).toBe(entry);
    });

    it('does NOT return includes match when expected.length <= 10 and actual.length <= 10', () => {
      const entry = makeChatEntry({ text: 'hello' });
      const result = findUserEntryForGroup({
        userEntries: [entry],
        groupUserMessage: 'say hello',
      });
      // expected.length=9, actual.length=5
      // expected > actual and expected.length > 10? No (9 ≤ 10)
      // actual > expected? No (5 < 9)
      expect(result).toEqual({ entry: null, index: -1, match: null });
    });

    it('pass 1 (prefix) takes priority over pass 2 (includes)', () => {
      const prefixEntry = makeChatEntry({ text: 'Hello world extended' });
      const includesEntry = makeChatEntry({ text: 'world' });
      const result = findUserEntryForGroup({
        userEntries: [prefixEntry, includesEntry],
        groupUserMessage: 'Hello world',
      });
      // Pass 1: prefixEntry actual='Hello world extended' starts with 'Hello world', length > 3 → prefix
      expect(result.match).toBe('prefix');
      expect(result.entry).toBe(prefixEntry);
    });

    // ---- startIndex parameter ----

    it('skips entries before startIndex', () => {
      const entries = [
        makeChatEntry({ text: 'Target' }),
        makeChatEntry({ text: 'Target' }),
      ];
      const result = findUserEntryForGroup({
        userEntries: entries,
        groupUserMessage: 'Target',
        startIndex: 1,
      });
      expect(result.entry).toBe(entries[1]);
      expect(result.index).toBe(1);
    });

    it('clamps negative startIndex to 0', () => {
      const entry = makeChatEntry({ text: 'Hello' });
      const result = findUserEntryForGroup({
        userEntries: [entry],
        groupUserMessage: 'Hello',
        startIndex: -5,
      });
      expect(result.entry).toBe(entry);
      expect(result.index).toBe(0);
    });

    it('returns no match when startIndex is beyond array length', () => {
      const entry = makeChatEntry({ text: 'Hello' });
      const result = findUserEntryForGroup({
        userEntries: [entry],
        groupUserMessage: 'Hello',
        startIndex: 10,
      });
      expect(result).toEqual({ entry: null, index: -1, match: null });
    });

    it('defaults startIndex to 0 when not provided', () => {
      const entries = [
        makeChatEntry({ text: 'First' }),
        makeChatEntry({ text: 'Second' }),
      ];
      const result = findUserEntryForGroup({
        userEntries: entries,
        groupUserMessage: 'First',
      });
      expect(result.index).toBe(0);
    });

    it('startIndex applies to both pass 1 and pass 2', () => {
      const entries = [
        makeChatEntry({ text: 'substring' }),
        makeChatEntry({ text: 'different content entirely' }),
      ];
      // Pass 2 includes: expected.includes(actual) where expected is long
      const result = findUserEntryForGroup({
        userEntries: entries,
        groupUserMessage: 'this is a long substring that contains the word',
        startIndex: 1,
      });
      // Entry at index 0 ('substring') would match includes but is skipped by startIndex
      // Entry at index 1 ('different content entirely') does not match
      expect(result).toEqual({ entry: null, index: -1, match: null });
    });

    // ---- Entries with empty text are skipped ----

    it('skips entries that produce empty normalized text', () => {
      const emptyEntry = makeChatEntry({ text: '' });
      const realEntry = makeChatEntry({ text: 'Target message' });
      const result = findUserEntryForGroup({
        userEntries: [emptyEntry, realEntry],
        groupUserMessage: 'Target message',
      });
      expect(result.entry).toBe(realEntry);
      expect(result.index).toBe(1);
    });

    it('skips entries with whitespace-only text', () => {
      const wsEntry = makeChatEntry({ text: '   ' });
      const realEntry = makeChatEntry({ text: 'Hello' });
      const result = findUserEntryForGroup({
        userEntries: [wsEntry, realEntry],
        groupUserMessage: 'Hello',
      });
      expect(result.entry).toBe(realEntry);
      expect(result.index).toBe(1);
    });

    it('skips empty-text entries in pass 2 (includes) as well', () => {
      // Force pass 1 to fail (no exact/prefix), then pass 2 encounters an empty entry before the match
      const emptyEntry = makeChatEntry({ text: '' });
      const matchEntry = makeChatEntry({ text: 'review' });
      const result = findUserEntryForGroup({
        userEntries: [emptyEntry, matchEntry],
        groupUserMessage: 'please perform a code review of the module',
      });
      // Pass 1: no exact or prefix match for either entry
      // Pass 2: emptyEntry → continue (line 70). matchEntry → expected.includes('review') and expected.length > 10
      expect(result.match).toBe('includes');
      expect(result.entry).toBe(matchEntry);
      expect(result.index).toBe(1);
    });

    // ---- Forward cursor correctness (multiple groups) ----

    it('supports forward cursor for sequential group resolution', () => {
      const entries = [
        makeChatEntry({ text: 'First question' }),
        makeChatEntry({ text: 'Second question' }),
        makeChatEntry({ text: 'Third question' }),
      ];

      const r1 = findUserEntryForGroup({
        userEntries: entries,
        groupUserMessage: 'First question',
        startIndex: 0,
      });
      expect(r1.index).toBe(0);
      expect(r1.match).toBe('exact');

      const r2 = findUserEntryForGroup({
        userEntries: entries,
        groupUserMessage: 'Second question',
        startIndex: r1.index + 1,
      });
      expect(r2.index).toBe(1);
      expect(r2.match).toBe('exact');

      const r3 = findUserEntryForGroup({
        userEntries: entries,
        groupUserMessage: 'Third question',
        startIndex: r2.index + 1,
      });
      expect(r3.index).toBe(2);
      expect(r3.match).toBe('exact');
    });

    // ---- Architectural: prevents false positives from substring matches ----

    it('prevents "hey" from matching "say hey in html" via pass 1', () => {
      const entry = makeChatEntry({ text: 'say hey in html' });
      const result = findUserEntryForGroup({
        userEntries: [entry],
        groupUserMessage: 'hey',
      });
      // 'say hey in html' does NOT start with 'hey'
      // 'hey' does NOT start with 'say hey in html'
      // Pass 2: expected.length=3 ≤ 10 → no includes match
      // actual.length=15 > expected.length=3 but actual.length > 10 and actual.includes('hey') → includes
      expect(result.match).toBe('includes');
    });

    it('short expected (length <= 10) does not match long actual via includes when expected is shorter', () => {
      const entry = makeChatEntry({ text: 'This is a very long message about code' });
      const result = findUserEntryForGroup({
        userEntries: [entry],
        groupUserMessage: 'code',
      });
      // expected.length=4, actual.length=38
      // Pass 2 first branch: expected.length > actual.length? No.
      // Pass 2 second branch: actual.length > expected.length? Yes. actual.length > 10? Yes. actual.includes('code')? Yes.
      expect(result.match).toBe('includes');
    });
  });

  // =========================================================================
  // findNextAssistantEntry
  // =========================================================================

  describe('findNextAssistantEntry', () => {
    it('returns null for null input', () => {
      expect(findNextAssistantEntry(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(findNextAssistantEntry(undefined)).toBeNull();
    });

    it('returns null when afterEntry has no nextElementSibling', () => {
      const entry = document.createElement('div');
      // Not appended to anything → nextElementSibling is null
      expect(findNextAssistantEntry(entry)).toBeNull();
    });

    it('finds immediate next assistant chat-entry', () => {
      const userEntry = makeChatEntry({ role: 'user', text: 'Question' });
      const assistantEntry = makeChatEntry({ role: 'assistant', text: 'Answer' });
      buildSiblingChain([userEntry, assistantEntry]);

      const result = findNextAssistantEntry(userEntry);
      expect(result).toBe(assistantEntry);
    });

    it('skips non-chat-entry siblings', () => {
      const userEntry = makeChatEntry({ role: 'user', text: 'Q' });
      const divider = document.createElement('div');
      divider.className = 'divider';
      const assistantEntry = makeChatEntry({ role: 'assistant', text: 'A' });
      buildSiblingChain([userEntry, divider, assistantEntry]);

      const result = findNextAssistantEntry(userEntry);
      expect(result).toBe(assistantEntry);
    });

    it('skips chat-entries with non-assistant roles', () => {
      const userEntry = makeChatEntry({ role: 'user', text: 'Q1' });
      const anotherUser = makeChatEntry({ role: 'user', text: 'Q2' });
      const systemEntry = makeChatEntry({ role: 'system', text: 'S' });
      const assistantEntry = makeChatEntry({ role: 'assistant', text: 'A' });
      buildSiblingChain([userEntry, anotherUser, systemEntry, assistantEntry]);

      const result = findNextAssistantEntry(userEntry);
      expect(result).toBe(assistantEntry);
    });

    it('returns null when only non-assistant siblings exist', () => {
      const userEntry = makeChatEntry({ role: 'user', text: 'Q' });
      const anotherUser = makeChatEntry({ role: 'user', text: 'Q2' });
      buildSiblingChain([userEntry, anotherUser]);

      expect(findNextAssistantEntry(userEntry)).toBeNull();
    });

    it('returns first assistant entry, not subsequent ones', () => {
      const userEntry = makeChatEntry({ role: 'user', text: 'Q' });
      const assistant1 = makeChatEntry({ role: 'assistant', text: 'A1' });
      const assistant2 = makeChatEntry({ role: 'assistant', text: 'A2' });
      buildSiblingChain([userEntry, assistant1, assistant2]);

      expect(findNextAssistantEntry(userEntry)).toBe(assistant1);
    });

    it('handles entry without classList on sibling (no .chat-entry class)', () => {
      const userEntry = makeChatEntry({ role: 'user', text: 'Q' });
      // Create sibling with role=assistant but no chat-entry class
      const noClass = document.createElement('div');
      noClass.dataset.role = 'assistant';
      const realAssistant = makeChatEntry({ role: 'assistant', text: 'A' });
      buildSiblingChain([userEntry, noClass, realAssistant]);

      expect(findNextAssistantEntry(userEntry)).toBe(realAssistant);
    });

    it('handles sibling with chat-entry class but no dataset', () => {
      const userEntry = makeChatEntry({ role: 'user', text: 'Q' });
      const noDataset = document.createElement('div');
      noDataset.classList.add('chat-entry');
      // No dataset.role set → role is undefined
      const assistantEntry = makeChatEntry({ role: 'assistant', text: 'A' });
      buildSiblingChain([userEntry, noDataset, assistantEntry]);

      expect(findNextAssistantEntry(userEntry)).toBe(assistantEntry);
    });

    it('handles afterEntry with object-like structure (no nextElementSibling)', () => {
      // Object that has a falsy nextElementSibling
      const fakeEntry = { nextElementSibling: null };
      expect(findNextAssistantEntry(fakeEntry)).toBeNull();
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================

  describe('module exports', () => {
    it('exports findUserEntryForGroup as a function', () => {
      expect(typeof findUserEntryForGroup).toBe('function');
    });

    it('exports findNextAssistantEntry as a function', () => {
      expect(typeof findNextAssistantEntry).toBe('function');
    });

    it('exports _normalizeText as a function', () => {
      expect(typeof _normalizeText).toBe('function');
    });

    it('exports _getEntryText as a function', () => {
      expect(typeof _getEntryText).toBe('function');
    });
  });
});
