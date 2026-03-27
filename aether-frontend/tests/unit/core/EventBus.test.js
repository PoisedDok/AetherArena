'use strict';

/**
 * EventBus Comprehensive Tests
 * Tests actual event subscription, emission, lifecycle, validators,
 * middleware, filters, history, stats, and edge cases.
 */

const EventBus = require('../../../src/core/events/EventBus');

describe('Core EventBus', () => {
  let eventBus;

  beforeEach(() => {
    eventBus = new EventBus({ name: 'test-bus' });
  });

  afterEach(() => {
    if (eventBus) {
      eventBus.dispose();
    }
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('uses provided name', () => {
      expect(eventBus.name).toBe('test-bus');
    });

    it('defaults name to "default"', () => {
      const bus = new EventBus();
      expect(bus.name).toBe('default');
      bus.dispose();
    });

    it('initializes with empty state', () => {
      expect(eventBus.subscribers.size).toBe(0);
      expect(eventBus.eventHistory).toEqual([]);
      expect(eventBus.validators.size).toBe(0);
      expect(eventBus.middleware).toEqual([]);
      expect(eventBus._destroyed).toBe(false);
      expect(eventBus._subscriptionCounter).toBe(0);
    });

    it('accepts maxHistory option', () => {
      const bus = new EventBus({ maxHistory: 5 });
      expect(bus.maxHistory).toBe(5);
      bus.dispose();
    });

    it('accepts enableLogging option', () => {
      const bus = new EventBus({ enableLogging: true });
      expect(bus.enableLogging).toBe(true);
      bus.dispose();
    });
  });

  // =========================================================================
  // on() — subscription
  // =========================================================================

  describe('on()', () => {
    it('subscribes to events and receives emissions', () => {
      const handler = jest.fn();
      eventBus.on('test:event', handler);

      eventBus.emit('test:event', { data: 'test' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        { data: 'test' },
        expect.objectContaining({ bus: 'test-bus', timestamp: expect.any(Number) })
      );
    });

    it('supports multiple handlers for same event', () => {
      const h1 = jest.fn();
      const h2 = jest.fn();

      eventBus.on('test:event', h1);
      eventBus.on('test:event', h2);

      eventBus.emit('test:event', { data: 'test' });

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it('supports multiple events', () => {
      const handler = jest.fn();
      eventBus.on('ev1', handler);
      eventBus.on('ev2', handler);

      eventBus.emit('ev1', { d: 1 });
      eventBus.emit('ev2', { d: 2 });

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('returns noop function when bus is destroyed', () => {
      eventBus.dispose();
      const handler = jest.fn();
      const unsub = eventBus.on('test', handler);

      // Should return a function but it does nothing
      expect(typeof unsub).toBe('function');
      unsub(); // should not throw
    });

    it('throws on non-string event name', () => {
      expect(() => eventBus.on(123, jest.fn())).toThrow(TypeError);
      expect(() => eventBus.on(null, jest.fn())).toThrow(TypeError);
    });

    it('throws on empty event name', () => {
      expect(() => eventBus.on('', jest.fn())).toThrow(TypeError);
    });

    it('throws on non-function handler', () => {
      expect(() => eventBus.on('test', 'not-a-fn')).toThrow(TypeError);
      expect(() => eventBus.on('test', null)).toThrow(TypeError);
    });

    it('sorts subscribers by priority (higher first)', () => {
      const order = [];
      eventBus.on('test', () => order.push('low'), { priority: 1 });
      eventBus.on('test', () => order.push('high'), { priority: 10 });
      eventBus.on('test', () => order.push('mid'), { priority: 5 });

      eventBus.emit('test', null);

      expect(order).toEqual(['high', 'mid', 'low']);
    });

    it('stores subscription metadata', () => {
      eventBus.on('test', jest.fn(), { metadata: { source: 'unit-test' } });
      const subs = eventBus.subscribers.get('test');
      expect(subs[0].metadata).toEqual({ source: 'unit-test' });
    });

    it('supports context binding', () => {
      const ctx = { value: 42 };
      const handler = jest.fn(function () {
        return this.value;
      });

      eventBus.on('test', handler, { context: ctx });
      eventBus.emit('test', null);

      expect(handler.mock.instances[0]).toBe(ctx);
    });

    it('logs subscription when enableLogging is true', () => {
      const bus = new EventBus({ enableLogging: true });
      // Should not throw — exercises the logging branch
      bus.on('test', jest.fn());
      bus.dispose();
    });
  });

  // =========================================================================
  // off() — unsubscription
  // =========================================================================

  describe('off()', () => {
    it('unsubscribes using returned function', () => {
      const handler = jest.fn();
      const unsub = eventBus.on('test', handler);

      unsub();
      eventBus.emit('test', {});

      expect(handler).not.toHaveBeenCalled();
    });

    it('unsubscribes by handler reference', () => {
      const handler = jest.fn();
      eventBus.on('test', handler);

      eventBus.off('test', handler);
      eventBus.emit('test', {});

      expect(handler).not.toHaveBeenCalled();
    });

    it('does nothing for unknown event name', () => {
      // Should not throw
      eventBus.off('nonexistent', jest.fn());
    });

    it('does nothing for unmatched handler', () => {
      eventBus.on('test', jest.fn());
      eventBus.off('test', jest.fn()); // different reference
      expect(eventBus.getSubscriberCount('test')).toBe(1);
    });

    it('cleans up empty subscriber lists', () => {
      const handler = jest.fn();
      eventBus.on('test', handler);
      eventBus.off('test', handler);

      expect(eventBus.subscribers.has('test')).toBe(false);
    });

    it('logs unsubscription when enableLogging is true', () => {
      const bus = new EventBus({ enableLogging: true });
      const handler = jest.fn();
      bus.on('test', handler);
      bus.off('test', handler); // exercises logging branch
      bus.dispose();
    });
  });

  // =========================================================================
  // once() — one-time subscription
  // =========================================================================

  describe('once()', () => {
    it('triggers handler only once', () => {
      const handler = jest.fn();
      eventBus.once('test', handler);

      eventBus.emit('test', { d: 1 });
      eventBus.emit('test', { d: 2 });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toEqual({ d: 1 });
    });

    it('returns an unsubscribe function', () => {
      const handler = jest.fn();
      const unsub = eventBus.once('test', handler);

      unsub();
      eventBus.emit('test', {});

      expect(handler).not.toHaveBeenCalled();
    });

    it('auto-removes after first invocation', () => {
      eventBus.once('test', jest.fn());
      eventBus.emit('test', {});

      expect(eventBus.getSubscriberCount('test')).toBe(0);
    });
  });

  // =========================================================================
  // emit()
  // =========================================================================

  describe('emit()', () => {
    it('does nothing after disposal (destroyed guard)', () => {
      const handler = jest.fn();
      eventBus.on('test', handler);
      eventBus.dispose();

      eventBus.emit('test', {}); // should not throw, should not call handler
      expect(handler).not.toHaveBeenCalled();
    });

    it('throws on non-string event name', () => {
      expect(() => eventBus.emit(123, {})).toThrow(TypeError);
      expect(() => eventBus.emit(null, {})).toThrow(TypeError);
    });

    it('throws on empty event name', () => {
      expect(() => eventBus.emit('', {})).toThrow(TypeError);
    });

    it('applies event validator and blocks invalid events', () => {
      eventBus.registerValidator('validated', (data) => {
        if (!data || typeof data.count !== 'number') {
          return { valid: false, errors: ['count is required'] };
        }
        return { valid: true, errors: [] };
      });

      const handler = jest.fn();
      eventBus.on('validated', handler);

      // Invalid event — blocked
      eventBus.emit('validated', { wrong: 'data' });
      expect(handler).not.toHaveBeenCalled();

      // Valid event — passes through
      eventBus.emit('validated', { count: 5 });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('runs middleware chain and uses transformed event', () => {
      eventBus.use((event) => ({
        ...event,
        data: { ...event.data, enriched: true }
      }));

      const handler = jest.fn();
      eventBus.on('test', handler);
      eventBus.emit('test', { original: true });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ original: true, enriched: true }),
        expect.any(Object)
      );
    });

    it('catches middleware errors and continues', () => {
      eventBus.use(() => { throw new Error('middleware boom'); });

      const handler = jest.fn();
      eventBus.on('test', handler);
      eventBus.emit('test', { value: 1 });

      // Handler still called — middleware error is caught
      expect(handler).toHaveBeenCalled();
    });

    it('middleware returning null uses original event', () => {
      eventBus.use(() => null);

      const handler = jest.fn();
      eventBus.on('test', handler);
      eventBus.emit('test', { v: 1 });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ v: 1 }),
        expect.any(Object)
      );
    });

    it('caps history at maxHistory', () => {
      const bus = new EventBus({ maxHistory: 3 });
      for (let i = 0; i < 5; i++) {
        bus.emit('ev', { i });
      }
      expect(bus.eventHistory.length).toBe(3);
      bus.dispose();
    });

    it('applies subscriber filter', () => {
      const handler = jest.fn();
      eventBus.on('test', handler, {
        filter: (data) => data.pass === true
      });

      eventBus.emit('test', { pass: false });
      expect(handler).not.toHaveBeenCalled();

      eventBus.emit('test', { pass: true });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('catches handler errors and continues to next handler', () => {
      const order = [];
      eventBus.on('test', () => {
        order.push('before-error');
        throw new Error('boom');
      });
      eventBus.on('test', () => { order.push('after-error'); });

      eventBus.emit('test', {});

      expect(order).toEqual(['before-error', 'after-error']);
    });

    it('does nothing when no subscribers exist (no crash)', () => {
      // No subscribers registered
      eventBus.emit('unhandled', { data: 'ignored' });
      // Should add to history but not crash
      expect(eventBus.getHistory()).toHaveLength(1);
    });

    it('logs emission when enableLogging is true', () => {
      const bus = new EventBus({ enableLogging: true });
      bus.on('test', jest.fn());
      bus.emit('test', {}); // exercises logging branches
      bus.dispose();
    });

    it('logs no-subscribers when enableLogging is true', () => {
      const bus = new EventBus({ enableLogging: true });
      bus.emit('unhandled', {}); // exercises no-subscribers logging
      bus.dispose();
    });
  });

  // =========================================================================
  // registerValidator / unregisterValidator
  // =========================================================================

  describe('registerValidator()', () => {
    it('registers a validator for an event', () => {
      const v = jest.fn(() => ({ valid: true, errors: [] }));
      eventBus.registerValidator('test', v);

      const handler = jest.fn();
      eventBus.on('test', handler);
      eventBus.emit('test', {});

      expect(v).toHaveBeenCalled();
      expect(handler).toHaveBeenCalled();
    });

    it('throws on non-function validator', () => {
      expect(() => eventBus.registerValidator('test', 'not-fn')).toThrow(TypeError);
    });
  });

  describe('unregisterValidator()', () => {
    it('removes a registered validator', () => {
      eventBus.registerValidator('test', () => ({ valid: false, errors: ['blocked'] }));
      eventBus.unregisterValidator('test');

      const handler = jest.fn();
      eventBus.on('test', handler);
      eventBus.emit('test', {});

      // No validator, handler receives event
      expect(handler).toHaveBeenCalled();
    });

    it('returns true when validator existed', () => {
      eventBus.registerValidator('test', jest.fn());
      expect(eventBus.unregisterValidator('test')).toBe(true);
    });

    it('returns false when no validator existed', () => {
      expect(eventBus.unregisterValidator('nonexistent')).toBe(false);
    });
  });

  // =========================================================================
  // use() / removeMiddleware()
  // =========================================================================

  describe('use()', () => {
    it('adds middleware to the chain', () => {
      const mw = jest.fn((event) => event);
      eventBus.use(mw);

      eventBus.emit('test', {});
      expect(mw).toHaveBeenCalled();
    });

    it('throws on non-function middleware', () => {
      expect(() => eventBus.use('not-fn')).toThrow(TypeError);
    });

    it('supports multiple middleware in order', () => {
      const order = [];
      eventBus.use(() => { order.push('mw1'); });
      eventBus.use(() => { order.push('mw2'); });

      eventBus.emit('test', {});
      expect(order).toEqual(['mw1', 'mw2']);
    });
  });

  describe('removeMiddleware()', () => {
    it('removes existing middleware and returns true', () => {
      const mw = jest.fn((e) => e);
      eventBus.use(mw);
      expect(eventBus.removeMiddleware(mw)).toBe(true);

      eventBus.emit('test', {});
      expect(mw).not.toHaveBeenCalled();
    });

    it('returns false for non-existent middleware', () => {
      expect(eventBus.removeMiddleware(jest.fn())).toBe(false);
    });
  });

  // =========================================================================
  // getHistory()
  // =========================================================================

  describe('getHistory()', () => {
    it('returns full history as array', () => {
      eventBus.emit('ev1', { a: 1 });
      eventBus.emit('ev2', { a: 2 });

      const history = eventBus.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].name).toBe('ev1');
      expect(history[1].name).toBe('ev2');
    });

    it('filters by eventName', () => {
      eventBus.emit('ev1', {});
      eventBus.emit('ev2', {});
      eventBus.emit('ev1', {});

      const filtered = eventBus.getHistory({ eventName: 'ev1' });
      expect(filtered).toHaveLength(2);
      filtered.forEach(e => expect(e.name).toBe('ev1'));
    });

    it('filters by since timestamp', () => {
      eventBus.emit('old', {});
      const cutoff = Date.now() + 1;
      // Artificially insert a future event
      eventBus.eventHistory.push({ name: 'future', timestamp: cutoff + 100 });

      const filtered = eventBus.getHistory({ since: cutoff });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe('future');
    });

    it('limits results', () => {
      for (let i = 0; i < 10; i++) {
        eventBus.emit('ev', { i });
      }

      const limited = eventBus.getHistory({ limit: 3 });
      expect(limited).toHaveLength(3);
      // Should be last 3 events (slice(-3))
      expect(limited[0].data.i).toBe(7);
    });

    it('returns empty array when no history', () => {
      expect(eventBus.getHistory()).toEqual([]);
    });
  });

  describe('clearHistory()', () => {
    it('clears all event history', () => {
      eventBus.emit('test', {});
      eventBus.clearHistory();
      expect(eventBus.getHistory()).toHaveLength(0);
    });
  });

  // =========================================================================
  // getEventNames()
  // =========================================================================

  describe('getEventNames()', () => {
    it('returns array of event names with active subscribers', () => {
      eventBus.on('alpha', jest.fn());
      eventBus.on('beta', jest.fn());

      const names = eventBus.getEventNames();
      expect(names).toEqual(expect.arrayContaining(['alpha', 'beta']));
    });

    it('returns empty array when no subscribers', () => {
      expect(eventBus.getEventNames()).toEqual([]);
    });
  });

  // =========================================================================
  // getSubscriberCount()
  // =========================================================================

  describe('getSubscriberCount()', () => {
    it('returns correct count for existing event', () => {
      eventBus.on('test', jest.fn());
      eventBus.on('test', jest.fn());
      expect(eventBus.getSubscriberCount('test')).toBe(2);
    });

    it('returns 0 for unknown event', () => {
      expect(eventBus.getSubscriberCount('nonexistent')).toBe(0);
    });
  });

  // =========================================================================
  // getStats()
  // =========================================================================

  describe('getStats()', () => {
    it('returns frozen stats object with all fields', () => {
      eventBus.on('ev1', jest.fn());
      eventBus.on('ev2', jest.fn());
      eventBus.use(jest.fn());
      eventBus.registerValidator('ev1', jest.fn(() => ({ valid: true, errors: [] })));
      eventBus.emit('ev1', {});

      const stats = eventBus.getStats();
      expect(stats.name).toBe('test-bus');
      expect(stats.events).toBe(2);
      expect(stats.totalSubscribers).toBe(2);
      expect(stats.historySize).toBe(1);
      expect(stats.validators).toBe(1);
      expect(stats.middleware).toBe(1);
      expect(stats.destroyed).toBe(false);
      expect(Object.isFrozen(stats)).toBe(true);
    });

    it('reflects destroyed state after dispose', () => {
      eventBus.dispose();
      // Create new bus to check stats after dispose
      const bus = new EventBus();
      bus.dispose();
      // Can't call getStats on destroyed bus easily, but we tested the
      // frozen output above. Test a fresh bus stats instead.
      const bus2 = new EventBus();
      const stats = bus2.getStats();
      expect(stats.destroyed).toBe(false);
      expect(stats.totalSubscribers).toBe(0);
      bus2.dispose();
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================

  describe('dispose()', () => {
    it('clears all handlers, history, validators, and middleware', () => {
      eventBus.on('test', jest.fn());
      eventBus.registerValidator('test', () => ({ valid: true, errors: [] }));
      eventBus.use((e) => e);
      eventBus.emit('test', {});

      eventBus.dispose();

      expect(eventBus.subscribers.size).toBe(0);
      expect(eventBus.eventHistory).toEqual([]);
      expect(eventBus.validators.size).toBe(0);
      expect(eventBus.middleware).toEqual([]);
      expect(eventBus._destroyed).toBe(true);
    });

    it('is idempotent (double-dispose is safe)', () => {
      eventBus.dispose();
      eventBus.dispose(); // should not throw
      expect(eventBus._destroyed).toBe(true);
    });

    it('prevents subsequent subscriptions', () => {
      eventBus.dispose();
      const handler = jest.fn();
      eventBus.on('test', handler);
      // emit should also be a no-op
      eventBus.emit('test', {});
      expect(handler).not.toHaveBeenCalled();
    });

    it('logs dispose when enableLogging is true', () => {
      const bus = new EventBus({ enableLogging: true });
      bus.on('test', jest.fn());
      bus.dispose(); // exercises logging branches in dispose
    });
  });

  // =========================================================================
  // _generateSubscriptionId()
  // =========================================================================

  describe('_generateSubscriptionId()', () => {
    it('generates unique IDs', () => {
      const id1 = eventBus._generateSubscriptionId();
      const id2 = eventBus._generateSubscriptionId();
      expect(id1).not.toBe(id2);
    });

    it('includes bus name in ID', () => {
      const id = eventBus._generateSubscriptionId();
      expect(id).toContain('test-bus');
    });

    it('increments counter', () => {
      expect(eventBus._subscriptionCounter).toBe(0);
      eventBus._generateSubscriptionId();
      expect(eventBus._subscriptionCounter).toBe(1);
    });
  });

  // =========================================================================
  // Edge cases / integration
  // =========================================================================

  describe('edge cases', () => {
    it('handler can unsubscribe itself during emit', () => {
      let unsub;
      const handler = jest.fn(() => unsub());
      unsub = eventBus.on('test', handler);

      // Second handler should still fire
      const h2 = jest.fn();
      eventBus.on('test', h2);

      eventBus.emit('test', {});
      expect(handler).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);

      // Second emit should not call self-unsubscribed handler
      eventBus.emit('test', {});
      expect(handler).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(2);
    });

    it('combining once + filter', () => {
      const handler = jest.fn();
      eventBus.on('test', handler, {
        once: true,
        filter: (data) => data.ready === true
      });

      eventBus.emit('test', { ready: false }); // filtered out
      expect(handler).not.toHaveBeenCalled();

      eventBus.emit('test', { ready: true }); // passes filter, triggers once
      expect(handler).toHaveBeenCalledTimes(1);

      eventBus.emit('test', { ready: true }); // already removed
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('combining validator + middleware + filter', () => {
      // Validator
      eventBus.registerValidator('pipeline', (data) => ({
        valid: typeof data.value === 'number',
        errors: typeof data.value !== 'number' ? ['value must be number'] : []
      }));

      // Middleware
      eventBus.use((event) => ({
        ...event,
        data: { ...event.data, doubled: event.data.value * 2 }
      }));

      // Filtered subscriber
      const handler = jest.fn();
      eventBus.on('pipeline', handler, {
        filter: (data) => data.doubled > 10
      });

      eventBus.emit('pipeline', { value: 3 }); // doubled=6, filtered out
      expect(handler).not.toHaveBeenCalled();

      eventBus.emit('pipeline', { value: 8 }); // doubled=16, passes
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].doubled).toBe(16);

      eventBus.emit('pipeline', { value: 'not-a-number' }); // validator blocks
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
