'use strict';

const ComponentFactory = require('../../../../shared/utils/ComponentFactory');

const IntelligenceTemplate = ComponentFactory.define(`
    <div class="onboarding-intelligence">
        <div class="intel-section intel-primary-section">
            <div class="intel-section-header">
                <div class="intel-section-icon accent"><i class="fas fa-hard-drive"></i></div>
                <div class="intel-section-text">
                    <h4>Primary Storage</h4>
                    <p>AetherArena monitors this folder for new and changed files to generate smart suggestions. Pick the folder where your main work lives.</p>
                </div>
            </div>
            <div class="intel-locations-area">
                <div data-ref="primaryDisplay" id="intel-primary-display"></div>
                <button data-ref="selectPrimaryBtn" id="intel-select-primary" class="btn-premium-outline btn-sm">
                    <i class="fas fa-folder-open"></i> <span data-ref="selectPrimaryLabel">Select Folder</span>
                </button>
            </div>
        </div>

        <div class="intel-section">
            <div class="intel-section-header">
                <div class="intel-section-icon"><i class="fas fa-folder-plus"></i></div>
                <div class="intel-section-text">
                    <h4>Additional Folders</h4>
                    <p>These folders are indexed for search and memory but are not actively monitored.</p>
                </div>
            </div>
            <div class="intel-locations-area">
                <div data-ref="secondaryChips" id="intel-secondary-chips" class="intel-location-chips"></div>
                <button data-ref="addSecondaryBtn" id="intel-add-secondary" class="btn-premium-outline btn-sm">
                    <i class="fas fa-plus"></i> Add Folder
                </button>
            </div>
        </div>

        <div class="intel-section intel-proactive-card">
            <div class="intel-section-header">
                <div class="intel-section-icon accent"><i class="fas fa-bolt"></i></div>
                <div class="intel-section-text">
                    <h4>Smart Suggestions</h4>
                    <p>AetherArena runs lightweight background services to understand your workflow and surface relevant information before you need it.</p>
                </div>
                <label class="intel-master-toggle" aria-label="Enable smart suggestions">
                    <input type="checkbox" data-ref="proactiveToggle" id="intel-toggle-proactive" aria-label="Enable smart suggestions">
                    <span class="intel-toggle-track"><span class="intel-toggle-thumb"></span></span>
                </label>
            </div>
            <div class="intel-proactive-disclosure">
                <i class="fas fa-info-circle" aria-hidden="true"></i>
                <span>These services run independently \u2014 even when AetherArena is closed. Activity data is stored locally for 24 hours, then automatically deleted. Nothing leaves your machine.</span>
            </div>
            <div class="intel-proactive-detail">
                <span>Choose which activity to learn from below.</span>
            </div>
        </div>

        <div data-ref="sourceSection" id="intel-source-section" class="intel-source-section" role="region" aria-label="Activity source configuration">
            <div class="intel-source-section-header" id="intel-source-section-label">Activity Sources</div>
            <div data-ref="sourceCards" id="intel-source-cards" aria-labelledby="intel-source-section-label" aria-busy="true" role="status"></div>
        </div>

        <div class="intel-daemon-summary" data-ref="daemonSummary" role="status" aria-live="polite"></div>

        <div class="intel-privacy-notice">
            <i class="fas fa-lock"></i>
            <span>100% local. Nothing leaves your machine. Adjust anytime in <strong>Settings</strong>.</span>
        </div>
    </div>
`);

const LocationChipTemplate = ComponentFactory.define(`
    <div class="intel-location-chip" data-ref="chip">
        <i data-ref="icon" class="fas"></i>
        <span class="chip-path" data-ref="chipPath"></span>
        <span class="chip-type-badge" data-ref="typeBadge"></span>
        <select class="input intel-mode-select" data-ref="modeSelect" aria-label="Select Indexing Mode" style="margin-left: 8px; font-size: 0.8em; padding: 2px 6px; height: auto;">
            <option value="combined">Hybrid</option>
            <option value="semantic">Smart Search</option>
            <option value="bm25">Keyword Search</option>
        </select>
        <button class="chip-remove" data-ref="removeBtn" aria-label="Remove">&times;</button>
    </div>
`);

