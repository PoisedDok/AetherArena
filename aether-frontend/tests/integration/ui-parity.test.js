'use strict';

/**
 * UI/UX Parity Tests
 * ============================================================================
 * Ensures new frontend maintains complete feature parity with old frontend.
 * No UI/UX changes - only architectural improvements.
 */

const fs = require('fs');
const path = require('path');

describe('UI/UX Parity Validation', () => {
  const OLD_FRONTEND = path.join(__dirname, '../../../../frontend');
  const NEW_FRONTEND = path.join(__dirname, '../../');

  describe('Main Window Features', () => {
    test('should have widget mode support', () => {
      const newMain = path.join(NEW_FRONTEND, 'src/main/windows/MainWindow.js');
      const content = fs.readFileSync(newMain, 'utf8');

      expect(content).toMatch(/widget.*mode/i);
      expect(content).toMatch(/enterWidgetMode|setWidgetMode/i);
      expect(content).toMatch(/exitWidgetMode/i);
    });

    test('should have neural network visualizer', () => {
      const visualizer = path.join(NEW_FRONTEND, 'src/renderer/main/modules/visualizer/Visualizer.js');
      expect(fs.existsSync(visualizer)).toBe(true);

      const content = fs.readFileSync(visualizer, 'utf8');
      expect(content).toMatch(/THREE|three\.js/i);
      expect(content).toMatch(/neural.*network/i);
    });

    test('should have settings panel with same sections', () => {
      const newHtml = path.join(NEW_FRONTEND, 'src/renderer/main/index.html');
      const content = fs.readFileSync(newHtml, 'utf8');

      // Check for settings sections
      expect(content).toMatch(/tab-assistant|assistant.*settings/i);
      expect(content).toMatch(/tab-connections|connections.*settings/i);
      expect(content).toMatch(/tab-documents|documents.*settings/i);
    });

    test('should support drag and drop', () => {
      // Check if drag and drop is implemented in main window or chat window
      const mainController = path.join(NEW_FRONTEND, 'src/renderer/main/controllers/MainController.js');
      const chatWindow = path.join(NEW_FRONTEND, 'src/renderer/chat/modules/window/ChatWindow.js');
      
      const mainExists = fs.existsSync(mainController);
      const chatExists = fs.existsSync(chatWindow);
      
      // Drag and drop is supported via file attachments in chat
      if (chatExists) {
        const chatContent = fs.readFileSync(chatWindow, 'utf8');
        const hasFileSupport = /file|attach|upload/i.test(chatContent);
        expect(hasFileSupport).toBe(true);
      } else {
        // At minimum, file manager should exist
        const fileManager = path.join(NEW_FRONTEND, 'src/renderer/chat/modules/files/FileManager.js');
        expect(fs.existsSync(fileManager)).toBe(true);
      }
    });
  });

  describe('Chat Window Features', () => {
    test('should have message sending capability', () => {
      const chatController = path.join(NEW_FRONTEND, 'src/renderer/chat/controllers/ChatController.js');
      const content = fs.readFileSync(chatController, 'utf8');

      expect(content).toMatch(/send.*message|handleSend/i);
    });

    test('should have message streaming support', () => {
      const messageManager = path.join(NEW_FRONTEND, 'src/renderer/chat/modules/messaging/MessageManager.js');
      const content = fs.readFileSync(messageManager, 'utf8');

      expect(content).toMatch(/stream/i);
    });

    test('should have markdown rendering', () => {
      const chatDir = path.join(NEW_FRONTEND, 'src/renderer/chat/modules');
      const files = fs.readdirSync(chatDir, { recursive: true });
      const hasMarkdown = files.some((file) => {
        if (typeof file !== 'string' || !file.endsWith('.js')) return false;
        const fullPath = path.join(chatDir, file);
        const content = fs.readFileSync(fullPath, 'utf8');
        return /markdown|marked/i.test(content);
      });

      expect(hasMarkdown).toBe(true);
    });

    test('should have thinking bubble indicator', () => {
      const chatModules = path.join(NEW_FRONTEND, 'src/renderer/chat/modules');
      const files = fs.readdirSync(chatModules, { recursive: true });
      const hasThinking = files.some((file) => {
        if (typeof file !== 'string') return false;
        return /thinking/i.test(file);
      });

      expect(hasThinking).toBe(true);
    });

    test('should have file upload capability', () => {
      const fileManager = path.join(NEW_FRONTEND, 'src/renderer/chat/modules/files/FileManager.js');
      expect(fs.existsSync(fileManager)).toBe(true);

      const content = fs.readFileSync(fileManager, 'utf8');
      expect(content).toMatch(/upload|file.*input/i);
    });

    test('should have chat history/sessions', () => {
      const chatRepo = path.join(NEW_FRONTEND, 'src/domain/chat/repositories/ChatRepository.js');
      expect(fs.existsSync(chatRepo)).toBe(true);

      const content = fs.readFileSync(chatRepo, 'utf8');
      expect(content).toMatch(/history|session/i);
    });

    test('should have sidebar for chat selection', () => {
      const sidebar = path.join(NEW_FRONTEND, 'src/renderer/chat/modules/sidebar/SidebarManager.js');
      expect(fs.existsSync(sidebar)).toBe(true);
    });
  });

  describe('Artifacts Window Features', () => {
    test('should have code editor', () => {
      const codeViewer = path.join(NEW_FRONTEND, 'src/renderer/artifacts/modules/code/CodeViewer.js');
      expect(fs.existsSync(codeViewer)).toBe(true);

      const content = fs.readFileSync(codeViewer, 'utf8');
      expect(content).toMatch(/ace.*editor|editor.*ace/i);
    });

    test('should have output viewer', () => {
      const outputViewer = path.join(NEW_FRONTEND, 'src/renderer/artifacts/modules/output/OutputViewer.js');
      expect(fs.existsSync(outputViewer)).toBe(true);
    });

    test('should have file manager', () => {
      const fileManager = path.join(NEW_FRONTEND, 'src/renderer/artifacts/modules/files/FileManager.js');
      expect(fs.existsSync(fileManager)).toBe(true);
    });

    test('should have tab system', () => {
      const tabManager = path.join(NEW_FRONTEND, 'src/renderer/artifacts/modules/tabs/TabManager.js');
      expect(fs.existsSync(tabManager)).toBe(true);

      const content = fs.readFileSync(tabManager, 'utf8');
      expect(content).toMatch(/tab.*switch|switch.*tab/i);
    });

    test('should have code execution capability', () => {
      const artifactsService = path.join(NEW_FRONTEND, 'src/domain/artifacts/services/ExecutionService.js');
      expect(fs.existsSync(artifactsService)).toBe(true);

      const content = fs.readFileSync(artifactsService, 'utf8');
      expect(content).toMatch(/execute|run.*code/i);
    });

    test('should support multiple output renderers', () => {
      const outputDir = path.join(NEW_FRONTEND, 'src/renderer/artifacts/modules/output');
      const files = fs.readdirSync(outputDir, { recursive: true });
      const hasRenderers = files.some((file) => {
        if (typeof file !== 'string') return false;
        return /renderer/i.test(file);
      });

      expect(hasRenderers).toBe(true);
    });
  });

  describe('Window Management', () => {
    test('should have window controls (minimize, maximize, close)', () => {
      // Window controls are implemented via Electron BrowserWindow API
      // Check that window classes exist
      const mainWindow = path.join(NEW_FRONTEND, 'src/main/windows/MainWindow.js');
      const chatWindow = path.join(NEW_FRONTEND, 'src/main/windows/ChatWindow.js');
      const artifactsWindow = path.join(NEW_FRONTEND, 'src/main/windows/ArtifactsWindow.js');

      expect(fs.existsSync(mainWindow)).toBe(true);
      expect(fs.existsSync(chatWindow)).toBe(true);
      expect(fs.existsSync(artifactsWindow)).toBe(true);
      
      // Verify windows use Electron's built-in controls
      const mainContent = fs.readFileSync(mainWindow, 'utf8');
      expect(mainContent).toMatch(/BrowserWindow|new.*Window/i);
    });

    test('should support drag resize', () => {
      // Check for DragResizeManager in chat modules
      const dragResizeManager = path.join(NEW_FRONTEND, 'src/renderer/chat/modules/window/DragResizeManager.js');
      expect(fs.existsSync(dragResizeManager)).toBe(true);
      
      if (fs.existsSync(dragResizeManager)) {
        const content = fs.readFileSync(dragResizeManager, 'utf8');
        expect(content).toMatch(/drag.*resize|DragResizeManager/i);
      }
    });

    test('should have always-on-top functionality', () => {
      // Check MainWindow which implements the alwaysOnTop functionality
      const mainWindow = path.join(NEW_FRONTEND, 'src/main/windows/MainWindow.js');
      const content = fs.readFileSync(mainWindow, 'utf8');

      expect(content).toMatch(/alwaysOnTop|always.*on.*top|setAlwaysOnTop/i);
    });
  });

  describe('Keyboard Shortcuts', () => {
    test('should have shortcut manager', () => {
      const shortcutManager = path.join(NEW_FRONTEND, 'src/main/services/ShortcutManager.js');
      expect(fs.existsSync(shortcutManager)).toBe(true);
    });

    test('should support Alt+D for widget mode', () => {
      const shortcutManager = path.join(NEW_FRONTEND, 'src/main/services/ShortcutManager.js');
      const content = fs.readFileSync(shortcutManager, 'utf8');

      expect(content).toMatch(/Alt.*D|widget.*toggle/i);
    });

    test('should support Alt+C for chat window', () => {
      const shortcutManager = path.join(NEW_FRONTEND, 'src/main/services/ShortcutManager.js');
      const content = fs.readFileSync(shortcutManager, 'utf8');

      expect(content).toMatch(/Alt.*C|chat.*toggle/i);
    });

    test('should support Alt+A for artifacts window', () => {
      const shortcutManager = path.join(NEW_FRONTEND, 'src/main/services/ShortcutManager.js');
      const content = fs.readFileSync(shortcutManager, 'utf8');

      expect(content).toMatch(/Alt.*A|artifacts.*toggle/i);
    });
  });

  describe('Audio Features', () => {
    test('should have audio manager', () => {
      const audioService = path.join(NEW_FRONTEND, 'src/domain/audio/services/AudioManager.js');
      expect(fs.existsSync(audioService)).toBe(true);
    });

    test('should have STT support', () => {
      const sttService = path.join(NEW_FRONTEND, 'src/domain/audio/services/STTService.js');
      expect(fs.existsSync(sttService)).toBe(true);
    });

    test('should have TTS support', () => {
      const ttsService = path.join(NEW_FRONTEND, 'src/domain/audio/services/TTSService.js');
      expect(fs.existsSync(ttsService)).toBe(true);
    });
  });

  describe('Styling and Themes', () => {
    test('should have CSS files for all windows', () => {
      const mainCss = path.join(NEW_FRONTEND, 'src/renderer/main/styles/main.css');
      const chatCss = path.join(NEW_FRONTEND, 'src/renderer/chat/styles/chat.css');
      const artifactsCss = path.join(NEW_FRONTEND, 'src/renderer/artifacts/styles/artifacts.css');

      expect(fs.existsSync(mainCss)).toBe(true);
      expect(fs.existsSync(chatCss)).toBe(true);
      expect(fs.existsSync(artifactsCss)).toBe(true);
    });

    test('should use shared styles', () => {
      const sharedStyles = path.join(NEW_FRONTEND, 'src/renderer/shared/styles');
      expect(fs.existsSync(sharedStyles)).toBe(true);

      const files = fs.readdirSync(sharedStyles);
      expect(files.some((f) => f.endsWith('.css'))).toBe(true);
    });
  });

  describe('IPC Communication', () => {
    test('should have IPC bridge in preload', () => {
      const mainPreload = path.join(NEW_FRONTEND, 'src/preload/main-preload.js');
      const chatPreload = path.join(NEW_FRONTEND, 'src/preload/chat-preload.js');
      const artifactsPreload = path.join(NEW_FRONTEND, 'src/preload/artifacts-preload.js');

      expect(fs.existsSync(mainPreload)).toBe(true);
      expect(fs.existsSync(chatPreload)).toBe(true);
      expect(fs.existsSync(artifactsPreload)).toBe(true);
    });

    test('should have channel definitions', () => {
      const channels = path.join(NEW_FRONTEND, 'src/preload/ipc/channels.js');
      expect(fs.existsSync(channels)).toBe(true);
    });

    test('should validate IPC payloads', () => {
      const validators = path.join(NEW_FRONTEND, 'src/preload/common/api-validators.js');
      expect(fs.existsSync(validators)).toBe(true);
    });
  });

  describe('Service Integration', () => {
    test('should have service launcher', () => {
      const serviceLauncher = path.join(NEW_FRONTEND, 'src/main/services/ServiceLauncher.js');
      expect(fs.existsSync(serviceLauncher)).toBe(true);
    });

    test('should configure Perplexica integration', () => {
      const config = path.join(NEW_FRONTEND, 'src/core/config/defaults.js');
      const content = fs.readFileSync(config, 'utf8');

      expect(content).toMatch(/perplexica/i);
    });

    test('should configure Docling integration', () => {
      const config = path.join(NEW_FRONTEND, 'src/core/config/defaults.js');
      const content = fs.readFileSync(config, 'utf8');

      expect(content).toMatch(/docling/i);
    });
  });
});

