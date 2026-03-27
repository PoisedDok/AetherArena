'use strict';

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  }),
}));

function createContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('JsonRenderer', () => {
  let JsonRenderer;
  let renderer;
  let container;

  beforeEach(() => {
    jest.resetModules();
    document.body.innerHTML = '';
    document.head.innerHTML = '';

    JsonRenderer = require('../../../src/renderer/artifacts/modules/output/renderers/JsonRenderer');
    renderer = new JsonRenderer();
    container = createContainer();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('renders null/undefined as empty message', async () => {
    await renderer.render(null, container);
    expect(container.querySelector('.render-empty')).not.toBeNull();
    expect(container.textContent).toContain('No data to display');

    await renderer.render(undefined, container);
    expect(container.querySelector('.render-empty')).not.toBeNull();
  });

  it('renders flat object as key-value card', async () => {
    await renderer.render({ first_name: 'Alice', age: 30, active: true }, container);
    expect(container.querySelector('.jc-card')).not.toBeNull();
    expect(container.textContent).toContain('First Name');
    expect(container.textContent).toContain('Alice');
    expect(container.textContent).toContain('Age');
    expect(container.textContent).toContain('30');
    expect(container.textContent).toContain('Yes');
  });

  it('applies shared output surface classes for cards', async () => {
    await renderer.render({ first_name: 'Alice' }, container);
    expect(container.classList.contains('output-renderer-surface')).toBe(true);
    expect(container.querySelector('.jc-card').classList.contains('output-card')).toBe(true);
  });

  it('renders nested objects as sectioned card blocks', async () => {
    await renderer.render({
      profile: { name: 'A', role: 'Engineer' },
      settings: { dark_mode: true },
    }, container);
    expect(container.querySelectorAll('.jc-section').length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain('Profile');
    expect(container.textContent).toContain('Settings');
  });

  it('renders array of primitive values as tag pills', async () => {
    await renderer.render(['alpha', 'beta', 3], container);
    const tags = container.querySelectorAll('.jc-tag');
    expect(tags.length).toBe(3);
    expect(tags[0].classList.contains('output-pill')).toBe(true);
    expect(container.textContent).toContain('alpha');
    expect(container.textContent).toContain('beta');
    expect(container.textContent).toContain('3');
  });

  it('renders array of similar objects as table', async () => {
    await renderer.render(
      [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
      container
    );
    expect(container.querySelector('.jc-table')).not.toBeNull();
    expect(container.querySelector('.jc-table').classList.contains('output-table')).toBe(true);
    expect(container.querySelector('.jc-table-wrap').classList.contains('output-table-wrap')).toBe(true);
    expect(container.querySelectorAll('.jc-table tbody tr').length).toBe(2);
    expect(container.textContent).toContain('ID');
    expect(container.textContent).toContain('Name');
  });

  it('renders URL strings as clickable links with clean host text', async () => {
    await renderer.render({ website: 'https://example.com/path?q=1' }, container);
    const link = container.querySelector('.jc-link');
    expect(link).not.toBeNull();
    expect(link.href).toBe('https://example.com/path?q=1');
    expect(link.textContent).toBe('example.com/path');
    expect(link.title).toBe('https://example.com/path?q=1');
  });

  it('humanizes common technical key names', async () => {
    await renderer.render({ api_url: 'https://example.com', userId: 12 }, container);
    expect(container.textContent).toContain('API URL');
    expect(container.textContent).toContain('User ID');
  });

  it('injects clean styles once', async () => {
    await renderer.render({ a: 1 }, container);
    await renderer.render({ b: 2 }, container);
    const cleanStyles = document.querySelectorAll('#jc-clean-styles');
    expect(cleanStyles.length).toBe(1);
  });

  it('falls back to tree renderer if visual renderer throws', async () => {
    const spy = jest.spyOn(renderer, '_renderValue').mockImplementation(() => {
      throw new Error('forced render failure');
    });

    await renderer.render({ a: 1 }, container);

    expect(container.classList.contains('json-renderer-container')).toBe(true);
    expect(container.querySelector('.json-formatter-row')).not.toBeNull();
    spy.mockRestore();
  });

  it('removes fallback class on next successful render', async () => {
    const spy = jest.spyOn(renderer, '_renderValue').mockImplementation(() => {
      throw new Error('forced render failure');
    });
    await renderer.render({ a: 1 }, container);
    spy.mockRestore();

    await renderer.render({ b: 2 }, container);

    expect(container.classList.contains('jc-container')).toBe(true);
    expect(container.classList.contains('json-renderer-container')).toBe(false);
    expect(container.querySelector('.jc-card')).not.toBeNull();
  });

  it('dispose clears injected styles tracking and is idempotent', async () => {
    await renderer.render({ a: 1 }, container);
    expect(renderer.injectedStyles.size).toBeGreaterThan(0);

    renderer.dispose();
    expect(renderer.injectedStyles.size).toBe(0);
    expect(() => renderer.dispose()).not.toThrow();
  });

  it('exposes JsonRenderer on window', () => {
    expect(window.JsonRenderer).toBe(JsonRenderer);
  });
});
