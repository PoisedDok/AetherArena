'use strict';

// ---------------------------------------------------------------------------
// handsfree-toggle-init.js — Unit tests
// ---------------------------------------------------------------------------
// Source: src/renderer/main/scripts/handsfree-toggle-init.js (57 lines)
// Side-effect IIFE: reads DOM elements, attaches change listener, defaults off.
// Requires jsdom environment with specific DOM element IDs present.
// ---------------------------------------------------------------------------

describe('handsfree-toggle-init.js', () => {
  beforeEach(() => {
    jest.resetModules();
    // Clean global state
    delete window.__AETHER_CONFIG_READY__;
    delete window.AETHER_CONFIG;
  });

  // =========================================================================
  // Early exit — missing DOM elements
  // =========================================================================

  describe('early exit when DOM elements missing', () => {
    it('returns immediately when handsfree-enabled element is absent', () => {
      document.body.innerHTML = '<div id="handsfree-advanced-settings"></div>';
      // Should not throw
      require('../../../../src/renderer/main/scripts/handsfree-toggle-init');
    });

    it('returns immediately when handsfree-advanced-settings element is absent', () => {
      document.body.innerHTML = '<input type="checkbox" id="handsfree-enabled" />';
      require('../../../../src/renderer/main/scripts/handsfree-toggle-init');
    });

    it('returns immediately when both elements are absent', () => {
      document.body.innerHTML = '';
      require('../../../../src/renderer/main/scripts/handsfree-toggle-init');
    });
  });

  // =========================================================================
  // Initialization state
  // =========================================================================

  describe('initialization state', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <input type="checkbox" id="handsfree-enabled" />
        <div id="handsfree-advanced-settings">
          <input type="text" class="adv-input" />
          <select class="adv-select"><option>A</option></select>
        </div>
      `;
    });

    it('sets toggle to unchecked on load', () => {
      require('../../../../src/renderer/main/scripts/handsfree-toggle-init');

      const toggle = document.getElementById('handsfree-enabled');
      expect(toggle.checked).toBe(false);
    });

    it('hides advanced settings container on load', () => {
      require('../../../../src/renderer/main/scripts/handsfree-toggle-init');

      const container = document.getElementById('handsfree-advanced-settings');
      expect(container.style.display).toBe('none');
    });

    it('disables all inputs and selects inside advanced settings on load', () => {
      require('../../../../src/renderer/main/scripts/handsfree-toggle-init');

      const inputs = document.querySelectorAll('#handsfree-advanced-settings input, #handsfree-advanced-settings select');
      inputs.forEach((el) => {
        expect(el.disabled).toBe(true);
      });
    });
  });

  // =========================================================================
  // Toggle change handler
  // =========================================================================

  describe('change event handler', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <input type="checkbox" id="handsfree-enabled" />
        <div id="handsfree-advanced-settings">
          <input type="text" class="adv-input" />
          <select class="adv-select"><option>A</option></select>
        </div>
      `;
    });

    it('shows advanced settings when toggle is checked', () => {
      require('../../../../src/renderer/main/scripts/handsfree-toggle-init');

      const toggle = document.getElementById('handsfree-enabled');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));

      const container = document.getElementById('handsfree-advanced-settings');
      expect(container.style.display).toBe('block');
    });

    it('enables all child inputs/selects when toggle is checked', () => {
      require('../../../../src/renderer/main/scripts/handsfree-toggle-init');

      const toggle = document.getElementById('handsfree-enabled');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));

      const inputs = document.querySelectorAll('#handsfree-advanced-settings input, #handsfree-advanced-settings select');
      inputs.forEach((el) => {
        expect(el.disabled).toBe(false);
      });
    });

    it('hides advanced settings when toggle is unchecked', () => {
      require('../../../../src/renderer/main/scripts/handsfree-toggle-init');

      const toggle = document.getElementById('handsfree-enabled');
      // First enable
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      // Then disable
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));

      const container = document.getElementById('handsfree-advanced-settings');
      expect(container.style.display).toBe('none');
    });

    it('disables child inputs/selects when toggle is unchecked', () => {
      require('../../../../src/renderer/main/scripts/handsfree-toggle-init');

      const toggle = document.getElementById('handsfree-enabled');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));

      const inputs = document.querySelectorAll('#handsfree-advanced-settings input, #handsfree-advanced-settings select');
      inputs.forEach((el) => {
        expect(el.disabled).toBe(true);
      });
    });
  });

  // =========================================================================
  // resolveBaseUrl (internal) — exercised indirectly
  // =========================================================================
  // Note: resolveBaseUrl is defined inside the IIFE but is never called
  // in the current code (persistence was removed). The function exists
  // as dead code. We verify the branches we CAN reach through the
  // publicly observable behavior.
});
