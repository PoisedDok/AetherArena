'use strict';

/**
 * ChatService Unit Tests
 * Tests the chat domain ChatService
 */

const { ChatService } = require('../../../../src/domain/chat/services/ChatService');
const { Chat } = require('../../../../src/domain/chat/models/Chat');
const { ChatValidator } = require('../../../../src/domain/chat/validators/ChatValidator');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('ChatService', () => {
  let service;
  let mockChatRepository;
  let mockMessageRepository;
  let mockStorageAPI;
  
  beforeEach(() => {
    // Create complete mock storage API
    mockStorageAPI = {
      createChat: jest.fn().mockImplementation((title) => Promise.resolve({
        id: 'test-chat-id',
        title: title || 'New Chat',
        created_at: Date.now(),
        updated_at: Date.now(),
        messages: []
      })),
      loadChats: jest.fn().mockResolvedValue([]),
      loadChat: jest.fn().mockImplementation((chatId) => Promise.resolve({
        id: chatId,
        title: 'Test Chat',
        created_at: Date.now(),
        updated_at: Date.now(),
        messages: []
      })),
      updateChatTitle: jest.fn().mockImplementation((chatId, title) => Promise.resolve({
        id: chatId,
        title: title,
        created_at: Date.now(),
        updated_at: Date.now()
      })),
      deleteChat: jest.fn().mockResolvedValue({ success: true }),
      loadMessages: jest.fn().mockResolvedValue([]),
      saveMessage: jest.fn().mockResolvedValue({ id: 'msg-id' }),
    };

    // Create repository with mocked storage API
    mockChatRepository = {
      storageAPI: mockStorageAPI,
      create: jest.fn().mockImplementation(async (chat) => {
        const result = await mockStorageAPI.createChat(chat.title);
        chat.id = result.id;
        chat.createdAt = result.created_at;
        chat.updatedAt = result.updated_at;
        return chat;
      }),
      save: jest.fn().mockResolvedValue(true),
      findById: jest.fn().mockImplementation(async (chatId) => {
        const result = await mockStorageAPI.loadChat(chatId);
        return Chat.fromPostgresRow(result, result.messages);
      }),
      findAll: jest.fn().mockResolvedValue([]),
      findActive: jest.fn().mockResolvedValue([]),
      findMostRecent: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockImplementation(async (chatId) => {
        await mockStorageAPI.deleteChat(chatId);
        return true;
      }),
      updateTitle: jest.fn().mockImplementation(async (chatId, title) => {
        const result = await mockStorageAPI.updateChatTitle(chatId, title);
        return Chat.fromPostgresRow(result);
      }),
      count: jest.fn().mockResolvedValue(0),
      exists: jest.fn().mockResolvedValue(false),
    };

    mockMessageRepository = {
      getStatistics: jest.fn().mockResolvedValue({
        userMessages: 0,
        assistantMessages: 0,
        systemMessages: 0,
      }),
    };
    
    service = new ChatService({ 
      chatRepository: mockChatRepository,
      messageRepository: mockMessageRepository,
      validator: new ChatValidator()
    });
  });

  afterEach(() => {
    service = null;
    mockChatRepository = null;
    mockMessageRepository = null;
    mockStorageAPI = null;
  });

  describe('createChat', () => {
    it('should create a new chat', async () => {
      const title = 'New Chat';
      
      const chat = await service.createChat(title);
      
      expect(chat.id).toEqual(expect.any(String));
      expect(chat.id.length).toBeGreaterThan(0);
      expect(chat.title).toBe(title);
      expect(mockChatRepository.create).toHaveBeenCalled();
      expect(mockStorageAPI.createChat).toHaveBeenCalledWith(title);
    });

    it('should create chat with default title', async () => {
      const chat = await service.createChat();
      
      expect(chat.title).toBeTruthy();
      expect(chat.title).toMatch(/^New Chat|Chat/i);
    });

    it('should initialize empty messages array', async () => {
      const chat = await service.createChat('Test');
      
      expect(chat.messages).toEqual([]);
      expect(Array.isArray(chat.messages)).toBe(true);
    });

    it('should set active status to true', async () => {
      const chat = await service.createChat('Test');
      
      expect(chat.isActive).toBe(true);
    });

    it('should handle repository save failure', async () => {
      mockStorageAPI.createChat.mockRejectedValue(new Error('Save failed'));
      
      await expect(service.createChat('Test')).rejects.toThrow();
    });
  });

  describe('chatId generation', () => {
    it('should generate UUIDs for new chats', () => {
      const chat = Chat.create('Test');
      expect(chat.id).toMatch(UUID_REGEX);
    });
  });

  describe('loadChat', () => {
    it('should retrieve chat by ID', async () => {
      const chatId = 'chat_123';
      
      const chat = await service.loadChat(chatId);
      
      expect(chat).toBeDefined();
      expect(chat.id).toBe(chatId);
      expect(chat.title).toBeTruthy();
      expect(mockChatRepository.findById).toHaveBeenCalledWith(chatId);
      expect(mockStorageAPI.loadChat).toHaveBeenCalledWith(chatId);
    });

    it('should load chat with messages', async () => {
      const chatId = 'chat_123';
      mockStorageAPI.loadChat.mockResolvedValue({
        id: chatId,
        title: 'Test Chat',
        created_at: Date.now(),
        updated_at: Date.now(),
        messages: [
          { id: 'msg1', role: 'user', content: 'Hello', created_at: Date.now() },
          { id: 'msg2', role: 'assistant', content: 'Hi', created_at: Date.now() }
        ]
      });
      
      const chat = await service.loadChat(chatId);
      
      expect(chat.messages).toHaveLength(2);
    });

    it('should throw error for invalid ID', async () => {
      mockChatRepository.findById.mockImplementation((chatId) => {
        if (!chatId || typeof chatId !== 'string') {
          throw new Error('Chat ID must be a non-empty string');
        }
        return Promise.resolve(Chat.create('Test'));
      });
      
      await expect(service.loadChat('')).rejects.toThrow();
      await expect(service.loadChat(null)).rejects.toThrow();
    });
  });

  describe('deleteChat', () => {
    it('should delete chat by ID', async () => {
      const result = await service.deleteChat('chat_123');
      
      expect(result).toBeTruthy();
      expect(mockChatRepository.delete).toHaveBeenCalledWith('chat_123');
      expect(mockStorageAPI.deleteChat).toHaveBeenCalledWith('chat_123');
    });

    it('should handle deletion failure', async () => {
      mockStorageAPI.deleteChat.mockRejectedValue(new Error('Delete failed'));
      
      await expect(service.deleteChat('chat_123')).rejects.toThrow();
    });
  });

  describe('loadAllChats', () => {
    it('should list all chats', async () => {
      const mockChats = [
        { id: 'chat_1', title: 'Chat 1', created_at: Date.now(), updated_at: Date.now(), messages: [] },
        { id: 'chat_2', title: 'Chat 2', created_at: Date.now(), updated_at: Date.now(), messages: [] },
      ];
      mockStorageAPI.loadChats.mockResolvedValue(mockChats);
      mockChatRepository.findAll.mockImplementation(async () => {
        const chats = await mockStorageAPI.loadChats();
        return chats.map(c => Chat.fromPostgresRow(c));
      });
      
      const chats = await service.loadAllChats();
      
      expect(chats).toHaveLength(2);
      expect(mockChatRepository.findAll).toHaveBeenCalled();
    });

    it('should return empty array when no chats', async () => {
      mockStorageAPI.loadChats.mockResolvedValue([]);
      
      const chats = await service.loadAllChats();
      
      expect(chats).toEqual([]);
    });
  });

  describe('updateChatTitle', () => {
    it('should update chat title', async () => {
      const chatId = 'chat_123';
      const newTitle = 'Updated Title';
      
      const updated = await service.updateChatTitle(chatId, newTitle);
      
      expect(updated.title).toBe(newTitle);
      expect(mockChatRepository.updateTitle).toHaveBeenCalledWith(chatId, newTitle);
      expect(mockStorageAPI.updateChatTitle).toHaveBeenCalledWith(chatId, newTitle);
    });

    it('should throw error for empty title', async () => {
      await expect(service.updateChatTitle('chat_123', ''))
        .rejects.toThrow();
    });

    it('should throw error for invalid title type', async () => {
      await expect(service.updateChatTitle('chat_123', null))
        .rejects.toThrow();
      await expect(service.updateChatTitle('chat_123', 123))
        .rejects.toThrow();
    });
  });

  describe('chatExists', () => {
    it('should return true for existing chat', async () => {
      mockChatRepository.exists.mockResolvedValue(true);
      
      const exists = await service.chatExists('chat_123');
      
      expect(exists).toBe(true);
    });

    it('should return false for non-existent chat', async () => {
      mockChatRepository.exists.mockResolvedValue(false);
      
      const exists = await service.chatExists('non_existent');
      
      expect(exists).toBe(false);
    });
  });

  describe('getChatCount', () => {
    it('should return total chat count', async () => {
      mockChatRepository.count.mockResolvedValue(5);
      
      const count = await service.getChatCount();
      
      expect(count).toBe(5);
    });
  });

  describe('searchByTitle', () => {
    it('should search chats by title', async () => {
      const mockChats = [
        Chat.create('Test Chat 1'),
        Chat.create('Test Chat 2'),
        Chat.create('Another Chat'),
      ];
      mockChatRepository.findAll.mockResolvedValue(mockChats);
      
      const results = await service.searchByTitle('Test');
      
      expect(results).toHaveLength(2);
      expect(results.every(c => c.title.includes('Test'))).toBe(true);
    });

    it('should return empty array for no matches', async () => {
      mockChatRepository.findAll.mockResolvedValue([Chat.create('Test Chat')]);
      
      const results = await service.searchByTitle('NonExistent');
      
      expect(results).toEqual([]);
    });

    it('should throw error for invalid query', async () => {
      await expect(service.searchByTitle('')).rejects.toThrow();
      await expect(service.searchByTitle(null)).rejects.toThrow();
    });
  });

  describe('generateSmartTitle', () => {
    it('should generate title from first user message', () => {
      const messages = [
        { role: 'user', content: 'How do I build a React app?', isUser: () => true },
        { role: 'assistant', content: 'Here is how...', isUser: () => false },
      ];
      
      const title = service.generateSmartTitle(messages);
      
      expect(title).toBe('How do I build a React app?');
    });

    it('should truncate long messages', () => {
      const longMessage = 'A'.repeat(100);
      const messages = [
        { role: 'user', content: longMessage, isUser: () => true },
      ];
      
      const title = service.generateSmartTitle(messages);
      
      expect(title.length).toBeLessThanOrEqual(50);
      expect(title).toContain('...');
    });

    it('should return default for empty messages', () => {
      const title = service.generateSmartTitle([]);
      
      expect(title).toBe('New Chat');
    });
  });

  // ==================== _sanitizeAndValidateTitleOrThrow ====================

  describe('_sanitizeAndValidateTitleOrThrow', () => {
    it('should reject non-string types', () => {
      expect(() => service._sanitizeAndValidateTitleOrThrow(null)).toThrow('Title must be a non-empty string');
      expect(() => service._sanitizeAndValidateTitleOrThrow(123)).toThrow('Title must be a non-empty string');
      expect(() => service._sanitizeAndValidateTitleOrThrow(undefined)).toThrow('Title must be a non-empty string');
    });

    it('should reject whitespace-only strings', () => {
      expect(() => service._sanitizeAndValidateTitleOrThrow('   ')).toThrow('Title must be a non-empty string');
      expect(() => service._sanitizeAndValidateTitleOrThrow('\t\n')).toThrow('Title must be a non-empty string');
    });

    it('should sanitize XSS content and return escaped string', () => {
      const result = service._sanitizeAndValidateTitleOrThrow('<script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('should accept and return valid plain text titles', () => {
      const result = service._sanitizeAndValidateTitleOrThrow('My Chat');
      expect(result).toBe('My Chat');
    });

    it('should trim whitespace from valid titles', () => {
      const result = service._sanitizeAndValidateTitleOrThrow('  Padded Title  ');
      expect(result).toBe('Padded Title');
    });

    it('should reject title that sanitizer strips to empty (all special chars)', () => {
      // Override sanitizeTitle to simulate stripping all content
      const origSanitize = service.validator.sanitizeTitle;
      service.validator.sanitizeTitle = () => '';

      expect(() => service._sanitizeAndValidateTitleOrThrow('test'))
        .toThrow('Title must be a non-empty string');

      service.validator.sanitizeTitle = origSanitize;
    });
  });

  // ==================== createChat — extended ====================

  describe('createChat — extended', () => {
    it('should apply metadata options via setMetadata', async () => {
      const chat = await service.createChat('Test', {
        metadata: { theme: 'dark', lang: 'en' },
      });

      expect(chat.metadata.theme).toBe('dark');
      expect(chat.metadata.lang).toBe('en');
    });

    it('should apply sessionId option', async () => {
      const chat = await service.createChat('Test', {
        sessionId: 'sess_abc',
      });

      expect(chat.sessionId).toBe('sess_abc');
    });

    it('should invalidate list cache after creation', async () => {
      // Pre-populate list cache
      mockChatRepository.findAll.mockResolvedValue([Chat.create('Existing')]);
      await service.loadAllChats();
      // Verify cache populated (second call should NOT hit repo)
      await service.loadAllChats();
      expect(mockChatRepository.findAll).toHaveBeenCalledTimes(1);

      // Create new chat — should invalidate list cache
      await service.createChat('New');

      // Next loadAllChats must hit repo again (cache was invalidated)
      await service.loadAllChats();
      expect(mockChatRepository.findAll).toHaveBeenCalledTimes(2);
    });

    it('should throw for empty title', async () => {
      await expect(service.createChat('')).rejects.toThrow('Title must be a non-empty string');
    });
  });

  // ==================== loadChat — caching ====================

  describe('loadChat — caching', () => {
    it('should return cached chat on second call (cache hit)', async () => {
      // First call — cache miss, goes to repo
      const chat1 = await service.loadChat('chat_abc');
      expect(mockChatRepository.findById).toHaveBeenCalledTimes(1);

      // Second call — cache hit, does NOT call repo again
      const chat2 = await service.loadChat('chat_abc');
      expect(mockChatRepository.findById).toHaveBeenCalledTimes(1);

      // Same object from cache
      expect(chat2).toBe(chat1);
    });

    it('should call repository for different chat IDs', async () => {
      await service.loadChat('chat_1');
      await service.loadChat('chat_2');

      expect(mockChatRepository.findById).toHaveBeenCalledTimes(2);
    });
  });

  // ==================== loadAllChats — caching ====================

  describe('loadAllChats — caching', () => {
    it('should cache results on first call and return cached on second', async () => {
      const chats = [Chat.create('Chat 1'), Chat.create('Chat 2')];
      mockChatRepository.findAll.mockResolvedValue(chats);

      const result1 = await service.loadAllChats();
      const result2 = await service.loadAllChats();

      expect(mockChatRepository.findAll).toHaveBeenCalledTimes(1);
      expect(result1).toBe(result2);
    });

    it('should bypass cache when option is set', async () => {
      const chats = [Chat.create('Chat 1')];
      mockChatRepository.findAll.mockResolvedValue(chats);

      await service.loadAllChats();
      await service.loadAllChats({ bypassCache: true });

      expect(mockChatRepository.findAll).toHaveBeenCalledTimes(2);
    });

    it('should propagate errors', async () => {
      mockChatRepository.findAll.mockRejectedValue(new Error('Load all failed'));

      await expect(service.loadAllChats()).rejects.toThrow('Load all failed');
    });
  });

  // ==================== loadActiveChats ====================

  describe('loadActiveChats', () => {
    it('should delegate to chatRepository.findActive', async () => {
      const activeChats = [Chat.create('Active 1')];
      mockChatRepository.findActive.mockResolvedValue(activeChats);

      const result = await service.loadActiveChats();

      expect(result).toBe(activeChats);
      expect(mockChatRepository.findActive).toHaveBeenCalled();
    });

    it('should propagate errors', async () => {
      mockChatRepository.findActive.mockRejectedValue(new Error('Active load failed'));

      await expect(service.loadActiveChats()).rejects.toThrow('Active load failed');
    });
  });

  // ==================== loadMostRecentChat ====================

  describe('loadMostRecentChat', () => {
    it('should delegate to chatRepository.findMostRecent', async () => {
      const recentChat = Chat.create('Recent');
      mockChatRepository.findMostRecent.mockResolvedValue(recentChat);

      const result = await service.loadMostRecentChat();

      expect(result).toBe(recentChat);
      expect(mockChatRepository.findMostRecent).toHaveBeenCalled();
    });

    it('should return null when no chats exist', async () => {
      mockChatRepository.findMostRecent.mockResolvedValue(null);

      const result = await service.loadMostRecentChat();

      expect(result).toBeNull();
    });

    it('should propagate errors', async () => {
      mockChatRepository.findMostRecent.mockRejectedValue(new Error('Recent failed'));

      await expect(service.loadMostRecentChat()).rejects.toThrow('Recent failed');
    });
  });

  // ==================== archiveChat ====================

  describe('archiveChat', () => {
    it('should archive chat and return it with isArchived true', async () => {
      const chat = Chat.create('Archivable');
      mockChatRepository.findById.mockResolvedValue(chat);

      const result = await service.archiveChat(chat.id);

      expect(result.isArchived).toBe(true);
      expect(result.isActive).toBe(false);
    });

    it('should propagate errors from loadChat', async () => {
      mockChatRepository.findById.mockRejectedValue(new Error('Load failed'));

      await expect(service.archiveChat('bad_id')).rejects.toThrow('Load failed');
    });
  });

  // ==================== getOrCreateDefaultChat ====================

  describe('getOrCreateDefaultChat', () => {
    it('should return existing most recent chat when one exists', async () => {
      const recentChat = Chat.create('Recent');
      mockChatRepository.findMostRecent.mockResolvedValue(recentChat);

      const result = await service.getOrCreateDefaultChat();

      expect(result).toBe(recentChat);
      // createChat should NOT have been called
      expect(mockChatRepository.create).not.toHaveBeenCalled();
    });

    it('should create new chat when no chats exist', async () => {
      mockChatRepository.findMostRecent.mockResolvedValue(null);

      const result = await service.getOrCreateDefaultChat();

      expect(result).toBeDefined();
      expect(result.title).toBe('New Chat');
      expect(mockChatRepository.create).toHaveBeenCalled();
    });

    it('should propagate errors', async () => {
      mockChatRepository.findMostRecent.mockRejectedValue(new Error('Default failed'));

      await expect(service.getOrCreateDefaultChat()).rejects.toThrow('Default failed');
    });
  });

  // ==================== loadChatWithMessages ====================

  describe('loadChatWithMessages', () => {
    it('should delegate to chatRepository.findById', async () => {
      const chat = Chat.create('With Messages');
      mockChatRepository.findById.mockResolvedValue(chat);

      const result = await service.loadChatWithMessages('chat_wm');

      expect(result).toBe(chat);
      expect(mockChatRepository.findById).toHaveBeenCalledWith('chat_wm');
    });

    it('should propagate errors', async () => {
      mockChatRepository.findById.mockRejectedValue(new Error('Load WM failed'));

      await expect(service.loadChatWithMessages('bad')).rejects.toThrow('Load WM failed');
    });
  });

  // ==================== getChatStatistics ====================

  describe('getChatStatistics', () => {
    it('should combine chat and message statistics', async () => {
      const chat = Chat.create('Stats Chat');
      mockChatRepository.findById.mockResolvedValue(chat);
      mockMessageRepository.getStatistics.mockResolvedValue({
        userMessages: 5,
        assistantMessages: 4,
      });

      const stats = await service.getChatStatistics(chat.id);

      expect(stats.id).toBe(chat.id);
      expect(stats.title).toBe('Stats Chat');
      expect(stats.createdAt).toBeDefined();
      expect(stats.updatedAt).toBeDefined();
      expect(typeof stats.age).toBe('number');
      expect(typeof stats.timeSinceUpdate).toBe('number');
      expect(stats.messageCount).toBe(0); // empty chat
      expect(stats.totalTokens).toBe(0); // no messages
      expect(stats.isActive).toBe(true);
      expect(stats.isArchived).toBe(false);
      expect(stats.artifactCount).toBe(0);
      expect(stats.userMessages).toBe(5);
      expect(stats.assistantMessages).toBe(4);
    });

    it('should propagate errors', async () => {
      mockChatRepository.findById.mockRejectedValue(new Error('Stats failed'));

      await expect(service.getChatStatistics('bad')).rejects.toThrow('Stats failed');
    });
  });

  // ==================== autoUpdateTitle ====================

  describe('autoUpdateTitle', () => {
    it('should not update if title is already custom', async () => {
      const chat = Chat.create('Custom Title');
      mockChatRepository.findById.mockResolvedValue(chat);

      const result = await service.autoUpdateTitle(chat.id);

      expect(result.title).toBe('Custom Title');
      expect(mockChatRepository.updateTitle).not.toHaveBeenCalled();
    });

    it('should not update if message count is zero', async () => {
      const chat = Chat.create('New Chat');
      mockChatRepository.findById.mockResolvedValue(chat);

      const result = await service.autoUpdateTitle(chat.id);

      expect(result.title).toBe('New Chat');
      expect(mockChatRepository.updateTitle).not.toHaveBeenCalled();
    });

    it('should update with smart title when messages exist', async () => {
      const chat = new Chat({
        id: Chat.generateId(),
        title: 'New Chat',
        messages: [
          { id: 'msg1', role: 'user', content: 'How does JavaScript work?', isUser: () => true },
        ],
      });
      mockChatRepository.findById.mockResolvedValue(chat);

      const result = await service.autoUpdateTitle(chat.id);

      expect(mockChatRepository.updateTitle).toHaveBeenCalled();
      // updateTitle was called with the smart title
      const updateCall = mockChatRepository.updateTitle.mock.calls[0];
      expect(updateCall[0]).toBe(chat.id);
      expect(updateCall[1]).toContain('How does JavaScript work');
    });

    it('should not update when smart title is still New Chat', async () => {
      // Chat has messages but no user messages — generateSmartTitle returns 'New Chat'
      const chat = new Chat({
        id: Chat.generateId(),
        title: 'New Chat',
        messages: [
          { id: 'msg1', role: 'system', content: 'System prompt', isUser: () => false },
        ],
      });
      mockChatRepository.findById.mockResolvedValue(chat);

      const result = await service.autoUpdateTitle(chat.id);

      expect(result.title).toBe('New Chat');
      expect(mockChatRepository.updateTitle).not.toHaveBeenCalled();
    });

    it('should propagate errors', async () => {
      mockChatRepository.findById.mockRejectedValue(new Error('Auto title failed'));

      await expect(service.autoUpdateTitle('bad')).rejects.toThrow('Auto title failed');
    });
  });

  // ==================== chatExists — error handling ====================

  describe('chatExists — error handling', () => {
    it('should return false when repository throws', async () => {
      mockChatRepository.exists.mockRejectedValue(new Error('DB down'));

      const result = await service.chatExists('chat_err');

      expect(result).toBe(false);
    });
  });

  // ==================== getChatCount — error handling ====================

  describe('getChatCount — error handling', () => {
    it('should propagate errors', async () => {
      mockChatRepository.count.mockRejectedValue(new Error('Count failed'));

      await expect(service.getChatCount()).rejects.toThrow('Count failed');
    });
  });

  // ==================== deleteChat — cache invalidation ====================

  describe('deleteChat — cache invalidation', () => {
    it('should invalidate both chat and list caches', async () => {
      // Pre-populate caches
      const chat = Chat.create('To Delete');
      mockChatRepository.findById.mockResolvedValue(chat);
      await service.loadChat(chat.id); // Populates chat cache
      mockChatRepository.findAll.mockResolvedValue([chat]);
      await service.loadAllChats(); // Populates list cache

      // Verify cache populated
      await service.loadChat(chat.id);
      expect(mockChatRepository.findById).toHaveBeenCalledTimes(1); // Only initial call

      // Delete
      await service.deleteChat(chat.id);

      // Next loadAllChats must hit repo again (cache invalidated)
      await service.loadAllChats();
      expect(mockChatRepository.findAll).toHaveBeenCalledTimes(2);
    });
  });

  // ==================== updateChatTitle — cache invalidation ====================

  describe('updateChatTitle — error handling', () => {
    it('should propagate repository errors', async () => {
      mockChatRepository.updateTitle.mockRejectedValue(new Error('Update failed'));

      await expect(service.updateChatTitle('chat_1', 'Valid Title'))
        .rejects.toThrow('Update failed');
    });
  });

  describe('updateChatTitle — cache invalidation', () => {
    it('should invalidate chat and list caches after update', async () => {
      // Pre-populate caches
      const chat = Chat.create('Old Title');
      mockChatRepository.findById.mockResolvedValue(chat);
      await service.loadChat(chat.id);
      mockChatRepository.findAll.mockResolvedValue([chat]);
      await service.loadAllChats();

      await service.updateChatTitle(chat.id, 'New Title');

      // Next loadAllChats must hit repo again (cache invalidated)
      await service.loadAllChats();
      expect(mockChatRepository.findAll).toHaveBeenCalledTimes(2);
    });
  });

  // ==================== generateSmartTitle — extended ====================

  describe('generateSmartTitle — extended', () => {
    it('should return default for non-array input', () => {
      expect(service.generateSmartTitle(null)).toBe('New Chat');
      expect(service.generateSmartTitle(undefined)).toBe('New Chat');
    });

    it('should return default when no user messages found', () => {
      const messages = [
        { role: 'assistant', content: 'Hello!', isUser: () => false },
        { role: 'system', content: 'You are helpful', isUser: () => false },
      ];
      expect(service.generateSmartTitle(messages)).toBe('New Chat');
    });

    it('should extract first sentence ending with period', () => {
      const messages = [
        { role: 'user', content: 'Help me with this. Then do something else.', isUser: () => true },
      ];
      const title = service.generateSmartTitle(messages);
      expect(title).toBe('Help me with this.');
    });

    it('should extract first sentence ending with exclamation', () => {
      const messages = [
        { role: 'user', content: 'Fix this bug! It is urgent.', isUser: () => true },
      ];
      const title = service.generateSmartTitle(messages);
      expect(title).toBe('Fix this bug!');
    });

    it('should extract first sentence ending with question mark', () => {
      const messages = [
        { role: 'user', content: 'What is React? I want to learn.', isUser: () => true },
      ];
      const title = service.generateSmartTitle(messages);
      expect(title).toBe('What is React?');
    });

    it('should skip assistant messages and use first user message', () => {
      const messages = [
        { role: 'assistant', content: 'I am ready to help', isUser: () => false },
        { role: 'user', content: 'Tell me about TypeScript', isUser: () => true },
      ];
      const title = service.generateSmartTitle(messages);
      expect(title).toBe('Tell me about TypeScript');
    });

    it('should truncate at exactly 47 chars plus ellipsis for long content', () => {
      const longContent = 'A'.repeat(100);
      const messages = [
        { role: 'user', content: longContent, isUser: () => true },
      ];
      const title = service.generateSmartTitle(messages);
      expect(title).toBe('A'.repeat(47) + '...');
      expect(title.length).toBe(50);
    });
  });

  // ==================== searchByTitle — extended ====================

  describe('searchByTitle — extended', () => {
    it('should perform case-insensitive search', async () => {
      const mockChats = [
        Chat.create('JavaScript Guide'),
        Chat.create('Python Tutorial'),
      ];
      mockChatRepository.findAll.mockResolvedValue(mockChats);

      const results = await service.searchByTitle('javascript');

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('JavaScript Guide');
    });

    it('should propagate repository errors', async () => {
      mockChatRepository.findAll.mockRejectedValue(new Error('Search failed'));

      await expect(service.searchByTitle('test')).rejects.toThrow('Search failed');
    });
  });
});

