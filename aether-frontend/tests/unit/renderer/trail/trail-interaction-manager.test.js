'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../../src/renderer/shared/utils/logger', () => {
  const noop = () => {};
  const makeLogger = () => {
    const log = { info: noop, warn: noop, error: noop, debug: noop, trace: noop };
    log.child = () => log;
    return log;
  };
  return { createRendererLogger: makeLogger };
});

const { EventTypes } = require('../../../../src/core/events/EventTypes');
const TrailInteractionManager = require('../../../../src/renderer/chat/modules/trail/TrailInteractionManager');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  };
}

function createEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function createRenderer() {
  return { toggleTrailState: jest.fn().mockReturnValue('collapsed') };
}

function createManager(overrides = {}) {
  const log = createLogger();
  const defaults = {
    eventBus: createEventBus(),
    renderer: createRenderer(),
  };
  const opts = { ...defaults, ...overrides };
  const manager = new TrailInteractionManager(opts);
  manager.log = log;
  return { manager, log, ...opts };
}

/** Build a trail DOM element with a .trail-header child */
function createTrailElement(trailId = 'trail-1') {
  const el = document.createElement('div');
  el.dataset.trailId = trailId;
  const header = document.createElement('div');
  header.classList.add('trail-header');
  el.appendChild(header);
  return el;
}

