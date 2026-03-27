'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: () => {},
  trace: () => {},
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const STTInputManager = require(
  '../../../../src/renderer/chat/controllers/modules/STTInputManager'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createInputElement(initialValue = '') {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = initialValue;
  return input;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('STTInputManager', () => {
  let manager;
  let inputEl;

  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    inputEl = createInputElement();
    manager = new STTInputManager({ inputElement: inputEl });
  });

  afterEach(() => {
    manager.dispose();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores inputElement reference', () => {
      expect(manager.inputElement).toBe(inputEl);
    });

    it('defaults inputElement to null when not provided', () => {
      const m = new STTInputManager({});
      expect(m.inputElement).toBeNull();
      m.dispose();
    });

    it('defaults inputElement to null with no options', () => {
      const m = new STTInputManager();
      expect(m.inputElement).toBeNull();
      m.dispose();
    });
  });

  // =========================================================================
  // setInputElement
  // =========================================================================

  describe('setInputElement', () => {
    it('sets inputElement reference', () => {
      const newInput = createInputElement();
      manager.setInputElement(newInput);
      expect(manager.inputElement).toBe(newInput);
    });

    it('throws when element is null', () => {
      expect(() => manager.setInputElement(null)).toThrow(
        '[STTInputManager] Input element is REQUIRED'
      );
    });

    it('throws when element is undefined', () => {
      expect(() => manager.setInputElement(undefined)).toThrow(
        '[STTInputManager] Input element is REQUIRED'
      );
    });

    it('replaces existing inputElement', () => {
      const newInput = createInputElement();
      manager.setInputElement(newInput);
      expect(manager.inputElement).toBe(newInput);
      expect(manager.inputElement).not.toBe(inputEl);
    });
  });

  // =========================================================================
  // handleStream — final transcripts
  // =========================================================================

  describe('handleStream — final transcripts', () => {
    it('sets input value to text when input is empty', () => {
      manager.handleStream({ text: 'Hello world', isFinal: true });
      expect(inputEl.value).toBe('Hello world');
    });

    it('appends text to existing value with space separator', () => {
      inputEl.value = 'Existing text';
      manager.handleStream({ text: 'more words', isFinal: true });
      expect(inputEl.value).toBe('Existing text more words');
    });

    it('trims existing text before appending', () => {
      inputEl.value = '  Existing text  ';
      manager.handleStream({ text: 'more', isFinal: true });
      expect(inputEl.value).toBe('Existing text more');
    });

    it('removes data-stt-base attribute after final transcript', () => {
      inputEl.setAttribute('data-stt-base', 'old base');
      manager.handleStream({ text: 'final', isFinal: true });
      expect(inputEl.hasAttribute('data-stt-base')).toBe(false);
    });

    it('dispatches input event after final transcript', () => {
      const listener = jest.fn();
      inputEl.addEventListener('input', listener);
      manager.handleStream({ text: 'test', isFinal: true });
      expect(listener).toHaveBeenCalledTimes(1);
      inputEl.removeEventListener('input', listener);
    });

    it('handles empty existing value (no leading space)', () => {
      inputEl.value = '';
      manager.handleStream({ text: 'New utterance', isFinal: true });
      expect(inputEl.value).toBe('New utterance');
    });

    it('handles whitespace-only existing value', () => {
      inputEl.value = '   ';
      manager.handleStream({ text: 'Hello', isFinal: true });
      // trim('   ') = '' → currentText is falsy → just text
      expect(inputEl.value).toBe('Hello');
    });
  });

  // =========================================================================
  // handleStream — partial transcripts
  // =========================================================================

  describe('handleStream — partial transcripts', () => {
    it('appends partial text to current value', () => {
      inputEl.value = 'Base text ';
      manager.handleStream({ text: 'partial', isFinal: false });
      expect(inputEl.value).toBe('Base text partial');
    });

    it('stores base text in data-stt-base on first partial', () => {
      inputEl.value = 'Initial';
      manager.handleStream({ text: ' more', isFinal: false });
      expect(inputEl.getAttribute('data-stt-base')).toBe('Initial');
    });

    it('uses data-stt-base for subsequent partials', () => {
      inputEl.value = 'Base';
      inputEl.setAttribute('data-stt-base', 'Base');
      manager.handleStream({ text: ' updated', isFinal: false });
      expect(inputEl.value).toBe('Base updated');
      // data-stt-base remains 'Base'
      expect(inputEl.getAttribute('data-stt-base')).toBe('Base');
    });

    it('dispatches input event after partial transcript', () => {
      const listener = jest.fn();
      inputEl.addEventListener('input', listener);
      manager.handleStream({ text: 'partial', isFinal: false });
      expect(listener).toHaveBeenCalledTimes(1);
      inputEl.removeEventListener('input', listener);
    });

    it('handles empty base text', () => {
      inputEl.value = '';
      manager.handleStream({ text: 'first word', isFinal: false });
      expect(inputEl.value).toBe('first word');
      expect(inputEl.getAttribute('data-stt-base')).toBe('');
    });
  });

  // =========================================================================
  // handleStream — edge cases
  // =========================================================================

  describe('handleStream — edge cases', () => {
    it('returns early when text is empty', () => {
      const listener = jest.fn();
      inputEl.addEventListener('input', listener);
      manager.handleStream({ text: '', isFinal: true });
      expect(listener).not.toHaveBeenCalled();
      inputEl.removeEventListener('input', listener);
    });

    it('returns early when text is null', () => {
      manager.handleStream({ text: null, isFinal: true });
      expect(inputEl.value).toBe('');
    });

    it('returns early when text is undefined', () => {
      manager.handleStream({ text: undefined, isFinal: true });
      expect(inputEl.value).toBe('');
    });

    it('warns when input element is not set', () => {
      manager.inputElement = null;
      manager.handleStream({ text: 'hello', isFinal: true });
      expect(mockLog.warn).toHaveBeenCalledWith('STT stream received but input element not set');
    });

    it('catches and logs errors from handleStream', () => {
      // data is not destructurable → throws
      manager.handleStream(null);
      expect(mockLog.error).toHaveBeenCalledWith(
        'STT stream handling error',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    it('handles source field in data (no special processing)', () => {
      manager.handleStream({ text: 'test', isFinal: true, source: 'microphone' });
      expect(inputEl.value).toBe('test');
    });
  });

  // =========================================================================
  // clear
  // =========================================================================

  describe('clear', () => {
    it('removes data-stt-base attribute', () => {
      inputEl.setAttribute('data-stt-base', 'stored');
      manager.clear();
      expect(inputEl.hasAttribute('data-stt-base')).toBe(false);
    });

    it('does nothing when inputElement is null', () => {
      manager.inputElement = null;
      expect(() => manager.clear()).not.toThrow();
    });

    it('does nothing when data-stt-base is not present', () => {
      expect(() => manager.clear()).not.toThrow();
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('nulls inputElement', () => {
      manager.dispose();
      expect(manager.inputElement).toBeNull();
    });

    it('clears stt state before nulling', () => {
      inputEl.setAttribute('data-stt-base', 'value');
      manager.dispose();
      expect(inputEl.hasAttribute('data-stt-base')).toBe(false);
    });

    it('can be called multiple times', () => {
      manager.dispose();
      expect(() => manager.dispose()).not.toThrow();
    });
  });

  // =========================================================================
  // Full lifecycle
  // =========================================================================

  describe('full lifecycle', () => {
    it('FIX VERIFIED: partial → partial → final sequence (|| → ?? fix for empty data-stt-base)', () => {
      inputEl.value = '';
      manager.handleStream({ text: 'Hel', isFinal: false });
      expect(inputEl.value).toBe('Hel');
      expect(inputEl.getAttribute('data-stt-base')).toBe('');

      manager.handleStream({ text: 'Hello', isFinal: false });
      expect(inputEl.value).toBe('Hello');
      expect(inputEl.getAttribute('data-stt-base')).toBe('');

      manager.handleStream({ text: 'Hello world', isFinal: true });
      expect(inputEl.value).toBe('Hello world');
      expect(inputEl.hasAttribute('data-stt-base')).toBe(false);
    });

    it('multiple final transcripts accumulate', () => {
      manager.handleStream({ text: 'First sentence.', isFinal: true });
      manager.handleStream({ text: 'Second sentence.', isFinal: true });
      expect(inputEl.value).toBe('First sentence. Second sentence.');
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================

  describe('module exports', () => {
    it('exports STTInputManager constructor', () => {
      expect(typeof STTInputManager).toBe('function');
    });

    it('instances have expected methods', () => {
      expect(typeof manager.setInputElement).toBe('function');
      expect(typeof manager.handleStream).toBe('function');
      expect(typeof manager.clear).toBe('function');
      expect(typeof manager.dispose).toBe('function');
    });
  });
});
