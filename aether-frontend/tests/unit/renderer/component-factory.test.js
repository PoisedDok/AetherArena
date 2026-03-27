'use strict';

/**
 * ComponentFactory Unit Tests
 * ============================================================================
 * Adversarial tests for renderer/shared/utils/ComponentFactory.js.
 *
 * Covers:
 * - define(): input validation, template parsing, TemplateStamp return
 * - stamp(): cloneNode independence, data-ref capture, nested refs
 * - bind(): by ref name, by raw element, missing ref, non-function handler
 * - dispose(): listener removal, ref nulling, idempotent double-dispose
 * - Independence: multiple stamps from one template are fully isolated
 *
 * Test environment: jsdom (via tests/unit/renderer/** match in jest.config.js)
 */

const ComponentFactory = require('../../../src/renderer/shared/utils/ComponentFactory');

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ComponentFactory', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    // =====================================================================
    // Module structure
    // =====================================================================

    describe('module exports', () => {
        it('exports a frozen object', () => {
            expect(Object.isFrozen(ComponentFactory)).toBe(true);
        });

        it('has exactly one public method: define', () => {
            const keys = Object.keys(ComponentFactory);
            expect(keys).toEqual(['define']);
            expect(typeof ComponentFactory.define).toBe('function');
        });

        it('does NOT have a stamp shortcut', () => {
            expect(ComponentFactory.stamp).toBeUndefined();
        });
    });

    // =====================================================================
    // define()
    // =====================================================================

    describe('define()', () => {
        it('returns a TemplateStamp with a stamp() method', () => {
            const tmpl = ComponentFactory.define('<div>hello</div>');
            expect(tmpl).toBeDefined();
            expect(typeof tmpl.stamp).toBe('function');
        });

        it('throws on empty string', () => {
            expect(() => ComponentFactory.define('')).toThrow(
                /requires a non-empty HTML string/
            );
        });

        it('throws on whitespace-only string', () => {
            expect(() => ComponentFactory.define('   \n  ')).toThrow(
                /requires a non-empty HTML string/
            );
        });

        it('throws on non-string input (number)', () => {
            expect(() => ComponentFactory.define(42)).toThrow(
                /requires a non-empty HTML string/
            );
        });

        it('throws on null', () => {
            expect(() => ComponentFactory.define(null)).toThrow(
                /requires a non-empty HTML string/
            );
        });

        it('throws on undefined', () => {
            expect(() => ComponentFactory.define(undefined)).toThrow(
                /requires a non-empty HTML string/
            );
        });

        it('trims whitespace from template HTML', () => {
            const tmpl = ComponentFactory.define('  <div data-ref="root">x</div>  ');
            const { refs } = tmpl.stamp();
            expect(refs.root).toBeDefined();
            expect(refs.root.textContent).toBe('x');
        });
    });

    // =====================================================================
    // stamp() — basic cloning
    // =====================================================================

    describe('stamp()', () => {
        it('returns root as DocumentFragment', () => {
            const tmpl = ComponentFactory.define('<div>test</div>');
            const { root } = tmpl.stamp();
            expect(root).toBeInstanceOf(DocumentFragment);
        });

        it('clones DOM structure correctly', () => {
            const tmpl = ComponentFactory.define(
                '<div class="card"><span class="title">hello</span></div>'
            );
            const { root } = tmpl.stamp();
            const div = root.querySelector('.card');
            expect(div).not.toBeNull();
            expect(div.querySelector('.title').textContent).toBe('hello');
        });

        it('root can be appended to a container', () => {
            const tmpl = ComponentFactory.define('<p data-ref="para">mounted</p>');
            const { root } = tmpl.stamp();
            document.body.appendChild(root);
            const para = document.body.querySelector('p');
            expect(para).not.toBeNull();
            expect(para.textContent).toBe('mounted');
        });
    });

    // =====================================================================
    // stamp() — refs capture
    // =====================================================================

    describe('refs capture', () => {
        it('captures single data-ref', () => {
            const tmpl = ComponentFactory.define('<div data-ref="container">content</div>');
            const { refs } = tmpl.stamp();
            expect(refs.container).toBeDefined();
            expect(refs.container.textContent).toBe('content');
        });

        it('captures multiple data-ref elements', () => {
            const tmpl = ComponentFactory.define(`
                <div data-ref="root">
                    <h1 data-ref="title">Title</h1>
                    <p data-ref="body">Body</p>
                    <button data-ref="btn">Click</button>
                </div>
            `);
            const { refs } = tmpl.stamp();
            expect(Object.keys(refs).sort()).toEqual(['body', 'btn', 'root', 'title']);
            expect(refs.title.tagName).toBe('H1');
            expect(refs.body.tagName).toBe('P');
            expect(refs.btn.tagName).toBe('BUTTON');
        });

        it('captures deeply nested data-ref elements', () => {
            const tmpl = ComponentFactory.define(`
                <div>
                    <div>
                        <div>
                            <span data-ref="deep">found</span>
                        </div>
                    </div>
                </div>
            `);
            const { refs } = tmpl.stamp();
            expect(refs.deep).toBeDefined();
            expect(refs.deep.textContent).toBe('found');
        });

        it('returns empty refs object when no data-ref attributes', () => {
            const tmpl = ComponentFactory.define('<div><span>no refs</span></div>');
            const { refs } = tmpl.stamp();
            expect(Object.keys(refs)).toEqual([]);
        });

        it('last data-ref wins on duplicate ref names', () => {
            const tmpl = ComponentFactory.define(`
                <div>
                    <span data-ref="item">first</span>
                    <span data-ref="item">second</span>
                </div>
            `);
            const { refs } = tmpl.stamp();
            expect(refs.item.textContent).toBe('second');
        });

        it('preserves element attributes alongside data-ref', () => {
            const tmpl = ComponentFactory.define(
                '<input data-ref="input" type="text" placeholder="enter" class="field" />'
            );
            const { refs } = tmpl.stamp();
            expect(refs.input.type).toBe('text');
            expect(refs.input.placeholder).toBe('enter');
            expect(refs.input.className).toBe('field');
        });
    });

    // =====================================================================
    // bind() — listener attachment
    // =====================================================================

    describe('bind()', () => {
        it('attaches listener to ref by name', () => {
            const tmpl = ComponentFactory.define('<button data-ref="btn">Go</button>');
            const { refs, bind } = tmpl.stamp();
            const handler = jest.fn();

            bind('btn', 'click', handler);
            refs.btn.click();
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('attaches listener to raw element', () => {
            const tmpl = ComponentFactory.define('<div data-ref="root"></div>');
            const { refs, bind } = tmpl.stamp();
            const externalEl = document.createElement('span');
            const handler = jest.fn();

            bind(externalEl, 'click', handler);
            externalEl.click();
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('passes event object to handler', () => {
            const tmpl = ComponentFactory.define('<button data-ref="btn">Go</button>');
            const { refs, bind } = tmpl.stamp();
            let receivedEvent = null;

            bind('btn', 'click', (e) => { receivedEvent = e; });
            refs.btn.click();
            expect(receivedEvent).not.toBeNull();
            expect(receivedEvent.type).toBe('click');
        });

        it('is a no-op when ref name does not exist', () => {
            const tmpl = ComponentFactory.define('<div data-ref="root"></div>');
            const { bind } = tmpl.stamp();
            expect(() => bind('nonexistent', 'click', jest.fn())).not.toThrow();
        });

        it('is a no-op when element is null', () => {
            const tmpl = ComponentFactory.define('<div></div>');
            const { bind } = tmpl.stamp();
            expect(() => bind(null, 'click', jest.fn())).not.toThrow();
        });

        it('is a no-op when handler is not a function', () => {
            const tmpl = ComponentFactory.define('<button data-ref="btn">Go</button>');
            const { bind } = tmpl.stamp();
            expect(() => bind('btn', 'click', 'not-a-function')).not.toThrow();
        });

        it('supports addEventListener options', () => {
            const tmpl = ComponentFactory.define('<div data-ref="root"></div>');
            const { refs, bind } = tmpl.stamp();
            const handler = jest.fn();

            const addSpy = jest.spyOn(refs.root, 'addEventListener');
            bind('root', 'click', handler, { capture: true, passive: true });
            expect(addSpy).toHaveBeenCalledWith(
                'click', handler, { capture: true, passive: true }
            );
            addSpy.mockRestore();
        });
    });

    // =====================================================================
    // dispose() — cleanup
    // =====================================================================

    describe('dispose()', () => {
        it('removes all tracked listeners', () => {
            const tmpl = ComponentFactory.define(`
                <div data-ref="root">
                    <button data-ref="btn1">A</button>
                    <button data-ref="btn2">B</button>
                </div>
            `);
            const { root, bind, dispose } = tmpl.stamp();
            const h1 = jest.fn();
            const h2 = jest.fn();

            document.body.appendChild(root);
            const btn1 = document.body.querySelector('[data-ref="btn1"]');
            const btn2 = document.body.querySelector('[data-ref="btn2"]');

            bind('btn1', 'click', h1);
            bind('btn2', 'click', h2);

            btn1.click();
            btn2.click();
            expect(h1).toHaveBeenCalledTimes(1);
            expect(h2).toHaveBeenCalledTimes(1);

            dispose();

            btn1.click();
            btn2.click();
            expect(h1).toHaveBeenCalledTimes(1); // still 1 — listener removed
            expect(h2).toHaveBeenCalledTimes(1); // still 1 — listener removed
        });

        it('removes listener from element — post-dispose clicks do not fire', () => {
            const tmpl = ComponentFactory.define('<button data-ref="btn">Go</button>');
            const { root, bind, dispose } = tmpl.stamp();
            const handler = jest.fn();

            // Must mount first so we can keep a reference to the actual element
            document.body.appendChild(root);
            const btn = document.body.querySelector('[data-ref="btn"]');

            bind('btn', 'click', handler);
            btn.click();
            expect(handler).toHaveBeenCalledTimes(1);

            dispose();
            btn.click();
            expect(handler).toHaveBeenCalledTimes(1); // still 1, listener removed
        });

        it('nulls all refs', () => {
            const tmpl = ComponentFactory.define(`
                <div data-ref="a"></div>
                <div data-ref="b"></div>
            `);
            const { refs, dispose } = tmpl.stamp();
            expect(refs.a).not.toBeNull();
            expect(refs.b).not.toBeNull();

            dispose();
            expect(refs.a).toBeNull();
            expect(refs.b).toBeNull();
        });

        it('is idempotent — second call does not throw', () => {
            const tmpl = ComponentFactory.define('<div data-ref="root"></div>');
            const { dispose } = tmpl.stamp();
            dispose();
            expect(() => dispose()).not.toThrow();
        });

        it('handles dispose when no listeners were bound', () => {
            const tmpl = ComponentFactory.define('<div data-ref="root">text</div>');
            const { dispose } = tmpl.stamp();
            expect(() => dispose()).not.toThrow();
        });

        it('handles dispose when element was removed from DOM', () => {
            const tmpl = ComponentFactory.define('<button data-ref="btn">Go</button>');
            const { root, bind, dispose } = tmpl.stamp();
            document.body.appendChild(root);

            const btn = document.body.querySelector('[data-ref="btn"]');
            bind('btn', 'click', jest.fn());

            btn.remove();
            expect(() => dispose()).not.toThrow();
        });
    });

    // =====================================================================
    // Independence — multiple stamps from same template
    // =====================================================================

    describe('stamp independence', () => {
        it('two stamps produce independent DOM trees', () => {
            const tmpl = ComponentFactory.define(
                '<div data-ref="root"><span data-ref="label">default</span></div>'
            );
            const stamp1 = tmpl.stamp();
            const stamp2 = tmpl.stamp();

            stamp1.refs.label.textContent = 'stamp1';
            stamp2.refs.label.textContent = 'stamp2';

            expect(stamp1.refs.label.textContent).toBe('stamp1');
            expect(stamp2.refs.label.textContent).toBe('stamp2');
        });

        it('disposing stamp1 does not affect stamp2 listeners', () => {
            const tmpl = ComponentFactory.define('<button data-ref="btn">Go</button>');

            const s1 = tmpl.stamp();
            const s2 = tmpl.stamp();
            const h1 = jest.fn();
            const h2 = jest.fn();

            document.body.appendChild(s1.root);
            document.body.appendChild(s2.root);

            const btn1 = document.body.querySelectorAll('[data-ref="btn"]')[0];
            const btn2 = document.body.querySelectorAll('[data-ref="btn"]')[1];

            s1.bind('btn', 'click', h1);
            s2.bind('btn', 'click', h2);

            s1.dispose();

            btn1.click();
            btn2.click();

            expect(h1).toHaveBeenCalledTimes(0); // removed
            expect(h2).toHaveBeenCalledTimes(1); // still active
        });

        it('disposing stamp1 does not null stamp2 refs', () => {
            const tmpl = ComponentFactory.define('<div data-ref="item">x</div>');
            const s1 = tmpl.stamp();
            const s2 = tmpl.stamp();

            s1.dispose();
            expect(s1.refs.item).toBeNull();
            expect(s2.refs.item).not.toBeNull();
        });
    });

    // =====================================================================
    // Edge cases
    // =====================================================================

    describe('edge cases', () => {
        it('template with only text (no elements) produces empty refs', () => {
            const tmpl = ComponentFactory.define('<div>plain text only</div>');
            const { root, refs } = tmpl.stamp();
            expect(Object.keys(refs)).toEqual([]);
            expect(root.textContent).toBe('plain text only');
        });

        it('template with multiple root elements', () => {
            const tmpl = ComponentFactory.define(
                '<span data-ref="a">1</span><span data-ref="b">2</span>'
            );
            const { root, refs } = tmpl.stamp();
            expect(refs.a.textContent).toBe('1');
            expect(refs.b.textContent).toBe('2');
            expect(root.childNodes.length).toBe(2);
        });

        it('template with input elements preserves type', () => {
            const tmpl = ComponentFactory.define(
                '<input data-ref="check" type="checkbox" />'
            );
            const { refs } = tmpl.stamp();
            expect(refs.check.type).toBe('checkbox');
        });

        it('template with select > option preserves structure', () => {
            const tmpl = ComponentFactory.define(`
                <select data-ref="sel">
                    <option value="a">A</option>
                    <option value="b">B</option>
                </select>
            `);
            const { refs } = tmpl.stamp();
            expect(refs.sel.options.length).toBe(2);
            expect(refs.sel.options[0].value).toBe('a');
        });

        it('bind works with change event on input', () => {
            const tmpl = ComponentFactory.define(
                '<input data-ref="input" type="text" />'
            );
            const { refs, bind } = tmpl.stamp();
            const handler = jest.fn();

            bind('input', 'change', handler);
            refs.input.dispatchEvent(new Event('change'));
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('bind works with keydown event', () => {
            const tmpl = ComponentFactory.define('<div data-ref="root"></div>');
            const { refs, bind } = tmpl.stamp();
            const handler = jest.fn();

            bind('root', 'keydown', handler);
            refs.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
            expect(handler).toHaveBeenCalledTimes(1);
        });
    });
});
