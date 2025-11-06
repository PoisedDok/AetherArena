'use strict';

/**
 * @.architecture
 * 
 * Incoming: All modules (.emit() method calls with event names) --- {event_types.*, javascript_api}
 * Processing: Pub-sub pattern - maintain subscribers Map (eventName → handlers array), sort by priority, apply filters, run middleware, validate events, track history (max 100), call handlers with proper context --- {6 jobs: JOB_DISPOSE, JOB_GET_STATE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: Invoke subscriber handlers with (data, meta) --- {method_calls, javascript_api}
 * 
 * 
 * @module core/events/EventBus
 */

const { freeze } = Object;

class EventBus {
  constructor(options = {}) {
    this.name = options.name || 'default';
    this.subscribers = new Map();
    this.eventHistory = [];
    this.maxHistory = options.maxHistory || 100;
    this.enableLogging = options.enableLogging || false;
    this.validators = new Map();
    this.middleware = [];
    this._destroyed = false;
    this._subscriptionCounter = 0;
  }

  /**
   * Subscribe to an event
   * @param {string} eventName - Event to subscribe to
   * @param {Function} handler - Handler function
   * @param {Object} options - Subscription options (priority, once, filter)
   * @returns {Function} Unsubscribe function
   */
  on(eventName, handler, options = {}) {
    if (this._destroyed) {
      console.warn(`[EventBus:${this.name}] Cannot subscribe after destruction`);
      return () => {};
    }

    if (typeof eventName !== 'string' || !eventName) {
      throw new TypeError('Event name must be a non-empty string');
    }

    if (typeof handler !== 'function') {
      throw new TypeError('Handler must be a function');
    }

    if (!this.subscribers.has(eventName)) {
      this.subscribers.set(eventName, []);
    }

    const subscription = {
      handler,
      priority: options.priority || 0,
      once: options.once || false,
      filter: options.filter || null,
      id: this._generateSubscriptionId(),
      context: options.context || null,
      metadata: options.metadata || {}
    };

    const subscribers = this.subscribers.get(eventName);
    subscribers.push(subscription);
    
    // Sort by priority (higher first)
    subscribers.sort((a, b) => b.priority - a.priority);

    if (this.enableLogging) {
      console.log(`[EventBus:${this.name}] Subscribed to "${eventName}" (id: ${subscription.id}, priority: ${subscription.priority})`);
    }

    // Return unsubscribe function
    return () => this.off(eventName, subscription.id);
  }

  /**
   * Subscribe once - automatically unsubscribes after first invocation
   */
  once(eventName, handler, options = {}) {
    return this.on(eventName, handler, { ...options, once: true });
  }

  /**
   * Unsubscribe from an event
   * @param {string} eventName - Event name
   * @param {string|Function} handlerOrId - Handler function or subscription ID
   */
  off(eventName, handlerOrId) {
    if (!this.subscribers.has(eventName)) return;

    const subscribers = this.subscribers.get(eventName);
    const isId = typeof handlerOrId === 'string';
    
    const index = subscribers.findIndex(sub => 
      isId ? sub.id === handlerOrId : sub.handler === handlerOrId
    );

    if (index !== -1) {
      subscribers.splice(index, 1);
      
      if (this.enableLogging) {
        console.log(`[EventBus:${this.name}] Unsubscribed from "${eventName}"`);
      }
    }

    // Clean up empty subscriber lists
    if (subscribers.length === 0) {
      this.subscribers.delete(eventName);
    }
  }

