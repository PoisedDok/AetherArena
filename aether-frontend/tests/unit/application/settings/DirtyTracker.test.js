/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */
'use strict';

/**
 * DirtyTracker Unit Tests
 * ============================================================================
 * Tests the extracted DirtyTracker: document-level event delegation for
 * settings dirty tracking, DOM status indicator updates, save button state,
 * populating guard, TTS callback delegation, attach/detach lifecycle.
 *
 * @module tests/unit/application/settings/DirtyTracker.test
 */

const DirtyTracker = require('../../../../src/application/main/modules/settings/DirtyTracker');

describe('DirtyTracker', () => {
  let tracker;
  let callbacks;

  beforeEach(() => {
    callbacks = {
      isPopulating: jest.fn().mockReturnValue(false),
      onTtsEngineChange: jest.fn(),
      onQwen3VoiceChange: jest.fn(),
      onProactiveTtsToggle: jest.fn(),
    };
    tracker = new DirtyTracker(callbacks);
  });

  afterEach(() => {
    tracker.detach();
    document.body.innerHTML = '';
  });

  // =========================================================================
  // constructor
  // =========================================================================
  describe('constructor', () => {
    it('initialises with isDirty false', () => {
      expect(tracker.isDirty()).toBe(false);
    });

    it('stores callbacks', () => {
      expect(tracker._isPopulating).toBe(callbacks.isPopulating);
      expect(tracker._onTtsEngineChange).toBe(callbacks.onTtsEngineChange);
      expect(tracker._onQwen3VoiceChange).toBe(callbacks.onQwen3VoiceChange);
      expect(tracker._onProactiveTtsToggle).toBe(callbacks.onProactiveTtsToggle);
    });

    it('defaults isPopulating to always-false when not provided', () => {
      const t = new DirtyTracker({});
      expect(t._isPopulating()).toBe(false);
      t.detach();
    });

    it('defaults callback functions to null when not provided', () => {
      const t = new DirtyTracker();
      expect(t._onTtsEngineChange).toBeNull();
      expect(t._onQwen3VoiceChange).toBeNull();
      expect(t._onProactiveTtsToggle).toBeNull();
      t.detach();
    });

    it('does not attach listeners in constructor (requires explicit attach)', () => {
      expect(tracker._inputHandler).toBeNull();
      expect(tracker._changeHandler).toBeNull();
    });
  });

  // =========================================================================
  // attach / detach
  // =========================================================================
  describe('attach()', () => {
    it('creates _inputHandler and _changeHandler', () => {
      tracker.attach();
      expect(typeof tracker._inputHandler).toBe('function');
      expect(typeof tracker._changeHandler).toBe('function');
    });

    it('registers document event listeners', () => {
      const spy = jest.spyOn(document, 'addEventListener');
      tracker.attach();
      const inputCalls = spy.mock.calls.filter(c => c[0] === 'input');
      const changeCalls = spy.mock.calls.filter(c => c[0] === 'change');
      expect(inputCalls.length).toBe(1);
      expect(changeCalls.length).toBe(1);
      spy.mockRestore();
    });
  });

  describe('detach()', () => {
    it('removes document event listeners', () => {
      tracker.attach();
      const spy = jest.spyOn(document, 'removeEventListener');
      tracker.detach();
      const inputCalls = spy.mock.calls.filter(c => c[0] === 'input');
      const changeCalls = spy.mock.calls.filter(c => c[0] === 'change');
      expect(inputCalls.length).toBe(1);
      expect(changeCalls.length).toBe(1);
      spy.mockRestore();
    });

    it('nulls out handler references', () => {
      tracker.attach();
      tracker.detach();
      expect(tracker._inputHandler).toBeNull();
      expect(tracker._changeHandler).toBeNull();
    });

    it('is safe to call multiple times', () => {
      tracker.attach();
      tracker.detach();
      expect(() => tracker.detach()).not.toThrow();
    });

    it('is safe to call without prior attach', () => {
      expect(() => tracker.detach()).not.toThrow();
    });
  });

  // =========================================================================
  // setDirty
  // =========================================================================
  describe('setDirty()', () => {
    it('sets isDirty flag', () => {
      tracker.setDirty(true);
      expect(tracker.isDirty()).toBe(true);
    });

    it('clears isDirty flag', () => {
      tracker.setDirty(true);
      tracker.setDirty(false);
      expect(tracker.isDirty()).toBe(false);
    });

    it('suppressed when isPopulating returns true', () => {
      callbacks.isPopulating.mockReturnValue(true);
      tracker.setDirty(true);
      expect(tracker.isDirty()).toBe(false);
    });

    it('updates DOM status element text when dirty', () => {
      const statusEl = document.createElement('div');
      statusEl.id = 'settings-status';
      document.body.appendChild(statusEl);

      tracker.setDirty(true);
      expect(statusEl.textContent).toContain('Unsaved changes');
    });

    it('clears DOM status element text when not dirty', () => {
      const statusEl = document.createElement('div');
      statusEl.id = 'settings-status';
      document.body.appendChild(statusEl);

      tracker.setDirty(true);
      tracker.setDirty(false);
      expect(statusEl.textContent).toBe('');
    });

    it('sets status opacity when dirty', () => {
      const statusEl = document.createElement('div');
      statusEl.id = 'settings-status';
      document.body.appendChild(statusEl);

      tracker.setDirty(true);
      // jsdom doesn't support CSS custom properties in style.color,
      // so we verify the setAttribute was attempted via cssText
      expect(statusEl.style.opacity).toBe('1');
    });

    it('adds is-dirty class and enables save button when dirty', () => {
      const saveBtn = document.createElement('button');
      saveBtn.id = 'settings-save';
      saveBtn.disabled = true;
      document.body.appendChild(saveBtn);

      tracker.setDirty(true);
      expect(saveBtn.classList.contains('is-dirty')).toBe(true);
      expect(saveBtn.disabled).toBe(false);
    });

    it('removes is-dirty class and disables save button when clean', () => {
      const saveBtn = document.createElement('button');
      saveBtn.id = 'settings-save';
      document.body.appendChild(saveBtn);

      tracker.setDirty(true);
      tracker.setDirty(false);
      expect(saveBtn.classList.contains('is-dirty')).toBe(false);
      expect(saveBtn.disabled).toBe(true);
    });

    it('does not throw when DOM elements are absent', () => {
      expect(() => tracker.setDirty(true)).not.toThrow();
      expect(() => tracker.setDirty(false)).not.toThrow();
    });
  });

  // =========================================================================
  // Event delegation: input events
  // =========================================================================
  describe('input event delegation', () => {
    let modal;

    beforeEach(() => {
      modal = document.createElement('div');
      modal.id = 'settings-modal';
      document.body.appendChild(modal);
      tracker.attach();
    });

    it('sets dirty when input event fires inside settings modal', () => {
      const input = document.createElement('input');
      modal.appendChild(input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(tracker.isDirty()).toBe(true);
    });

    it('does not set dirty when input fires outside settings modal', () => {
      const outsideInput = document.createElement('input');
      document.body.appendChild(outsideInput);
      outsideInput.dispatchEvent(new Event('input', { bubbles: true }));
      expect(tracker.isDirty()).toBe(false);
    });

    it('does not set dirty when settings-modal does not exist', () => {
      document.body.removeChild(modal);
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(tracker.isDirty()).toBe(false);
    });
  });

  // =========================================================================
  // Event delegation: change events
  // =========================================================================
  describe('change event delegation', () => {
    let modal;

    beforeEach(() => {
      modal = document.createElement('div');
      modal.id = 'settings-modal';
      document.body.appendChild(modal);
      tracker.attach();
    });

    it('sets dirty when change event fires inside settings modal', () => {
      const select = document.createElement('select');
      modal.appendChild(select);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(tracker.isDirty()).toBe(true);
    });

    it('does not set dirty when change fires outside settings modal', () => {
      const select = document.createElement('select');
      document.body.appendChild(select);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(tracker.isDirty()).toBe(false);
    });
  });

  // =========================================================================
  // TTS callback delegation
  // =========================================================================
  describe('TTS callback delegation', () => {
    beforeEach(() => {
      tracker.attach();
    });

    it('calls onTtsEngineChange when handsfree-tts-engine changes', () => {
      const select = document.createElement('select');
      select.id = 'handsfree-tts-engine';
      const opt = document.createElement('option');
      opt.value = 'kokoro';
      select.appendChild(opt);
      select.value = 'kokoro';
      document.body.appendChild(select);

      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(callbacks.onTtsEngineChange).toHaveBeenCalledWith('kokoro');
    });

    it('calls onQwen3VoiceChange when handsfree-tts-voice-qwen3 changes', () => {
      const select = document.createElement('select');
      select.id = 'handsfree-tts-voice-qwen3';
      const opt = document.createElement('option');
      opt.value = 'Vivian';
      select.appendChild(opt);
      select.value = 'Vivian';
      document.body.appendChild(select);

      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(callbacks.onQwen3VoiceChange).toHaveBeenCalledWith('Vivian');
    });

    it('calls onProactiveTtsToggle when proactive-tts-enabled changes', () => {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = 'proactive-tts-enabled';
      checkbox.checked = true;
      document.body.appendChild(checkbox);

      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      expect(callbacks.onProactiveTtsToggle).toHaveBeenCalledWith(true);
    });

    it('does not call TTS callbacks when callback is null', () => {
      const t = new DirtyTracker({ isPopulating: () => false });
      t.attach();

      const select = document.createElement('select');
      select.id = 'handsfree-tts-engine';
      const opt = document.createElement('option');
      opt.value = 'kokoro';
      select.appendChild(opt);
      select.value = 'kokoro';
      document.body.appendChild(select);

      // Should not throw even though callbacks are null
      expect(() => {
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }).not.toThrow();

      t.detach();
    });

    it('does not call TTS callbacks for unrelated elements', () => {
      const input = document.createElement('input');
      input.id = 'some-other-input';
      document.body.appendChild(input);

      input.dispatchEvent(new Event('change', { bubbles: true }));
      expect(callbacks.onTtsEngineChange).not.toHaveBeenCalled();
      expect(callbacks.onQwen3VoiceChange).not.toHaveBeenCalled();
      expect(callbacks.onProactiveTtsToggle).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Lifecycle: events stop after detach
  // =========================================================================
  describe('lifecycle: events stop after detach', () => {
    it('does not respond to input events after detach', () => {
      const modal = document.createElement('div');
      modal.id = 'settings-modal';
      document.body.appendChild(modal);

      tracker.attach();
      tracker.detach();

      const input = document.createElement('input');
      modal.appendChild(input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(tracker.isDirty()).toBe(false);
    });

    it('does not respond to change events after detach', () => {
      tracker.attach();
      tracker.detach();

      const select = document.createElement('select');
      select.id = 'handsfree-tts-engine';
      const opt = document.createElement('option');
      opt.value = 'kokoro';
      select.appendChild(opt);
      select.value = 'kokoro';
      document.body.appendChild(select);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(callbacks.onTtsEngineChange).not.toHaveBeenCalled();
    });
  });
});
