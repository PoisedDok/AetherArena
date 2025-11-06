'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, data_model}
 * Processing: Define frozen event type constants (19 categories, 90+ events), validators for 6 critical events, priority levels --- {1 jobs: JOB_INITIALIZE}
 * Outgoing: Export frozen objects (EventTypes, EventValidators, EventPriority) for import by all modules --- {event_types.*, frozen_object}
 * 
 * 
 * @module core/events/EventTypes
 * 
 * EventTypes - Centralized Event Type Definitions
 * ============================================================================
 * Provides type-safe event constants and validators for the entire application.
 * All events should be defined here to ensure consistency and prevent typos.
 */

const { freeze } = Object;

const EventTypes = freeze({
  // UI Events
  UI: freeze({
    SETTINGS_OPENED: 'ui:settings:opened',
    SETTINGS_CLOSED: 'ui:settings:closed',
    SETTINGS_SAVED: 'ui:settings:saved',
    SETTINGS_CHANGED: 'ui:settings:changed',
    TAB_CHANGED: 'ui:tab:changed',
    MODAL_OPENED: 'ui:modal:opened',
    MODAL_CLOSED: 'ui:modal:closed',
    THEME_CHANGED: 'ui:theme:changed',
    WIDGET_MODE_CHANGED: 'ui:widget:mode:changed',
    COMPONENT_READY: 'ui:component:ready',
    ERROR: 'ui:error',
    NOTIFICATION: 'ui:notification',
    WINDOW_SHOWN: 'ui:window:shown',
    WINDOW_HIDDEN: 'ui:window:hidden',
    WINDOW_MOVED: 'ui:window:moved',
    WINDOW_FOCUSED: 'ui:window:focused',
    WINDOW_VISIBILITY_REQUESTED: 'ui:window:visibility:requested',
  }),

  // Connection Events
  CONNECTION: freeze({
    STATUS_CHANGED: 'connection:status:changed',
    WEBSOCKET_OPENED: 'connection:ws:opened',
    WEBSOCKET_CLOSED: 'connection:ws:closed',
    WEBSOCKET_ERROR: 'connection:ws:error',
    REST_CONNECTED: 'connection:rest:connected',
    REST_DISCONNECTED: 'connection:rest:disconnected',
    BACKEND_ONLINE: 'connection:backend:online',
    BACKEND_OFFLINE: 'connection:backend:offline',
  }),

  // Service Events
  SERVICE: freeze({
    STATUS_UPDATED: 'service:status:updated',
    HEALTH_CHECK: 'service:health:check',
    ONLINE: 'service:online',
    OFFLINE: 'service:offline',
    ERROR: 'service:error',
  }),

  // Model Events
  MODEL: freeze({
    LOADED: 'model:loaded',
    CHANGED: 'model:changed',
    CAPABILITIES_UPDATED: 'model:capabilities:updated',
    VISION_DETECTED: 'model:vision:detected',
    LIST_UPDATED: 'model:list:updated',
    INFO_UPDATED: 'model:info:updated',
  }),

  // Profile Events
  PROFILE: freeze({
    LOADED: 'profile:loaded',
    CHANGED: 'profile:changed',
    LIST_UPDATED: 'profile:list:updated',
  }),

  // Chat Events
  CHAT: freeze({
    MESSAGE_SENT: 'chat:message:sent',
    MESSAGE_SENDING: 'chat:message:sending',
    MESSAGE_RECEIVED: 'chat:message:received',
    MESSAGE_ERROR: 'chat:message:error',
    STREAM_STARTED: 'chat:stream:started',
    STREAM_CHUNK: 'chat:stream:chunk',
    STREAM_ENDED: 'chat:stream:ended',
    STREAM_ERROR: 'chat:stream:error',
    REQUEST_STARTED: 'chat:request:started',
    REQUEST_COMPLETED: 'chat:request:completed',
    REQUEST_COMPLETE: 'chat:request:complete',
    REQUEST_STOPPED: 'chat:request:stopped',
    STOP_REQUESTED: 'chat:stop:requested',
    ASSISTANT_STREAM: 'chat:assistant:stream',
    WINDOW_OPENED: 'chat:window:opened',
    WINDOW_CLOSED: 'chat:window:closed',
    CREATED: 'chat:created',
    DELETED: 'chat:deleted',
    SWITCHED: 'chat:switched',
    LOADED: 'chat:loaded',
  }),

  // Artifacts Events
  ARTIFACTS: freeze({
    STREAM: 'artifacts:stream',
    STREAM_RECEIVED: 'artifacts:stream:received',
    CODE_RECEIVED: 'artifacts:code:received',
    OUTPUT_RECEIVED: 'artifacts:output:received',
    HTML_RECEIVED: 'artifacts:html:received',
    MEDIA_RECEIVED: 'artifacts:media:received',
    WINDOW_TOGGLED: 'artifacts:window:toggled',
    WINDOW_OPENED: 'artifacts:window:opened',
    WINDOW_CLOSED: 'artifacts:window:closed',
    ACTIVITY: 'artifacts:activity',
    LOADED: 'artifacts:loaded',
    MODE_CHANGED: 'artifacts:mode:changed',
    
    // Trail Management Events
    TRAIL_CREATED: 'artifacts:trail:created',
    TRAIL_UPDATED: 'artifacts:trail:updated',
    TRAIL_FINALIZED: 'artifacts:trail:finalized',
    TRAIL_COLLAPSED: 'artifacts:trail:collapsed',
    TRAIL_EXPANDED: 'artifacts:trail:expanded',
    TRAIL_RESTORED: 'artifacts:trail:restored',
    
    // Execution Events
    EXECUTION_STARTED: 'artifacts:execution:started',
    EXECUTION_UPDATED: 'artifacts:execution:updated',
    EXECUTION_COMPLETED: 'artifacts:execution:completed',
    EXECUTION_COMPLETE: 'artifacts:execution:complete',
    EXECUTION_ERROR: 'artifacts:execution:error',
    
    // Phase Events
    PHASE_STARTED: 'artifacts:phase:started',
    PHASE_UPDATED: 'artifacts:phase:updated',
    PHASE_COMPLETED: 'artifacts:phase:completed',
    PHASE_ERROR: 'artifacts:phase:error',
    
    // Tab Management Events
    TAB_CHANGED: 'artifacts:tab:changed',
    CODE_TAB_CREATED: 'artifacts:code:tab:created',
    CODE_TAB_CLOSED: 'artifacts:code:tab:closed',
    CODE_TAB_CHANGED: 'artifacts:code:tab:changed',
    
    // Content Events
    CODE_LOADED: 'artifacts:code:loaded',
    OUTPUT_LOADED: 'artifacts:output:loaded',
    
    // File Events
    FILE_SELECTED: 'artifacts:file:selected',
    FILE_EXPORT_STARTED: 'artifacts:file:export:started',
    FILE_EXPORTED: 'artifacts:file:exported',
    FILE_EXPORT_ERROR: 'artifacts:file:export:error',
    
    // Session Events
    SESSION_SWITCHED: 'artifacts:session:switched',
    SESSION_LOADED: 'artifacts:session:loaded',
    ARTIFACT_ADDED: 'artifacts:artifact:added',
    CHAT_SWITCHED: 'artifacts:chat:switched',
  }),

  // Audio Events
  AUDIO: freeze({
    MIC_STARTED: 'audio:mic:started',
    MIC_STOPPED: 'audio:mic:stopped',
    MIC_LEVEL: 'audio:mic:level',
    TTS_STARTED: 'audio:tts:started',
    TTS_ENDED: 'audio:tts:ended',
    TTS_ERROR: 'audio:tts:error',
  }),

  // Settings Events
  SETTINGS: freeze({
    LLM_UPDATED: 'settings:llm:updated',
    VOICE_UPDATED: 'settings:voice:updated',
    DOCLING_UPDATED: 'settings:docling:updated',
    PROFILE_UPDATED: 'settings:profile:updated',
    MODEL_UPDATED: 'settings:model:updated',
  }),

  // System Events
  SYSTEM: freeze({
    INITIALIZED: 'system:initialized',
    READY: 'system:ready',
    ERROR: 'system:error',
    STATUS_CHANGED: 'system:status:changed',
    SHUTDOWN: 'system:shutdown',
  }),

  // IPC Events
  IPC: freeze({
    MESSAGE_RECEIVED: 'ipc:message:received',
    MESSAGE_SENT: 'ipc:message:sent',
    CHANNEL_REGISTERED: 'ipc:channel:registered',
    ERROR: 'ipc:error',
  }),

  // Document Events
  DOCUMENT: freeze({
    UPLOADED: 'document:uploaded',
    PROCESSED: 'document:processed',
    ERROR: 'document:error',
    PIPELINE_CHANGED: 'document:pipeline:changed',
  }),

  // File Events
  FILES: freeze({
    SELECTED: 'files:selected',
    REMOVED: 'files:removed',
    CLEARED: 'files:cleared',
    SENT_VISION: 'files:sent:vision',
    SENT_DOCLING: 'files:sent:docling',
    ERROR: 'files:error',
    IMAGE_CLEARED: 'files:image:cleared',
  }),

  // Visualizer Events
  VISUALIZER: freeze({
    INITIALIZED: 'visualizer:initialized',
    PAUSED: 'visualizer:paused',
    RESUMED: 'visualizer:resumed',
    DESTROYED: 'visualizer:destroyed',
    STATE_CHANGED: 'visualizer:state:changed',
  }),
});

