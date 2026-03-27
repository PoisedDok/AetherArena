/**
 * @.architecture
 *
 * Incoming: All UI components (template definitions at module top) --- {require, define()}
 * Processing: Parse HTML template once, stamp DOM clones with ref capture + auto-tracked listeners
 *             --- {2 jobs: JOB_DEFINE_TEMPLATE, JOB_STAMP_INSTANCE}
 * Outgoing: { root: DocumentFragment, refs: Object, bind: Function, dispose: Function }
 *           --- {dom_types.fragment, ref_map, cleanup_fn}
 *
 * ONE public method: define(html) -> TemplateStamp.
 * TemplateStamp.stamp() -> { root, refs, bind, dispose }.
 *
 * WHY: Replaces innerHTML-based rendering with parse-once / clone-many pattern.
 * Templates are parsed into <template> elements at require() time (once per module load).
 * Each stamp() call clones the template, captures data-ref elements into a refs map,
 * and provides a bind() function that auto-tracks listeners for cleanup via dispose().
 *
 * @module renderer/shared/utils/ComponentFactory
 */

'use strict';

/**
 * TemplateStamp — reusable stamper created by ComponentFactory.define().
 *
 * Each stamp() call returns an independent { root, refs, bind, dispose } tuple.
 * Multiple stamps from the same TemplateStamp are fully independent — disposing
 * one does not affect another.
 */
class TemplateStamp {
    /**
     * @param {HTMLTemplateElement} templateEl — parsed <template> element
     */
    constructor(templateEl) {
        this._tmpl = templateEl;
    }

    /**
     * Clone the template and return a mountable instance with ref bindings.
     *
     * @returns {{ root: DocumentFragment, refs: Object<string, HTMLElement>, bind: Function, dispose: Function }}
     *   - root:    DocumentFragment ready to appendChild into a container
     *   - refs:    Map of data-ref attribute values to their elements
     *   - bind:    bind(refNameOrElement, event, handler, options?) — auto-tracked
     *   - dispose: Removes all tracked listeners and nulls all refs. Idempotent.
     */
    stamp() {
        const frag = this._tmpl.content.cloneNode(true);

        // Capture refs: every element with data-ref="name" → refs.name
        const refs = {};
        const refEls = frag.querySelectorAll('[data-ref]');
        for (let i = 0; i < refEls.length; i++) {
            refs[refEls[i].dataset.ref] = refEls[i];
        }

        // Listener tracking — private to this stamp instance
        const tracked = [];

        /**
         * Bind an event listener to a ref (by name) or a raw element.
         * The listener is auto-tracked and will be removed by dispose().
         *
         * @param {string|HTMLElement} refOrEl — ref name (string) or element
         * @param {string} event — event type (e.g. 'click', 'change')
         * @param {Function} handler — event handler
         * @param {Object} [options] — addEventListener options
         */
        function bind(refOrEl, event, handler, options) {
            const el = typeof refOrEl === 'string' ? refs[refOrEl] : refOrEl;
            if (!el || typeof handler !== 'function') return;
            el.addEventListener(event, handler, options);
            tracked.push({ element: el, event, handler, options });
        }

        /**
         * Remove all tracked listeners and null all refs.
         * Idempotent — safe to call multiple times.
         */
        function dispose() {
            for (let i = 0; i < tracked.length; i++) {
                const { element, event: evt, handler, options } = tracked[i];
                element?.removeEventListener(evt, handler, options);
            }
            tracked.length = 0;

            const keys = Object.keys(refs);
            for (let i = 0; i < keys.length; i++) {
                refs[keys[i]] = null;
            }
        }

        return { root: frag, refs, bind, dispose };
    }
}

/**
 * ComponentFactory — template stamping utility.
 *
 * Usage:
 *   const MyTemplate = ComponentFactory.define(`<div data-ref="root">...</div>`);
 *   const { root, refs, bind, dispose } = MyTemplate.stamp();
 */
const ComponentFactory = Object.freeze({
    /**
     * Parse an HTML string into a reusable TemplateStamp.
     * Call this at module top level — the template is parsed ONCE.
     *
     * @param {string} html — HTML template string. Elements with data-ref="name"
     *                         attributes will be captured in the refs map on stamp().
     * @returns {TemplateStamp} — call .stamp() to create instances
     */
    define(html) {
        if (typeof html !== 'string' || !html.trim()) {
            throw new Error('ComponentFactory.define() requires a non-empty HTML string');
        }
        const tmpl = document.createElement('template');
        tmpl.innerHTML = html.trim();
        return new TemplateStamp(tmpl);
    },
});

module.exports = ComponentFactory;