const BrowserCardTemplate = ComponentFactory.define(`
    <div class="intel-source-card" data-source="browser" id="intel-card-browser" data-ref="card">
        <div class="intel-source-header" data-ref="header" role="button" tabindex="0" aria-expanded="true" aria-controls="intel-card-browser-body">
            <div class="intel-source-icon"><i class="fas fa-globe"></i></div>
            <span class="intel-source-title" data-ref="title" id="intel-card-browser-label">Web Activity</span>
            <span class="source-status-dot" data-ref="statusDot"></span>
            <span class="source-platform-badge">All Platforms</span>
            <label class="intel-source-toggle" data-ref="toggleLabel" data-toggle="browser" aria-label="Enable web activity tracking">
                <input type="checkbox" data-ref="toggleInput" aria-labelledby="intel-card-browser-label">
                <span class="intel-source-toggle-track"><span class="intel-source-toggle-thumb"></span></span>
            </label>
            <i class="fas fa-chevron-down intel-source-chevron" aria-hidden="true"></i>
        </div>
        <div class="intel-source-body" data-ref="body" id="intel-card-browser-body" role="region" aria-labelledby="intel-card-browser-label"></div>
    </div>
`);

const EmailCardTemplate = ComponentFactory.define(`
    <div class="intel-source-card" data-source="email" id="intel-card-email" data-ref="card">
        <div class="intel-source-header" data-ref="header" role="button" tabindex="0" aria-expanded="true" aria-controls="intel-card-email-body">
            <div class="intel-source-icon"><i class="fas fa-envelope"></i></div>
            <span class="intel-source-title" data-ref="title" id="intel-card-email-label">Email Activity</span>
            <span class="source-status-dot" data-ref="statusDot"></span>
            <span class="source-platform-badge" data-ref="platformBadge">macOS</span>
            <label class="intel-source-toggle" data-ref="toggleLabel" data-toggle="email" aria-label="Enable email activity tracking">
                <input type="checkbox" data-ref="toggleInput" aria-labelledby="intel-card-email-label">
                <span class="intel-source-toggle-track"><span class="intel-source-toggle-thumb"></span></span>
            </label>
            <i class="fas fa-chevron-down intel-source-chevron" aria-hidden="true"></i>
        </div>
        <div class="intel-source-body" data-ref="body" id="intel-card-email-body" role="region" aria-labelledby="intel-card-email-label"></div>
    </div>
`);

const FilesystemCardTemplate = ComponentFactory.define(`
    <div class="intel-source-card" data-source="filesystem" id="intel-card-filesystem" data-ref="card">
        <div class="intel-source-header" data-ref="header" role="button" tabindex="0" aria-expanded="true" aria-controls="intel-card-filesystem-body">
            <div class="intel-source-icon"><i class="fas fa-folder-tree"></i></div>
            <span class="intel-source-title" data-ref="title" id="intel-card-filesystem-label">File Activity</span>
            <span class="source-status-dot" data-ref="statusDot"></span>
            <span class="source-platform-badge">All Platforms</span>
            <label class="intel-source-toggle" data-ref="toggleLabel" data-toggle="filesystem" aria-label="Enable file activity tracking">
                <input type="checkbox" data-ref="toggleInput" aria-labelledby="intel-card-filesystem-label">
                <span class="intel-source-toggle-track"><span class="intel-source-toggle-thumb"></span></span>
            </label>
            <i class="fas fa-chevron-down intel-source-chevron" aria-hidden="true"></i>
        </div>
        <div class="intel-source-body" data-ref="body" id="intel-card-filesystem-body" role="region" aria-labelledby="intel-card-filesystem-label"></div>
    </div>
`);

module.exports = {
    IntelligenceTemplate,
    LocationChipTemplate,
    BrowserCardTemplate,
    EmailCardTemplate,
    FilesystemCardTemplate
};