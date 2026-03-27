'use strict';

/**
 * ArtifactService Unit Tests
 * Tests the artifacts domain ArtifactService
 */

const { ArtifactService } = require('../../../../src/domain/artifacts/services/ArtifactService');
const { Artifact } = require('../../../../src/domain/artifacts/models/Artifact');

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
      expect(artifact.id).toEqual(expect.any(String));
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
    it('should cache streaming artifacts (in-flight only)', async () => {
      const streamData = { 
        id: 'artifact_456',
        kind: 'code', 
        content: 'test', 
        chatId: '550e8400-e29b-41d4-a716-446655440000' 
      };
      const artifact = await service.createFromStream(streamData);
      
      expect(service.streamingArtifacts.has(artifact.id)).toBe(true);
    });

    it('should clear cache', () => {
      service.clearCache();
      
      expect(service.streamingArtifacts.size).toBe(0);
    });

    it('should get cache statistics', () => {
      const stats = service.getCacheStats();
      
      expect(stats).toHaveProperty('streaming');
      expect(stats).toHaveProperty('byType');
      expect(stats).toHaveProperty('note');
    });
  });

  // ==================== CONSTRUCTOR ====================

  describe('constructor', () => {
    it('should accept custom dependencies', () => {
      const mockRepo = { save: jest.fn() };
      const mockTrace = { linkArtifactToMessage: jest.fn() };
      const mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
      const svc = new ArtifactService({
        repository: mockRepo,
        traceabilityService: mockTrace,
        logger: mockLogger,
      });
      expect(svc.repository).toBe(mockRepo);
      expect(svc.traceabilityService).toBe(mockTrace);
      expect(svc.logger).toBe(mockLogger);
    });

    it('should initialize empty streaming maps', () => {
      expect(service.streamingArtifacts).toBeInstanceOf(Map);
      expect(service.streamBuffers).toBeInstanceOf(Map);
      expect(service.streamingArtifacts.size).toBe(0);
      expect(service.streamBuffers.size).toBe(0);
    });

    it('should work without repository', () => {
      const svc = new ArtifactService({});
      expect(svc.repository).toBeUndefined();
    });
  });

  // ==================== createFromStream — extended ====================

  describe('createFromStream — extended', () => {
    it('should set streaming status on created artifact', async () => {
      const streamData = {
        id: 'art_stream_1',
        kind: 'code',
        content: 'let x = 1;',
        chatId: 'chat_1',
      };
      const artifact = await service.createFromStream(streamData);

      expect(artifact.status).toBe('streaming');
    });

    it('should cache the artifact in streamingArtifacts map', async () => {
      const streamData = {
        id: 'art_cached',
        kind: 'html',
        content: '<p>hello</p>',
        chatId: 'chat_1',
      };
      const artifact = await service.createFromStream(streamData);

      expect(service.streamingArtifacts.has(artifact.id)).toBe(true);
      expect(service.streamingArtifacts.get(artifact.id)).toBe(artifact);
    });

    it('should create output artifact type', async () => {
      const streamData = {
        id: 'art_output',
        kind: 'output',
        content: 'Result: 42',
        chatId: 'chat_1',
      };
      const artifact = await service.createFromStream(streamData);

      expect(artifact.type).toBe('output');
      expect(artifact.content).toBe('Result: 42');
    });

    it('should propagate sourceMessageId and correlationId', async () => {
      const streamData = {
        id: 'art_linked',
        kind: 'code',
        content: 'code',
        sourceMessageId: 'msg_100',
        correlationId: 'corr_200',
        chatId: 'chat_1',
      };
      const artifact = await service.createFromStream(streamData);

      expect(artifact.sourceMessageId).toBe('msg_100');
      expect(artifact.correlationId).toBe('corr_200');
    });

    it('should handle missing content gracefully', async () => {
      const streamData = {
        id: 'art_empty',
        kind: 'code',
        chatId: 'chat_1',
      };
      const artifact = await service.createFromStream(streamData);

      expect(artifact.content).toBe('');
    });

    it('should propagate errors from Artifact.fromStreamData', async () => {
      // Pass invalid data that causes fromStreamData to throw
      // Since fromStreamData is robust, force an error via prototype override
      const origFromStream = Artifact.fromStreamData;
      Artifact.fromStreamData = () => { throw new Error('Parse failure'); };

      await expect(service.createFromStream({})).rejects.toThrow('Parse failure');

      Artifact.fromStreamData = origFromStream;
    });
  });

  // ==================== updateContent ====================

  describe('updateContent', () => {
    let streamingArtifact;

    beforeEach(async () => {
      const streamData = {
        id: 'art_update',
        kind: 'code',
        content: 'line1\n',
        chatId: 'chat_1',
      };
      streamingArtifact = await service.createFromStream(streamData);
    });

    it('should append content to streaming artifact', () => {
      const updated = service.updateContent('art_update', 'line2\n');

      expect(updated).not.toBeNull();
      expect(updated.content).toBe('line1\nline2\n');
    });

    it('should return the updated artifact instance', () => {
      const updated = service.updateContent('art_update', 'more');

      expect(updated).toBeDefined();
      expect(updated.id).toBe('art_update');
      // Immutable — must be a different instance
      expect(updated).not.toBe(streamingArtifact);
    });

    it('should update the streaming cache with new instance', () => {
      service.updateContent('art_update', 'added');

      const cached = service.streamingArtifacts.get('art_update');
      expect(cached.content).toBe('line1\nadded');
    });

    it('should return null for non-existent artifact', () => {
      const result = service.updateContent('non_existent', 'data');
      expect(result).toBeNull();
    });

    it('should accumulate content across multiple updates', () => {
      service.updateContent('art_update', 'line2\n');
      service.updateContent('art_update', 'line3\n');
      const updated = service.updateContent('art_update', 'line4');

      expect(updated.content).toBe('line1\nline2\nline3\nline4');
    });

    it('should handle empty string addition', () => {
      const updated = service.updateContent('art_update', '');
      expect(updated.content).toBe('line1\n');
    });
  });

  // ==================== finalizeArtifact ====================

  describe('finalizeArtifact', () => {
    let streamingArtifact;

    beforeEach(async () => {
      const streamData = {
        id: 'art_finalize',
        kind: 'code',
        content: 'final code',
        chatId: 'chat_1',
        sourceMessageId: 'msg_src',
      };
      streamingArtifact = await service.createFromStream(streamData);
    });

    it('should mark artifact as active and persist via repository', async () => {
      mockRepository.save.mockImplementation(artifact => Promise.resolve(artifact));

      const result = await service.finalizeArtifact('art_finalize');

      expect(result).not.toBeNull();
      expect(result.status).toBe('active');
      expect(mockRepository.save).toHaveBeenCalled();
      // Verify save was called with an active-status artifact
      const savedArg = mockRepository.save.mock.calls[0][0];
      expect(savedArg.status).toBe('active');
    });

    it('should remove artifact from streaming cache after successful persist', async () => {
      mockRepository.save.mockImplementation(artifact => Promise.resolve(artifact));

      await service.finalizeArtifact('art_finalize');

      expect(service.streamingArtifacts.has('art_finalize')).toBe(false);
    });

    it('should return null for non-existent streaming artifact', async () => {
      const result = await service.finalizeArtifact('non_existent');
      expect(result).toBeNull();
    });

    it('should keep artifact in cache when persist fails (bug fix — data loss prevention)', async () => {
      // Before fix: artifact was removed from cache even on persist failure.
      // This caused data loss — artifact neither cached nor persisted.
      mockRepository.save.mockRejectedValue(new Error('DB down'));

      const result = await service.finalizeArtifact('art_finalize');

      // Artifact still in streaming cache (not lost)
      expect(service.streamingArtifacts.has('art_finalize')).toBe(true);
      // Returns the active-status artifact (caller knows finalization was attempted)
      expect(result.status).toBe('active');
    });

    it('should not call traceabilityService when persist fails', async () => {
      const mockTrace = { linkArtifactToMessage: jest.fn() };
      const svcWithTrace = new ArtifactService({
        repository: mockRepository,
        traceabilityService: mockTrace,
      });

      // Create streaming artifact in this service instance
      const streamData = {
        id: 'art_trace_test',
        kind: 'code',
        content: 'code',
        chatId: 'chat_1',
        sourceMessageId: 'msg_1',
      };
      await svcWithTrace.createFromStream(streamData);

      mockRepository.save.mockRejectedValue(new Error('DB error'));
      await svcWithTrace.finalizeArtifact('art_trace_test');

      // Traceability NOT called because persist failed
      expect(mockTrace.linkArtifactToMessage).not.toHaveBeenCalled();
    });

    it('should call traceabilityService when persist succeeds', async () => {
      const mockTrace = { linkArtifactToMessage: jest.fn() };
      const svcWithTrace = new ArtifactService({
        repository: mockRepository,
        traceabilityService: mockTrace,
      });

      const streamData = {
        id: 'art_trace_ok',
        kind: 'code',
        content: 'code',
        chatId: 'chat_1',
        sourceMessageId: 'msg_1',
      };
      await svcWithTrace.createFromStream(streamData);

      mockRepository.save.mockImplementation(a => Promise.resolve(a));
      await svcWithTrace.finalizeArtifact('art_trace_ok');

      expect(mockTrace.linkArtifactToMessage).toHaveBeenCalledWith('art_trace_ok', 'msg_1');
    });

    it('should still finalize when no repository is configured', async () => {
      const svcNoRepo = new ArtifactService({});
      const streamData = {
        id: 'art_no_repo',
        kind: 'code',
        content: 'code',
        chatId: 'chat_1',
      };
      await svcNoRepo.createFromStream(streamData);

      const result = await svcNoRepo.finalizeArtifact('art_no_repo');

      expect(result).not.toBeNull();
      expect(result.status).toBe('active');
      // Removed from cache (no repo means persist step is skipped, persistSucceeded stays true)
      expect(svcNoRepo.streamingArtifacts.has('art_no_repo')).toBe(false);
    });

    it('should handle traceabilityService error gracefully', async () => {
      const mockTrace = {
        linkArtifactToMessage: jest.fn(() => { throw new Error('Trace failed'); }),
      };
      const svcWithTrace = new ArtifactService({
        repository: mockRepository,
        traceabilityService: mockTrace,
      });

      const streamData = {
        id: 'art_trace_err',
        kind: 'code',
        content: 'code',
        chatId: 'chat_1',
        sourceMessageId: 'msg_1',
      };
      await svcWithTrace.createFromStream(streamData);
      mockRepository.save.mockImplementation(a => Promise.resolve(a));

      // Should not throw even though traceability failed
      const result = await svcWithTrace.finalizeArtifact('art_trace_err');
      expect(result).not.toBeNull();
      expect(result.status).toBe('active');
    });
  });

  // ==================== saveArtifact ====================

  describe('saveArtifact', () => {
    it('should save an Artifact instance directly', async () => {
      const artifact = Artifact.fromStreamData({
        id: 'art_save_1',
        kind: 'code',
        content: 'saved code',
        chatId: 'chat_1',
      });
      mockRepository.save.mockResolvedValue(artifact);

      const result = await service.saveArtifact(artifact);

      expect(result).toBe(artifact);
      expect(mockRepository.save).toHaveBeenCalledWith(artifact);
    });

    it('should convert plain object payload to Artifact before saving', async () => {
      const payload = {
        id: 'pg-uuid-123',
        type: 'code',
        content: 'from payload',
        language: 'python',
        chat_id: 'chat_1',
      };
      mockRepository.save.mockImplementation(a => Promise.resolve(a));

      const result = await service.saveArtifact(payload);

      expect(result).toBeDefined();
      // The saved argument should be an Artifact (converted from payload)
      const savedArg = mockRepository.save.mock.calls[0][0];
      expect(savedArg).toBeInstanceOf(Artifact);
    });

    it('should throw when repository is not available', async () => {
      const svcNoRepo = new ArtifactService({});

      const artifact = Artifact.fromStreamData({
        id: 'art_no_repo',
        kind: 'code',
        content: 'code',
        chatId: 'chat_1',
      });

      await expect(svcNoRepo.saveArtifact(artifact)).rejects.toThrow('Repository not available');
    });

    it('should propagate repository errors', async () => {
      const artifact = Artifact.fromStreamData({
        id: 'art_err',
        kind: 'code',
        content: 'code',
        chatId: 'chat_1',
      });
      mockRepository.save.mockRejectedValue(new Error('Save failed'));

      await expect(service.saveArtifact(artifact)).rejects.toThrow('Save failed');
    });
  });

  // ==================== getById — extended ====================

  describe('getById — extended', () => {
    it('should return streaming artifact from cache before querying repository', async () => {
      // Put an artifact in the streaming cache
      const streamData = {
        id: 'art_cached',
        kind: 'code',
        content: 'cached content',
        chatId: 'chat_1',
      };
      await service.createFromStream(streamData);

      const result = await service.getById('art_cached');

      expect(result).not.toBeNull();
      expect(result.content).toBe('cached content');
      // Repository should NOT be called — cache hit
      expect(mockRepository.findById).not.toHaveBeenCalled();
    });

    it('should fall back to repository when not in streaming cache', async () => {
      const mockArtifact = new Artifact({ id: 'art_repo', type: 'code', content: 'from repo' });
      mockRepository.findById.mockResolvedValue(mockArtifact);

      const result = await service.getById('art_repo');

      expect(result).toBe(mockArtifact);
      expect(mockRepository.findById).toHaveBeenCalledWith('art_repo');
    });

    it('should return null when repository returns falsy', async () => {
      mockRepository.findById.mockResolvedValue(undefined);

      const result = await service.getById('non_existent');

      expect(result).toBeNull();
    });

    it('should return null and log error when repository throws', async () => {
      mockRepository.findById.mockRejectedValue(new Error('DB error'));

      const result = await service.getById('art_err');

      expect(result).toBeNull();
    });

    it('should return null when no repository configured and not in cache', async () => {
      const svcNoRepo = new ArtifactService({});

      const result = await svcNoRepo.getById('anything');

      expect(result).toBeNull();
    });
  });

  // ==================== getByChat — extended ====================

  describe('getByChat — extended', () => {
    it('should return empty array when no repository configured', async () => {
      const svcNoRepo = new ArtifactService({});

      const result = await svcNoRepo.getByChat('chat_1');

      expect(result).toEqual([]);
    });

    it('should return empty array on repository error', async () => {
      mockRepository.findByChatId.mockRejectedValue(new Error('DB error'));

      const result = await service.getByChat('chat_1');

      expect(result).toEqual([]);
    });
  });

  // ==================== getByMessage ====================

  describe('getByMessage', () => {
    beforeEach(() => {
      mockRepository.findByMessageId = jest.fn();
    });

    it('should delegate to repository.findByMessageId', async () => {
      const artifacts = [new Artifact({ id: 'a1', type: 'code' })];
      mockRepository.findByMessageId.mockResolvedValue(artifacts);

      const result = await service.getByMessage('msg_1');

      expect(mockRepository.findByMessageId).toHaveBeenCalledWith('msg_1');
      expect(result).toBe(artifacts);
    });

    it('should return empty array when no repository', async () => {
      const svcNoRepo = new ArtifactService({});
      const result = await svcNoRepo.getByMessage('msg_1');
      expect(result).toEqual([]);
    });

    it('should return empty array on repository error', async () => {
      mockRepository.findByMessageId.mockRejectedValue(new Error('DB error'));

      const result = await service.getByMessage('msg_1');

      expect(result).toEqual([]);
    });
  });

  // ==================== getByCorrelation ====================

  describe('getByCorrelation', () => {
    beforeEach(() => {
      mockRepository.findByCorrelationId = jest.fn();
    });

    it('should delegate to repository.findByCorrelationId', async () => {
      const artifacts = [new Artifact({ id: 'a1', type: 'code' })];
      mockRepository.findByCorrelationId.mockResolvedValue(artifacts);

      const result = await service.getByCorrelation('corr_1');

      expect(mockRepository.findByCorrelationId).toHaveBeenCalledWith('corr_1');
      expect(result).toBe(artifacts);
    });

    it('should return empty array when no repository', async () => {
      const svcNoRepo = new ArtifactService({});
      const result = await svcNoRepo.getByCorrelation('corr_1');
      expect(result).toEqual([]);
    });

    it('should return empty array on repository error', async () => {
      mockRepository.findByCorrelationId.mockRejectedValue(new Error('DB error'));

      const result = await service.getByCorrelation('corr_1');

      expect(result).toEqual([]);
    });
  });

  // ==================== linkToMessage ====================

  describe('linkToMessage', () => {
    beforeEach(() => {
      mockRepository.updateMessageLink = jest.fn().mockResolvedValue(undefined);
    });

    it('should link artifact to message and update repository', async () => {
      const artifact = new Artifact({
        id: 'art_link',
        type: 'code',
        content: 'code',
      });
      mockRepository.findById.mockResolvedValue(artifact);

      const result = await service.linkToMessage('art_link', 'msg_target', 'corr_1');

      expect(result).not.toBeNull();
      expect(result.sourceMessageId).toBe('msg_target');
      expect(result.correlationId).toBe('corr_1');
      expect(mockRepository.updateMessageLink).toHaveBeenCalledWith('art_link', 'msg_target');
    });

    it('should return null when artifact not found', async () => {
      mockRepository.findById.mockResolvedValue(null);

      const result = await service.linkToMessage('non_existent', 'msg_1');

      expect(result).toBeNull();
    });

    it('should call traceabilityService when available', async () => {
      const mockTrace = { linkArtifactToMessage: jest.fn() };
      const svcWithTrace = new ArtifactService({
        repository: mockRepository,
        traceabilityService: mockTrace,
      });

      const artifact = new Artifact({ id: 'art_t', type: 'code', content: 'c' });
      mockRepository.findById.mockResolvedValue(artifact);

      await svcWithTrace.linkToMessage('art_t', 'msg_t');

      expect(mockTrace.linkArtifactToMessage).toHaveBeenCalledWith('art_t', 'msg_t');
    });

    it('should handle repository updateMessageLink error gracefully', async () => {
      const artifact = new Artifact({ id: 'art_e', type: 'code', content: 'c' });
      mockRepository.findById.mockResolvedValue(artifact);
      mockRepository.updateMessageLink.mockRejectedValue(new Error('Link failed'));

      // Should NOT throw — error is caught and logged
      const result = await service.linkToMessage('art_e', 'msg_e');

      // Returns linked artifact (in-memory) despite repo failure
      expect(result).not.toBeNull();
      expect(result.sourceMessageId).toBe('msg_e');
    });

    it('should handle traceabilityService error gracefully in linkToMessage', async () => {
      const mockTrace = {
        linkArtifactToMessage: jest.fn(() => { throw new Error('Trace link failed'); }),
      };
      const svcWithTrace = new ArtifactService({
        repository: mockRepository,
        traceabilityService: mockTrace,
      });
      const artifact = new Artifact({ id: 'art_te', type: 'code', content: 'c' });
      mockRepository.findById.mockResolvedValue(artifact);
      mockRepository.updateMessageLink.mockResolvedValue(undefined);

      // Should NOT throw despite traceability error
      const result = await svcWithTrace.linkToMessage('art_te', 'msg_te');
      expect(result).not.toBeNull();
      expect(result.sourceMessageId).toBe('msg_te');
    });

    it('should link streaming artifact from cache', async () => {
      const streamData = {
        id: 'art_stream_link',
        kind: 'code',
        content: 'streaming code',
        chatId: 'chat_1',
      };
      await service.createFromStream(streamData);

      const result = await service.linkToMessage('art_stream_link', 'msg_new');

      expect(result).not.toBeNull();
      expect(result.sourceMessageId).toBe('msg_new');
      // Repository findById should NOT be called — cache hit
      expect(mockRepository.findById).not.toHaveBeenCalled();
    });
  });

  // ==================== archive ====================

  describe('archive', () => {
    it('should set artifact status to archived and persist', async () => {
      const artifact = new Artifact({ id: 'art_arch', type: 'code', content: 'c', status: 'active' });
      mockRepository.findById.mockResolvedValue(artifact);
      mockRepository.save.mockImplementation(a => Promise.resolve(a));

      const result = await service.archive('art_arch');

      expect(result).not.toBeNull();
      expect(result.status).toBe('archived');
      expect(mockRepository.save).toHaveBeenCalled();
      const savedArg = mockRepository.save.mock.calls[0][0];
      expect(savedArg.status).toBe('archived');
    });

    it('should return null when artifact not found', async () => {
      mockRepository.findById.mockResolvedValue(null);

      const result = await service.archive('non_existent');

      expect(result).toBeNull();
      expect(mockRepository.save).not.toHaveBeenCalled();
    });

    it('should return null when getById fails (repo error swallowed by getById)', async () => {
      // getById catches repo errors internally and returns null
      // archive sees null artifact and returns null
      mockRepository.findById.mockRejectedValue(new Error('Archive query failed'));

      const result = await service.archive('art_err');
      expect(result).toBeNull();
    });

    it('should skip persistence when no repository', async () => {
      // Create a service with no repo, put artifact in streaming cache
      const svcNoRepo = new ArtifactService({});
      const streamData = { id: 'art_norepo', kind: 'code', content: 'c', chatId: 'c1' };
      await svcNoRepo.createFromStream(streamData);

      const result = await svcNoRepo.archive('art_norepo');

      expect(result).not.toBeNull();
      expect(result.status).toBe('archived');
    });
  });

  // ==================== delete — extended ====================

  describe('delete — extended', () => {
    it('should set status to deleted and persist via repository.save', async () => {
      const artifact = new Artifact({ id: 'art_del', type: 'code', content: 'c', status: 'active' });
      mockRepository.findById.mockResolvedValue(artifact);
      mockRepository.save.mockImplementation(a => Promise.resolve(a));

      const result = await service.delete('art_del');

      expect(result).toBe(true);
      expect(mockRepository.save).toHaveBeenCalled();
      const savedArg = mockRepository.save.mock.calls[0][0];
      expect(savedArg.status).toBe('deleted');
    });

    it('should propagate errors from repository', async () => {
      const artifact = new Artifact({ id: 'art_del_err', type: 'code', content: 'c' });
      mockRepository.findById.mockResolvedValue(artifact);
      mockRepository.save.mockRejectedValue(new Error('Delete persist failed'));

      await expect(service.delete('art_del_err')).rejects.toThrow('Delete persist failed');
    });
  });

  // ==================== clearCache — extended ====================

  describe('clearCache — extended', () => {
    it('should clear both streamingArtifacts and streamBuffers maps', async () => {
      // Populate streaming cache
      await service.createFromStream({ id: 'a1', kind: 'code', content: 'c', chatId: 'c1' });
      await service.createFromStream({ id: 'a2', kind: 'html', content: 'h', chatId: 'c1' });
      // Manually add a stream buffer entry
      service.streamBuffers.set('stream_1', { artifact: null, buffer: '' });

      expect(service.streamingArtifacts.size).toBe(2);
      expect(service.streamBuffers.size).toBe(1);

      service.clearCache();

      expect(service.streamingArtifacts.size).toBe(0);
      expect(service.streamBuffers.size).toBe(0);
    });
  });

  // ==================== getCacheStats — extended ====================

  describe('getCacheStats — extended', () => {
    it('should return accurate type breakdown for populated cache', async () => {
      await service.createFromStream({ id: 'c1', kind: 'code', content: '1', chatId: 'c' });
      await service.createFromStream({ id: 'c2', kind: 'code', content: '2', chatId: 'c' });
      await service.createFromStream({ id: 'h1', kind: 'html', content: '3', chatId: 'c' });
      await service.createFromStream({ id: 'o1', kind: 'output', content: '4', chatId: 'c' });

      const stats = service.getCacheStats();

      expect(stats.streaming).toBe(4);
      expect(stats.byType.code).toBe(2);
      expect(stats.byType.html).toBe(1);
      expect(stats.byType.output).toBe(1);
      expect(stats.byType.file).toBe(0);
    });

    it('should return zero counts for empty cache', () => {
      const stats = service.getCacheStats();

      expect(stats.streaming).toBe(0);
      expect(stats.byType.code).toBe(0);
      expect(stats.byType.output).toBe(0);
      expect(stats.byType.html).toBe(0);
      expect(stats.byType.file).toBe(0);
    });
  });

  // ==================== Full lifecycle integration ====================

  describe('full streaming lifecycle', () => {
    it('should support create -> update -> finalize -> cache empty', async () => {
      // 1. Create streaming artifact
      const streamData = {
        id: 'art_lifecycle',
        kind: 'code',
        content: 'function foo() {\n',
        chatId: 'chat_1',
        sourceMessageId: 'msg_1',
      };
      const created = await service.createFromStream(streamData);
      expect(created.status).toBe('streaming');
      expect(service.streamingArtifacts.size).toBe(1);

      // 2. Update content (streaming chunks)
      service.updateContent('art_lifecycle', '  return 42;\n');
      const updated = service.updateContent('art_lifecycle', '}');
      expect(updated.content).toBe('function foo() {\n  return 42;\n}');

      // 3. Finalize
      mockRepository.save.mockImplementation(a => Promise.resolve(a));
      const finalized = await service.finalizeArtifact('art_lifecycle');
      expect(finalized.status).toBe('active');

      // 4. Cache is empty
      expect(service.streamingArtifacts.size).toBe(0);
    });
  });
});

