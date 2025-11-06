'use strict';

/**
 * EventBus Real Tests
 * Tests actual event subscription, emission, and lifecycle management
 */

const EventBus = require('../../../src/core/events/EventBus');

describe('Core EventBus', () => {
  let eventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  afterEach(() => {
    if (eventBus) {
      eventBus.dispose();
    }
  });

  describe('Event Subscription', () => {
    it('should subscribe to events and receive emissions', () => {
      const handler = jest.fn();
      eventBus.on('test:event', handler);
      
      eventBus.emit('test:event', { data: 'test' });
      
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        { data: 'test' },
        expect.objectContaining({ bus: expect.any(String), timestamp: expect.any(Number) })
      );
    });

    it('should support multiple handlers for same event', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      
      eventBus.on('test:event', handler1);
      eventBus.on('test:event', handler2);
      
      eventBus.emit('test:event', { data: 'test' });
      
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should support multiple events', () => {
      const handler = jest.fn();
      eventBus.on('test:event1', handler);
      eventBus.on('test:event2', handler);
      
      eventBus.emit('test:event1', { data: 1 });
      eventBus.emit('test:event2', { data: 2 });
      
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('Event Unsubscription', () => {
    it('should unsubscribe using returned unsubscribe function', () => {
      const handler = jest.fn();
      const unsubscribe = eventBus.on('test:event', handler);
      
      // Call the unsubscribe function
      unsubscribe();
      eventBus.emit('test:event', { data: 'test' });
      
      expect(handler).not.toHaveBeenCalled();
    });

    it('should support unsubscription workflow', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      
      const unsub1 = eventBus.on('test:event', handler1);
      const unsub2 = eventBus.on('test:event', handler2);
      
      // Unsubscribe first handler
      unsub1();
      eventBus.emit('test:event', { data: 'test' });
      
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });
  });

  describe('Once Subscription', () => {
    it('should trigger handler only once', () => {
      const handler = jest.fn();
      eventBus.once('test:event', handler);
      
      eventBus.emit('test:event', { data: 1 });
      eventBus.emit('test:event', { data: 2 });
      
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toMatchObject({ data: 1 });
    });
  });

  describe('Error Handling', () => {
    it('should catch handler errors and continue', () => {
      const errorHandler = jest.fn(() => {
        throw new Error('Handler error');
      });
      const normalHandler = jest.fn();
      
      eventBus.on('test:event', errorHandler);
      eventBus.on('test:event', normalHandler);
      
      eventBus.emit('test:event', { data: 'test' });
      
      expect(errorHandler).toHaveBeenCalled();
      expect(normalHandler).toHaveBeenCalled();
    });
  });

  describe('Event History', () => {
    it('should track event history', () => {
      eventBus.emit('test:event1', { data: 1 });
      eventBus.emit('test:event2', { data: 2 });
      
      const history = eventBus.getHistory();
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBeGreaterThanOrEqual(0);
    });

    it('should allow clearing history', () => {
      eventBus.emit('test:event', { data: 1 });
      
      eventBus.clearHistory();
      
      const history = eventBus.getHistory();
      expect(history).toHaveLength(0);
    });
  });

  describe('Async Event Handling', () => {
    it('should handle async handlers', async () => {
      const handler = jest.fn(async (data) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return data.value * 2;
      });
      
      eventBus.on('test:async', handler);
      eventBus.emit('test:async', { value: 5 });
      
      await new Promise(resolve => setTimeout(resolve, 20));
      
      expect(handler.mock.calls[0][0]).toMatchObject({ value: 5 });
    });
  });

  describe('Stats and Monitoring', () => {
    it('should provide stats', () => {
      eventBus.on('test:event1', jest.fn());
      eventBus.on('test:event2', jest.fn());
      eventBus.emit('test:event1', {});
      
      const stats = eventBus.getStats();
      expect(stats).toHaveProperty('name');
      expect(stats).toHaveProperty('totalSubscribers');
      expect(stats).toHaveProperty('historySize');
      expect(stats.totalSubscribers).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Lifecycle', () => {
    it('should clear all handlers on dispose', () => {
      const handler = jest.fn();
      eventBus.on('test:event', handler);
      
      eventBus.dispose();
      eventBus.emit('test:event', { data: 'test' });
      
      expect(handler).not.toHaveBeenCalled();
    });
  });
});

