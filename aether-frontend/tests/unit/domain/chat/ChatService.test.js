'use strict';

/**
 * ChatService Unit Tests
 * Tests the chat domain ChatService
 */

const { ChatService } = require('../../../../src/domain/chat/services/ChatService');
const { Chat } = require('../../../../src/domain/chat/models/Chat');
const { ChatValidator } = require('../../../../src/domain/chat/validators/ChatValidator');

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
      
      expect(chat.id).toBeTruthy();
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
});

