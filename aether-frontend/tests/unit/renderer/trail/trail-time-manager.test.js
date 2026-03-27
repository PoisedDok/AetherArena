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

const TrailTimeManager = require('../../../../src/renderer/chat/modules/trail/TrailTimeManager');

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

/** Build a container with a trail element and time displays */
function buildContainer() {
  const container = document.createElement('div');
  return container;
}

function addTrailElement(container, trailId, opts = {}) {
  const el = document.createElement('div');
  el.dataset.trailId = trailId;
  if (opts.state) el.dataset.state = opts.state;
  if (opts.trailNumber) el.dataset.trailNumber = opts.trailNumber;

  const timeDisplay = document.createElement('span');
  timeDisplay.classList.add('trail-time');
  el.appendChild(timeDisplay);

  if (opts.state === 'collapsed' && opts.trailNumber) {
    const titleText = document.createElement('span');
    titleText.classList.add('trail-title-text');
    titleText.textContent = `Trail ${opts.trailNumber}`;
    el.appendChild(titleText);
  }

  container.appendChild(el);
  return el;
}

function addNodeElement(container, nodeId, subgroupId) {
  const el = document.createElement('div');
  el.dataset.nodeId = nodeId;
  el.dataset.subgroupId = subgroupId;

  const timeDisplay = document.createElement('span');
  timeDisplay.classList.add('node-time');
  el.appendChild(timeDisplay);

  container.appendChild(el);
  return el;
}

