'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export IpcBridge for centralized import path --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: infrastructure/* (IpcBridge) --- {module_exports, javascript_object}
 * 
 * 
 * @module infrastructure/ipc/index
 * 
 * IPC Infrastructure - Inter-process communication
 * ============================================================================
 * Centralized exports for IPC components.
 * 
 * @module infrastructure/ipc
 */

const { IpcBridge } = require('./IpcBridge');

module.exports = {
  IpcBridge
};