/** Build a node DOM element */
function createNodeElement() {
  return document.createElement('div');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('TrailInteractionManager', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // =========================================================================
  // constructor
  // =========================================================================
  describe('constructor', () => {
    it('stores eventBus and renderer', () => {
      const { manager, eventBus, renderer } = createManager();
      expect(manager.eventBus).toBe(eventBus);
      expect(manager.renderer).toBe(renderer);
    });

    it('throws when eventBus is missing', () => {
      expect(() => createManager({ eventBus: null })).toThrow('eventBus is REQUIRED');
    });

    it('throws when called with no arguments (exercises default options={})', () => {
      expect(() => new TrailInteractionManager()).toThrow('eventBus is REQUIRED');
    });

    it('defaults renderer to null when not provided', () => {
      const log = createLogger();
      const mgr = new TrailInteractionManager({ eventBus: createEventBus() });
      mgr.log = log;
      expect(mgr.renderer).toBeNull();
    });
  });

  // =========================================================================
  // attachHeaderClickHandler
  // =========================================================================
  describe('attachHeaderClickHandler', () => {
    it('throws when trailElement is null', () => {
      const { manager } = createManager();
      expect(() => manager.attachHeaderClickHandler(null)).toThrow('Invalid trailElement');
    });

    it('throws when trailElement has no querySelector', () => {
      const { manager } = createManager();
      expect(() => manager.attachHeaderClickHandler({})).toThrow('Invalid trailElement');
    });

    it('warns and returns when .trail-header not found', () => {
      const { manager, log } = createManager();
      const el = document.createElement('div');
      el.dataset.trailId = 'no-header';

      manager.attachHeaderClickHandler(el);

      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('Trail header not found'),
        expect.objectContaining({ trailId: 'no-header' })
      );
    });

    it('attaches click handler to .trail-header', () => {
      const { manager } = createManager();
      const trailEl = createTrailElement();
      const header = trailEl.querySelector('.trail-header');

      manager.attachHeaderClickHandler(trailEl);

      expect(header._clickHandler).toBeDefined();
      expect(typeof header._clickHandler).toBe('function');
    });

    it('toggles trail state via renderer on header click', () => {
      const { manager, renderer } = createManager();
      const trailEl = createTrailElement();
      const header = trailEl.querySelector('.trail-header');

      manager.attachHeaderClickHandler(trailEl);
      header.click();

      expect(renderer.toggleTrailState).toHaveBeenCalledWith(trailEl);
    });

    it('does not toggle when clicking inside .execution-node', () => {
      const { manager, renderer } = createManager();
      const trailEl = createTrailElement();
      const header = trailEl.querySelector('.trail-header');
      const execNode = document.createElement('div');
      execNode.classList.add('execution-node');
      header.appendChild(execNode);

      manager.attachHeaderClickHandler(trailEl);

      // Click the execution node — event target is inside .execution-node
      execNode.click();

      expect(renderer.toggleTrailState).not.toHaveBeenCalled();
    });

    it('does not crash when renderer is null', () => {
      const { manager } = createManager({ renderer: null });
      const trailEl = createTrailElement();
      const header = trailEl.querySelector('.trail-header');

      manager.attachHeaderClickHandler(trailEl);
      expect(() => header.click()).not.toThrow();
    });

    it('does not crash when renderer.toggleTrailState is not a function', () => {
      const { manager } = createManager({ renderer: { toggleTrailState: 'nope' } });
      const trailEl = createTrailElement();
      const header = trailEl.querySelector('.trail-header');

      manager.attachHeaderClickHandler(trailEl);
      expect(() => header.click()).not.toThrow();
    });

    it('removes previous handler before attaching new one', () => {
      const { manager, renderer } = createManager();
      const trailEl = createTrailElement();
      const header = trailEl.querySelector('.trail-header');

      // Attach twice
      manager.attachHeaderClickHandler(trailEl);
      manager.attachHeaderClickHandler(trailEl);

      header.click();
      // Only one handler should fire — toggleTrailState called once
      expect(renderer.toggleTrailState).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // attachNodeClickHandler
  // =========================================================================
  describe('attachNodeClickHandler', () => {
    const validArgs = ['artifact-123', 'node-456', 'subgroup-789', 'writing'];

    it('throws when nodeElement is missing', () => {
      const { manager } = createManager();
      expect(() => manager.attachNodeClickHandler(null, ...validArgs)).toThrow('Missing required parameters');
    });

    it('throws when artifactId is missing', () => {
      const { manager } = createManager();
      const node = createNodeElement();
      expect(() => manager.attachNodeClickHandler(node, '', 'n', 's', 't')).toThrow('Missing required parameters');
    });

    it('throws when nodeId is missing', () => {
      const { manager } = createManager();
      const node = createNodeElement();
      expect(() => manager.attachNodeClickHandler(node, 'a', '', 's', 't')).toThrow('Missing required parameters');
    });

    it('throws when subgroupId is missing', () => {
      const { manager } = createManager();
      const node = createNodeElement();
      expect(() => manager.attachNodeClickHandler(node, 'a', 'n', '', 't')).toThrow('Missing required parameters');
    });

    it('throws when nodeType is missing', () => {
      const { manager } = createManager();
      const node = createNodeElement();
      expect(() => manager.attachNodeClickHandler(node, 'a', 'n', 's', '')).toThrow('Missing required parameters');
    });

    it('makes node visually clickable', () => {
      const { manager } = createManager();
      const node = createNodeElement();

      manager.attachNodeClickHandler(node, ...validArgs);

      expect(node.classList.contains('clickable')).toBe(true);
      expect(node.title).toBe('Click to view artifact');
    });

    it('attaches click handler to node', () => {
      const { manager } = createManager();
      const node = createNodeElement();

      manager.attachNodeClickHandler(node, ...validArgs);

      expect(node._clickHandler).toBeDefined();
      expect(typeof node._clickHandler).toBe('function');
    });

    it('emits TRAIL.NODE_CLICKED on click with "writing" type mapped to "code"', () => {
      const { manager, eventBus } = createManager();
      const node = createNodeElement();
      document.body.appendChild(node);

      manager.attachNodeClickHandler(node, 'artifact-123', 'node-456', 'subgroup-789', 'writing');
      node.click();

      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.TRAIL.NODE_CLICKED, {
        artifactId: 'artifact-123',
        artifactType: 'code',
        nodeId: 'node-456',
        subgroupId: 'subgroup-789',
      });
    });

    it('maps non-"writing" type to "output"', () => {
      const { manager, eventBus } = createManager();
      const node = createNodeElement();
      document.body.appendChild(node);

      manager.attachNodeClickHandler(node, 'a1', 'n1', 's1', 'executing');
      node.click();

      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.TRAIL.NODE_CLICKED, expect.objectContaining({
        artifactType: 'output',
      }));
    });

    it('stops event propagation on click', () => {
      const { manager } = createManager();
      const parent = document.createElement('div');
      const node = createNodeElement();
      parent.appendChild(node);
      document.body.appendChild(parent);

      const parentHandler = jest.fn();
      parent.addEventListener('click', parentHandler);

      manager.attachNodeClickHandler(node, ...validArgs);
      node.click();

      expect(parentHandler).not.toHaveBeenCalled();
    });

    it('removes previous handler before attaching new one', () => {
      const { manager, eventBus } = createManager();
      const node = createNodeElement();
      document.body.appendChild(node);

      manager.attachNodeClickHandler(node, ...validArgs);
      manager.attachNodeClickHandler(node, ...validArgs);
      node.click();

      // Emit called only once (old handler removed)
      const clickCalls = eventBus.emit.mock.calls.filter(
        ([ev]) => ev === EventTypes.TRAIL.NODE_CLICKED
      );
      expect(clickCalls).toHaveLength(1);
    });
  });

  // =========================================================================
  // detachNodeClickHandler
  // =========================================================================
  describe('detachNodeClickHandler', () => {
    it('returns silently for null element', () => {
      const { manager } = createManager();
      expect(() => manager.detachNodeClickHandler(null)).not.toThrow();
    });

    it('removes click handler and resets styling', () => {
      const { manager } = createManager();
      const node = createNodeElement();
      const validArgs = ['artifact-1', 'node-1', 'sub-1', 'writing'];

      manager.attachNodeClickHandler(node, ...validArgs);
      expect(node._clickHandler).not.toBeNull();
      expect(node.classList.contains('clickable')).toBe(true);

      manager.detachNodeClickHandler(node);

      expect(node._clickHandler).toBeNull();
      expect(node.classList.contains('clickable')).toBe(false);
      expect(node.title).toBe('');
    });

    it('does not crash when no handler was attached', () => {
      const { manager } = createManager();
      const node = createNodeElement();
      expect(() => manager.detachNodeClickHandler(node)).not.toThrow();
    });

    it('prevents further event emission after detach', () => {
      const { manager, eventBus } = createManager();
      const node = createNodeElement();
      document.body.appendChild(node);

      manager.attachNodeClickHandler(node, 'a', 'n', 's', 'writing');
      manager.detachNodeClickHandler(node);
      eventBus.emit.mockClear();

      node.click();

      expect(eventBus.emit).not.toHaveBeenCalledWith(EventTypes.TRAIL.NODE_CLICKED, expect.anything());
    });
  });

  // =========================================================================
  // destroy
  // =========================================================================
  describe('destroy', () => {
    it('logs destruction and does not crash', () => {
      const { manager, log } = createManager();
      expect(() => manager.destroy()).not.toThrow();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('destroyed'));
    });
  });
});
