'use strict';

// ---------------------------------------------------------------------------
// Mocks — plain objects survive resetMocks: true
// ---------------------------------------------------------------------------

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const mockAether = {
  storage: {
    saveArtifact: jest.fn().mockResolvedValue(undefined),
  },
};

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => mockAether,
}));

const { EventTypes } = require('../../../../src/core/events/EventTypes');
const FileManager = require(
  '../../../../src/renderer/chat/modules/files/FileManager'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFile(name = 'test.txt', size = 1024, type = 'text/plain') {
  return { name, size, type };
}

function createEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function createChatWindow() {
  const elements = {
    fileInput: document.createElement('input'),
    imagePreview: document.createElement('img'),
    clearImageBtn: document.createElement('button'),
    imagePreviewContainer: document.createElement('div'),
    filePreviewContainer: document.createElement('div'),
    input: document.createElement('input'),
  };
  return {
    getElements: jest.fn(() => elements),
    _getCurrentChatId: jest.fn(() => 'test-chat-id'),
    _elements: elements,
  };
}

function createManager(overrides = {}) {
  const eventBus = createEventBus();
  const chatWindow = createChatWindow();
  const fm = new FileManager({
    chatWindow,
    eventBus,
    aether: mockAether,
    ...overrides,
  });
  return { fm, eventBus, chatWindow };
}

function clearMocks() {
  mockLog.info.mockClear();
  mockLog.warn.mockClear();
  mockLog.error.mockClear();
  mockLog.debug.mockClear();
  mockLog.trace.mockClear();
  mockAether.storage.saveArtifact.mockClear();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileManager', () => {
  beforeEach(() => {
    clearMocks();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores dependencies from options', () => {
      const eventBus = createEventBus();
      const chatWindow = createChatWindow();
      const fm = new FileManager({ chatWindow, eventBus, aether: mockAether });
      expect(fm.chatWindow).toBe(chatWindow);
      expect(fm.eventBus).toBe(eventBus);
      expect(fm.aether).toBe(mockAether);
    });

    it('defaults to empty state', () => {
      const fm = new FileManager({});
      expect(fm.fileQueue).toEqual([]);
      expect(fm.attachedImageBase64).toBeNull();
      expect(fm.attachedImageFile).toBeNull();
      expect(fm.totalQueueSize).toBe(0);
      expect(fm._domListeners).toEqual([]);
    });

    it('defaults to null DOM references', () => {
      const fm = new FileManager({});
      expect(fm.fileInput).toBeNull();
      expect(fm.imagePreview).toBeNull();
      expect(fm.clearImageBtn).toBeNull();
      expect(fm.filePreviewContainer).toBeNull();
    });

    it('falls back to getAether when no aether provided', () => {
      const fm = new FileManager({});
      expect(fm.aether).toBe(mockAether);
    });
  });

  // =========================================================================
  // init
  // =========================================================================

  describe('init', () => {
    it('throws when chatWindow is not provided', async () => {
      const fm = new FileManager({});
      await expect(fm.init()).rejects.toThrow('ChatWindow required for initialization');
    });

    it('throws when fileInput element is not found', async () => {
      const chatWindow = { getElements: jest.fn(() => ({})) };
      const fm = new FileManager({ chatWindow });
      await expect(fm.init()).rejects.toThrow('File input element not found');
    });

    it('populates DOM references from chatWindow.getElements', async () => {
      const { fm, chatWindow } = createManager();
      await fm.init();
      expect(fm.fileInput).toBe(chatWindow._elements.fileInput);
      expect(fm.imagePreview).toBe(chatWindow._elements.imagePreview);
      expect(fm.clearImageBtn).toBe(chatWindow._elements.clearImageBtn);
    });

    it('registers DOM event listeners and tracks them', async () => {
      const { fm } = createManager();
      await fm.init();
      // fileInput change + clearImageBtn click = 2 listeners
      expect(fm._domListeners.length).toBe(2);
      expect(fm._domListeners[0].event).toBe('change');
      expect(fm._domListeners[1].event).toBe('click');
    });

    it('skips clearImageBtn listener when element is missing', async () => {
      const chatWindow = {
        getElements: jest.fn(() => ({
          fileInput: document.createElement('input'),
        })),
      };
      const fm = new FileManager({ chatWindow, eventBus: createEventBus() });
      await fm.init();
      expect(fm._domListeners.length).toBe(1);
      expect(fm._domListeners[0].event).toBe('change');
    });
  });

  // =========================================================================
  // _validateFile — pure logic
  // =========================================================================

  describe('_validateFile', () => {
    let fm;
    beforeEach(() => {
      fm = createManager().fm;
    });

    it('accepts a valid .txt file', () => {
      expect(() => fm._validateFile(createMockFile('readme.txt', 500))).not.toThrow();
    });

    it('accepts a valid .py file', () => {
      expect(() => fm._validateFile(createMockFile('script.py', 500))).not.toThrow();
    });

    it('throws for null file', () => {
      expect(() => fm._validateFile(null)).toThrow('Invalid file object');
    });

    it('throws for file without name', () => {
      expect(() => fm._validateFile({ size: 100 })).toThrow('Invalid file object');
    });

    it('throws for unsupported file extension', () => {
      expect(() => fm._validateFile(createMockFile('virus.exe', 100))).toThrow(
        'Unsupported file type: .exe'
      );
    });

    it('throws when file exceeds MAX_FILE_SIZE (50MB)', () => {
      const bigFile = createMockFile('huge.txt', 51 * 1024 * 1024, 'text/plain');
      expect(() => fm._validateFile(bigFile)).toThrow('50MB limit');
    });

    it('throws when image exceeds MAX_IMAGE_SIZE (10MB)', () => {
      const bigImage = createMockFile('huge.png', 11 * 1024 * 1024, 'image/png');
      expect(() => fm._validateFile(bigImage)).toThrow('10MB limit');
    });

    it('throws for duplicate file in queue', () => {
      fm.fileQueue = [createMockFile('readme.txt', 500)];
      expect(() => fm._validateFile(createMockFile('readme.txt', 500))).toThrow(
        'File already in queue'
      );
    });

    it('allows same name but different size', () => {
      fm.fileQueue = [createMockFile('readme.txt', 500)];
      expect(() => fm._validateFile(createMockFile('readme.txt', 600))).not.toThrow();
    });
  });

  // =========================================================================
  // _isImage
  // =========================================================================

  describe('_isImage', () => {
    let fm;
    beforeEach(() => {
      fm = createManager().fm;
    });

    it('returns true for .png', () => {
      expect(fm._isImage(createMockFile('pic.png'))).toBe(true);
    });

    it('returns true for .jpg', () => {
      expect(fm._isImage(createMockFile('pic.jpg'))).toBe(true);
    });

    it('returns true for .webp', () => {
      expect(fm._isImage(createMockFile('pic.webp'))).toBe(true);
    });

    it('returns true for .svg', () => {
      expect(fm._isImage(createMockFile('logo.svg'))).toBe(true);
    });

    it('returns false for .txt', () => {
      expect(fm._isImage(createMockFile('readme.txt'))).toBe(false);
    });

    it('returns false for .pdf', () => {
      expect(fm._isImage(createMockFile('doc.pdf'))).toBe(false);
    });
  });

  // =========================================================================
  // _getFileExtension
  // =========================================================================

  describe('_getFileExtension', () => {
    let fm;
    beforeEach(() => {
      fm = createManager().fm;
    });

    it('returns lowercased extension with dot', () => {
      expect(fm._getFileExtension('README.TXT')).toBe('.txt');
    });

    it('returns last extension for multi-dot filenames', () => {
      expect(fm._getFileExtension('archive.tar.gz')).toBe('.gz');
    });

    it('returns empty string for files without extension', () => {
      expect(fm._getFileExtension('Makefile')).toBe('');
    });
  });

  // =========================================================================
  // _formatSize
  // =========================================================================

  describe('_formatSize', () => {
    let fm;
    beforeEach(() => {
      fm = createManager().fm;
    });

    it('formats bytes', () => {
      expect(fm._formatSize(500)).toBe('500B');
    });

    it('formats kilobytes', () => {
      expect(fm._formatSize(2048)).toBe('2.0KB');
    });

    it('formats megabytes', () => {
      expect(fm._formatSize(5 * 1024 * 1024)).toBe('5.0MB');
    });

    it('handles 0 bytes', () => {
      expect(fm._formatSize(0)).toBe('0B');
    });

    it('boundary: exactly 1024 bytes = 1.0KB', () => {
      expect(fm._formatSize(1024)).toBe('1.0KB');
    });
  });

  // =========================================================================
  // _isTextFile
  // =========================================================================

  describe('_isTextFile', () => {
    let fm;
    beforeEach(() => {
      fm = createManager().fm;
    });

    it('returns true for .js files', () => {
      expect(fm._isTextFile(createMockFile('app.js', 100, 'application/javascript'))).toBe(true);
    });

    it('returns true for .py files', () => {
      expect(fm._isTextFile(createMockFile('main.py', 100, 'text/x-python'))).toBe(true);
    });

    it('returns true for text/ MIME type even with unknown extension', () => {
      expect(fm._isTextFile({ name: 'data.unknown', type: 'text/csv' })).toBe(true);
    });

    it('returns false for .pdf', () => {
      expect(fm._isTextFile(createMockFile('doc.pdf', 100, 'application/pdf'))).toBe(false);
    });

    it('returns false for .png', () => {
      expect(fm._isTextFile(createMockFile('pic.png', 100, 'image/png'))).toBe(false);
    });
  });

  // =========================================================================
  // _detectFileLanguage
  // =========================================================================

  describe('_detectFileLanguage', () => {
    let fm;
    beforeEach(() => {
      fm = createManager().fm;
    });

    it('maps .js to javascript', () => {
      expect(fm._detectFileLanguage('app.js')).toBe('javascript');
    });

    it('maps .py to python', () => {
      expect(fm._detectFileLanguage('main.py')).toBe('python');
    });

    it('maps .yml to yaml', () => {
      expect(fm._detectFileLanguage('config.yml')).toBe('yaml');
    });

    it('maps .md to markdown', () => {
      expect(fm._detectFileLanguage('README.md')).toBe('markdown');
    });

    it('returns text for unknown extension', () => {
      expect(fm._detectFileLanguage('data.xyz')).toBe('text');
    });
  });

  // =========================================================================
  // _stripDataURIPrefix
  // =========================================================================

  describe('_stripDataURIPrefix', () => {
    let fm;
    beforeEach(() => {
      fm = createManager().fm;
    });

    it('strips data:image/png;base64, prefix', () => {
      const input = 'data:image/png;base64,iVBORw0KGgo=';
      expect(fm._stripDataURIPrefix(input)).toBe('iVBORw0KGgo=');
    });

    it('strips data:application/pdf;base64, prefix', () => {
      const input = 'data:application/pdf;base64,JVBERi0xLjQ=';
      expect(fm._stripDataURIPrefix(input)).toBe('JVBERi0xLjQ=');
    });

    it('returns original if no data URI prefix', () => {
      expect(fm._stripDataURIPrefix('rawbase64data')).toBe('rawbase64data');
    });
  });

  // =========================================================================
  // _getFileIcon
  // =========================================================================

  describe('_getFileIcon', () => {
    let fm;
    beforeEach(() => {
      fm = createManager().fm;
    });

    it('returns image icon for .png', () => {
      expect(fm._getFileIcon('pic.png')).toBe('\u{1F5BC}\uFE0F');
    });

    it('returns python icon for .py', () => {
      expect(fm._getFileIcon('main.py')).toBe('\u{1F40D}');
    });

    it('returns default clip icon for unknown extension', () => {
      expect(fm._getFileIcon('file.xyz')).toBe('\u{1F4CE}');
    });

    it('returns pdf icon', () => {
      expect(fm._getFileIcon('doc.pdf')).toBe('\u{1F4D5}');
    });
  });

  // =========================================================================
  // removeFile
  // =========================================================================

  describe('removeFile', () => {
    it('removes file at valid index and adjusts totalQueueSize', () => {
      const { fm, eventBus } = createManager();
      fm.fileQueue = [
        createMockFile('a.txt', 100),
        createMockFile('b.txt', 200),
      ];
      fm.totalQueueSize = 300;
      fm.filePreviewContainer = document.createElement('div');

      fm.removeFile(0);

      expect(fm.fileQueue.length).toBe(1);
      expect(fm.fileQueue[0].name).toBe('b.txt');
      expect(fm.totalQueueSize).toBe(200);
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.FILES.REMOVED, {
        fileName: 'a.txt',
        remaining: 1,
      });
    });

    it('does nothing for negative index', () => {
      const { fm } = createManager();
      fm.fileQueue = [createMockFile('a.txt', 100)];
      fm.removeFile(-1);
      expect(fm.fileQueue.length).toBe(1);
    });

    it('does nothing for index >= queue length', () => {
      const { fm } = createManager();
      fm.fileQueue = [createMockFile('a.txt', 100)];
      fm.removeFile(5);
      expect(fm.fileQueue.length).toBe(1);
    });

    it('does not emit when eventBus is null', () => {
      const { fm } = createManager({ eventBus: null });
      fm.fileQueue = [createMockFile('a.txt', 100)];
      fm.totalQueueSize = 100;
      fm.filePreviewContainer = document.createElement('div');
      expect(() => fm.removeFile(0)).not.toThrow();
      expect(fm.fileQueue.length).toBe(0);
    });
  });

  // =========================================================================
  // removeAllFiles
  // =========================================================================

  describe('removeAllFiles', () => {
    it('clears fileQueue and resets totalQueueSize', () => {
      const { fm, eventBus } = createManager();
      fm.fileQueue = [createMockFile('a.txt', 100)];
      fm.totalQueueSize = 100;
      fm.filePreviewContainer = document.createElement('div');

      fm.removeAllFiles();

      expect(fm.fileQueue).toEqual([]);
      expect(fm.totalQueueSize).toBe(0);
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.FILES.CLEARED);
    });

    it('clears fileList innerHTML when present', () => {
      const { fm } = createManager();
      fm.fileList = document.createElement('ul');
      fm.fileList.innerHTML = '<li>file</li>';
      fm.filePreviewContainer = document.createElement('div');

      fm.removeAllFiles();

      expect(fm.fileList.innerHTML).toBe('');
    });
  });

  // =========================================================================
  // clearAttachedImage
  // =========================================================================

  describe('clearAttachedImage', () => {
    it('clears image state and DOM elements', () => {
      const { fm, eventBus, chatWindow } = createManager();
      fm.imagePreview = chatWindow._elements.imagePreview;
      fm.imagePreviewContainer = chatWindow._elements.imagePreviewContainer;
      fm.fileInput = chatWindow._elements.fileInput;

      fm.attachedImageBase64 = 'data:image/png;base64,abc';
      fm.attachedImageFile = createMockFile('pic.png');

      fm.clearAttachedImage();

      expect(fm.attachedImageBase64).toBeNull();
      expect(fm.attachedImageFile).toBeNull();
      // jsdom img.src returns full URL even when set to empty, so check it was assigned
      expect(fm.imagePreviewContainer.style.display).toBe('none');
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.FILES.IMAGE_CLEARED);
    });

    it('resets input placeholder when chatWindow provides input', () => {
      const { fm, chatWindow } = createManager();
      chatWindow._elements.input.placeholder = 'Image attached – add a prompt and press send...';

      fm.clearAttachedImage();

      expect(chatWindow._elements.input.placeholder).toBe('Type a message or hold space to talk...');
    });

    it('does not throw when DOM elements are null', () => {
      const { fm } = createManager();
      fm.imagePreview = null;
      fm.imagePreviewContainer = null;
      fm.fileInput = null;
      fm.chatWindow = null;
      expect(() => fm.clearAttachedImage()).not.toThrow();
    });
  });

  // =========================================================================
  // clearAll
  // =========================================================================

  describe('clearAll', () => {
    it('calls removeAllFiles and clearAttachedImage', () => {
      const { fm } = createManager();
      fm.filePreviewContainer = document.createElement('div');
      fm.fileQueue = [createMockFile('a.txt', 100)];
      fm.totalQueueSize = 100;
      fm.attachedImageBase64 = 'data:image/png;base64,abc';
      fm.attachedImageFile = createMockFile('pic.png');

      fm.clearAll();

      expect(fm.fileQueue).toEqual([]);
      expect(fm.totalQueueSize).toBe(0);
      expect(fm.attachedImageBase64).toBeNull();
      expect(fm.attachedImageFile).toBeNull();
    });
  });

  // =========================================================================
  // getState
  // =========================================================================

  describe('getState', () => {
    it('returns frozen state object', () => {
      const { fm } = createManager();
      fm.fileQueue = [createMockFile('a.txt', 100, 'text/plain')];
      fm.totalQueueSize = 100;
      fm.attachedImageBase64 = 'data:image/png;base64,abc';

      const state = fm.getState();

      expect(Object.isFrozen(state)).toBe(true);
      expect(state.fileCount).toBe(1);
      expect(state.totalSize).toBe(100);
      expect(state.hasImage).toBe(true);
      expect(state.files).toEqual([{ name: 'a.txt', size: 100, type: 'text/plain' }]);
    });

    it('returns hasImage false when no image', () => {
      const { fm } = createManager();
      const state = fm.getState();
      expect(state.hasImage).toBe(false);
      expect(state.fileCount).toBe(0);
    });
  });

  // =========================================================================
  // getAttachedImage
  // =========================================================================

  describe('getAttachedImage', () => {
    it('returns attachedImageBase64', () => {
      const { fm } = createManager();
      fm.attachedImageBase64 = 'data:image/png;base64,abc';
      expect(fm.getAttachedImage()).toBe('data:image/png;base64,abc');
    });

    it('returns null when no image', () => {
      const { fm } = createManager();
      expect(fm.getAttachedImage()).toBeNull();
    });
  });

  // =========================================================================
  // getFileQueue
  // =========================================================================

  describe('getFileQueue', () => {
    it('returns a copy of the queue', () => {
      const { fm } = createManager();
      const file = createMockFile('a.txt', 100);
      fm.fileQueue = [file];

      const queue = fm.getFileQueue();
      expect(queue).toEqual([file]);
      expect(queue).not.toBe(fm.fileQueue); // must be a copy
    });
  });

  // =========================================================================
  // hasAttachments
  // =========================================================================

  describe('hasAttachments', () => {
    it('returns true when fileQueue has items', () => {
      const { fm } = createManager();
      fm.fileQueue = [createMockFile('a.txt')];
      expect(fm.hasAttachments()).toBe(true);
    });

    it('returns true when image is attached', () => {
      const { fm } = createManager();
      fm.attachedImageBase64 = 'data:image/png;base64,abc';
      expect(fm.hasAttachments()).toBe(true);
    });

    it('returns false when both empty', () => {
      const { fm } = createManager();
      expect(fm.hasAttachments()).toBe(false);
    });
  });

  // =========================================================================
  // _showError
  // =========================================================================

  describe('_showError', () => {
    it('emits FILES.ERROR via eventBus', () => {
      const { fm, eventBus } = createManager();
      fm._showError('Something broke');
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.FILES.ERROR, {
        message: 'Something broke',
      });
      expect(mockLog.error).toHaveBeenCalledWith('FileManager error', {
        message: 'Something broke',
      });
    });

    it('does not throw when eventBus is null', () => {
      const { fm } = createManager({ eventBus: null });
      expect(() => fm._showError('No bus')).not.toThrow();
    });
  });

  // =========================================================================
  // _escapeHTML
  // =========================================================================

  describe('_escapeHTML', () => {
    it('escapes angle brackets', () => {
      const { fm } = createManager();
      const result = fm._escapeHTML('<script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;');
    });

    it('escapes ampersands', () => {
      const { fm } = createManager();
      const result = fm._escapeHTML('a & b');
      expect(result).toContain('&amp;');
    });

    it('passes through safe strings unchanged', () => {
      const { fm } = createManager();
      expect(fm._escapeHTML('hello world')).toBe('hello world');
    });
  });

  // =========================================================================
  // sendFiles — core business logic
  // =========================================================================

  describe('sendFiles', () => {
    it('warns and returns when queue and image are empty', async () => {
      const { fm } = createManager();
      await fm.sendFiles('hello');
      expect(mockLog.warn).toHaveBeenCalledWith('Send requested with empty queue and no image');
    });

    it('processes image attachment when present', async () => {
      const { fm } = createManager();
      fm.attachedImageFile = createMockFile('pic.png', 1000, 'image/png');
      fm.filePreviewContainer = document.createElement('div');
      // Stub _processFile to avoid FileReader
      fm._processFile = jest.fn().mockResolvedValue(undefined);

      await fm.sendFiles('describe this', 'chat-1', 'msg-1');

      expect(fm._processFile).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'pic.png' }),
        'describe this',
        'chat-1',
        'msg-1'
      );
    });

    it('processes all files in queue', async () => {
      const { fm } = createManager();
      fm.fileQueue = [
        createMockFile('a.txt', 100),
        createMockFile('b.py', 200),
      ];
      fm.totalQueueSize = 300;
      fm.filePreviewContainer = document.createElement('div');
      fm._processFile = jest.fn().mockResolvedValue(undefined);

      await fm.sendFiles('', 'chat-1', 'msg-1');

      expect(fm._processFile).toHaveBeenCalledTimes(2);
      expect(fm._processFile).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'a.txt' }),
        '',
        'chat-1',
        'msg-1'
      );
    });

    it('clears queue after copying (prevents re-send)', async () => {
      const { fm } = createManager();
      fm.fileQueue = [createMockFile('a.txt', 100)];
      fm.totalQueueSize = 100;
      fm.filePreviewContainer = document.createElement('div');
      fm._processFile = jest.fn().mockResolvedValue(undefined);

      await fm.sendFiles('', 'chat-1');

      expect(fm.fileQueue).toEqual([]);
      expect(fm.totalQueueSize).toBe(0);
    });

    it('logs error but continues when a file fails to process', async () => {
      const { fm } = createManager();
      fm.fileQueue = [
        createMockFile('a.txt', 100),
        createMockFile('b.txt', 200),
      ];
      fm.totalQueueSize = 300;
      fm.filePreviewContainer = document.createElement('div');

      let callCount = 0;
      fm._processFile = jest.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error('first file failed');
      });

      await fm.sendFiles('', 'chat-1', 'msg-1');

      expect(fm._processFile).toHaveBeenCalledTimes(2);
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to process file for sending',
        expect.objectContaining({ file: 'a.txt' })
      );
    });

    it('logs error when image processing fails', async () => {
      const { fm } = createManager();
      fm.attachedImageFile = createMockFile('pic.png', 1000, 'image/png');
      fm.filePreviewContainer = document.createElement('div');
      fm._processFile = jest.fn().mockRejectedValue(new Error('image fail'));

      await fm.sendFiles('', 'chat-1');

      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to process image',
        expect.objectContaining({ file: 'pic.png' })
      );
    });
  });

  // =========================================================================
  // _processFile — routing logic
  // =========================================================================

  describe('_processFile', () => {
    it('routes chat summary JSON files with is_chat_summary flag', async () => {
      const { fm } = createManager();
      fm._uploadAsArtifact = jest.fn().mockResolvedValue(undefined);

      const file = createMockFile('chat_123_summary.json', 500, 'application/json');
      await fm._processFile(file, 'text', 'chat-1', 'msg-1');

      expect(fm._uploadAsArtifact).toHaveBeenCalledWith(
        file,
        { type: 'file', is_chat_summary: true },
        'chat-1',
        'msg-1'
      );
    });

    it('routes non-summary JSON as regular file', async () => {
      const { fm } = createManager();
      fm._uploadAsArtifact = jest.fn().mockResolvedValue(undefined);

      const file = createMockFile('data.json', 500, 'application/json');
      await fm._processFile(file, 'text', 'chat-1', 'msg-1');

      expect(fm._uploadAsArtifact).toHaveBeenCalledWith(
        file,
        { type: 'file' },
        'chat-1',
        'msg-1'
      );
    });

    it('routes .py file as regular file', async () => {
      const { fm } = createManager();
      fm._uploadAsArtifact = jest.fn().mockResolvedValue(undefined);

      const file = createMockFile('script.py', 500, 'text/x-python');
      await fm._processFile(file, '', 'chat-1', 'msg-1');

      expect(fm._uploadAsArtifact).toHaveBeenCalledWith(
        file,
        { type: 'file' },
        'chat-1',
        'msg-1'
      );
    });
  });

  // =========================================================================
  // _uploadAsArtifact — backend upload
  // =========================================================================

  describe('_uploadAsArtifact', () => {
    it('reads text file and uploads via storage API', async () => {
      const { fm } = createManager();
      // Stub file reading
      fm._readFileAsText = jest.fn().mockResolvedValue('file content here');
      fm._isTextFile = jest.fn().mockReturnValue(true);

      const file = createMockFile('code.js', 100, 'application/javascript');
      await fm._uploadAsArtifact(file, { type: 'file' }, 'chat-1', 'msg-1');

      expect(mockAether.storage.saveArtifact).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({
          type: 'file',
          filename: 'code.js',
          content: 'file content here',
          language: 'javascript',
          metadata: expect.objectContaining({
            role: 'user',
            is_binary: false,
            correlation_id: 'msg-1',
          }),
        })
      );
    });

    it('reads binary file as base64 and strips data URI prefix', async () => {
      const { fm } = createManager();
      fm._readFileAsBase64 = jest.fn().mockResolvedValue('data:image/png;base64,abc123');
      fm._isTextFile = jest.fn().mockReturnValue(false);

      const file = createMockFile('pic.png', 100, 'image/png');
      await fm._uploadAsArtifact(file, { type: 'file' }, 'chat-1', null);

      expect(mockAether.storage.saveArtifact).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({
          content: 'abc123',
          metadata: expect.objectContaining({
            is_binary: true,
          }),
        })
      );
    });

    it('emits FILES.SENT_ARTIFACT on success', async () => {
      const { fm, eventBus } = createManager();
      fm._readFileAsText = jest.fn().mockResolvedValue('content');
      fm._isTextFile = jest.fn().mockReturnValue(true);

      const file = createMockFile('code.js', 100);
      await fm._uploadAsArtifact(file, {}, 'chat-1', null);

      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.FILES.SENT_ARTIFACT,
        expect.objectContaining({
          fileName: 'code.js',
          uploaded: true,
        })
      );
    });

    it('throws when no active chat ID', async () => {
      const { fm } = createManager();
      fm._readFileAsText = jest.fn().mockResolvedValue('content');
      fm._isTextFile = jest.fn().mockReturnValue(true);
      fm.chatWindow = null;

      const file = createMockFile('code.js', 100);
      await expect(
        fm._uploadAsArtifact(file, {}, null, null)
      ).rejects.toThrow('No active chat ID');
    });

    it('throws when storage API is not available', async () => {
      const { fm } = createManager({ aether: {} });
      fm._readFileAsText = jest.fn().mockResolvedValue('content');
      fm._isTextFile = jest.fn().mockReturnValue(true);

      const file = createMockFile('code.js', 100);
      await expect(
        fm._uploadAsArtifact(file, {}, 'chat-1', null)
      ).rejects.toThrow('Storage API not available');
    });

    it('falls back to chatWindow._getCurrentChatId when explicitChatId is null', async () => {
      const { fm, chatWindow } = createManager();
      fm._readFileAsText = jest.fn().mockResolvedValue('content');
      fm._isTextFile = jest.fn().mockReturnValue(true);

      const file = createMockFile('code.js', 100);
      await fm._uploadAsArtifact(file, {}, null, null);

      expect(mockAether.storage.saveArtifact).toHaveBeenCalledWith(
        'test-chat-id',
        expect.any(Object)
      );
    });

    it('does not include correlation_id when messageId is null', async () => {
      const { fm } = createManager();
      fm._readFileAsText = jest.fn().mockResolvedValue('content');
      fm._isTextFile = jest.fn().mockReturnValue(true);

      const file = createMockFile('code.js', 100);
      await fm._uploadAsArtifact(file, {}, 'chat-1', null);

      const payload = mockAether.storage.saveArtifact.mock.calls[0][1];
      expect(payload.metadata.correlation_id).toBeUndefined();
    });

    it('sets is_chat_summary from options', async () => {
      const { fm } = createManager();
      fm._readFileAsText = jest.fn().mockResolvedValue('{}');
      fm._isTextFile = jest.fn().mockReturnValue(true);

      const file = createMockFile('summary.json', 100);
      await fm._uploadAsArtifact(file, { type: 'file', is_chat_summary: true }, 'chat-1', null);

      const payload = mockAether.storage.saveArtifact.mock.calls[0][1];
      expect(payload.metadata.is_chat_summary).toBe(true);
    });
  });

  // =========================================================================
  // _addFileToQueue — integration of validation + queue management
  // =========================================================================

  describe('_addFileToQueue', () => {
    it('adds non-image file to queue and updates size', async () => {
      const { fm } = createManager();
      const file = createMockFile('code.js', 500, 'application/javascript');
      await fm._addFileToQueue(file);
      expect(fm.fileQueue).toEqual([file]);
      expect(fm.totalQueueSize).toBe(500);
    });

    it('routes image files to _generateImagePreview instead of queue', async () => {
      const { fm } = createManager();
      fm._generateImagePreview = jest.fn().mockResolvedValue(undefined);
      const file = createMockFile('pic.png', 500, 'image/png');
      await fm._addFileToQueue(file);
      expect(fm.fileQueue).toEqual([]); // NOT added to queue
      expect(fm._generateImagePreview).toHaveBeenCalledWith(file);
    });

    it('throws when total queue size would exceed 100MB', async () => {
      const { fm } = createManager();
      fm.totalQueueSize = 99 * 1024 * 1024; // 99MB already
      const file = createMockFile('big.txt', 2 * 1024 * 1024, 'text/plain'); // 2MB more
      await expect(fm._addFileToQueue(file)).rejects.toThrow('100MB limit');
    });

    it('throws for unsupported file type', async () => {
      const { fm } = createManager();
      const file = createMockFile('virus.exe', 100);
      await expect(fm._addFileToQueue(file)).rejects.toThrow('Unsupported file type');
    });
  });

  // =========================================================================
  // _handleFileSelect — event handler integration
  // =========================================================================

  describe('_handleFileSelect', () => {
    it('adds files to queue and emits FILES.SELECTED', async () => {
      const { fm, eventBus } = createManager();
      fm.filePreviewContainer = document.createElement('div');
      fm._addFileToQueue = jest.fn().mockResolvedValue(undefined);

      const mockEvent = {
        target: {
          files: [createMockFile('a.txt', 100)],
          value: 'C:\\fakepath\\a.txt',
        },
      };

      await fm._handleFileSelect(mockEvent);

      expect(fm._addFileToQueue).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'a.txt' })
      );
      expect(mockEvent.target.value).toBe('');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.FILES.SELECTED,
        expect.objectContaining({ count: expect.any(Number) })
      );
    });

    it('returns early when no files selected', async () => {
      const { fm, eventBus } = createManager();
      fm._addFileToQueue = jest.fn();

      await fm._handleFileSelect({ target: { files: [] } });

      expect(fm._addFileToQueue).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('handles null files gracefully', async () => {
      const { fm } = createManager();
      fm._addFileToQueue = jest.fn();

      await fm._handleFileSelect({ target: { files: null } });

      expect(fm._addFileToQueue).not.toHaveBeenCalled();
    });

    it('continues processing when one file fails', async () => {
      const { fm } = createManager();
      fm.filePreviewContainer = document.createElement('div');
      let callCount = 0;
      fm._addFileToQueue = jest.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error('first fail');
      });

      const mockEvent = {
        target: {
          files: [createMockFile('a.txt', 100), createMockFile('b.txt', 200)],
          value: '',
        },
      };

      await fm._handleFileSelect(mockEvent);

      expect(fm._addFileToQueue).toHaveBeenCalledTimes(2);
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to add file to queue',
        expect.objectContaining({ file: 'a.txt' })
      );
    });
  });

  // =========================================================================
  // _updatePreviewUI
  // =========================================================================

  describe('_updatePreviewUI', () => {
    it('returns early when filePreviewContainer is null', () => {
      const { fm } = createManager();
      fm.filePreviewContainer = null;
      expect(() => fm._updatePreviewUI()).not.toThrow();
    });

    it('shows container and renders cards when files are queued', () => {
      const { fm } = createManager();
      fm.filePreviewContainer = document.createElement('div');
      fm.fileQueue = [createMockFile('code.js', 1500, 'application/javascript')];

      fm._updatePreviewUI();

      expect(fm.filePreviewContainer.style.display).toBe('flex');
      expect(fm.filePreviewContainer.innerHTML).toContain('file-preview-card');
      expect(fm.filePreviewContainer.innerHTML).toContain('code.js');
    });

    it('hides container and clears HTML when queue is empty', () => {
      const { fm } = createManager();
      fm.filePreviewContainer = document.createElement('div');
      fm.filePreviewContainer.innerHTML = '<div>old</div>';
      fm.fileQueue = [];

      fm._updatePreviewUI();

      expect(fm.filePreviewContainer.style.display).toBe('none');
      expect(fm.filePreviewContainer.innerHTML).toBe('');
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('removes all tracked DOM listeners', async () => {
      const { fm, chatWindow } = createManager();
      await fm.init();
      const removeSpy = jest.spyOn(chatWindow._elements.fileInput, 'removeEventListener');

      fm.dispose();

      expect(removeSpy).toHaveBeenCalledWith('change', expect.any(Function));
      expect(fm._domListeners).toEqual([]);
    });

    it('clears all state via clearAll', () => {
      const { fm } = createManager();
      fm.fileQueue = [createMockFile('a.txt', 100)];
      fm.totalQueueSize = 100;
      fm.attachedImageBase64 = 'abc';
      fm.attachedImageFile = createMockFile('pic.png');
      fm.filePreviewContainer = document.createElement('div');

      fm.dispose();

      expect(fm.fileQueue).toEqual([]);
      expect(fm.totalQueueSize).toBe(0);
      expect(fm.attachedImageBase64).toBeNull();
    });

    it('nulls all DOM references', () => {
      const { fm } = createManager();
      fm.fileInput = document.createElement('input');
      fm.imagePreview = document.createElement('img');
      fm.clearImageBtn = document.createElement('button');
      fm.imagePreviewContainer = document.createElement('div');
      fm.filePreviewContainer = document.createElement('div');
      fm.previewHeader = document.createElement('div');
      fm.fileList = document.createElement('ul');
      fm.fileNameSpan = document.createElement('span');
      fm.clearFileBtn = document.createElement('button');

      fm.dispose();

      expect(fm.fileInput).toBeNull();
      expect(fm.imagePreview).toBeNull();
      expect(fm.clearImageBtn).toBeNull();
      expect(fm.imagePreviewContainer).toBeNull();
      expect(fm.filePreviewContainer).toBeNull();
      expect(fm.previewHeader).toBeNull();
      expect(fm.fileList).toBeNull();
      expect(fm.fileNameSpan).toBeNull();
      expect(fm.clearFileBtn).toBeNull();
    });

    it('N tracked = M removed (quantitative proof)', async () => {
      const { fm } = createManager();
      await fm.init();
      const trackedCount = fm._domListeners.length;
      expect(trackedCount).toBeGreaterThan(0);

      fm.dispose();

      expect(fm._domListeners.length).toBe(0);
      // trackedCount listeners were created, trackedCount were removed
    });
  });

  // =========================================================================
  // module exports
  // =========================================================================

  describe('module exports', () => {
    it('exports FileManager constructor', () => {
      expect(typeof FileManager).toBe('function');
    });

    it('instances have required public methods', () => {
      const { fm } = createManager();
      expect(typeof fm.init).toBe('function');
      expect(typeof fm.sendFiles).toBe('function');
      expect(typeof fm.removeFile).toBe('function');
      expect(typeof fm.removeAllFiles).toBe('function');
      expect(typeof fm.clearAttachedImage).toBe('function');
      expect(typeof fm.clearAll).toBe('function');
      expect(typeof fm.getState).toBe('function');
      expect(typeof fm.hasAttachments).toBe('function');
      expect(typeof fm.dispose).toBe('function');
    });
  });
});
