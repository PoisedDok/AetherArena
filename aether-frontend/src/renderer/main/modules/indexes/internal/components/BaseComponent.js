'use strict';

const IndexBrowserUtils = require('../IndexBrowserUtils');

class BaseComponent {
  constructor(container, ctx) {
    this.container = container;
    this.ctx = ctx;
    this._listeners = [];
  }

  _trackListener(element, event, handler, options) {
    if (!element || !event || !handler) return;
    element.addEventListener(event, handler, options);
    this._listeners.push({ element, event, handler, options });
  }

  dispose() {
    this._listeners.forEach(({ element, event, handler, options }) => {
      element?.removeEventListener(event, handler, options);
    });
    this._listeners = [];
  }

  render() {
    // Override in subclass
  }

  update() {
    // Override in subclass for targeted diffing
  }
}

module.exports = BaseComponent;