function createManager(overrides = {}) {
  const log = createLogger();
  const container = overrides.container !== undefined ? overrides.container : buildContainer();
  const manager = new TrailTimeManager({ container, ...overrides });
  manager.log = log;
  return { manager, log, container };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('TrailTimeManager', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    document.body.innerHTML = '';
  });

  // =========================================================================
  // constructor
  // =========================================================================
  describe('constructor', () => {
    it('stores container from options', () => {
      const container = buildContainer();
      const { manager } = createManager({ container });
      expect(manager.container).toBe(container);
    });

    it('defaults container to null', () => {
      const log = createLogger();
      const mgr = new TrailTimeManager();
      mgr.log = log;
      expect(mgr.container).toBeNull();
    });

    it('initializes empty tracking maps', () => {
      const { manager } = createManager();
      expect(manager.trailTimes).toBeInstanceOf(Map);
      expect(manager.trailTimes.size).toBe(0);
      expect(manager.nodeTimes).toBeInstanceOf(Map);
      expect(manager.nodeTimes.size).toBe(0);
    });

    it('initializes _isDisposed to false', () => {
      const { manager } = createManager();
      expect(manager._isDisposed).toBe(false);
    });
  });

  // =========================================================================
  // startTrail
  // =========================================================================
  describe('startTrail', () => {
    it('throws when trailId is falsy', () => {
      const { manager } = createManager();
      expect(() => manager.startTrail('')).toThrow('trailId is REQUIRED');
      expect(() => manager.startTrail(null)).toThrow('trailId is REQUIRED');
    });

    it('creates time tracking entry with provided startTime', () => {
      const { manager } = createManager();
      manager.startTrail('t1', 1000);

      const entry = manager.trailTimes.get('t1');
      expect(entry.startTime).toBe(1000);
      expect(entry.endTime).toBeNull();
      expect(entry.intervalId).not.toBeNull();
    });

    it('defaults startTime to Date.now() when not provided', () => {
      jest.setSystemTime(new Date(5000));
      const { manager } = createManager();
      manager.startTrail('t1');

      expect(manager.trailTimes.get('t1').startTime).toBe(5000);
    });

    it('BUG REGRESSION: clears existing interval when called twice with same trailId', () => {
      const { manager } = createManager();
      const clearSpy = jest.spyOn(global, 'clearInterval');

      manager.startTrail('t1', 1000);
      const firstIntervalId = manager.trailTimes.get('t1').intervalId;

      manager.startTrail('t1', 2000);
      const secondIntervalId = manager.trailTimes.get('t1').intervalId;

      // First interval must have been cleared
      expect(clearSpy).toHaveBeenCalledWith(firstIntervalId);
      // Second interval is different from first
      expect(secondIntervalId).not.toBe(firstIntervalId);
      // Entry updated with new startTime
      expect(manager.trailTimes.get('t1').startTime).toBe(2000);

      clearSpy.mockRestore();
    });

    it('starts a 1-second interval that updates time display', () => {
      const { manager, container } = createManager();
      const trailEl = addTrailElement(container, 't1');

      jest.setSystemTime(new Date(1000));
      manager.startTrail('t1', 1000);

      // advanceTimersByTime advances both timer clock AND Date.now()
      // After advancing 3000ms: Date.now() = 1000 + 3000 = 4000
      // elapsed = (4000 - 1000) / 1000 = 3s
      jest.advanceTimersByTime(3000);

      const timeDisplay = trailEl.querySelector('.trail-time');
      expect(timeDisplay.textContent).toBe('3s');
    });
  });

  // =========================================================================
  // completeTrail
  // =========================================================================
  describe('completeTrail', () => {
    it('throws when trailId is falsy', () => {
      const { manager } = createManager();
      expect(() => manager.completeTrail('')).toThrow('trailId is REQUIRED');
    });

    it('warns and returns when trail not found', () => {
      const { manager, log } = createManager();
      manager.completeTrail('unknown');
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('Trail time not found'),
        expect.objectContaining({ trailId: 'unknown' })
      );
    });

    it('stops the interval', () => {
      const { manager } = createManager();
      manager.startTrail('t1', 1000);
      const entry = manager.trailTimes.get('t1');
      expect(entry.intervalId).not.toBeNull();

      manager.completeTrail('t1', 5000);
      expect(entry.intervalId).toBeNull();
    });

    it('sets endTime', () => {
      const { manager } = createManager();
      manager.startTrail('t1', 1000);
      manager.completeTrail('t1', 5000);
      expect(manager.trailTimes.get('t1').endTime).toBe(5000);
    });

    it('defaults endTime to Date.now() when not provided', () => {
      jest.setSystemTime(new Date(9000));
      const { manager } = createManager();
      manager.startTrail('t1', 1000);
      manager.completeTrail('t1');
      expect(manager.trailTimes.get('t1').endTime).toBe(9000);
    });

    it('updates dataset.endTime on trail DOM element', () => {
      const { manager, container } = createManager();
      const trailEl = addTrailElement(container, 't1');

      manager.startTrail('t1', 1000);
      manager.completeTrail('t1', 5000);

      expect(trailEl.dataset.endTime).toBe('5000');
    });

    it('does not crash when container is null', () => {
      const { manager } = createManager({ container: null });
      manager.startTrail('t1', 1000);
      expect(() => manager.completeTrail('t1', 5000)).not.toThrow();
    });

    it('does not crash when trail element not in DOM', () => {
      const { manager } = createManager();
      manager.startTrail('t1', 1000);
      // No trail element added to container
      expect(() => manager.completeTrail('t1', 5000)).not.toThrow();
    });

    it('handles trail entry with null intervalId gracefully', () => {
      const { manager } = createManager();
      // Manually insert entry with no intervalId (simulates already-completed or external state)
      manager.trailTimes.set('t1', { startTime: 1000, endTime: null, intervalId: null });
      expect(() => manager.completeTrail('t1', 5000)).not.toThrow();
      expect(manager.trailTimes.get('t1').endTime).toBe(5000);
    });

    it('performs final time display update', () => {
      const { manager, container } = createManager();
      const trailEl = addTrailElement(container, 't1');

      manager.startTrail('t1', 1000);
      manager.completeTrail('t1', 6000);

      expect(trailEl.querySelector('.trail-time').textContent).toBe('5s');
    });
  });

  // =========================================================================
  // _updateTrailTimeDisplay
  // =========================================================================
  describe('_updateTrailTimeDisplay', () => {
    it('returns early when container is null', () => {
      const { manager } = createManager({ container: null });
      manager.trailTimes.set('t1', { startTime: 1000, endTime: null });
      expect(() => manager._updateTrailTimeDisplay('t1')).not.toThrow();
    });

    it('returns early when trail element not found', () => {
      const { manager } = createManager();
      manager.trailTimes.set('t1', { startTime: 1000, endTime: null });
      expect(() => manager._updateTrailTimeDisplay('t1')).not.toThrow();
    });

    it('returns early when trail time entry not found', () => {
      const { manager, container } = createManager();
      addTrailElement(container, 't1');
      expect(() => manager._updateTrailTimeDisplay('t1')).not.toThrow();
    });

    it('updates .trail-time textContent', () => {
      const { manager, container } = createManager();
      const trailEl = addTrailElement(container, 't1');
      manager.trailTimes.set('t1', { startTime: 1000, endTime: 4000 });

      manager._updateTrailTimeDisplay('t1');

      expect(trailEl.querySelector('.trail-time').textContent).toBe('3s');
    });

    it('updates collapsed trail title with time', () => {
      const { manager, container } = createManager();
      const trailEl = addTrailElement(container, 't1', {
        state: 'collapsed',
        trailNumber: '2',
      });
      manager.trailTimes.set('t1', { startTime: 1000, endTime: 66000 });

      manager._updateTrailTimeDisplay('t1');

      const titleText = trailEl.querySelector('.trail-title-text');
      expect(titleText.textContent).toBe('Trail 2 (1m 5s)');
    });

    it('does not update title when trail is not collapsed', () => {
      const { manager, container } = createManager();
      const trailEl = addTrailElement(container, 't1');
      trailEl.dataset.state = 'expanded';
      manager.trailTimes.set('t1', { startTime: 1000, endTime: 4000 });

      manager._updateTrailTimeDisplay('t1');

      // No .trail-title-text exists because state is not collapsed at creation
      // Should not crash
    });

    it('does not update collapsed title when trailNumber is missing', () => {
      const { manager, container } = createManager();
      // Create collapsed trail element WITHOUT trailNumber
      const el = document.createElement('div');
      el.dataset.trailId = 't1';
      el.dataset.state = 'collapsed';
      const timeDisplay = document.createElement('span');
      timeDisplay.classList.add('trail-time');
      el.appendChild(timeDisplay);
      const titleText = document.createElement('span');
      titleText.classList.add('trail-title-text');
      titleText.textContent = 'Original Title';
      el.appendChild(titleText);
      container.appendChild(el);

      manager.trailTimes.set('t1', { startTime: 1000, endTime: 4000 });
      manager._updateTrailTimeDisplay('t1');

      // titleText exists but trailNumber is undefined/empty — should NOT update title
      expect(titleText.textContent).toBe('Original Title');
    });

    it('handles missing .trail-time display gracefully', () => {
      const { manager, container } = createManager();
      const el = document.createElement('div');
      el.dataset.trailId = 't1';
      container.appendChild(el);
      manager.trailTimes.set('t1', { startTime: 1000, endTime: 4000 });

      expect(() => manager._updateTrailTimeDisplay('t1')).not.toThrow();
    });
  });

  // =========================================================================
  // startNode
  // =========================================================================
  describe('startNode', () => {
    it('throws when nodeId is falsy', () => {
      const { manager } = createManager();
      expect(() => manager.startNode('', 'sg-1')).toThrow('nodeId and subgroupId are REQUIRED');
    });

    it('throws when subgroupId is falsy', () => {
      const { manager } = createManager();
      expect(() => manager.startNode('n1', '')).toThrow('nodeId and subgroupId are REQUIRED');
    });

    it('creates node time entry with interval', () => {
      const { manager } = createManager();
      manager.startNode('n1', 'sg-1', 1000);

      const entry = manager.nodeTimes.get('n1');
      expect(entry.startTime).toBe(1000);
      expect(entry.endTime).toBeNull();
      expect(entry.subgroupId).toBe('sg-1');
      expect(entry.intervalId).not.toBeNull();
    });

    it('defaults startTime to Date.now()', () => {
      jest.setSystemTime(new Date(7000));
      const { manager } = createManager();
      manager.startNode('n1', 'sg-1');
      expect(manager.nodeTimes.get('n1').startTime).toBe(7000);
    });

    it('BUG REGRESSION: clears existing interval when called twice with same nodeId', () => {
      const { manager } = createManager();
      const clearSpy = jest.spyOn(global, 'clearInterval');

      manager.startNode('n1', 'sg-1', 1000);
      const firstIntervalId = manager.nodeTimes.get('n1').intervalId;

      manager.startNode('n1', 'sg-1', 2000);
      const secondIntervalId = manager.nodeTimes.get('n1').intervalId;

      expect(clearSpy).toHaveBeenCalledWith(firstIntervalId);
      expect(secondIntervalId).not.toBe(firstIntervalId);
      expect(manager.nodeTimes.get('n1').startTime).toBe(2000);

      clearSpy.mockRestore();
    });

    it('performs immediate time display update', () => {
      jest.setSystemTime(new Date(1000));
      const { manager, container } = createManager();
      addNodeElement(container, 'n1', 'sg-1');

      manager.startNode('n1', 'sg-1', 1000);

      const nodeTime = container.querySelector('.node-time');
      expect(nodeTime.textContent).toBe('0s');
    });

    it('updates time display every second', () => {
      const { manager, container } = createManager();
      addNodeElement(container, 'n1', 'sg-1');

      jest.setSystemTime(new Date(1000));
      manager.startNode('n1', 'sg-1', 1000);

      // advanceTimersByTime advances Date.now() from 1000 to 3000
      // elapsed = (3000 - 1000) / 1000 = 2s
      jest.advanceTimersByTime(2000);

      expect(container.querySelector('.node-time').textContent).toBe('2s');
    });
  });

  // =========================================================================
  // completeNode
  // =========================================================================
  describe('completeNode', () => {
    it('throws when nodeId is falsy', () => {
      const { manager } = createManager();
      expect(() => manager.completeNode('', 'sg-1')).toThrow('nodeId and subgroupId are REQUIRED');
    });

    it('throws when subgroupId is falsy', () => {
      const { manager } = createManager();
      expect(() => manager.completeNode('n1', '')).toThrow('nodeId and subgroupId are REQUIRED');
    });

    it('returns early when node not found', () => {
      const { manager, log } = createManager();
      manager.completeNode('unknown', 'sg-1');
      expect(log.trace).toHaveBeenCalledWith(
        expect.stringContaining('Node time not found'),
        expect.objectContaining({ nodeId: 'unknown' })
      );
    });

    it('clears the interval', () => {
      const { manager } = createManager();
      manager.startNode('n1', 'sg-1', 1000);
      const entry = manager.nodeTimes.get('n1');
      expect(entry.intervalId).not.toBeNull();

      manager.completeNode('n1', 'sg-1', 5000);
      expect(entry.intervalId).toBeNull();
    });

    it('sets endTime', () => {
      const { manager } = createManager();
      manager.startNode('n1', 'sg-1', 1000);
      manager.completeNode('n1', 'sg-1', 5000);
      expect(manager.nodeTimes.get('n1').endTime).toBe(5000);
    });

    it('defaults endTime to Date.now()', () => {
      jest.setSystemTime(new Date(8000));
      const { manager } = createManager();
      manager.startNode('n1', 'sg-1', 1000);
      manager.completeNode('n1', 'sg-1');
      expect(manager.nodeTimes.get('n1').endTime).toBe(8000);
    });

    it('handles node entry with null intervalId gracefully', () => {
      const { manager } = createManager();
      manager.nodeTimes.set('n1', { startTime: 1000, endTime: null, subgroupId: 'sg-1', intervalId: null });
      expect(() => manager.completeNode('n1', 'sg-1', 5000)).not.toThrow();
      expect(manager.nodeTimes.get('n1').endTime).toBe(5000);
    });

    it('performs final time display update', () => {
      const { manager, container } = createManager();
      addNodeElement(container, 'n1', 'sg-1');

      manager.startNode('n1', 'sg-1', 1000);
      manager.completeNode('n1', 'sg-1', 11000);

      expect(container.querySelector('.node-time').textContent).toBe('10s');
    });
  });

  // =========================================================================
  // _updateNodeTimeDisplay
  // =========================================================================
  describe('_updateNodeTimeDisplay', () => {
    it('returns early when container is null', () => {
      const { manager } = createManager({ container: null });
      manager.nodeTimes.set('n1', { startTime: 1000, endTime: null });
      expect(() => manager._updateNodeTimeDisplay('n1', 'sg-1')).not.toThrow();
    });

    it('returns early when node element not found', () => {
      const { manager } = createManager();
      manager.nodeTimes.set('n1', { startTime: 1000, endTime: null });
      expect(() => manager._updateNodeTimeDisplay('n1', 'sg-1')).not.toThrow();
    });

    it('returns early when node time entry not found', () => {
      const { manager, container } = createManager();
      addNodeElement(container, 'n1', 'sg-1');
      expect(() => manager._updateNodeTimeDisplay('n1', 'sg-1')).not.toThrow();
    });

    it('returns early when .node-time display not found', () => {
      const { manager, container } = createManager();
      const el = document.createElement('div');
      el.dataset.nodeId = 'n1';
      el.dataset.subgroupId = 'sg-1';
      container.appendChild(el);
      manager.nodeTimes.set('n1', { startTime: 1000, endTime: 6000 });

      expect(() => manager._updateNodeTimeDisplay('n1', 'sg-1')).not.toThrow();
    });

    it('updates .node-time textContent', () => {
      const { manager, container } = createManager();
      addNodeElement(container, 'n1', 'sg-1');
      manager.nodeTimes.set('n1', { startTime: 1000, endTime: 6000 });

      manager._updateNodeTimeDisplay('n1', 'sg-1');

      expect(container.querySelector('.node-time').textContent).toBe('5s');
    });
  });

  // =========================================================================
  // _formatElapsed
  // =========================================================================
  describe('_formatElapsed', () => {
    it('returns "0s" when startTime is falsy', () => {
      const { manager } = createManager();
      expect(manager._formatElapsed(0, null)).toBe('0s');
      expect(manager._formatElapsed(null, null)).toBe('0s');
      expect(manager._formatElapsed(undefined, null)).toBe('0s');
    });

    it('formats seconds < 60', () => {
      const { manager } = createManager();
      expect(manager._formatElapsed(1000, 6000)).toBe('5s');
      expect(manager._formatElapsed(1000, 60000)).toBe('59s');
    });

    it('formats minutes and seconds >= 60', () => {
      const { manager } = createManager();
      expect(manager._formatElapsed(1000, 61000)).toBe('1m 0s');
      expect(manager._formatElapsed(1000, 91000)).toBe('1m 30s');
      expect(manager._formatElapsed(1000, 126000)).toBe('2m 5s');
    });

    it('uses Date.now() when endTime is null (live elapsed)', () => {
      jest.setSystemTime(new Date(11000));
      const { manager } = createManager();
      expect(manager._formatElapsed(1000, null)).toBe('10s');
    });

    it('handles sub-second precision (rounds down)', () => {
      const { manager } = createManager();
      expect(manager._formatElapsed(1000, 2500)).toBe('1s');
      expect(manager._formatElapsed(1000, 1999)).toBe('0s');
    });
  });

  // =========================================================================
  // destroy
  // =========================================================================
  describe('destroy', () => {
    it('clears all trail intervals', () => {
      const { manager } = createManager();
      manager.startTrail('t1', 1000);
      manager.startTrail('t2', 1000);

      const t1Interval = manager.trailTimes.get('t1').intervalId;
      const t2Interval = manager.trailTimes.get('t2').intervalId;
      const clearSpy = jest.spyOn(global, 'clearInterval');

      manager.destroy();

      expect(clearSpy).toHaveBeenCalledWith(t1Interval);
      expect(clearSpy).toHaveBeenCalledWith(t2Interval);
      clearSpy.mockRestore();
    });

    it('clears all node intervals', () => {
      const { manager } = createManager();
      manager.startNode('n1', 'sg-1', 1000);

      const n1Interval = manager.nodeTimes.get('n1').intervalId;
      const clearSpy = jest.spyOn(global, 'clearInterval');

      manager.destroy();

      expect(clearSpy).toHaveBeenCalledWith(n1Interval);
      clearSpy.mockRestore();
    });

    it('clears both tracking maps', () => {
      const { manager } = createManager();
      manager.startTrail('t1', 1000);
      manager.startNode('n1', 'sg-1', 1000);

      manager.destroy();

      expect(manager.trailTimes.size).toBe(0);
      expect(manager.nodeTimes.size).toBe(0);
    });

    it('handles empty maps (no intervals to clear)', () => {
      const { manager } = createManager();
      expect(() => manager.destroy()).not.toThrow();
    });

    it('handles trail entries without intervalId', () => {
      const { manager } = createManager();
      manager.trailTimes.set('t1', { startTime: 1000, endTime: 2000, intervalId: null });
      expect(() => manager.destroy()).not.toThrow();
    });

    it('handles node entries without intervalId', () => {
      const { manager } = createManager();
      manager.nodeTimes.set('n1', { startTime: 1000, endTime: 2000, subgroupId: 'sg-1', intervalId: null });
      expect(() => manager.destroy()).not.toThrow();
    });

    it('is idempotent — second call is a no-op', () => {
      const { manager, log } = createManager();
      manager.startTrail('t1', 1000);
      manager.destroy();
      const logCallCount = log.info.mock.calls.length;

      manager.destroy(); // second call

      expect(log.info.mock.calls.length).toBe(logCallCount);
      expect(manager._isDisposed).toBe(true);
    });

    it('sets _isDisposed to true', () => {
      const { manager } = createManager();
      expect(manager._isDisposed).toBe(false);
      manager.destroy();
      expect(manager._isDisposed).toBe(true);
    });

    it('nulls container reference', () => {
      const { manager } = createManager();
      expect(manager.container).not.toBeNull();
      manager.destroy();
      expect(manager.container).toBeNull();
    });
  });

  // =========================================================================
  // Integration
  // =========================================================================
  describe('integration', () => {
    it('full trail lifecycle: start → interval ticks → complete → display final', () => {
      const { manager, container } = createManager();
      const trailEl = addTrailElement(container, 't1');

      jest.setSystemTime(new Date(1000));
      manager.startTrail('t1', 1000);

      // advanceTimersByTime advances Date.now() from 1000 → 4000 (3s elapsed)
      jest.advanceTimersByTime(3000);
      expect(trailEl.querySelector('.trail-time').textContent).toBe('3s');

      // Advance 2 more seconds (Date.now() = 6000) then complete
      jest.advanceTimersByTime(2000);
      manager.completeTrail('t1', 6000);
      expect(trailEl.querySelector('.trail-time').textContent).toBe('5s');
      expect(trailEl.dataset.endTime).toBe('6000');

      // No more interval ticks after completion
      jest.advanceTimersByTime(5000);
      // Still 5s (interval was cleared)
      expect(trailEl.querySelector('.trail-time').textContent).toBe('5s');
    });

    it('full node lifecycle: start → interval ticks → complete', () => {
      const { manager, container } = createManager();
      addNodeElement(container, 'n1', 'sg-1');

      jest.setSystemTime(new Date(1000));
      manager.startNode('n1', 'sg-1', 1000);
      expect(container.querySelector('.node-time').textContent).toBe('0s');

      // Advance 2s: Date.now() = 3000, elapsed = 2s
      jest.advanceTimersByTime(2000);
      expect(container.querySelector('.node-time').textContent).toBe('2s');

      // Advance 2 more seconds (Date.now() = 5000) then complete
      jest.advanceTimersByTime(2000);
      manager.completeNode('n1', 'sg-1', 5000);
      expect(container.querySelector('.node-time').textContent).toBe('4s');
    });

    it('destroy stops all active intervals', () => {
      const { manager } = createManager();
      manager.startTrail('t1', 1000);
      manager.startNode('n1', 'sg-1', 1000);

      const clearSpy = jest.spyOn(global, 'clearInterval');
      manager.destroy();

      // Should have cleared at least 2 intervals (1 trail + 1 node)
      expect(clearSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      clearSpy.mockRestore();
    });
  });
});
