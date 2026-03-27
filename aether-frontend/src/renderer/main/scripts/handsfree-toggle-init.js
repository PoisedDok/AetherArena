'use strict';

/**
 * @.architecture
 *
 * Incoming: index.html (loaded after config-init.js) --- {DOM, window.AETHER_CONFIG}
 * Processing: Wire handsfree toggle UI change listener, enable/disable advanced controls --- {2 jobs: JOB_UPDATE_STATE, JOB_TOGGLE_ADVANCED}
 * Outgoing: DOM updates --- {DOM}
 */

(function () {
  const handsfreeToggle = document.getElementById('handsfree-enabled');
  const advancedContainer = document.getElementById('handsfree-advanced-settings');

  if (!handsfreeToggle || !advancedContainer) return;

  const setAdvancedEnabled = (enabled) => {
    advancedContainer.style.display = enabled ? 'block' : 'none';
    document
      .querySelectorAll('#handsfree-advanced-settings input, #handsfree-advanced-settings select')
      .forEach((el) => {
        el.disabled = !enabled;
      });
  };

  handsfreeToggle.addEventListener('change', async function () {
    const enabled = Boolean(this.checked);
    setAdvancedEnabled(enabled);
    
    // PERSISTENCE REMOVED: Saving is now handled globally by SettingsManager.saveSettings()
    // to ensure no changes are applied until the user clicks "Save Changes".
  });

  // Initialize state on load.
  // DEFERRED: Wait for config-init AND backend health (signalled by StartupSplash
  // completing and MainApp calling loadHandsfreePreference). This inline script
  // only sets up the toggle change listener and defaults to OFF. The actual
  // preference value is loaded by MainApp.loadHandsfreePreference() after the
  // onboarding gate confirms backend health -- avoiding Failed to fetch noise
  // during the 30-60s backend cold start.
  handsfreeToggle.checked = false;
  setAdvancedEnabled(false);
})();

