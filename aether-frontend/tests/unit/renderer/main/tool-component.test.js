'use strict';

// ---------------------------------------------------------------------------
// ToolComponent.js — Unit tests
// ---------------------------------------------------------------------------
// Source: src/renderer/main/modules/agents/components/tools/ToolComponent.js (212 lines)
// Abstract base class. Template Method pattern. DOM-based _escapeHtml.
// ---------------------------------------------------------------------------

const ToolComponent = require('../../../../src/renderer/main/modules/agents/components/tools/ToolComponent');

describe('ToolComponent', () => {
  let tool;
  let endpoint;
  let toolState;
  let logger;
  let agent;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-02-09T12:00:00Z'));

    endpoint = { someMethod: jest.fn() };
    toolState = {
      getToolJobs: jest.fn().mockReturnValue([]),
      getToolRunState: jest.fn().mockReturnValue(null),
    };
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    agent = { name: 'research_agent' };

    tool = new ToolComponent({ name: 'research', agent, endpoint, toolState, logger });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores name', () => {
      expect(tool.name).toBe('research');
    });

    it('stores agent reference', () => {
      expect(tool.agent).toBe(agent);
    });

    it('stores endpoint reference', () => {
      expect(tool.endpoint).toBe(endpoint);
    });

    it('stores toolState reference', () => {
      expect(tool.toolState).toBe(toolState);
    });

    it('stores logger', () => {
      expect(tool.logger).toBe(logger);
    });

    it('defaults logger to console when not provided', () => {
      const t = new ToolComponent({ name: 'x', endpoint, toolState });
      expect(t.logger).toBe(console);
    });

    it('throws when name is missing', () => {
      expect(() => new ToolComponent({ endpoint, toolState }))
        .toThrow('Tool name is required');
    });

    it('throws when endpoint is missing', () => {
      expect(() => new ToolComponent({ name: 'x', toolState }))
        .toThrow('Endpoint is required');
    });

    it('throws when toolState is missing', () => {
      expect(() => new ToolComponent({ name: 'x', endpoint }))
        .toThrow('ToolStateManager is required');
    });

    it('throws when no config is provided (default parameter)', () => {
      expect(() => new ToolComponent())
        .toThrow('Tool name is required');
    });
  });

  // =========================================================================
  // Abstract methods
  // =========================================================================

  describe('abstract methods', () => {
    it('render() throws with class name', () => {
      expect(() => tool.render()).toThrow('ToolComponent: render() must be implemented by subclass');
    });

    it('createDialog() throws with class name', () => {
      expect(() => tool.createDialog()).toThrow('ToolComponent: createDialog() must be implemented by subclass');
    });

    it('invoke() rejects with class name', async () => {
      await expect(tool.invoke({})).rejects.toThrow('ToolComponent: invoke() must be implemented by subclass');
    });

    it('getStatus() throws with class name', () => {
      expect(() => tool.getStatus()).toThrow('ToolComponent: getStatus() must be implemented by subclass');
    });

    it('abstract method errors include the actual subclass name', () => {
      class MyTool extends ToolComponent {
        // Does NOT override abstract methods
      }
      const myTool = new MyTool({ name: 'my', endpoint, toolState });
      expect(() => myTool.render()).toThrow('MyTool: render() must be implemented by subclass');
    });
  });

  // =========================================================================
  // getRecentJobs
  // =========================================================================

  describe('getRecentJobs', () => {
    it('delegates to toolState.getToolJobs with tool name', () => {
      const jobs = [{ id: 'j1' }];
      toolState.getToolJobs = jest.fn().mockReturnValue(jobs);
      expect(tool.getRecentJobs()).toBe(jobs);
      expect(toolState.getToolJobs).toHaveBeenCalledWith('research');
    });
  });

  // =========================================================================
  // getRunState
  // =========================================================================

  describe('getRunState', () => {
    it('delegates to toolState.getToolRunState with tool name', () => {
      const state = { status: 'running' };
      toolState.getToolRunState = jest.fn().mockReturnValue(state);
      expect(tool.getRunState()).toBe(state);
      expect(toolState.getToolRunState).toHaveBeenCalledWith('research');
    });
  });

  // =========================================================================
  // _formatAgentName
  // =========================================================================

  describe('_formatAgentName', () => {
    it('capitalizes first letter and replaces underscores with spaces', () => {
      expect(tool._formatAgentName('research_agent')).toBe('Research Agent');
    });

    it('handles single word', () => {
      expect(tool._formatAgentName('testing')).toBe('Testing');
    });

    it('handles already capitalized input', () => {
      expect(tool._formatAgentName('Research')).toBe('Research');
    });

    it('returns "Unknown" for empty string', () => {
      expect(tool._formatAgentName('')).toBe('Unknown');
    });

    it('returns "Unknown" for null', () => {
      expect(tool._formatAgentName(null)).toBe('Unknown');
    });

    it('returns "Unknown" for undefined', () => {
      expect(tool._formatAgentName(undefined)).toBe('Unknown');
    });

    it('handles multiple underscores', () => {
      expect(tool._formatAgentName('deep_research_agent_v2')).toBe('Deep Research Agent V2');
    });
  });

  // =========================================================================
  // _escapeHtml
  // =========================================================================

  describe('_escapeHtml', () => {
    it('escapes < and > characters', () => {
      const result = tool._escapeHtml('<script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
    });

    it('escapes & character', () => {
      const result = tool._escapeHtml('A & B');
      expect(result).toContain('&amp;');
    });

    it('passes through normal text unchanged', () => {
      expect(tool._escapeHtml('Hello World')).toBe('Hello World');
    });

    it('converts non-string values via String()', () => {
      expect(tool._escapeHtml(42)).toBe('42');
      expect(tool._escapeHtml(true)).toBe('true');
    });
  });

  // =========================================================================
  // _formatDuration
  // =========================================================================

  describe('_formatDuration', () => {
    it('formats sub-second as milliseconds', () => {
      expect(tool._formatDuration(500)).toBe('500ms');
    });

    it('formats sub-second boundary (999ms)', () => {
      expect(tool._formatDuration(999)).toBe('999ms');
    });

    it('formats seconds with one decimal', () => {
      expect(tool._formatDuration(1000)).toBe('1.0s');
    });

    it('formats 30.5 seconds', () => {
      expect(tool._formatDuration(30500)).toBe('30.5s');
    });

    it('formats under 60 seconds', () => {
      expect(tool._formatDuration(59999)).toBe('60.0s');
    });

    it('formats minutes and seconds for 60000ms', () => {
      expect(tool._formatDuration(60000)).toBe('1m 0s');
    });

    it('formats minutes and seconds', () => {
      expect(tool._formatDuration(90000)).toBe('1m 30s');
    });

    it('formats large durations', () => {
      expect(tool._formatDuration(360000)).toBe('6m 0s');
    });
  });

  // =========================================================================
  // _formatRelativeTime
  // =========================================================================

  describe('_formatRelativeTime', () => {
    // System time is 2026-02-09T12:00:00Z

    it('returns "just now" for timestamps within last 60 seconds', () => {
      const ts = new Date('2026-02-09T11:59:30Z');
      expect(tool._formatRelativeTime(ts)).toBe('just now');
    });

    it('returns minutes ago for 1-59 minute range', () => {
      const ts = new Date('2026-02-09T11:55:00Z');
      expect(tool._formatRelativeTime(ts)).toBe('5m ago');
    });

    it('returns hours ago for 1-47 hour range', () => {
      const ts = new Date('2026-02-09T09:00:00Z');
      expect(tool._formatRelativeTime(ts)).toBe('3h ago');
    });

    it('returns days ago for >= 48 hours', () => {
      const ts = new Date('2026-02-06T12:00:00Z');
      expect(tool._formatRelativeTime(ts)).toBe('3d ago');
    });

    it('handles string timestamp', () => {
      expect(tool._formatRelativeTime('2026-02-09T11:59:30Z')).toBe('just now');
    });

    it('returns raw string for invalid timestamp', () => {
      expect(tool._formatRelativeTime('not-a-date')).toBe('not-a-date');
    });

    it('returns dash for undefined (invalid date)', () => {
      // new Date(undefined) => Invalid Date => NaN getTime => String(undefined || '—') => '—'
      expect(tool._formatRelativeTime(undefined)).toBe('—');
    });

    it('treats null as epoch time (new Date(null) => Date(0))', () => {
      // new Date(null) => new Date(0) => epoch, which IS a valid date
      const result = tool._formatRelativeTime(null);
      expect(result).toMatch(/\d+d ago/);
    });

    it('handles Date instance correctly', () => {
      const ts = new Date('2026-02-09T10:00:00Z');
      expect(tool._formatRelativeTime(ts)).toBe('2h ago');
    });

    it('returns "just now" for exactly now', () => {
      const ts = new Date('2026-02-09T12:00:00Z');
      expect(tool._formatRelativeTime(ts)).toBe('just now');
    });

    it('boundary: exactly 60 seconds ago shows minutes', () => {
      const ts = new Date('2026-02-09T11:59:00Z');
      expect(tool._formatRelativeTime(ts)).toBe('1m ago');
    });

    it('boundary: exactly 60 minutes ago shows hours', () => {
      const ts = new Date('2026-02-09T11:00:00Z');
      expect(tool._formatRelativeTime(ts)).toBe('1h ago');
    });

    it('boundary: exactly 48 hours shows days', () => {
      const ts = new Date('2026-02-07T12:00:00Z');
      expect(tool._formatRelativeTime(ts)).toBe('2d ago');
    });
  });

  // =========================================================================
  // isAvailable
  // =========================================================================

  describe('isAvailable', () => {
    it('returns true when agent is set', () => {
      expect(tool.isAvailable()).toBe(true);
    });

    it('returns false when agent is null', () => {
      tool.agent = null;
      expect(tool.isAvailable()).toBe(false);
    });

    it('returns false when agent is undefined', () => {
      tool.agent = undefined;
      expect(tool.isAvailable()).toBe(false);
    });
  });

  // =========================================================================
  // getDisplayName
  // =========================================================================

  describe('getDisplayName', () => {
    it('returns formatted tool name', () => {
      expect(tool.getDisplayName()).toBe('Research');
    });

    it('handles multi-word name', () => {
      tool.name = 'deep_research';
      expect(tool.getDisplayName()).toBe('Deep Research');
    });
  });

  // =========================================================================
  // getDescription
  // =========================================================================

  describe('getDescription', () => {
    it('returns display name + " tool"', () => {
      expect(tool.getDescription()).toBe('Research tool');
    });
  });

  // =========================================================================
  // cleanup
  // =========================================================================

  describe('cleanup', () => {
    it('logs cleanup message with tool name', () => {
      tool.cleanup();
      expect(logger.info).toHaveBeenCalledWith('ToolComponent: Cleanup research');
    });

    it('does not throw', () => {
      expect(() => tool.cleanup()).not.toThrow();
    });
  });
});
