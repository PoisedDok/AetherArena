'use strict';

/**
 * ArtifactService Unit Tests
 * Tests the artifacts domain ArtifactService
 */

const { ArtifactService } = require('../../../../src/domain/artifacts/services/ArtifactService');

describe('ArtifactService', () => {
  let service;
  let mockRepository;
  
  beforeEach(() => {
    mockRepository = {
      save: jest.fn().mockResolvedValue(true),
      findById: jest.fn(),
      findAll: jest.fn().mockResolvedValue([]),
      findByChatId: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(true),
    };
    
    service = new ArtifactService({ repository: mockRepository });
  });

  afterEach(() => {
    service = null;
    mockRepository = null;
  });

  describe('createFromStream', () => {
    it('should create a code artifact from stream', async () => {
      const streamData = {
        id: 'artifact_123',
        kind: 'code',
        language: 'javascript',
        content: 'console.log("test");',
        chatId: '550e8400-e29b-41d4-a716-446655440000',
        sourceMessageId: 'msg_456'
      };
      
      const artifact = await service.createFromStream(streamData);
      
      expect(artifact.type).toBe('code');
      expect(artifact.language).toBe('javascript');
      expect(artifact.content).toBe(streamData.content);
      expect(artifact.id).toBeTruthy();
    });

  });

  describe('getById', () => {
    it('should retrieve artifact by ID', async () => {
      const mockArtifact = {
        id: 'artifact_123',
        type: 'code',
        content: 'test'
      };
      mockRepository.findById.mockResolvedValue(mockArtifact);
      
      const artifact = await service.getById('artifact_123');
      
      expect(artifact).toEqual(mockArtifact);
      expect(mockRepository.findById).toHaveBeenCalledWith('artifact_123');
    });

    it('should return null for non-existent artifact', async () => {
      mockRepository.findById.mockResolvedValue(null);
      
      const artifact = await service.getById('non_existent');
      
      expect(artifact).toBeNull();
    });
  });

  describe('getByChat', () => {
    it('should retrieve all artifacts for a chat', async () => {
      const chatId = 'chat_123';
      const mockArtifacts = [
        { id: 'artifact_1', type: 'code', chatId },
        { id: 'artifact_2', type: 'output', chatId }
      ];
      mockRepository.findByChatId.mockResolvedValue(mockArtifacts);
      
      const artifacts = await service.getByChat(chatId);
      
      expect(artifacts).toEqual(mockArtifacts);
      expect(artifacts.length).toBe(2);
      expect(mockRepository.findByChatId).toHaveBeenCalledWith(chatId);
    });

    it('should return empty array when no artifacts', async () => {
      mockRepository.findByChatId.mockResolvedValue([]);
      
      const artifacts = await service.getByChat('chat_123');
      
      expect(artifacts).toEqual([]);
    });
  });

  describe('delete', () => {
    it('should delete artifact by ID', async () => {
      const mockArtifact = { id: 'artifact_123', withStatus: jest.fn().mockReturnThis() };
      mockRepository.findById.mockResolvedValue(mockArtifact);
      
      const result = await service.delete('artifact_123');
      
      expect(result).toBe(true);
    });

    it('should return false when artifact not found', async () => {
      mockRepository.findById.mockResolvedValue(null);
      
      const result = await service.delete('non_existent');
      
      expect(result).toBe(false);
    });
  });

  describe('Cache management', () => {
    it('should cache active artifacts', async () => {
      const streamData = { 
        id: 'artifact_456',
        kind: 'code', 
        content: 'test', 
        chatId: '550e8400-e29b-41d4-a716-446655440000' 
      };
      const artifact = await service.createFromStream(streamData);
      
      expect(service.activeArtifacts.has(artifact.id)).toBe(true);
    });

    it('should clear cache', () => {
      service.clearCache();
      
      expect(service.activeArtifacts.size).toBe(0);
    });

    it('should get cache statistics', () => {
      const stats = service.getCacheStats();
      
      expect(stats).toHaveProperty('total');
      expect(stats).toHaveProperty('byType');
      expect(stats).toHaveProperty('byStatus');
    });
  });
});