// Event payload validators
const EventValidators = freeze({
  [EventTypes.CONNECTION.STATUS_CHANGED]: (data) => {
    const valid = data && typeof data.status === 'string';
    return {
      valid,
      errors: valid ? [] : ['status must be a string']
    };
  },

  [EventTypes.MODEL.CHANGED]: (data) => {
    const valid = data && typeof data.model === 'string';
    return {
      valid,
      errors: valid ? [] : ['model must be a string']
    };
  },

  [EventTypes.SERVICE.STATUS_UPDATED]: (data) => {
    const valid = data && typeof data.serviceName === 'string' && typeof data.status === 'string';
    return {
      valid,
      errors: valid ? [] : ['serviceName and status must be strings']
    };
  },

  [EventTypes.SETTINGS.MODEL_UPDATED]: (data) => {
    const valid = data && typeof data.model === 'string';
    return {
      valid,
      errors: valid ? [] : ['model must be a string']
    };
  },

  [EventTypes.CHAT.MESSAGE_SENT]: (data) => {
    const valid = data && typeof data.content === 'string';
    return {
      valid,
      errors: valid ? [] : ['content must be a string']
    };
  },

  [EventTypes.AUDIO.MIC_LEVEL]: (data) => {
    const valid = data && typeof data.level === 'number' && data.level >= 0 && data.level <= 100;
    return {
      valid,
      errors: valid ? [] : ['level must be a number between 0 and 100']
    };
  },
});

// Event priority levels
const EventPriority = freeze({
  CRITICAL: 100,
  HIGH: 75,
  NORMAL: 50,
  LOW: 25,
  BACKGROUND: 0,
});

// Export
module.exports = freeze({ EventTypes, EventValidators, EventPriority });

if (typeof window !== 'undefined') {
  window.EventTypes = EventTypes;
  window.EventValidators = EventValidators;
  window.EventPriority = EventPriority;
  console.log('📦 EventTypes loaded with', Object.keys(EventTypes).length, 'event categories');
}

