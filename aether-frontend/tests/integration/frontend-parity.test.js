'use strict';

/**
 * Frontend Parity Integration Tests
 * Verifies new frontend has all features from old frontend.
 * Each test asserts that the referenced source module actually exists on disk.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../src');

/** Resolve a src-relative path and assert the file exists. */
function expectModuleExists(relativePath) {
  const fullPath = path.join(SRC, relativePath);
  expect(fs.existsSync(fullPath)).toBe(true);
}

describe('Frontend Parity', () => {
  describe('Chat features', () => {
    it('should have ChatOrchestrator for sending text messages', () => {
      expectModuleExists('application/chat/ChatOrchestrator.js');
    });

    it('should have StreamHandler for message streaming', () => {
      expectModuleExists('renderer/chat/modules/messaging/StreamHandler.js');
    });

    it('should have SidebarManager for chat history', () => {
      expectModuleExists('renderer/chat/modules/sidebar/SidebarManager.js');
    });

    it('should have FileManager for file attachments', () => {
      expectModuleExists('renderer/chat/modules/files/FileManager.js');
    });

    it('should have FileManager for image attachments', () => {
      // Image handling is part of the same FileManager
      expectModuleExists('renderer/chat/modules/files/FileManager.js');
    });

    it('should have ChatRepository and MessageRepository for persistence', () => {
      expectModuleExists('domain/chat/repositories/ChatRepository.js');
      expectModuleExists('domain/chat/repositories/MessageRepository.js');
    });

    it('should have RequestLifecycleManager for stop generation', () => {
      expectModuleExists('application/shared/RequestLifecycleManager.js');
    });

    it('should have ChatService for chat switching', () => {
      expectModuleExists('domain/chat/services/ChatService.js');
    });

    it('should have ChatService for chat creation and deletion', () => {
      expectModuleExists('domain/chat/services/ChatService.js');
    });
  });

  describe('Artifacts features', () => {
    it('should have CodeViewer and ArtifactService for code artifacts', () => {
      expectModuleExists('renderer/artifacts/modules/code/CodeViewer.js');
      expectModuleExists('domain/artifacts/services/ArtifactService.js');
    });

    it('should have OutputViewer for output artifacts', () => {
      expectModuleExists('renderer/artifacts/modules/output/OutputViewer.js');
    });

    it('should have HtmlRenderer for HTML artifacts', () => {
      expectModuleExists('renderer/artifacts/modules/output/renderers/HtmlRenderer.js');
    });

    it('should have ArtifactStreamHandler for artifact streaming', () => {
      expectModuleExists('domain/artifacts/services/ArtifactStreamHandler.js');
    });

    it('should have ArtifactExecutor for code execution', () => {
      expectModuleExists('domain/artifacts/services/ArtifactExecutor.js');
    });

    it('should have FileManager for file export', () => {
      expectModuleExists('renderer/artifacts/modules/files/FileManager.js');
    });

    it('should have TabManager for tab management', () => {
      expectModuleExists('renderer/artifacts/modules/tabs/TabManager.js');
    });

    it('should have CodeViewer for syntax highlighting', () => {
      // Syntax highlighting is built into CodeViewer
      expectModuleExists('renderer/artifacts/modules/code/CodeViewer.js');
    });

    it('should have TraceabilityService for artifact-message traceability', () => {
      expectModuleExists('domain/artifacts/services/TraceabilityService.js');
    });

    it('should have ArtifactRepository for PostgreSQL artifact persistence', () => {
      expectModuleExists('domain/artifacts/repositories/ArtifactRepository.js');
    });
  });

  describe('Settings features', () => {
    it('should have ModelService and ModelManager for model selection', () => {
      expectModuleExists('domain/settings/services/ModelService.js');
      expectModuleExists('application/main/modules/models/ModelManager.js');
    });

    it('should have ProfileService and ProfileManager for profile management', () => {
      expectModuleExists('domain/settings/services/ProfileService.js');
      expectModuleExists('application/main/modules/profiles/ProfileManager.js');
    });

    it('should have SettingsRepository for settings persistence', () => {
      expectModuleExists('domain/settings/repositories/SettingsRepository.js');
    });

    it('should have ModelCapabilities model', () => {
      expectModuleExists('domain/settings/models/ModelCapabilities.js');
    });
  });

  describe('IPC/Communication features', () => {
    it('should have IpcBridge in infrastructure', () => {
      expectModuleExists('infrastructure/ipc/IpcBridge.js');
    });

    it('should have preload scripts', () => {
      expectModuleExists('preload/main-preload.js');
      expectModuleExists('preload/chat-preload.js');
      expectModuleExists('preload/artifacts-preload.js');
    });

    it('should have secure IPC channels definition', () => {
      expectModuleExists('preload/ipc/channels.js');
    });

    it('should have GuruConnection for WebSocket', () => {
      expectModuleExists('core/communication/GuruConnection.js');
    });

    it('should have Endpoint and ApiClient for REST API', () => {
      expectModuleExists('core/communication/Endpoint.js');
      expectModuleExists('core/communication/ApiClient.js');
    });
  });

  describe('Security features', () => {
    it('should have Sanitizer for content sanitization', () => {
      expectModuleExists('core/security/Sanitizer.js');
    });

    it('should have CspManager for CSP management', () => {
      expectModuleExists('core/security/CspManager.js');
    });

    it('should have RateLimiter for rate limiting', () => {
      expectModuleExists('core/security/RateLimiter.js');
    });

    it('should have InputValidator for input validation', () => {
      expectModuleExists('core/security/InputValidator.js');
    });

    it('should have PermissionHandler for permission handling', () => {
      expectModuleExists('main/security/PermissionHandler.js');
    });

    it('should have ExternalLinkHandler for external link handling', () => {
      expectModuleExists('main/security/ExternalLinkHandler.js');
    });
  });

  describe('Window management features', () => {
    it('should have MainWindow', () => {
      expectModuleExists('main/windows/MainWindow.js');
    });

    it('should have ChatWindow', () => {
      expectModuleExists('main/windows/ChatWindow.js');
    });

    it('should have ArtifactsWindow', () => {
      expectModuleExists('main/windows/ArtifactsWindow.js');
    });

    it('should have WindowManager', () => {
      expectModuleExists('main/windows/WindowManager.js');
    });

    it('should have ShortcutManager for keyboard shortcuts', () => {
      expectModuleExists('main/services/ShortcutManager.js');
    });
  });

  describe('UI features', () => {
    it('should have DragResizeManager for drag-resize panels', () => {
      expectModuleExists('renderer/chat/modules/window/DragResizeManager.js');
    });

    it('should have StyleManager for style management', () => {
      expectModuleExists('renderer/chat/modules/window/StyleManager.js');
    });

    it('should have ArtifactRouter for artifact activity routing', () => {
      expectModuleExists('domain/artifacts/services/ArtifactRouter.js');
    });

    it('should have ThinkingBubble for thinking indicator', () => {
      expectModuleExists('renderer/chat/modules/thinking/ThinkingBubble.js');
    });
  });

  describe('Storage features', () => {
    it('should have ChatRepository and MessageRepository for PostgreSQL chat storage', () => {
      expectModuleExists('domain/chat/repositories/ChatRepository.js');
      expectModuleExists('domain/chat/repositories/MessageRepository.js');
    });

    it('should have ArtifactRepository for PostgreSQL artifact storage', () => {
      expectModuleExists('domain/artifacts/repositories/ArtifactRepository.js');
    });

    it('should have LocalStorage adapter', () => {
      expectModuleExists('infrastructure/persistence/LocalStorage.js');
    });
  });

  describe('Monitoring features', () => {
    it('should have ErrorTracker for error tracking', () => {
      expectModuleExists('infrastructure/monitoring/ErrorTracker.js');
    });

    it('should have PerformanceMonitor for performance monitoring', () => {
      expectModuleExists('infrastructure/monitoring/PerformanceMonitor.js');
    });

    it('should have MetricsCollector for metrics collection', () => {
      expectModuleExists('infrastructure/monitoring/MetricsCollector.js');
    });

    it('should have MemoryMonitor for memory monitoring', () => {
      expectModuleExists('infrastructure/monitoring/MemoryMonitor.js');
    });
  });

  describe('Configuration features', () => {
    it('should have centralized configuration with defaults', () => {
      expectModuleExists('core/config/defaults.js');
    });

    it('should have EnvLoader for environment variables', () => {
      expectModuleExists('core/config/env-loader.js');
    });

    it('should have validators for configuration validation', () => {
      expectModuleExists('core/config/validators.js');
    });
  });

  describe('Architecture improvements', () => {
    it('should have clean architecture layers', () => {
      expectModuleExists('domain');
      expectModuleExists('application');
      expectModuleExists('infrastructure');
      expectModuleExists('core');
    });

    it('should have DI Container for dependency injection', () => {
      expectModuleExists('core/di/Container.js');
    });

    it('should have EventBus in core/events', () => {
      expectModuleExists('core/events/EventBus.js');
    });

    it('should have domain models', () => {
      expectModuleExists('domain/chat/models/Message.js');
      expectModuleExists('domain/chat/models/Chat.js');
      expectModuleExists('domain/artifacts/models/Artifact.js');
    });

    it('should have repository pattern', () => {
      expectModuleExists('domain/chat/repositories/ChatRepository.js');
      expectModuleExists('domain/artifacts/repositories/ArtifactRepository.js');
      expectModuleExists('domain/settings/repositories/SettingsRepository.js');
    });

    it('should have dedicated validators', () => {
      expectModuleExists('domain/settings/validators/SettingsValidator.js');
      expectModuleExists('domain/chat/validators/MessageValidator.js');
      expectModuleExists('domain/artifacts/validators/ArtifactValidator.js');
    });
  });
});
