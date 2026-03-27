'use strict';

const StepTemplates = require('../modules/OnboardingStepTemplates');
const { createRendererLogger } = require('../../../../shared/utils/logger');

const ONBOARDING_DONE_KEY = 'aether_onboarding_complete';
const ONBOARDING_SYNC_PENDING_KEY = 'aether_onboarding_complete_sync_pending';
const LEGAL_ACCEPTANCE_PREFERENCE_KEY = 'legal_acceptance_latest';
const LEGAL_ACCEPTANCE_VERSION = StepTemplates.LICENSE_ACCEPTANCE_VERSION || '2026-02-17';
const LEGAL_ACCEPTANCE_HASH = StepTemplates.LICENSE_ACCEPTANCE_HASH || '4fae27d8a2be5438cf2a70c549cab2df8f22ec3ddcfcf278c99244724b2b47a3';

class OnboardingService {
    constructor() {
        this.log = createRendererLogger('OnboardingService');
    }

    _getLocalStorageValue(key) {
        try {
            return localStorage.getItem(key);
        } catch (_) {
            return null;
        }
    }

    _setLocalStorageValue(key, value) {
        try {
            localStorage.setItem(key, value);
            return true;
        } catch (_) {
            return false;
        }
    }

    _removeLocalStorageValue(key) {
        try {
            localStorage.removeItem(key);
            return true;
        } catch (_) {
            return false;
        }
    }

    setLocalCompletionState(completed, pendingSync) {
        if (completed) {
            this._setLocalStorageValue(ONBOARDING_DONE_KEY, 'true');
        } else {
            this._removeLocalStorageValue(ONBOARDING_DONE_KEY);
        }
        if (pendingSync) {
            this._setLocalStorageValue(ONBOARDING_SYNC_PENDING_KEY, 'true');
        } else {
            this._removeLocalStorageValue(ONBOARDING_SYNC_PENDING_KEY);
        }
    }

    clearPendingSyncFlag() {
        this._removeLocalStorageValue(ONBOARDING_SYNC_PENDING_KEY);
    }

    isOnboardingPreferenceComplete(preferenceValue) {
        if (preferenceValue === true) return true;
        if (typeof preferenceValue === 'string') {
            const normalized = preferenceValue.trim().toLowerCase();
            if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
        }
        if (preferenceValue && typeof preferenceValue === 'object') {
            if (preferenceValue.value === true) return true;
            if (preferenceValue.completed === true) return true;
        }
        return false;
    }

    isLegalAcceptanceCurrent(preferenceValue) {
        const normalizedValue = (
            preferenceValue &&
            typeof preferenceValue === 'object' &&
            preferenceValue.value &&
            typeof preferenceValue.value === 'object'
        )
            ? preferenceValue.value
            : preferenceValue;

        if (!normalizedValue || typeof normalizedValue !== 'object') return false;
        return (
            normalizedValue.accepted === true &&
            normalizedValue.terms_version === LEGAL_ACCEPTANCE_VERSION &&
            normalizedValue.terms_hash === LEGAL_ACCEPTANCE_HASH
        );
    }

    async getLegalAcceptanceSnapshot(endpoint) {
        if (!endpoint) return null;

        if (typeof endpoint.getLatestLegalAcceptance === 'function') {
            return endpoint.getLatestLegalAcceptance();
        }

        if (typeof endpoint.getPreference === 'function') {
            return endpoint.getPreference(LEGAL_ACCEPTANCE_PREFERENCE_KEY);
        }

        return null;
    }

    async syncOnboardingCompletionPreference(endpoint) {
        if (
            !endpoint ||
            typeof endpoint.setPreference !== 'function' ||
            typeof endpoint.getPreference !== 'function'
        ) return false;
        try {
            await endpoint.setPreference('onboarding_complete', true);
            const persistedPreference = await endpoint.getPreference('onboarding_complete');
            if (!this.isOnboardingPreferenceComplete(persistedPreference)) {
                return false;
            }
            this.clearPendingSyncFlag();
            return true;
        } catch (_) {
            return false;
        }
    }

    async isNeeded(endpoint) {
        // Fast path: check localStorage
        const localStorageSaysDone = this._getLocalStorageValue(ONBOARDING_DONE_KEY) === 'true';
        const pendingSync = this._getLocalStorageValue(ONBOARDING_SYNC_PENDING_KEY) === 'true';

        if (localStorageSaysDone) {
            // If local completion is ahead of backend preference persistence, sync it now.
            // Failure is non-fatal; we keep pending flag and retry on next launch.
            if (pendingSync && endpoint) {
                await this.syncOnboardingCompletionPreference(endpoint);
            }

            // Cross-check: backend setup status is the source of truth.
            if (endpoint) {
                let setupStatus = null;
                try {
                    setupStatus = await endpoint.getSetupStatus();
                } catch (e) {
                    this.log.warn('[OnboardingService] Could not verify setup status:', e);
                }
                
                const phase = setupStatus?.current_phase;
                if (phase && phase !== 'completed') {
                    this.setLocalCompletionState(false, false);
                    return true;
                }

                let legalPref = null;
                try {
                    legalPref = await this.getLegalAcceptanceSnapshot(endpoint);
                } catch (e) {
                    this.log.warn('[OnboardingService] Could not verify legal acceptance:', e);
                }
                
                if (legalPref && !this.isLegalAcceptanceCurrent(legalPref)) {
                    this.setLocalCompletionState(false, false);
                    return true;
                }
            }
            return false;
        }

        // Slow path: check backend API
        if (!endpoint) return true;
        
        let pref = null;
        try {
            pref = await endpoint.getPreference('onboarding_complete');
        } catch (e) {
            this.log.warn('[OnboardingService] Could not check onboarding preference:', e);
            // If backend is down and we have no local state, we default to needing onboarding.
            return true;
        }
        
        const completed = this.isOnboardingPreferenceComplete(pref);
        if (completed) {
            let setupStatus = null;
            try {
                setupStatus = await endpoint.getSetupStatus();
            } catch (e) {
                this.log.warn('[OnboardingService] Could not verify setup status:', e);
            }
            
            const phase = setupStatus?.current_phase;
            if (phase && phase !== 'completed') {
                this.setLocalCompletionState(false, false);
                return true;
            }

            let legalPref = null;
            try {
                legalPref = await this.getLegalAcceptanceSnapshot(endpoint);
            } catch (e) {
                this.log.warn('[OnboardingService] Could not verify legal acceptance:', e);
            }
            
            if (legalPref && !this.isLegalAcceptanceCurrent(legalPref)) {
                this.setLocalCompletionState(false, false);
                return true;
            }
            this.setLocalCompletionState(true, false);
        }
        return !completed;
    }

    getLegalAcceptanceVersion() {
        return LEGAL_ACCEPTANCE_VERSION;
    }

    getLegalAcceptanceHash() {
        return LEGAL_ACCEPTANCE_HASH;
    }
}

module.exports = new OnboardingService();