  /**
   * Emit an event to all subscribers
   * @param {string} eventName - Event name
   * @param {*} data - Event data
   * @param {Object} meta - Event metadata
   */
  emit(eventName, data, meta = {}) {
    if (this._destroyed) {
      console.warn(`[EventBus:${this.name}] Cannot emit after destruction`);
      return;
    }

    if (typeof eventName !== 'string' || !eventName) {
      throw new TypeError('Event name must be a non-empty string');
    }

    const event = {
      name: eventName,
      data,
      meta: {
        ...meta,
        timestamp: Date.now(),
        bus: this.name
      }
    };

    // Validate event if validator exists
    if (this.validators.has(eventName)) {
      const validator = this.validators.get(eventName);
      const result = validator(data);
      if (!result.valid) {
        console.error(`[EventBus:${this.name}] Event "${eventName}" validation failed:`, result.errors);
        return;
      }
    }

    // Run middleware
    let processedEvent = event;
    for (const mw of this.middleware) {
      try {
        processedEvent = mw(processedEvent) || processedEvent;
      } catch (error) {
        console.error(`[EventBus:${this.name}] Middleware error:`, error);
      }
    }

    // Add to history
    this.eventHistory.push({
      ...processedEvent,
      timestamp: event.meta.timestamp
    });

    if (this.eventHistory.length > this.maxHistory) {
      this.eventHistory.shift();
    }

    if (this.enableLogging) {
      console.log(`[EventBus:${this.name}] Emitting "${eventName}"`, data);
    }

    // Get subscribers
    const subscribers = this.subscribers.get(eventName);
    if (!subscribers || subscribers.length === 0) {
      if (this.enableLogging) {
        console.log(`[EventBus:${this.name}] No subscribers for "${eventName}"`);
      }
      return;
    }

    // Call handlers (copy array to allow modifications during iteration)
    const subscribersCopy = [...subscribers];
    const toRemove = [];

    for (const sub of subscribersCopy) {
      // Apply filter if exists
      if (sub.filter && !sub.filter(processedEvent.data, processedEvent.meta)) {
        continue;
      }

      try {
        // Call handler with proper context
        const ctx = sub.context || null;
        sub.handler.call(ctx, processedEvent.data, processedEvent.meta);

        // Mark for removal if once
        if (sub.once) {
          toRemove.push(sub.id);
        }
      } catch (error) {
        console.error(`[EventBus:${this.name}] Handler error for "${eventName}":`, error);
      }
    }

    // Remove once handlers
    for (const id of toRemove) {
      this.off(eventName, id);
    }
  }

  /**
   * Register event validator
   * @param {string} eventName - Event name
   * @param {Function} validator - Validator function
   */
  registerValidator(eventName, validator) {
    if (typeof validator !== 'function') {
      throw new TypeError('Validator must be a function');
    }
    this.validators.set(eventName, validator);
  }

  /**
   * Unregister event validator
   * @param {string} eventName - Event name
   * @returns {boolean} - True if removed, false if not found
   */
  unregisterValidator(eventName) {
    return this.validators.delete(eventName);
  }

  /**
   * Add middleware
   * @param {Function} middleware - Middleware function
   */
  use(middleware) {
    if (typeof middleware !== 'function') {
      throw new TypeError('Middleware must be a function');
    }
    this.middleware.push(middleware);
  }

  /**
   * Remove middleware
   * @param {Function} middleware - The middleware to remove
   * @returns {boolean} - True if removed, false if not found
   */
  removeMiddleware(middleware) {
    const index = this.middleware.indexOf(middleware);
    if (index !== -1) {
      this.middleware.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Get event history
   * @param {Object} options - Filter options
   * @returns {Array}
   */
  getHistory(options = {}) {
    let history = [...this.eventHistory];

    if (options.eventName) {
      history = history.filter(e => e.name === options.eventName);
    }

    if (options.since) {
      history = history.filter(e => e.timestamp >= options.since);
    }

    if (options.limit) {
      history = history.slice(-options.limit);
    }

    return history;
  }

  /**
   * Clear event history
   */
  clearHistory() {
    this.eventHistory = [];
  }

  /**
   * Get all event names with subscribers
   * @returns {string[]}
   */
  getEventNames() {
    return Array.from(this.subscribers.keys());
  }

  /**
   * Get subscriber count for event
   * @param {string} eventName - Event name
   * @returns {number}
   */
  getSubscriberCount(eventName) {
    const subscribers = this.subscribers.get(eventName);
    return subscribers ? subscribers.length : 0;
  }

  /**
   * Get bus statistics
   * @returns {Object}
   */
  getStats() {
    return freeze({
      name: this.name,
      events: this.subscribers.size,
      totalSubscribers: Array.from(this.subscribers.values()).reduce((sum, subs) => sum + subs.length, 0),
      historySize: this.eventHistory.length,
      validators: this.validators.size,
      middleware: this.middleware.length,
      destroyed: this._destroyed
    });
  }

  /**
   * Dispose event bus
   */
  dispose() {
    if (this._destroyed) return;

    if (this.enableLogging) {
      console.log(`[EventBus:${this.name}] Disposing...`);
    }

    this.subscribers.clear();
    this.eventHistory = [];
    this.validators.clear();
    this.middleware = [];
    this._destroyed = true;

    if (this.enableLogging) {
      console.log(`[EventBus:${this.name}] Disposed`);
    }
  }

  /**
   * Generate unique subscription ID
   * @private
   */
  _generateSubscriptionId() {
    return `${this.name}_${++this._subscriptionCounter}_${Date.now()}`;
  }
}

// Export
module.exports = EventBus;

if (typeof window !== 'undefined') {
  window.EventBus = EventBus;
  console.log('📦 EventBus loaded');
}

