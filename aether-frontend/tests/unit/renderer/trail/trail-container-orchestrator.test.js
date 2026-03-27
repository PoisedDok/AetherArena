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

jest.mock('../../../../src/renderer/chat/modules/trail/TrailStateManager');
jest.mock('../../../../src/renderer/chat/modules/trail/TrailTimeManager');
jest.mock('../../../../src/renderer/chat/modules/trail/TrailDOMRenderer');
jest.mock('../../../../src/renderer/chat/modules/trail/TrailInteractionManager');

const TrailContainerOrchestrator = require('../../../../src/renderer/chat/modules/trail/TrailContainerOrchestrator');
const TrailStateManager = require('../../../../src/renderer/chat/modules/trail/TrailStateManager');
const TrailTimeManager = require('../../../../src/renderer/chat/modules/trail/TrailTimeManager');
const TrailDOMRenderer = require('../../../../src/renderer/chat/modules/trail/TrailDOMRenderer');
const TrailInteractionManager = require('../../../../src/renderer/chat/modules/trail/TrailInteractionManager');

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

/** Build a minimal trail element matching real TrailDOMRenderer output structure */
function buildTrailElement(trailNumber = 1) {
  const trail = document.createElement('div');
  trail.className = 'chat-entry artifact-execution-trail-container';
  trail.dataset.trailId = `trail_mock_${trailNumber}_${Date.now()}`;
  trail.dataset.startTime = String(Date.now());
  trail.dataset.state = 'partial';

  const contentWrapper = document.createElement('div');
  contentWrapper.className = 'trail-content-wrapper';

  const trailWrapper = document.createElement('div');
  trailWrapper.className = 'artifact-execution-trail-wrapper';

  const header = document.createElement('div');
  header.className = 'trail-header';

  // Real structure: .trail-title contains .trail-status-icon + span.trail-title-text
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
  trailWrapper.appendChild(header);
  trailWrapper.appendChild(innerContent);
  contentWrapper.appendChild(trailWrapper);
  trail.appendChild(contentWrapper);

  return trail;
}

/** Build a minimal node element matching real TrailDOMRenderer output structure */
function buildNodeElement(type = 'writing') {
  const node = document.createElement('div');
  node.className = 'execution-node';
  node.dataset.phaseKind = type;

  const nodeHeader = document.createElement('div');
  nodeHeader.className = 'node-header';

  const nodeTitle = document.createElement('div');
  nodeTitle.className = 'node-title';

  const nodeTime = document.createElement('span');
  nodeTime.className = 'node-time';
  nodeTime.textContent = '0s';

  nodeHeader.appendChild(nodeTitle);
  nodeHeader.appendChild(nodeTime);
  node.appendChild(nodeHeader);

  return node;
}

/** Create a pre-existing chat entry element with a data-sequence */
function createChatEntry(sequence) {
  const el = document.createElement('div');
  el.className = 'chat-entry';
  el.dataset.sequence = String(sequence);
  return el;
}

/**
 * Set up module mocks and create an orchestrator instance.
 * Must be called inside test/beforeEach because resetMocks clears implementations.
 */
