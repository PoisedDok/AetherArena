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

jest.mock('../../../../src/renderer/shared/utils/date-utils', () => ({
  getTimestamp: jest.fn().mockReturnValue(1700000000000),
  formatElapsedTime: jest.fn().mockReturnValue('5s'),
}));

const TrailDOMRenderer = require('../../../../src/renderer/chat/modules/trail/TrailDOMRenderer');
const DateUtils = require('../../../../src/renderer/shared/utils/date-utils');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  };
}

function createRenderer(opts = {}) {
  const log = createLogger();
  DateUtils.getTimestamp.mockReturnValue(1700000000000);
  DateUtils.formatElapsedTime.mockReturnValue('5s');

  const defaults = { enableLogging: true };
  const renderer = new TrailDOMRenderer({ ...defaults, ...opts });
  renderer.log = log;
  return { renderer, log };
}

/** Build a trail element matching createTrailContainer structure for mutation tests */
function buildTrailElement(trailNumber = 1) {
  const trail = document.createElement('div');
  trail.className = 'chat-entry artifact-execution-trail-container';
  trail.dataset.state = 'partial';
  trail.dataset.finalized = 'false';
  trail.dataset.trailId = 'trail_test_1';
  trail.dataset.trailNumber = String(trailNumber);
  trail.dataset.startTime = '1700000000000';

  const header = document.createElement('div');
  header.className = 'trail-header';

  const title = document.createElement('div');
  title.className = 'trail-title';

  const statusIcon = document.createElement('div');
  statusIcon.className = 'trail-status-icon';
  statusIcon.innerHTML = '<div class="trail-status-spinner"></div>';

  const titleText = document.createElement('span');
  titleText.className = 'trail-title-text';
  titleText.textContent = `Trail ${trailNumber}`;

  title.appendChild(statusIcon);
  title.appendChild(titleText);

  const timeDisplay = document.createElement('div');
  timeDisplay.className = 'trail-time';
  timeDisplay.textContent = '0s';

  const chevron = document.createElement('div');
  chevron.className = 'trail-chevron rotate-90';

  header.appendChild(title);
  header.appendChild(timeDisplay);
  header.appendChild(chevron);

  const innerContent = document.createElement('div');
  innerContent.className = 'trail-inner-content';
  const timeline = document.createElement('div');
  timeline.className = 'trail-timeline';
  innerContent.appendChild(timeline);

  trail.appendChild(header);
  trail.appendChild(innerContent);
  return trail;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('TrailDOMRenderer', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // =========================================================================
  // CONSTRUCTOR
  // =========================================================================

  describe('constructor', () => {
    it('creates instance with defaults', () => {
      DateUtils.getTimestamp.mockReturnValue(1700000000000);
      const renderer = new TrailDOMRenderer();
      expect(renderer.enableLogging).toBe(false);
      expect(renderer._isDisposed).toBe(false);
    });

    it('accepts options', () => {
      DateUtils.getTimestamp.mockReturnValue(1700000000000);
      const renderer = new TrailDOMRenderer({ enableLogging: true });
      expect(renderer.enableLogging).toBe(true);
      expect(renderer._isDisposed).toBe(false);
    });
  });

  // =========================================================================
  // createTrailContainer
  // =========================================================================

  describe('createTrailContainer()', () => {
    it('returns a div with correct class and dataset', () => {
      const { renderer } = createRenderer();
      const trail = renderer.createTrailContainer(3);

      expect(trail.tagName).toBe('DIV');
      expect(trail.className).toContain('chat-entry');
      expect(trail.className).toContain('artifact-execution-trail-container');
      expect(trail.dataset.state).toBe('partial');
      expect(trail.dataset.finalized).toBe('false');
      expect(trail.dataset.trailNumber).toBe('3');
      expect(trail.dataset.trailId).toMatch(/^trail_\d+_/);
      expect(trail.dataset.startTime).toBe('1700000000000');
    });

    it('contains role indicator with G', () => {
      const { renderer } = createRenderer();
      const trail = renderer.createTrailContainer(1);
      const role = trail.querySelector('.chat-role-indicator');
      expect(role).not.toBeNull();
      expect(role.textContent).toBe('G');
    });

    it('contains content wrapper with timestamp', () => {
      const { renderer } = createRenderer();
      const trail = renderer.createTrailContainer(1);
      const wrapper = trail.querySelector('.trail-content-wrapper');
      expect(wrapper).not.toBeNull();
      const ts = wrapper.querySelector('.chat-timestamp');
      expect(ts).not.toBeNull();
      expect(ts.textContent.length).toBeGreaterThan(0);
    });

    it('contains trail header with title, time, and chevron', () => {
      const { renderer } = createRenderer();
      const trail = renderer.createTrailContainer(5);
      const header = trail.querySelector('.trail-header');
      expect(header).not.toBeNull();

      const title = header.querySelector('.trail-title');
      expect(title).not.toBeNull();
      expect(title.textContent).toContain('Trail 5');

      const time = header.querySelector('.trail-time');
      expect(time).not.toBeNull();
      expect(time.textContent).toBe('0s');

      const chevron = header.querySelector('.trail-chevron');
      expect(chevron).not.toBeNull();
      expect(chevron.className).toContain('rotate-0');
    });

    it('contains trail timeline inside inner content', () => {
      const { renderer } = createRenderer();
      const trail = renderer.createTrailContainer(1);
      const timeline = trail.querySelector('.trail-timeline');
      expect(timeline).not.toBeNull();
    });

    it('contains status icon with spinner', () => {
      const { renderer } = createRenderer();
      const trail = renderer.createTrailContainer(1);
      const icon = trail.querySelector('.trail-status-icon');
      expect(icon).not.toBeNull();
      expect(icon.querySelector('.trail-status-spinner')).not.toBeNull();
    });
  });

  // =========================================================================
  // createTrailNode
  // =========================================================================

  describe('createTrailNode()', () => {
    it('creates non-clickable node with default status pending', () => {
      const { renderer } = createRenderer();
      const node = renderer.createTrailNode('writing');

      expect(node.className).toContain('execution-node');
      expect(node.dataset.phaseKind).toBe('writing');
      expect(node.dataset.phaseType).toBe('writing');
      expect(node.dataset.status).toBe('pending');
      expect(node.classList.contains('pending')).toBe(true);
      expect(node.classList.contains('clickable')).toBe(false);
      expect(node.title).toBe('');
    });

    it('creates clickable node', () => {
      const { renderer } = createRenderer();
      const node = renderer.createTrailNode('output', 'completed', true);

      expect(node.classList.contains('clickable')).toBe(true);
      expect(node.title).toContain('Click to view');
    });

    it('applies correct status class', () => {
      const { renderer } = createRenderer();

      expect(renderer.createTrailNode('x', 'completed').classList.contains('completed')).toBe(true);
      expect(renderer.createTrailNode('x', 'error').classList.contains('error')).toBe(true);
      expect(renderer.createTrailNode('x', 'active').classList.contains('active')).toBe(true);
    });

    it('contains node-header with node-time 0s', () => {
      const { renderer } = createRenderer();
      const node = renderer.createTrailNode('executing');
      const nodeTime = node.querySelector('.node-time');
      expect(nodeTime).not.toBeNull();
      expect(nodeTime.textContent).toBe('0s');
    });
  });

  // =========================================================================
  // updateTrailStatusIcon
  // =========================================================================

  describe('updateTrailStatusIcon()', () => {
    it('shows spinner when hasActive', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement();

      renderer.updateTrailStatusIcon(trail, true, false);

      const icon = trail.querySelector('.trail-status-icon');
      expect(icon.innerHTML).toContain('trail-status-spinner');
    });

    it('shows ERR when hasError and not active', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement();

      renderer.updateTrailStatusIcon(trail, false, true);

      const icon = trail.querySelector('.trail-status-icon');
      expect(icon.innerHTML).toContain('ERR');
    });

    it('shows OK when neither active nor error', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement();

      renderer.updateTrailStatusIcon(trail, false, false);

      const icon = trail.querySelector('.trail-status-icon');
      expect(icon.innerHTML).toContain('OK');
    });

    it('returns early when no statusIcon element', () => {
      const { renderer } = createRenderer();
      const trail = document.createElement('div');

      expect(() => renderer.updateTrailStatusIcon(trail, true, false)).not.toThrow();
    });
  });

  // =========================================================================
  // updateTrailTime
  // =========================================================================

  describe('updateTrailTime()', () => {
    it('updates time display', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement();

      renderer.updateTrailTime(trail, '10s');

      const time = trail.querySelector('.trail-time');
      expect(time.textContent).toBe('10s');
    });

    it('updates title text when collapsed', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement(3);
      trail.dataset.state = 'collapsed';

      renderer.updateTrailTime(trail, '2m 5s');

      const titleText = trail.querySelector('.trail-title-text');
      expect(titleText.textContent).toBe('Trail 3 (2m 5s)');
    });

    it('does not update title text when not collapsed', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement(3);
      trail.dataset.state = 'partial';

      renderer.updateTrailTime(trail, '10s');

      const titleText = trail.querySelector('.trail-title-text');
      expect(titleText.textContent).toBe('Trail 3'); // unchanged
    });

    it('handles missing time display element', () => {
      const { renderer } = createRenderer();
      const trail = document.createElement('div');
      trail.dataset.state = 'partial';

      expect(() => renderer.updateTrailTime(trail, '5s')).not.toThrow();
    });

    it('handles missing title text in collapsed state', () => {
      const { renderer } = createRenderer();
      const trail = document.createElement('div');
      trail.dataset.state = 'collapsed';
      trail.dataset.trailNumber = '1';

      expect(() => renderer.updateTrailTime(trail, '5s')).not.toThrow();
    });
  });

  // =========================================================================
  // finalizeTrail
  // =========================================================================

  describe('finalizeTrail()', () => {
    it('sets end time, finalized, and collapsed state', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement();

      renderer.finalizeTrail(trail);

      expect(trail.dataset.endTime).toBe('1700000000000');
      expect(trail.dataset.finalized).toBe('true');
      expect(trail.dataset.state).toBe('collapsed');
    });

    it('updates chevron to rotate-90 (collapsed convention)', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement();

      renderer.finalizeTrail(trail);

      const chevron = trail.querySelector('.trail-chevron');
      expect(chevron.className).toBe('trail-chevron rotate-90');
    });

    it('updates title text with elapsed time', () => {
      const { renderer } = createRenderer();
      DateUtils.formatElapsedTime.mockReturnValue('1m 30s');
      const trail = buildTrailElement(2);

      renderer.finalizeTrail(trail);

      const titleText = trail.querySelector('.trail-title-text');
      expect(titleText.textContent).toBe('Trail 2 (1m 30s)');
    });

    it('updates status icon to OK', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement();

      renderer.finalizeTrail(trail);

      const icon = trail.querySelector('.trail-status-icon');
      expect(icon.innerHTML).toContain('OK');
    });

    it('handles missing chevron', () => {
      const { renderer } = createRenderer();
      const trail = document.createElement('div');
      trail.dataset.startTime = '1700000000000';
      trail.dataset.trailNumber = '1';

      expect(() => renderer.finalizeTrail(trail)).not.toThrow();
    });

    it('handles missing titleText', () => {
      const { renderer } = createRenderer();
      const trail = document.createElement('div');
      trail.dataset.startTime = '1700000000000';
      trail.dataset.trailNumber = '1';
      const chevron = document.createElement('div');
      chevron.className = 'trail-chevron';
      trail.appendChild(chevron);

      expect(() => renderer.finalizeTrail(trail)).not.toThrow();
    });

    it('handles missing statusIcon', () => {
      const { renderer } = createRenderer();
      const trail = document.createElement('div');
      trail.dataset.startTime = '1700000000000';
      trail.dataset.trailNumber = '1';
      const titleText = document.createElement('span');
      titleText.className = 'trail-title-text';
      trail.appendChild(titleText);

      expect(() => renderer.finalizeTrail(trail)).not.toThrow();
    });
  });

  // =========================================================================
  // toggleTrailState
  // =========================================================================

  describe('toggleTrailState()', () => {
    it('uses explicit targetState when provided', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement();
      trail.dataset.state = 'partial';

      const result = renderer.toggleTrailState(trail, 'collapsed');
      expect(result).toBe('collapsed');
      expect(trail.dataset.state).toBe('collapsed');
    });

    it('toggles collapsed → expanded (2-state cycle)', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement();
      trail.dataset.state = 'collapsed';

      const result = renderer.toggleTrailState(trail);
      expect(result).toBe('expanded');
    });

    it('toggles partial → collapsed (2-state cycle)', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement();
      trail.dataset.state = 'partial';

      const result = renderer.toggleTrailState(trail);
      expect(result).toBe('collapsed');
    });

    it('toggles expanded → collapsed (2-state cycle)', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement();
      trail.dataset.state = 'expanded';

      const result = renderer.toggleTrailState(trail);
      expect(result).toBe('collapsed');
    });

    it('defaults to collapsed for unknown state (2-state cycle)', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement();
      trail.dataset.state = 'unknown';

      const result = renderer.toggleTrailState(trail);
      expect(result).toBe('collapsed');
    });

    it('updates chevron to rotate-90 for collapsed (> right convention)', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement();

      renderer.toggleTrailState(trail, 'collapsed');

      const chevron = trail.querySelector('.trail-chevron');
      expect(chevron.className).toBe('trail-chevron rotate-90');
    });

    it('updates chevron to rotate-0 for partial (V down convention)', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement();

      renderer.toggleTrailState(trail, 'partial');

      const chevron = trail.querySelector('.trail-chevron');
      expect(chevron.className).toBe('trail-chevron rotate-0');
    });

    it('updates chevron to rotate-0 for expanded (V down convention)', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement();

      renderer.toggleTrailState(trail, 'expanded');

      const chevron = trail.querySelector('.trail-chevron');
      expect(chevron.className).toBe('trail-chevron rotate-0');
    });

    it('updates title text with elapsed for collapsed state', () => {
      const { renderer } = createRenderer();
      DateUtils.formatElapsedTime.mockReturnValue('3m');
      const trail = buildTrailElement(2);

      renderer.toggleTrailState(trail, 'collapsed');

      const titleText = trail.querySelector('.trail-title-text');
      expect(titleText.textContent).toBe('Trail 2 (3m)');
    });

    it('resets title text for partial state', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement(2);
      trail.querySelector('.trail-title-text').textContent = 'Trail 2 (5s)';

      renderer.toggleTrailState(trail, 'partial');

      expect(trail.querySelector('.trail-title-text').textContent).toBe('Trail 2');
    });

    it('resets title text for expanded state', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement(2);

      renderer.toggleTrailState(trail, 'expanded');

      expect(trail.querySelector('.trail-title-text').textContent).toBe('Trail 2');
    });

    it('adds then removes animating class', () => {
      jest.useFakeTimers();
      const { renderer } = createRenderer();
      const trail = buildTrailElement();

      renderer.toggleTrailState(trail, 'collapsed');

      expect(trail.classList.contains('animating')).toBe(true);

      jest.advanceTimersByTime(500);

      expect(trail.classList.contains('animating')).toBe(false);
      jest.useRealTimers();
    });

    it('handles missing chevron', () => {
      const { renderer } = createRenderer();
      const trail = document.createElement('div');
      trail.dataset.state = 'partial';
      trail.dataset.trailNumber = '1';
      trail.dataset.startTime = '1700000000000';
      trail.classList = '';

      expect(() => renderer.toggleTrailState(trail, 'collapsed')).not.toThrow();
    });

    it('handles missing titleText', () => {
      const { renderer } = createRenderer();
      const trail = document.createElement('div');
      trail.dataset.state = 'partial';
      trail.dataset.trailNumber = '1';
      trail.dataset.startTime = '1700000000000';
      const chevron = document.createElement('div');
      chevron.className = 'trail-chevron';
      trail.appendChild(chevron);

      expect(() => renderer.toggleTrailState(trail, 'collapsed')).not.toThrow();
    });

    it('uses endTime from dataset when available for collapsed elapsed calc', () => {
      const { renderer } = createRenderer();
      const trail = buildTrailElement();
      trail.dataset.endTime = '1700000005000';

      renderer.toggleTrailState(trail, 'collapsed');

      expect(DateUtils.formatElapsedTime).toHaveBeenCalledWith(
        1700000000000,
        1700000005000,
      );
    });

    it('uses getTimestamp fallback when dataset.endTime is absent for collapsed', () => {
      const { renderer } = createRenderer();
      DateUtils.getTimestamp.mockReturnValue(1700000099000);
      const trail = buildTrailElement();
      // No endTime set — _formatElapsed receives null → DateUtils.getTimestamp()

      renderer.toggleTrailState(trail, 'collapsed');

      // null endTime → _formatElapsed normalizes via DateUtils.getTimestamp()
      expect(DateUtils.formatElapsedTime).toHaveBeenCalledWith(
        1700000000000,
        1700000099000,
      );
    });

    it('handles missing chevron and titleText for partial state', () => {
      const { renderer } = createRenderer();
      const trail = document.createElement('div');
      trail.dataset.state = 'expanded';
      trail.dataset.trailNumber = '1';
      trail.dataset.startTime = '1700000000000';

      const result = renderer.toggleTrailState(trail, 'partial');
      expect(result).toBe('partial');
    });

    it('handles missing chevron and titleText for expanded state', () => {
      const { renderer } = createRenderer();
      const trail = document.createElement('div');
      trail.dataset.state = 'partial';
      trail.dataset.trailNumber = '1';
      trail.dataset.startTime = '1700000000000';

      const result = renderer.toggleTrailState(trail, 'expanded');
      expect(result).toBe('expanded');
    });
  });

  // =========================================================================
  // animateNodeAddition
  // =========================================================================

  describe('animateNodeAddition()', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    it('sets initial opacity and transform, then animates', () => {
      const { renderer } = createRenderer();
      const node = document.createElement('div');
      let rafCalls = 0;
      const origRaf = global.requestAnimationFrame;
      global.requestAnimationFrame = (cb) => { rafCalls++; cb(); };

      renderer.animateNodeAddition(node);

      expect(rafCalls).toBe(2); // outer + inner
      expect(node.style.opacity).toBe('1');
      expect(node.style.transform).toBe('translateY(0)');
      expect(node.style.transition).toContain('opacity');
      global.requestAnimationFrame = origRaf;
    });

    it('clears residual inline styles after transition completes', () => {
      const { renderer } = createRenderer();
      const node = document.createElement('div');
      const origRaf = global.requestAnimationFrame;
      global.requestAnimationFrame = (cb) => cb();

      renderer.animateNodeAddition(node);

      // Before cleanup: inline styles present
      expect(node.style.opacity).toBe('1');
      expect(node.style.transform).toBe('translateY(0)');

      // After cleanup timer fires: inline styles removed so CSS classes take effect
      jest.advanceTimersByTime(400);
      expect(node.style.opacity).toBe('');
      expect(node.style.transform).toBe('');
      expect(node.style.transition).toBe('');

      global.requestAnimationFrame = origRaf;
    });
  });

  // =========================================================================
  // _getStatusClass
  // =========================================================================

  describe('_getStatusClass()', () => {
    it('returns correct class for each status', () => {
      const { renderer } = createRenderer();

      expect(renderer._getStatusClass('completed')).toBe('completed');
      expect(renderer._getStatusClass('error')).toBe('error');
      expect(renderer._getStatusClass('active')).toBe('active');
      expect(renderer._getStatusClass('pending')).toBe('pending');
    });

    it('returns pending for unknown status', () => {
      const { renderer } = createRenderer();
      expect(renderer._getStatusClass('unknown')).toBe('pending');
      expect(renderer._getStatusClass(undefined)).toBe('pending');
    });
  });

  // =========================================================================
  // _getLabelForKind
  // =========================================================================

  describe('_getLabelForKind()', () => {
    it('returns correct labels for known kinds', () => {
      const { renderer } = createRenderer();

      expect(renderer._getLabelForKind('write')).toBe('Writing Code');
      expect(renderer._getLabelForKind('process')).toBe('Processing');
      expect(renderer._getLabelForKind('execute')).toBe('Executing');
      expect(renderer._getLabelForKind('output')).toBe('Output');
    });

    it('returns kind itself for unknown kind', () => {
      const { renderer } = createRenderer();
      expect(renderer._getLabelForKind('custom')).toBe('custom');
    });

    it('returns Phase when kind is undefined/null', () => {
      const { renderer } = createRenderer();
      expect(renderer._getLabelForKind(undefined)).toBe('Phase');
      expect(renderer._getLabelForKind(null)).toBe('Phase');
    });
  });

  // =========================================================================
  // _formatElapsed
  // =========================================================================

  describe('_formatElapsed()', () => {
    it('returns 0s when startTime is falsy', () => {
      const { renderer } = createRenderer();
      expect(renderer._formatElapsed(0)).toBe('0s');
      expect(renderer._formatElapsed(null)).toBe('0s');
      expect(renderer._formatElapsed(undefined)).toBe('0s');
    });

    it('normalizes number startTime and endTime', () => {
      const { renderer } = createRenderer();
      DateUtils.formatElapsedTime.mockReturnValue('10s');

      const result = renderer._formatElapsed(1000, 11000);

      expect(result).toBe('10s');
      expect(DateUtils.formatElapsedTime).toHaveBeenCalledWith(1000, 11000);
    });

    it('parses string startTime and endTime', () => {
      const { renderer } = createRenderer();
      DateUtils.formatElapsedTime.mockReturnValue('3s');

      const result = renderer._formatElapsed('5000', '8000');

      expect(result).toBe('3s');
      expect(DateUtils.formatElapsedTime).toHaveBeenCalledWith(5000, 8000);
    });

    it('uses DateUtils.getTimestamp when endTime is null', () => {
      const { renderer } = createRenderer();
      DateUtils.getTimestamp.mockReturnValue(2000);
      DateUtils.formatElapsedTime.mockReturnValue('1s');

      const result = renderer._formatElapsed(1000, null);

      expect(result).toBe('1s');
      expect(DateUtils.formatElapsedTime).toHaveBeenCalledWith(1000, 2000);
    });

    it('uses DateUtils.getTimestamp when endTime is undefined', () => {
      const { renderer } = createRenderer();
      DateUtils.getTimestamp.mockReturnValue(3000);
      DateUtils.formatElapsedTime.mockReturnValue('2s');

      const result = renderer._formatElapsed(1000);

      expect(result).toBe('2s');
      expect(DateUtils.formatElapsedTime).toHaveBeenCalledWith(1000, 3000);
    });
  });

  // =========================================================================
  // _log
  // =========================================================================

  describe('_log()', () => {
    it('calls log.trace when enableLogging is true', () => {
      const { renderer, log } = createRenderer({ enableLogging: true });
      renderer._log('hello', 'world');
      expect(log.trace).toHaveBeenCalledWith('hello world');
    });

    it('does not call log.trace when enableLogging is false', () => {
      const { renderer, log } = createRenderer({ enableLogging: false });
      renderer._log('hello');
      expect(log.trace).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose()', () => {
    it('calls _log', () => {
      const { renderer, log } = createRenderer({ enableLogging: true });
      renderer.dispose();
      expect(log.trace).toHaveBeenCalledWith('Disposed');
    });
  });
});
