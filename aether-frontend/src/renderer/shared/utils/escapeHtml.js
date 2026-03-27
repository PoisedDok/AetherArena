/**
 * Escape HTML entities to prevent XSS when interpolating user-controlled
 * values into innerHTML templates.
 *
 * String-based replacement — no DOM dependency. Mirrors the entity set
 * used by ContentExporter.escapeHtml but extracted as a standalone utility
 * so callers avoid importing the full ContentExporter module.
 *
 * @param {string} str - Raw string to escape
 * @returns {string} Escaped string safe for innerHTML interpolation
 */
'use strict';

function escapeHtml(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

module.exports = escapeHtml;