function createOrchestrator(containerEl) {
  const log = createLogger();
  const eventBus = { emit: jest.fn(), on: jest.fn(), off: jest.fn() };

  const mockStateManager = {
    groups: new Map(),
    createGroup: jest.fn(),
    createSubgroup: jest.fn().mockReturnValue({ nodes: [] }),
    updateNodeStatus: jest.fn(),
    linkArtifact: jest.fn(),
    dispose: jest.fn(),
  };

  const mockTimeManager = {
    startTrail: jest.fn(),
    startNode: jest.fn(),
    completeNode: jest.fn(),
    completeTrail: jest.fn(),
    destroy: jest.fn(),
    trailTimes: new Map(),
  };

  const mockRenderer = {
    createTrailContainer: jest.fn().mockImplementation((n) => buildTrailElement(n)),
    createTrailNode: jest.fn().mockImplementation((type) => buildNodeElement(type)),
    toggleTrailState: jest.fn(),
    dispose: jest.fn(),
  };

  const mockInteractionManager = {
    attachHeaderClickHandler: jest.fn(),
    attachNodeClickHandler: jest.fn(),
    destroy: jest.fn(),
  };

  TrailStateManager.mockImplementation(() => mockStateManager);
  TrailTimeManager.mockImplementation(() => mockTimeManager);
  TrailDOMRenderer.mockImplementation(() => mockRenderer);
  TrailInteractionManager.mockImplementation(() => mockInteractionManager);

  const orch = new TrailContainerOrchestrator({
    container: containerEl,
    eventBus,
    enableLogging: true,
  });
  orch.log = log;

  return {
    orch,
    log,
    eventBus,
    stateManager: mockStateManager,
    timeManager: mockTimeManager,
    renderer: mockRenderer,
    interactionManager: mockInteractionManager,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('TrailContainerOrchestrator', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'chat-container';
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // =========================================================================
  // CONSTRUCTOR
  // =========================================================================

  describe('constructor', () => {
    it('creates instance with required options', () => {
      const { orch } = createOrchestrator(container);
      expect(orch.container).toBe(container);
      expect(orch.eventBus).toBeTruthy();
      expect(orch.stateManager).toBeDefined();
      expect(orch.timeManager).toBeDefined();
      expect(orch.renderer).toBeDefined();
      expect(orch.interactionManager).toBeDefined();
    });

    it('throws without container', () => {
      TrailStateManager.mockImplementation(() => ({}));
      TrailTimeManager.mockImplementation(() => ({}));
      TrailDOMRenderer.mockImplementation(() => ({}));
      TrailInteractionManager.mockImplementation(() => ({}));

      expect(() => new TrailContainerOrchestrator({ eventBus: {} }))
        .toThrow('[TrailContainerOrchestrator] container is REQUIRED');
    });

    it('throws when called with no arguments (options defaults to {})', () => {
      TrailStateManager.mockImplementation(() => ({}));
      TrailTimeManager.mockImplementation(() => ({}));
      TrailDOMRenderer.mockImplementation(() => ({}));
      TrailInteractionManager.mockImplementation(() => ({}));

      expect(() => new TrailContainerOrchestrator())
        .toThrow('[TrailContainerOrchestrator] container is REQUIRED');
    });

    it('throws without eventBus', () => {
      TrailStateManager.mockImplementation(() => ({}));
      TrailTimeManager.mockImplementation(() => ({}));
      TrailDOMRenderer.mockImplementation(() => ({}));
      TrailInteractionManager.mockImplementation(() => ({}));

      expect(() => new TrailContainerOrchestrator({ container: document.createElement('div') }))
        .toThrow('[TrailContainerOrchestrator] eventBus is REQUIRED');
    });

    it('passes enableLogging to all sub-modules', () => {
      createOrchestrator(container);

      expect(TrailStateManager).toHaveBeenCalledWith(expect.objectContaining({ enableLogging: true }));
      expect(TrailTimeManager).toHaveBeenCalledWith(expect.objectContaining({ enableLogging: true }));
      expect(TrailDOMRenderer).toHaveBeenCalledWith(expect.objectContaining({ enableLogging: true }));
      expect(TrailInteractionManager).toHaveBeenCalledWith(expect.objectContaining({ enableLogging: true }));
    });

    it('passes container to TimeManager', () => {
      createOrchestrator(container);
      expect(TrailTimeManager).toHaveBeenCalledWith(expect.objectContaining({ container }));
    });

    it('passes eventBus and renderer to InteractionManager', () => {
      const { eventBus, renderer } = createOrchestrator(container);
      expect(TrailInteractionManager).toHaveBeenCalledWith(expect.objectContaining({
        eventBus,
        renderer,
      }));
    });

    it('defaults enableLogging to false', () => {
      TrailStateManager.mockImplementation(() => ({}));
      TrailTimeManager.mockImplementation(() => ({ trailTimes: new Map() }));
      TrailDOMRenderer.mockImplementation(() => ({}));
      TrailInteractionManager.mockImplementation(() => ({}));

      const orch = new TrailContainerOrchestrator({ container, eventBus: {} });
      expect(orch.enableLogging).toBe(false);
    });
  });

  // =========================================================================
  // handleGroupCreated
  // =========================================================================

  describe('handleGroupCreated()', () => {
    it('delegates to stateManager.createGroup', () => {
      const { orch, stateManager } = createOrchestrator(container);
      const payload = { group_id: 'grp-12345678', sequence_number: 1 };

      orch.handleGroupCreated(payload);

      expect(stateManager.createGroup).toHaveBeenCalledWith(payload);
    });

    it('logs with truncated group_id and sequence number', () => {
      const { orch, log } = createOrchestrator(container);

      orch.handleGroupCreated({ group_id: 'grp-12345678-long-extra', sequence_number: 3 });

      expect(log.debug).toHaveBeenCalledWith('Handled group_created', {
        groupId: 'grp-1234',
        sequenceNumber: 3,
      });
    });
  });

  // =========================================================================
  // handleSubgroupCreated
  // =========================================================================

  describe('handleSubgroupCreated()', () => {
    const basePayload = {
      subgroup_id: 'sub-12345678-abcdef',
      group_id: 'grp-12345678-abcdef',
      chat_id: 'chat-001',
      backend_id: 'backend-001',
      sequence_in_chat: 5,
      subgroup_sequence_number: 2,
      nodes: [],
    };

    function makePayload(overrides = {}) {
      return { ...basePayload, ...overrides };
    }

    // ---------------------------------------------------------------
    // Core flow
    // ---------------------------------------------------------------

    it('creates state, renders trail, inserts into DOM for a live subgroup', () => {
      const { orch, stateManager, renderer, timeManager, interactionManager } = createOrchestrator(container);

      container.appendChild(createChatEntry(3));

      stateManager.createSubgroup.mockReturnValue({
        nodes: [
          { id: 'n1', type: 'writing', status: 'pending', clickable: false },
          { id: 'n2', type: 'executing', status: 'pending', clickable: false },
          { id: 'n3', type: 'output', status: 'pending', clickable: false },
        ],
      });

      orch.handleSubgroupCreated(makePayload());

      expect(stateManager.createSubgroup).toHaveBeenCalledWith(expect.objectContaining({
        subgroup_id: basePayload.subgroup_id,
      }));
      expect(renderer.createTrailContainer).toHaveBeenCalledWith(2);
      expect(renderer.createTrailNode).toHaveBeenCalledTimes(3);
      expect(interactionManager.attachHeaderClickHandler).toHaveBeenCalled();
      expect(timeManager.startTrail).toHaveBeenCalled();
    });

    it('prevents duplicate subgroup rendering (idempotent check)', () => {
      const { orch, stateManager, renderer, log } = createOrchestrator(container);

      const existing = document.createElement('div');
      existing.dataset.subgroupId = basePayload.subgroup_id;
      container.appendChild(existing);

      orch.handleSubgroupCreated(makePayload());

      expect(stateManager.createSubgroup).not.toHaveBeenCalled();
      expect(renderer.createTrailContainer).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('DUPLICATE PREVENTED'),
      );
    });

    it('sets all dataset attributes on trail element', () => {
      const { orch, stateManager } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload());

      const trail = container.querySelector('[data-subgroup-id]');
      expect(trail.dataset.groupId).toBe(basePayload.group_id);
      expect(trail.dataset.subgroupId).toBe(basePayload.subgroup_id);
      expect(trail.dataset.chatId).toBe(basePayload.chat_id);
      expect(trail.dataset.backendId).toBe(basePayload.backend_id);
      expect(trail.dataset.sequence).toBe('5');
    });

    it('sets node dataset attributes (nodeId, nodeType, subgroupId)', () => {
      const { orch, stateManager } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));
      stateManager.createSubgroup.mockReturnValue({
        nodes: [{ id: 'n1', type: 'writing', status: 'pending', clickable: false }],
      });

      orch.handleSubgroupCreated(makePayload());

      const nodeEl = container.querySelector('[data-node-id="n1"]');
      expect(nodeEl).toBeTruthy();
      expect(nodeEl.dataset.nodeType).toBe('writing');
      expect(nodeEl.dataset.subgroupId).toBe(basePayload.subgroup_id);
    });

    // ---------------------------------------------------------------
    // Trail number fallback chain
    // ---------------------------------------------------------------

    it('uses subgroup_sequence_number first for trailNumber', () => {
      const { orch, stateManager, renderer } = createOrchestrator(container);
      container.appendChild(createChatEntry(1));
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({
        subgroup_sequence_number: 4,
        subgroup_sequence: 7,
        sequence_number: 9,
        sequence_in_chat: 2,
      }));

      expect(renderer.createTrailContainer).toHaveBeenCalledWith(4);
    });

    it('falls back to subgroup_sequence', () => {
      const { orch, stateManager, renderer } = createOrchestrator(container);
      container.appendChild(createChatEntry(1));
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({
        subgroup_sequence_number: undefined,
        subgroup_sequence: 7,
        sequence_number: 9,
        sequence_in_chat: 2,
      }));

      expect(renderer.createTrailContainer).toHaveBeenCalledWith(7);
    });

    it('falls back to sequence_number', () => {
      const { orch, stateManager, renderer } = createOrchestrator(container);
      container.appendChild(createChatEntry(1));
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({
        subgroup_sequence_number: undefined,
        subgroup_sequence: undefined,
        sequence_number: 9,
        sequence_in_chat: 2,
      }));

      expect(renderer.createTrailContainer).toHaveBeenCalledWith(9);
    });

    it('falls back to 1 when all sequence fields missing', () => {
      const { orch, stateManager, renderer } = createOrchestrator(container);
      container.appendChild(createChatEntry(1));
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({
        subgroup_sequence_number: undefined,
        subgroup_sequence: undefined,
        sequence_number: undefined,
        sequence_in_chat: 2,
      }));

      expect(renderer.createTrailContainer).toHaveBeenCalledWith(1);
    });

    // ---------------------------------------------------------------
    // Restored trails
    // ---------------------------------------------------------------

    it('marks restored trail as collapsed with restored flag', () => {
      const { orch, stateManager } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({
        _restored: true,
        _timelineSequence: 5,
      }));

      const trail = container.querySelector('[data-subgroup-id]');
      expect(trail.dataset.state).toBe('collapsed');
      expect(trail.dataset.restored).toBe('true');
    });

    it('uses _timelineSequence for restored trails instead of sequence_in_chat', () => {
      const { orch, stateManager } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({
        _restored: true,
        _timelineSequence: 10,
        sequence_in_chat: 5,
      }));

      const trail = container.querySelector('[data-subgroup-id]');
      expect(trail.dataset.sequence).toBe('10');
    });

    it('displays historical duration on restored nodes with duration_ms', () => {
      const { orch, stateManager } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));
      stateManager.createSubgroup.mockReturnValue({
        nodes: [
          { id: 'n1', type: 'writing', status: 'completed', clickable: false, duration_ms: 5500 },
        ],
      });

      orch.handleSubgroupCreated(makePayload({
        _restored: true,
        _timelineSequence: 5,
      }));

      const nodeEl = container.querySelector('[data-node-id="n1"]');
      const nodeTime = nodeEl.querySelector('.node-time');
      expect(nodeTime.textContent).toBe('5s');
    });

    it('does not set duration on restored nodes without duration_ms', () => {
      const { orch, stateManager } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));
      stateManager.createSubgroup.mockReturnValue({
        nodes: [
          { id: 'n1', type: 'writing', status: 'completed', clickable: false },
        ],
      });

      orch.handleSubgroupCreated(makePayload({
        _restored: true,
        _timelineSequence: 5,
      }));

      const nodeEl = container.querySelector('[data-node-id="n1"]');
      const nodeTime = nodeEl.querySelector('.node-time');
      expect(nodeTime.textContent).toBe('0s');
    });

    it('handles restored node when .node-time element is missing', () => {
      const { orch, stateManager, renderer } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));

      renderer.createTrailNode.mockImplementation(() => {
        const node = document.createElement('div');
        node.className = 'execution-node';
        // No .node-time child
        return node;
      });

      stateManager.createSubgroup.mockReturnValue({
        nodes: [
          { id: 'n1', type: 'writing', status: 'completed', clickable: false, duration_ms: 5000 },
        ],
      });

      // Should not throw
      expect(() => orch.handleSubgroupCreated(makePayload({
        _restored: true,
        _timelineSequence: 5,
      }))).not.toThrow();
    });

    // ---------------------------------------------------------------
    // DOM Positioning
    // ---------------------------------------------------------------

    it('inserts trail after element with lower sequence', () => {
      const { orch, stateManager } = createOrchestrator(container);

      const entry3 = createChatEntry(3);
      const entry7 = createChatEntry(7);
      container.appendChild(entry3);
      container.appendChild(entry7);

      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({ sequence_in_chat: 5 }));

      const children = Array.from(container.children);
      const trailIdx = children.findIndex(c => c.dataset.subgroupId === basePayload.subgroup_id);
      expect(trailIdx).toBe(1); // after entry3, before entry7
    });

    it('inserts trail at the end when no lower sequence exists instead of throwing', () => {
      const { orch, stateManager } = createOrchestrator(container);

      container.appendChild(createChatEntry(10));

      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({ sequence_in_chat: 5 }));

      // Trail was inserted at the end
      const children = Array.from(container.children);
      expect(children[children.length - 1].dataset.subgroupId).toBe(basePayload.subgroup_id);
    });

    it('inserts trail via appendChild when container is empty instead of throwing', () => {
      const { orch, stateManager } = createOrchestrator(container);
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({ sequence_in_chat: 5 }));

      expect(container.children.length).toBe(1);
      expect(container.children[0].dataset.subgroupId).toBe(basePayload.subgroup_id);
    });

    it('falls back to appendChild when timelineSequence is undefined (no sequence_in_chat for live trail)', () => {
      const { orch, stateManager } = createOrchestrator(container);
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({
        sequence_in_chat: undefined,
        _restored: false,
      }));
      
      expect(container.children.length).toBe(1);
    });

    it('falls back to appendChild when timelineSequence is undefined (no _timelineSequence for restored trail)', () => {
      const { orch, stateManager } = createOrchestrator(container);
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({
        sequence_in_chat: undefined,
        _restored: true,
        _timelineSequence: undefined,
      }));
      
      expect(container.children.length).toBe(1);
    });

    it('filters out entries with NaN or non-positive sequences', () => {
      const { orch, stateManager } = createOrchestrator(container);

      container.appendChild(createChatEntry('abc')); // NaN
      container.appendChild(createChatEntry(0));      // non-positive
      container.appendChild(createChatEntry(-1));     // non-positive
      container.appendChild(createChatEntry(3));      // valid

      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({ sequence_in_chat: 5 }));

      // Trail inserted after entry3 (the only valid sequenced entry with seq < 5)
      const children = Array.from(container.children);
      const trailIdx = children.findIndex(c => c.dataset.subgroupId === basePayload.subgroup_id);
      expect(trailIdx).toBe(4);
    });

    // ---------------------------------------------------------------
    // Time tracking
    // ---------------------------------------------------------------

    it('starts timer for live trail', () => {
      const { orch, stateManager, timeManager } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({ _restored: false }));

      expect(timeManager.startTrail).toHaveBeenCalled();
      const [trailId, startTime] = timeManager.startTrail.mock.calls[0];
      expect(typeof trailId).toBe('string');
      expect(typeof startTime).toBe('number');
    });

    it('does not start timer for restored trail', () => {
      const { orch, stateManager, timeManager } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({
        _restored: true,
        _timelineSequence: 5,
        _duration_ms: 5000,
      }));

      expect(timeManager.startTrail).not.toHaveBeenCalled();
    });

    it('shows minutes+seconds in title for restored trail with duration >= 60s', () => {
      const { orch, stateManager } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({
        _restored: true,
        _timelineSequence: 5,
        _duration_ms: 125000, // 2m 5s
      }));

      const trail = container.querySelector('[data-subgroup-id]');
      const titleText = trail.querySelector('.trail-title-text');
      expect(titleText.textContent).toBe('Trail 2 (2m 5s)');
    });

    it('shows seconds only in title for restored trail with duration < 60s', () => {
      const { orch, stateManager } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({
        _restored: true,
        _timelineSequence: 5,
        _duration_ms: 45000,
      }));

      const trail = container.querySelector('[data-subgroup-id]');
      const titleText = trail.querySelector('.trail-title-text');
      expect(titleText.textContent).toBe('Trail 2 (45s)');
    });

    it('shows m 0s for exact minute durations', () => {
      const { orch, stateManager } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({
        _restored: true,
        _timelineSequence: 5,
        _duration_ms: 120000,
      }));

      const trail = container.querySelector('[data-subgroup-id]');
      const titleText = trail.querySelector('.trail-title-text');
      expect(titleText.textContent).toBe('Trail 2 (2m 0s)');
    });

    it('sets time text and endTime dataset for restored trail with duration', () => {
      const { orch, stateManager } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({
        _restored: true,
        _timelineSequence: 5,
        _duration_ms: 5000,
      }));

      const trail = container.querySelector('[data-subgroup-id]');
      // Time text set for when user expands the trail (no inline style.display='none')
      expect(trail.querySelector('.trail-time').textContent).toBe('5s');
      // endTime dataset set for correct re-collapse elapsed calculation
      const startTime = parseInt(trail.dataset.startTime, 10);
      expect(trail.dataset.endTime).toBe((startTime + 5000).toString());
      expect(trail.querySelector('.trail-status-icon').innerHTML).toContain('OK');
    });

    it('shows em-dash in time display for restored trail WITHOUT duration (undefined)', () => {
      const { orch, stateManager, timeManager } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({
        _restored: true,
        _timelineSequence: 5,
        _duration_ms: undefined,
      }));

      const trail = container.querySelector('[data-subgroup-id]');
      expect(trail.querySelector('.trail-time').textContent).toBe('\u2014');
      expect(timeManager.startTrail).not.toHaveBeenCalled();
    });

    it('shows em-dash in time display for restored trail WITHOUT duration (null)', () => {
      const { orch, stateManager } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload({
        _restored: true,
        _timelineSequence: 5,
        _duration_ms: null,
      }));

      const trail = container.querySelector('[data-subgroup-id]');
      expect(trail.querySelector('.trail-time').textContent).toBe('\u2014');
    });

    // ---------------------------------------------------------------
    // Edge: trail element missing specific child elements
    // ---------------------------------------------------------------

    it('handles trail element without .trail-title (restored with duration)', () => {
      const { orch, stateManager, renderer } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));

      renderer.createTrailContainer.mockImplementation(() => {
        const trail = document.createElement('div');
        trail.className = 'chat-entry artifact-execution-trail-container';
        trail.dataset.trailId = 'trail_no_title';
        trail.dataset.startTime = String(Date.now());
        // timeline present, no header/title/time/statusIcon
        const timeline = document.createElement('div');
        timeline.className = 'trail-timeline';
        trail.appendChild(timeline);
        return trail;
      });

      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      expect(() => orch.handleSubgroupCreated(makePayload({
        _restored: true,
        _timelineSequence: 5,
        _duration_ms: 5000,
      }))).not.toThrow();
    });

    it('handles trail element without .trail-time (restored without duration)', () => {
      const { orch, stateManager, renderer } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));

      renderer.createTrailContainer.mockImplementation(() => {
        const trail = document.createElement('div');
        trail.className = 'chat-entry artifact-execution-trail-container';
        trail.dataset.trailId = 'trail_no_time';
        trail.dataset.startTime = String(Date.now());
        const timeline = document.createElement('div');
        timeline.className = 'trail-timeline';
        trail.appendChild(timeline);
        return trail;
      });

      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      expect(() => orch.handleSubgroupCreated(makePayload({
        _restored: true,
        _timelineSequence: 5,
        _duration_ms: undefined,
      }))).not.toThrow();
    });

    it('handles trail element without .trail-status-icon (restored with duration)', () => {
      const { orch, stateManager, renderer } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));

      renderer.createTrailContainer.mockImplementation(() => {
        const trail = document.createElement('div');
        trail.className = 'chat-entry artifact-execution-trail-container';
        trail.dataset.trailId = 'trail_no_icon';
        trail.dataset.startTime = String(Date.now());
        const title = document.createElement('div');
        title.className = 'trail-title';
        const time = document.createElement('div');
        time.className = 'trail-time';
        const timeline = document.createElement('div');
        timeline.className = 'trail-timeline';
        trail.appendChild(title);
        trail.appendChild(time);
        trail.appendChild(timeline);
        return trail;
      });

      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      expect(() => orch.handleSubgroupCreated(makePayload({
        _restored: true,
        _timelineSequence: 5,
        _duration_ms: 5000,
      }))).not.toThrow();
    });

    it('logs debug and warn messages throughout the flow', () => {
      const { orch, stateManager, log } = createOrchestrator(container);
      container.appendChild(createChatEntry(3));
      stateManager.createSubgroup.mockReturnValue({ nodes: [] });

      orch.handleSubgroupCreated(makePayload());

      // Multiple log.warn calls for debug tracing
      expect(log.warn.mock.calls.length).toBeGreaterThanOrEqual(3);
      // Final debug log
      expect(log.debug).toHaveBeenCalledWith('Handled subgroup_created', expect.objectContaining({
        subgroupId: basePayload.subgroup_id.substring(0, 8),
        groupId: basePayload.group_id.substring(0, 8),
        trailNumber: 2,
      }));
    });
  });

  // =========================================================================
  // handleNodeStatusUpdated
  // =========================================================================

  describe('handleNodeStatusUpdated()', () => {
    function insertNode(cont, subgroupId, nodeId, nodeType = 'writing') {
      const el = document.createElement('div');
      el.className = 'execution-node';
      el.dataset.subgroupId = subgroupId;
      el.dataset.nodeId = nodeId;
      el.dataset.nodeType = nodeType;
      el.classList.add('pending');
      cont.appendChild(el);
      return el;
    }

    const baseNodePayload = {
      node_id: 'n1',
      status: 'active',
      subgroup_id: 'sub-1',
      group_id: 'grp-12345678',
      chat_id: 'chat-1',
    };

    it('updates node class from pending to active and starts time', () => {
      const { orch, stateManager, timeManager } = createOrchestrator(container);
      stateManager.updateNodeStatus.mockReturnValue({ id: 'n1' });
      insertNode(container, 'sub-1', 'n1');

      orch.handleNodeStatusUpdated(baseNodePayload);

      const nodeEl = container.querySelector('[data-node-id="n1"]');
      expect(nodeEl.classList.contains('active')).toBe(true);
      expect(nodeEl.classList.contains('pending')).toBe(false);
      expect(timeManager.startNode).toHaveBeenCalledWith('n1', 'sub-1');
    });

    it('updates node class to completed and completes time', () => {
      const { orch, stateManager, timeManager } = createOrchestrator(container);
      stateManager.updateNodeStatus.mockReturnValue({ id: 'n1' });
      const nodeEl = insertNode(container, 'sub-1', 'n1');
      nodeEl.classList.remove('pending');
      nodeEl.classList.add('active');

      orch.handleNodeStatusUpdated({ ...baseNodePayload, status: 'completed' });

      expect(nodeEl.classList.contains('completed')).toBe(true);
      expect(nodeEl.classList.contains('active')).toBe(false);
      expect(timeManager.completeNode).toHaveBeenCalledWith('n1', 'sub-1');
    });

    it('updates node to error status without time tracking', () => {
      const { orch, stateManager, timeManager } = createOrchestrator(container);
      stateManager.updateNodeStatus.mockReturnValue({ id: 'n1' });
      insertNode(container, 'sub-1', 'n1');

      orch.handleNodeStatusUpdated({ ...baseNodePayload, status: 'error' });

      const nodeEl = container.querySelector('[data-node-id="n1"]');
      expect(nodeEl.classList.contains('error')).toBe(true);
      expect(timeManager.startNode).not.toHaveBeenCalled();
      expect(timeManager.completeNode).not.toHaveBeenCalled();
    });

    it('updates node to pending status without time tracking', () => {
      const { orch, stateManager, timeManager } = createOrchestrator(container);
      stateManager.updateNodeStatus.mockReturnValue({ id: 'n1' });
      insertNode(container, 'sub-1', 'n1');

      orch.handleNodeStatusUpdated({ ...baseNodePayload, status: 'pending' });

      expect(timeManager.startNode).not.toHaveBeenCalled();
      expect(timeManager.completeNode).not.toHaveBeenCalled();
    });

    it('removes all previous status classes before adding new one', () => {
      const { orch, stateManager } = createOrchestrator(container);
      stateManager.updateNodeStatus.mockReturnValue({ id: 'n1' });
      const nodeEl = insertNode(container, 'sub-1', 'n1');
      nodeEl.classList.add('active', 'completed', 'error');

      orch.handleNodeStatusUpdated({ ...baseNodePayload, status: 'completed' });

      expect(nodeEl.classList.contains('pending')).toBe(false);
      expect(nodeEl.classList.contains('active')).toBe(false);
      expect(nodeEl.classList.contains('error')).toBe(false);
      expect(nodeEl.classList.contains('completed')).toBe(true);
    });

    it('handles missing node element gracefully', () => {
      const { orch, stateManager, timeManager } = createOrchestrator(container);
      stateManager.updateNodeStatus.mockReturnValue({ id: 'n1' });

      orch.handleNodeStatusUpdated(baseNodePayload);

      expect(timeManager.startNode).not.toHaveBeenCalled();
    });

    it('catches and logs errors from stateManager', () => {
      const { orch, stateManager, log } = createOrchestrator(container);
      stateManager.updateNodeStatus.mockImplementation(() => {
        throw new Error('state boom');
      });

      orch.handleNodeStatusUpdated(baseNodePayload);

      expect(log.error).toHaveBeenCalledWith(
        'Failed to handle node_status_updated',
        { error: 'state boom' },
      );
    });

    it('logs debug with truncated node_id and status', () => {
      const { orch, stateManager, log } = createOrchestrator(container);
      stateManager.updateNodeStatus.mockReturnValue({ id: 'n1' });
      insertNode(container, 'sub-1', 'n1');

      orch.handleNodeStatusUpdated(baseNodePayload);

      expect(log.debug).toHaveBeenCalledWith('Handled node_status_updated', {
        nodeId: 'n1'.substring(0, 8),
        status: 'active',
      });
    });
  });

  // =========================================================================
  // handleArtifactLinked
  // =========================================================================

  describe('handleArtifactLinked()', () => {
    function insertNode(cont, subgroupId, nodeId, nodeType = 'output') {
      const el = document.createElement('div');
      el.className = 'execution-node';
      el.dataset.subgroupId = subgroupId;
      el.dataset.nodeId = nodeId;
      el.dataset.nodeType = nodeType;
      cont.appendChild(el);
      return el;
    }

    const baseArtifactPayload = {
      artifact_id: 'art-12345678901234567890abcdefghijklmnop-extra',
      node_id: 'n1',
      subgroup_id: 'sub-1',
      group_id: 'grp-12345678',
      chat_id: 'chat-1',
    };

    it('sets artifactId dataset and attaches click handler', () => {
      const { orch, stateManager, interactionManager } = createOrchestrator(container);
      stateManager.linkArtifact.mockReturnValue({});
      insertNode(container, 'sub-1', 'n1', 'output');

      orch.handleArtifactLinked(baseArtifactPayload);

      const nodeEl = container.querySelector('[data-node-id="n1"]');
      expect(nodeEl.dataset.artifactId).toBe(baseArtifactPayload.artifact_id);
      expect(interactionManager.attachNodeClickHandler).toHaveBeenCalledWith(
        nodeEl,
        baseArtifactPayload.artifact_id,
        'n1',
        'sub-1',
        'output',
      );
    });

    it('delegates to stateManager.linkArtifact', () => {
      const { orch, stateManager } = createOrchestrator(container);
      stateManager.linkArtifact.mockReturnValue({});

      orch.handleArtifactLinked(baseArtifactPayload);

      expect(stateManager.linkArtifact).toHaveBeenCalledWith(baseArtifactPayload);
    });

    it('handles missing node element — does not attach click handler', () => {
      const { orch, stateManager, interactionManager } = createOrchestrator(container);
      stateManager.linkArtifact.mockReturnValue({});

      orch.handleArtifactLinked({ ...baseArtifactPayload, node_id: 'missing' });

      expect(interactionManager.attachNodeClickHandler).not.toHaveBeenCalled();
    });

    it('logs debug with truncated ids', () => {
      const { orch, stateManager, log } = createOrchestrator(container);
      stateManager.linkArtifact.mockReturnValue({});
      insertNode(container, 'sub-1', 'n1', 'output');

      orch.handleArtifactLinked(baseArtifactPayload);

      expect(log.debug).toHaveBeenCalledWith('Handled artifact_linked', {
        nodeId: 'n1'.substring(0, 8),
        artifactId: baseArtifactPayload.artifact_id.substring(0, 40),
      });
    });
  });

  // =========================================================================
  // handleSubgroupCompleted
  // =========================================================================

  describe('handleSubgroupCompleted()', () => {
    function insertTrail(cont, groupId, subgroupId, opts = {}) {
      const trail = document.createElement('div');
      trail.className = 'chat-entry';
      trail.dataset.groupId = groupId;
      trail.dataset.subgroupId = subgroupId;
      trail.dataset.trailId = opts.trailId || 'trail-1';
      trail.dataset.restored = opts.restored ? 'true' : 'false';

      const statusIcon = document.createElement('div');
      statusIcon.className = 'trail-status-icon';
      statusIcon.innerHTML = '<div class="trail-status-spinner"></div>';

      const node1 = document.createElement('div');
      node1.className = 'execution-node active';
      const node2 = document.createElement('div');
      node2.className = 'execution-node pending';

      trail.appendChild(statusIcon);
      trail.appendChild(node1);
      trail.appendChild(node2);
      cont.appendChild(trail);

      return { trail, statusIcon, nodes: [node1, node2] };
    }

    it('completes live trail: time, checkmark, nodes completed, collapse', () => {
      const { orch, timeManager, renderer } = createOrchestrator(container);
      const { trail, nodes } = insertTrail(container, 'grp-1', 'sub-1');
      timeManager.trailTimes.set('trail-1', { startTime: Date.now() });

      orch.handleSubgroupCompleted({ subgroup_id: 'sub-1', group_id: 'grp-1' });

      expect(timeManager.completeTrail).toHaveBeenCalledWith('trail-1');

      const statusIcon = trail.querySelector('.trail-status-icon');
      expect(statusIcon.innerHTML).toContain('OK');

      nodes.forEach(n => {
        expect(n.classList.contains('completed')).toBe(true);
        expect(n.classList.contains('active')).toBe(false);
        expect(n.classList.contains('pending')).toBe(false);
      });

      expect(renderer.toggleTrailState).toHaveBeenCalledWith(trail, 'collapsed');
    });

    it('skips time completion for restored trails', () => {
      const { orch, timeManager, renderer } = createOrchestrator(container);
      insertTrail(container, 'grp-1', 'sub-1', { restored: true });

      orch.handleSubgroupCompleted({ subgroup_id: 'sub-1', group_id: 'grp-1' });

      expect(timeManager.completeTrail).not.toHaveBeenCalled();
      expect(renderer.toggleTrailState).toHaveBeenCalled();
    });

    it('skips time completion when trailTimes does not have the trail', () => {
      const { orch, timeManager } = createOrchestrator(container);
      insertTrail(container, 'grp-1', 'sub-1');
      // NOT adding to timeManager.trailTimes

      orch.handleSubgroupCompleted({ subgroup_id: 'sub-1', group_id: 'grp-1' });

      expect(timeManager.completeTrail).not.toHaveBeenCalled();
    });

    it('returns early when trail element not found', () => {
      const { orch, timeManager, renderer, log } = createOrchestrator(container);

      orch.handleSubgroupCompleted({ subgroup_id: 'missing-12345678', group_id: 'grp-1' });

      expect(log.warn).toHaveBeenCalledWith(
        'Trail element not found for completion',
        { subgroupId: 'missing-' },
      );
      expect(timeManager.completeTrail).not.toHaveBeenCalled();
      expect(renderer.toggleTrailState).not.toHaveBeenCalled();
    });

    it('handles trail without .trail-status-icon', () => {
      const { orch } = createOrchestrator(container);

      const trail = document.createElement('div');
      trail.className = 'chat-entry';
      trail.dataset.groupId = 'grp-1';
      trail.dataset.subgroupId = 'sub-1';
      trail.dataset.trailId = 'trail-noicon';
      trail.dataset.restored = 'false';
      container.appendChild(trail);

      expect(() => orch.handleSubgroupCompleted({
        subgroup_id: 'sub-1',
        group_id: 'grp-1',
      })).not.toThrow();
    });

    it('removes error class from nodes during completion', () => {
      const { orch } = createOrchestrator(container);

      const trail = document.createElement('div');
      trail.className = 'chat-entry';
      trail.dataset.groupId = 'grp-1';
      trail.dataset.subgroupId = 'sub-1';
      trail.dataset.trailId = 'trail-err';
      trail.dataset.restored = 'false';

      const errNode = document.createElement('div');
      errNode.className = 'execution-node error';
      trail.appendChild(errNode);
      container.appendChild(trail);

      orch.handleSubgroupCompleted({ subgroup_id: 'sub-1', group_id: 'grp-1' });

      expect(errNode.classList.contains('error')).toBe(false);
      expect(errNode.classList.contains('completed')).toBe(true);
    });

    it('logs debug with truncated ids', () => {
      const { orch, log } = createOrchestrator(container);
      insertTrail(container, 'grp-12345678', 'sub-12345678');

      orch.handleSubgroupCompleted({ subgroup_id: 'sub-12345678', group_id: 'grp-12345678' });

      expect(log.debug).toHaveBeenCalledWith('Handled subgroup_completed', {
        subgroupId: 'sub-1234',
        groupId: 'grp-1234',
      });
    });
  });

  // =========================================================================
  // _formatDuration
  // =========================================================================

  describe('_formatDuration()', () => {
    let orch;

    beforeEach(() => {
      ({ orch } = createOrchestrator(container));
    });

    it('returns "0s" for 0', () => {
      expect(orch._formatDuration(0)).toBe('0s');
    });

    it('returns "0s" for negative values', () => {
      expect(orch._formatDuration(-5000)).toBe('0s');
    });

    it('returns "0s" for null', () => {
      expect(orch._formatDuration(null)).toBe('0s');
    });

    it('returns "0s" for undefined', () => {
      expect(orch._formatDuration(undefined)).toBe('0s');
    });

    it('returns "0s" for NaN', () => {
      expect(orch._formatDuration(NaN)).toBe('0s');
    });

    it('formats seconds only (< 60s)', () => {
      expect(orch._formatDuration(5000)).toBe('5s');
      expect(orch._formatDuration(59000)).toBe('59s');
    });

    it('formats minutes and seconds', () => {
      expect(orch._formatDuration(65000)).toBe('1m 5s');
      expect(orch._formatDuration(125000)).toBe('2m 5s');
    });

    it('formats exact minutes (no remaining seconds)', () => {
      expect(orch._formatDuration(60000)).toBe('1m');
      expect(orch._formatDuration(120000)).toBe('2m');
    });

    it('rounds down sub-second durations', () => {
      expect(orch._formatDuration(999)).toBe('0s');
      expect(orch._formatDuration(1500)).toBe('1s');
    });
  });

  // =========================================================================
  // destroy
  // =========================================================================

  describe('destroy()', () => {
    it('delegates to all sub-modules', () => {
      const { orch, timeManager, interactionManager, stateManager, renderer, log } = createOrchestrator(container);

      orch.destroy();

      expect(timeManager.destroy).toHaveBeenCalled();
      expect(interactionManager.destroy).toHaveBeenCalled();
      expect(stateManager.dispose).toHaveBeenCalled();
      expect(renderer.dispose).toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith('TrailContainerOrchestrator destroyed');
    });

    it('sets _isDisposed to true', () => {
      const { orch } = createOrchestrator(container);
      expect(orch._isDisposed).toBe(false);
      orch.destroy();
      expect(orch._isDisposed).toBe(true);
    });

    it('is idempotent — second call does not re-destroy sub-modules', () => {
      const { orch, timeManager, interactionManager } = createOrchestrator(container);
      orch.destroy();
      timeManager.destroy.mockClear();
      interactionManager.destroy.mockClear();

      orch.destroy();
      expect(timeManager.destroy).not.toHaveBeenCalled();
      expect(interactionManager.destroy).not.toHaveBeenCalled();
    });

    it('nulls all references', () => {
      const { orch } = createOrchestrator(container);
      orch.destroy();
      expect(orch.container).toBeNull();
      expect(orch.eventBus).toBeNull();
      expect(orch.stateManager).toBeNull();
      expect(orch.timeManager).toBeNull();
      expect(orch.renderer).toBeNull();
      expect(orch.interactionManager).toBeNull();
    });

    it('BUG REGRESSION: handler methods are no-ops after destroy', () => {
      const { orch, stateManager } = createOrchestrator(container);
      orch.destroy();

      // All handler methods should return early via _isDisposed guard
      orch.handleGroupCreated({ group_id: 'g1', sequence_number: 1 });
      orch.handleSubgroupCreated({ subgroup_id: 's1', group_id: 'g1', chat_id: 'c1' });
      orch.handleNodeStatusUpdated({ node_id: 'n1', status: 'active', subgroup_id: 's1' });
      orch.handleArtifactLinked({ artifact_id: 'a1', node_id: 'n1', subgroup_id: 's1' });
      orch.handleSubgroupCompleted({ subgroup_id: 's1', group_id: 'g1' });

      expect(stateManager.createGroup).not.toHaveBeenCalled();
    });
  });
});
