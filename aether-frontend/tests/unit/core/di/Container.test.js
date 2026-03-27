'use strict';

/**
 * DependencyContainer Unit Tests
 * Tests the DI container
 */

const { DependencyContainer } = require('../../../../src/core/di/Container');

describe('DependencyContainer', () => {
  let container;
  
  beforeEach(() => {
    container = new DependencyContainer({ name: 'test' });
  });

  afterEach(() => {
    if (container && !container._disposed) {
      container.dispose();
    }
    container = null;
  });

  describe('Service registration', () => {
    it('should register a service', () => {
      container.register('testService', () => ({ name: 'test' }));
      
      expect(container.has('testService')).toBe(true);
    });

    it('should register singleton service by default', () => {
      container.register('singleton', () => ({ id: Date.now() }));
      
      const instance1 = container.resolve('singleton');
      const instance2 = container.resolve('singleton');
      
      expect(instance1).toBe(instance2);
    });

    it('should register transient service', () => {
      container.register('transient', () => ({ id: Date.now() }), { singleton: false });
      
      const instance1 = container.resolve('transient');
      const instance2 = container.resolve('transient');
      
      expect(instance1).not.toBe(instance2);
    });

    it('should throw error for duplicate registration', () => {
      container.register('service', () => ({}));
      
      expect(() => container.register('service', () => ({}))).toThrow();
    });

    it('should throw error for invalid service name', () => {
      expect(() => container.register('', () => ({}))).toThrow();
      expect(() => container.register(null, () => ({}))).toThrow();
    });

    it('should throw error for non-function factory', () => {
      expect(() => container.register('service', {})).toThrow();
      expect(() => container.register('service', null)).toThrow();
    });
  });

  describe('Service resolution', () => {
    it('should resolve registered service', () => {
      container.register('service', () => ({ value: 42 }));
      
      const instance = container.resolve('service');
      
      expect(instance.value).toBe(42);
    });

    it('should throw error for unregistered service', () => {
      expect(() => container.resolve('nonexistent')).toThrow();
    });

    it('should resolve with dependencies', () => {
      container.register('dep1', () => ({ name: 'dependency1' }));
      container.register('dep2', () => ({ name: 'dependency2' }));
      container.register('service', (dep1, dep2) => ({ dep1, dep2 }), {
        dependencies: ['dep1', 'dep2']
      });
      
      const instance = container.resolve('service');
      
      expect(instance.dep1.name).toBe('dependency1');
      expect(instance.dep2.name).toBe('dependency2');
    });

    it('should detect circular dependencies', () => {
      container.register('a', (b) => ({ b }), { dependencies: ['b'] });
      container.register('b', (c) => ({ c }), { dependencies: ['c'] });
      container.register('c', (a) => ({ a }), { dependencies: ['a'] });
      
      expect(() => container.resolve('a')).toThrow(/circular/i);
    });

    it('should throw error when factory returns null', () => {
      container.register('nullService', () => null);
      
      expect(() => container.resolve('nullService')).toThrow();
    });

    it('should throw error when factory returns undefined', () => {
      container.register('undefinedService', () => undefined);
      
      expect(() => container.resolve('undefinedService')).toThrow();
    });
  });

  describe('Container lifecycle', () => {
    it('should dispose container', () => {
      container.register('service', () => ({ name: 'test' }));
      
      container.dispose();
      
      expect(container._disposed).toBe(true);
      expect(() => container.resolve('service')).toThrow(/disposal/i);
    });

    it('should not dispose twice', () => {
      container.dispose();
      const firstDispose = container._disposed;
      
      container.dispose();
      
      expect(container._disposed).toBe(firstDispose);
    });

    it('should clear singletons on dispose', () => {
      container.register('service', () => ({ id: Date.now() }));
      container.resolve('service');
      
      expect(container._singletons.size).toBeGreaterThan(0);
      
      container.dispose();
      
      expect(container._singletons.size).toBe(0);
    });
  });

  describe('Service checking', () => {
    it('should check if service exists', () => {
      container.register('service', () => ({}));
      
      expect(container.has('service')).toBe(true);
      expect(container.has('nonexistent')).toBe(false);
    });

    it('should list registered services', () => {
      container.register('service1', () => ({}));
      container.register('service2', () => ({}));
      
      const services = container.list();
      
      expect(services).toContain('service1');
      expect(services).toContain('service2');
      expect(services.length).toBe(2);
    });
  });

  describe('enableLogging paths', () => {
    it('should log on register when enableLogging is true', () => {
      const c = new DependencyContainer({ name: 'log-test', enableLogging: true });
      const spy = jest.spyOn(c.log, 'debug');
      c.register('svc', () => ({ val: 1 }));
      expect(spy).toHaveBeenCalledWith('registered', expect.objectContaining({ name: 'svc' }));
      spy.mockRestore();
      c.dispose();
    });

    it('should log on resolve when enableLogging is true', () => {
      const c = new DependencyContainer({ name: 'log-test', enableLogging: true });
      c.register('svc', () => ({ val: 1 }));
      const spy = jest.spyOn(c.log, 'debug');
      c.resolve('svc');
      expect(spy).toHaveBeenCalledWith('resolved', expect.objectContaining({ name: 'svc' }));
      spy.mockRestore();
      c.dispose();
    });

    it('should log on dispose when enableLogging is true', () => {
      const c = new DependencyContainer({ name: 'log-test', enableLogging: true });
      c.register('svc', () => ({ val: 1 }));
      c.resolve('svc');
      const spy = jest.spyOn(c.log, 'debug');
      c.dispose();
      expect(spy).toHaveBeenCalledWith('disposing', expect.any(Object));
      expect(spy).toHaveBeenCalledWith('container disposed');
      spy.mockRestore();
    });

    it('should log disposed service when service has dispose()', () => {
      const c = new DependencyContainer({ name: 'log-test', enableLogging: true });
      const disposeFn = jest.fn();
      c.register('svc', () => ({ dispose: disposeFn }));
      c.resolve('svc');
      const spy = jest.spyOn(c.log, 'debug');
      c.dispose();
      expect(disposeFn).toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith('disposed service', { name: 'svc' });
      spy.mockRestore();
    });

    it('should log on reset when enableLogging is true', () => {
      const c = new DependencyContainer({ name: 'log-test', enableLogging: true });
      const spy = jest.spyOn(c.log, 'debug');
      c.reset();
      expect(spy).toHaveBeenCalledWith('container reset');
      spy.mockRestore();
    });
  });

  describe('register after disposal', () => {
    it('should throw when registering after disposal', () => {
      container.dispose();
      expect(() => container.register('svc', () => ({}))).toThrow(/disposal/i);
    });
  });

  describe('dispose with service.dispose() error', () => {
    it('should log error when service dispose throws', () => {
      container.register('failing', () => ({
        dispose: () => { throw new Error('dispose boom'); },
      }));
      container.resolve('failing');
      const spy = jest.spyOn(container.log, 'error');
      container.dispose();
      expect(spy).toHaveBeenCalledWith('failed to dispose', expect.objectContaining({ name: 'failing' }));
      spy.mockRestore();
    });
  });

  describe('reset()', () => {
    it('should dispose and clear registrations', () => {
      container.register('svc', () => ({ val: 1 }));
      container.resolve('svc');

      container.reset();

      expect(container._disposed).toBe(false); // Reset re-enables
      expect(container._services.size).toBe(0);
      expect(container._singletons.size).toBe(0);
    });
  });

  describe('getMetadata()', () => {
    it('should return metadata for registered service', () => {
      container.register('svc', () => ({}), { metadata: { version: '1.0' } });
      const meta = container.getMetadata('svc');
      expect(meta).toEqual({ version: '1.0' });
    });

    it('should return null for unregistered service', () => {
      expect(container.getMetadata('nonexistent')).toBeNull();
    });
  });

  describe('getStats()', () => {
    it('should return container statistics', () => {
      container.register('svc', () => ({ val: 1 }));
      container.resolve('svc');
      const stats = container.getStats();
      expect(stats.name).toBe('test');
      expect(stats.registered).toBe(1);
      expect(stats.singletons).toBe(1);
      expect(stats.creating).toBe(0);
      expect(stats.disposed).toBe(false);
      expect(Object.isFrozen(stats)).toBe(true);
    });
  });

  describe('Complex dependency graphs', () => {
    it('should resolve deep dependency chain', () => {
      container.register('a', () => ({ name: 'a' }));
      container.register('b', (a) => ({ name: 'b', a }), { dependencies: ['a'] });
      container.register('c', (b) => ({ name: 'c', b }), { dependencies: ['b'] });
      container.register('d', (c) => ({ name: 'd', c }), { dependencies: ['c'] });
      
      const d = container.resolve('d');
      
      expect(d.name).toBe('d');
      expect(d.c.name).toBe('c');
      expect(d.c.b.name).toBe('b');
      expect(d.c.b.a.name).toBe('a');
    });

    it('should resolve multiple dependencies', () => {
      container.register('dep1', () => ({ value: 1 }));
      container.register('dep2', () => ({ value: 2 }));
      container.register('dep3', () => ({ value: 3 }));
      container.register('service', (d1, d2, d3) => ({
        sum: d1.value + d2.value + d3.value
      }), { dependencies: ['dep1', 'dep2', 'dep3'] });
      
      const service = container.resolve('service');
      
      expect(service.sum).toBe(6);
    });
  });
});

