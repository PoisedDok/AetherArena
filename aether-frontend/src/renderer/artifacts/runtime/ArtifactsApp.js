/**
Incoming: createRendererContainer, createRendererEventBus --- {Dict, javascript_module}
Processing: Instantiate window/tab/viewer modules, register DI singletons, bind controller dependencies --- {4 jobs: JOB_CREATE_BRIDGE, JOB_DELEGATE_TO_MODULE, JOB_INITIALIZE, JOB_UPDATE_STATE}
Outgoing: ArtifactsWindow, TabManager, CodeViewer, OutputViewer, FileManager, SafeCodeExecutor singletons --- {Dict, javascript_module}
*/

'use strict';

const { freeze } = Object;

const ArtifactsWindow = require('../modules/window/ArtifactsWindow');
const TabManager = require('../modules/tabs/TabManager');
const CodeViewer = require('../modules/code/CodeViewer');
const OutputViewer = require('../modules/output/OutputViewer');
const SafeCodeExecutor = require('../modules/execution/SafeCodeExecutor');
const FileManager = require('../modules/files/FileManager');
const { resolveStorageAPI } = require('../../../shared/utils/storage-resolver');

class ArtifactsApp {
  constructor(options = {}) {
    this.container = options.container;
    this.eventBus = options.eventBus;
    this.ipc = options.ipc || null;
    this.config = freeze({ ...(options.config || {}) });

    if (!this.container) {
      throw new Error('[ArtifactsApp] DI container required');
    }

    if (!this.eventBus) {
      throw new Error('[ArtifactsApp] EventBus required');
    }

    this.controller = null;
    this.modules = {};
    this._isDisposed = false;
    this.initialized = false;
    this.storageAPI = options.storageAPI || null;
  }

  setController(controller) {
    this.controller = controller;
  }

  async initialize({ sessionStore, storageAPI } = {}) {
    if (this._isDisposed) return this.modules;
    if (this.initialized) {
      return this.modules;
    }

    if (!this.controller) {
      throw new Error('[ArtifactsApp] Controller must be provided before initialization');
    }

    this.storageAPI = storageAPI || this._resolveStorageAPI();

    const artifactsWindow = new ArtifactsWindow({
      controller: this.controller,
      eventBus: this.eventBus,
    });
    await artifactsWindow.init();

    const tabManager = new TabManager({
      artifactsWindow,
      eventBus: this.eventBus,
    });
    await tabManager.init();

    const codePaneEl = tabManager.getPane('code');
    const outputPaneEl = tabManager.getPane('output');
    const filesPaneEl = tabManager.getPane('files');

    const codeViewer = new CodeViewer({
      controller: this.controller,
      eventBus: this.eventBus,
    });
    await codeViewer.init(codePaneEl);

    const outputViewer = new OutputViewer({
      controller: this.controller,
      eventBus: this.eventBus,
    });
    await outputViewer.init(outputPaneEl);

    const codeExecutor = new SafeCodeExecutor({
      timeout: 5000,
    });

    const fileManager = new FileManager({
      controller: this.controller,
      eventBus: this.eventBus,
      sessionManager: sessionStore,
      storageAPI: this.storageAPI,
    });
    await fileManager.init(filesPaneEl);

    this.modules = {
      artifactsWindow,
      tabManager,
      codeViewer,
      outputViewer,
      codeExecutor,
      fileManager,
    };

    this._registerSingleton('artifactsWindow', artifactsWindow);
    this._registerSingleton('tabManager', tabManager);
    this._registerSingleton('codeViewer', codeViewer);
    this._registerSingleton('outputViewer', outputViewer);
    this._registerSingleton('codeExecutor', codeExecutor);
    this._registerSingleton('fileManager', fileManager);

    this.initialized = true;
    return this.modules;
  }

  getModules() {
    return { ...this.modules };
  }

  getStorageAPI() {
    return this.storageAPI;
  }

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    // Dispose child modules in reverse creation order
    const names = Object.keys(this.modules).reverse();
    for (const name of names) {
      try {
        if (this.modules[name] && typeof this.modules[name].dispose === 'function') {
          this.modules[name].dispose();
        }
      } catch (_) {
        // Parent controller already logs module disposal failures
      }
    }
    this.modules = {};
    this.controller = null;
    this.storageAPI = null;
    this.initialized = false;
  }

  _registerSingleton(token, instance) {
    if (this.container.has(token)) {
      return;
    }
    this.container.register(token, () => instance, { singleton: true });
  }

  _resolveStorageAPI() {
    if (this.container.has('storageAPI')) {
      try {
        return this.container.resolve('storageAPI');
      } catch {
        // fall through to resolver below
      }
    }
    return resolveStorageAPI();
  }
}

module.exports = ArtifactsApp;
