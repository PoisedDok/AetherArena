'use strict';

const { EventTypes, EventValidators, EventPriority } = require('../../../../src/core/events/EventTypes');

describe('EventTypes', () => {
  // =========================================================================
  // Freeze integrity — no runtime mutation allowed
  // =========================================================================
  describe('freeze integrity', () => {
    it('top-level EventTypes object is frozen', () => {
      expect(Object.isFrozen(EventTypes)).toBe(true);
    });

    it('every category object is frozen', () => {
      const categories = Object.keys(EventTypes);
      expect(categories.length).toBeGreaterThan(10);
      for (const cat of categories) {
        expect(Object.isFrozen(EventTypes[cat])).toBe(true);
      }
    });

    it('rejects property addition on EventTypes', () => {
      expect(() => { EventTypes.NEW_CATEGORY = 'x'; }).toThrow();
    });

    it('rejects property mutation on nested category', () => {
      expect(() => { EventTypes.UI.SETTINGS_OPENED = 'hacked'; }).toThrow();
    });

    it('EventPriority is frozen', () => {
      expect(Object.isFrozen(EventPriority)).toBe(true);
    });

    it('EventValidators is frozen', () => {
      expect(Object.isFrozen(EventValidators)).toBe(true);
    });

    it('module export object is frozen', () => {
      const mod = require('../../../../src/core/events/EventTypes');
      expect(Object.isFrozen(mod)).toBe(true);
    });
  });

  // =========================================================================
  // Event categories — verify all 19 categories exist with string values
  // =========================================================================
  describe('event categories', () => {
    const expectedCategories = [
      'UI', 'CONNECTION', 'SERVICE', 'MODEL', 'PROFILE', 'CHAT',
      'ARTIFACTS', 'AUDIO', 'HANDSFREE', 'PROACTIVE', 'SETTINGS',
      'SYSTEM', 'IPC', 'DOCUMENT', 'FILES', 'VISUALIZER', 'TRAIL',
    ];

    it.each(expectedCategories)('%s category exists', (cat) => {
      expect(EventTypes[cat]).toBeDefined();
      expect(typeof EventTypes[cat]).toBe('object');
    });

    it('every event value is a unique colon-delimited string', () => {
      const allValues = new Set();
      for (const cat of Object.values(EventTypes)) {
        for (const val of Object.values(cat)) {
          expect(typeof val).toBe('string');
          expect(val).toMatch(/^[a-z]+:[a-z_:-]+$/);
          expect(allValues.has(val)).toBe(false);
          allValues.add(val);
        }
      }
      // Sanity: total event count should be 90+
      expect(allValues.size).toBeGreaterThanOrEqual(90);
    });
  });

  // =========================================================================
  // Specific event spot-checks (regression)
  // =========================================================================
  describe('specific event values', () => {
    it('UI events match expected strings', () => {
      expect(EventTypes.UI.SETTINGS_OPENED).toBe('ui:settings:opened');
      expect(EventTypes.UI.THEME_CHANGED).toBe('ui:theme:changed');
      expect(EventTypes.UI.WINDOW_FOCUSED).toBe('ui:window:focused');
    });

    it('CHAT events match expected strings', () => {
      expect(EventTypes.CHAT.MESSAGE_SENT).toBe('chat:message:sent');
      expect(EventTypes.CHAT.STREAM_STARTED).toBe('chat:stream:started');
      expect(EventTypes.CHAT.SWITCHED).toBe('chat:switched');
    });

    it('ARTIFACTS events match expected strings', () => {
      expect(EventTypes.ARTIFACTS.STREAM).toBe('artifacts:stream');
      expect(EventTypes.ARTIFACTS.TAB_CHANGED).toBe('artifacts:tab:changed');
      expect(EventTypes.ARTIFACTS.FILE_DELETED).toBe('artifacts:file:deleted');
      expect(EventTypes.ARTIFACTS.SESSION_SWITCHED).toBe('artifacts:session:switched');
    });

    it('CONNECTION events match expected strings', () => {
      expect(EventTypes.CONNECTION.STATUS_CHANGED).toBe('connection:status:changed');
      expect(EventTypes.CONNECTION.BACKEND_ONLINE).toBe('connection:backend:online');
    });

    it('TRAIL events match expected strings', () => {
      expect(EventTypes.TRAIL.GROUP_CREATED).toBe('trail:group:created');
      expect(EventTypes.TRAIL.SESSION_MAP_LOADED).toBe('trail:session_map:loaded');
      expect(EventTypes.TRAIL.NODE_CLICKED).toBe('trail:node:clicked');
    });
  });

  // =========================================================================
  // EventPriority
  // =========================================================================
  describe('EventPriority', () => {
    it('has exactly 5 levels', () => {
      expect(Object.keys(EventPriority)).toEqual(['CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND']);
    });

    it('levels are in descending order', () => {
      expect(EventPriority.CRITICAL).toBe(100);
      expect(EventPriority.HIGH).toBe(75);
      expect(EventPriority.NORMAL).toBe(50);
      expect(EventPriority.LOW).toBe(25);
      expect(EventPriority.BACKGROUND).toBe(0);
    });

    it('CRITICAL > HIGH > NORMAL > LOW > BACKGROUND', () => {
      expect(EventPriority.CRITICAL).toBeGreaterThan(EventPriority.HIGH);
      expect(EventPriority.HIGH).toBeGreaterThan(EventPriority.NORMAL);
      expect(EventPriority.NORMAL).toBeGreaterThan(EventPriority.LOW);
      expect(EventPriority.LOW).toBeGreaterThan(EventPriority.BACKGROUND);
    });
  });

  // =========================================================================
  // EventValidators — 6 validator functions
  // =========================================================================
  describe('EventValidators', () => {
    describe('CONNECTION.STATUS_CHANGED validator', () => {
      const validate = EventValidators[EventTypes.CONNECTION.STATUS_CHANGED];

      it('is a function', () => {
        expect(typeof validate).toBe('function');
      });

      it('returns valid:true for correct payload', () => {
        const result = validate({ status: 'connected' });
        expect(result).toEqual({ valid: true, errors: [] });
      });

      it('returns valid:false when status missing', () => {
        const result = validate({});
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('status must be a string');
      });

      it('returns valid:false for null data', () => {
        const result = validate(null);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBe(1);
      });

      it('returns valid:false when status is a number', () => {
        const result = validate({ status: 42 });
        expect(result.valid).toBe(false);
      });
    });

    describe('MODEL.CHANGED validator', () => {
      const validate = EventValidators[EventTypes.MODEL.CHANGED];

      it('returns valid:true for correct payload', () => {
        expect(validate({ model: 'gpt-4' })).toEqual({ valid: true, errors: [] });
      });

      it('returns valid:false for missing model', () => {
        const result = validate({});
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('model must be a string');
      });

      it('returns valid:false for null', () => {
        expect(validate(null).valid).toBe(false);
      });
    });

    describe('SERVICE.STATUS_UPDATED validator', () => {
      const validate = EventValidators[EventTypes.SERVICE.STATUS_UPDATED];

      it('returns valid:true for correct payload', () => {
        expect(validate({ serviceName: 'backend', status: 'online' })).toEqual({ valid: true, errors: [] });
      });

      it('returns valid:false when serviceName missing', () => {
        expect(validate({ status: 'online' }).valid).toBe(false);
      });

      it('returns valid:false when status missing', () => {
        expect(validate({ serviceName: 'backend' }).valid).toBe(false);
      });

      it('returns valid:false for null', () => {
        expect(validate(null).valid).toBe(false);
      });
    });

    describe('SETTINGS.MODEL_UPDATED validator', () => {
      const validate = EventValidators[EventTypes.SETTINGS.MODEL_UPDATED];

      it('returns valid:true for correct payload', () => {
        expect(validate({ model: 'claude-3' })).toEqual({ valid: true, errors: [] });
      });

      it('returns valid:false when model is not a string', () => {
        expect(validate({ model: 123 }).valid).toBe(false);
      });

      it('returns valid:false for undefined', () => {
        expect(validate(undefined).valid).toBe(false);
      });
    });

    describe('CHAT.MESSAGE_SENT validator', () => {
      const validate = EventValidators[EventTypes.CHAT.MESSAGE_SENT];

      it('returns valid:true for correct payload', () => {
        expect(validate({ content: 'hello' })).toEqual({ valid: true, errors: [] });
      });

      it('returns valid:false when content is not a string', () => {
        expect(validate({ content: 42 }).valid).toBe(false);
      });

      it('returns valid:false for empty object', () => {
        expect(validate({}).valid).toBe(false);
        expect(validate({}).errors).toContain('content must be a string');
      });
    });

    describe('AUDIO.MIC_LEVEL validator', () => {
      const validate = EventValidators[EventTypes.AUDIO.MIC_LEVEL];

      it('returns valid:true for level=0 (edge)', () => {
        expect(validate({ level: 0 })).toEqual({ valid: true, errors: [] });
      });

      it('returns valid:true for level=100 (edge)', () => {
        expect(validate({ level: 100 })).toEqual({ valid: true, errors: [] });
      });

      it('returns valid:true for level=50 (mid)', () => {
        expect(validate({ level: 50 })).toEqual({ valid: true, errors: [] });
      });

      it('returns valid:false for level=-1 (below range)', () => {
        expect(validate({ level: -1 }).valid).toBe(false);
      });

      it('returns valid:false for level=101 (above range)', () => {
        expect(validate({ level: 101 }).valid).toBe(false);
      });

      it('returns valid:false for level as string', () => {
        expect(validate({ level: '50' }).valid).toBe(false);
      });

      it('returns valid:false for null data', () => {
        expect(validate(null).valid).toBe(false);
        expect(validate(null).errors).toContain('level must be a number between 0 and 100');
      });
    });

    it('has exactly 6 validators', () => {
      expect(Object.keys(EventValidators).length).toBe(6);
    });

    it('all validator keys match real EventTypes values', () => {
      for (const key of Object.keys(EventValidators)) {
        // key should be one of the event type strings
        const allValues = [];
        for (const cat of Object.values(EventTypes)) {
          allValues.push(...Object.values(cat));
        }
        expect(allValues).toContain(key);
      }
    });
  });

  // =========================================================================
  // Window assignment (browser context)
  // =========================================================================
  describe('window assignment', () => {
    afterEach(() => {
      delete global.window;
    });

    it('assigns EventTypes to window when window exists', () => {
      global.window = {};
      jest.isolateModules(() => {
        const mod = require('../../../../src/core/events/EventTypes');
        expect(global.window.EventTypes).toBe(mod.EventTypes);
        expect(global.window.EventValidators).toBe(mod.EventValidators);
        expect(global.window.EventPriority).toBe(mod.EventPriority);
      });
    });

    it('does not crash when window is undefined', () => {
      delete global.window;
      jest.isolateModules(() => {
        expect(() => require('../../../../src/core/events/EventTypes')).not.toThrow();
      });
    });
  });
});
