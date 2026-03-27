'use strict';

class CodeTabsManager {
  constructor(maxTabs = 20) {
    this.maxTabs = maxTabs;
    this.tabs = new Map();
    this.activeTabId = null;
    this.tabCounter = 0;
  }

  generateTabId() {
    return `code-tab-${++this.tabCounter}-${Date.now()}`;
  }

  addTab(tabId, tabData) {
    if (this.tabs.size >= this.maxTabs) return false;
    this.tabs.set(tabId, tabData);
    return true;
  }

  removeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    this.tabs.delete(tabId);
    
    // If active tab was removed, reset activeTabId
    if (this.activeTabId === tabId) {
        this.activeTabId = null;
    }
    
    return tab;
  }

  getTab(tabId) {
    return this.tabs.get(tabId);
  }

  getAllTabs() {
    return Array.from(this.tabs.values());
  }

  getFirstTabId() {
    if (this.tabs.size === 0) return null;
    return this.tabs.keys().next().value;
  }

  hasTab(tabId) {
    return this.tabs.has(tabId);
  }

  getActiveTab() {
    if (!this.activeTabId) return null;
    return this.tabs.get(this.activeTabId);
  }

  get count() {
    return this.tabs.size;
  }

  clear() {
    this.tabs.clear();
    this.activeTabId = null;
  }
}

module.exports = CodeTabsManager;