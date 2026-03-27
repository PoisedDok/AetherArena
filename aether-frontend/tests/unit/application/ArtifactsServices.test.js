'use strict';

jest.mock('../../../src/domain/artifacts/services/ArtifactService');
jest.mock('../../../src/domain/artifacts/repositories/ArtifactRepository');
jest.mock('../../../src/domain/artifacts/validators/CodeExecutionValidator');
jest.mock('../../../src/domain/artifacts/validators/FileExportValidator');
jest.mock('../../../src/domain/artifacts/services/ExecutionResultFormatter');
jest.mock('../../../src/domain/artifacts/services/ArtifactRouter');
jest.mock('../../../src/domain/artifacts/services/ArtifactEnricher');
jest.mock('../../../src/domain/artifacts/state/ArtifactCache');
jest.mock('../../../src/domain/artifacts/services/ArtifactIndexService');
jest.mock('../../../src/infrastructure/monitoring/BackendHealthProbe');

const {
  ArtifactsServices,
  CodeExecutionValidator,
  FileExportValidator,
  ExecutionResultFormatter,
  ArtifactRouter,
  ArtifactEnricher,
} = require('../../../src/application/artifacts/ArtifactsServices');

const { ArtifactService } = require('../../../src/domain/artifacts/services/ArtifactService');
const { ArtifactRepository } = require('../../../src/domain/artifacts/repositories/ArtifactRepository');
const { ArtifactCache } = require('../../../src/domain/artifacts/state/ArtifactCache');
const { ArtifactIndexService } = require('../../../src/domain/artifacts/services/ArtifactIndexService');
const { BackendHealthProbe } = require('../../../src/infrastructure/monitoring/BackendHealthProbe');

describe('ArtifactsServices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // Constructor — default instantiation
  // =========================================================================
  describe('constructor with defaults', () => {
    it('creates all services when no pre-built instances provided', () => {
      const mockStorage = { load: jest.fn() };
      const mockLogger = { info: jest.fn() };

      const svc = new ArtifactsServices({
        storageAPI: mockStorage,
        logger: mockLogger,
      });

      expect(ArtifactRepository).toHaveBeenCalledWith({
        storageAPI: mockStorage,
        logger: mockLogger,
      });
      expect(ArtifactService).toHaveBeenCalledWith({
        repository: expect.any(Object),
        logger: mockLogger,
      });
      expect(ArtifactCache).toHaveBeenCalledWith({});
      expect(ArtifactIndexService).toHaveBeenCalledWith();
      expect(BackendHealthProbe).toHaveBeenCalledWith({
        storageAPI: mockStorage,
        systemAPI: null,
      });

      // Verify all service instances are set (mock constructors return mock instances)
      expect(svc.artifactRepository).not.toBeNull();
      expect(svc.artifactService).not.toBeNull();
      expect(svc.artifactCache).not.toBeNull();
      expect(svc.artifactIndexService).not.toBeNull();
      expect(svc.backendHealthProbe).not.toBeNull();
    });

    it('passes cacheOptions to ArtifactCache', () => {
      const cacheOpts = { maxSize: 500, ttl: 60000 };
      new ArtifactsServices({ cacheOptions: cacheOpts });
      expect(ArtifactCache).toHaveBeenCalledWith(cacheOpts);
    });

    it('passes systemAPI to BackendHealthProbe', () => {
      const mockSystem = { getStats: jest.fn() };
      new ArtifactsServices({ systemAPI: mockSystem });
      expect(BackendHealthProbe).toHaveBeenCalledWith(
        expect.objectContaining({ systemAPI: mockSystem })
      );
    });

    it('defaults to empty object when no options', () => {
      expect(() => new ArtifactsServices()).not.toThrow();
      expect(ArtifactRepository).toHaveBeenCalledWith({
        storageAPI: undefined,
        logger: undefined,
      });
    });
  });

  // =========================================================================
  // Constructor — pre-built instances (dependency injection)
  // =========================================================================
  describe('constructor with injected dependencies', () => {
    it('uses provided artifactRepository instead of creating new', () => {
      const customRepo = { findById: jest.fn() };
      const svc = new ArtifactsServices({ artifactRepository: customRepo });
      expect(svc.artifactRepository).toBe(customRepo);
    });

    it('uses provided artifactService', () => {
      const customSvc = { loadArtifact: jest.fn() };
      const svc = new ArtifactsServices({ artifactService: customSvc });
      expect(svc.artifactService).toBe(customSvc);
    });

    it('uses provided artifactCache', () => {
      const customCache = { get: jest.fn(), set: jest.fn() };
      const svc = new ArtifactsServices({ artifactCache: customCache });
      expect(svc.artifactCache).toBe(customCache);
    });

    it('uses provided artifactIndexService', () => {
      const customIdx = { getIndex: jest.fn() };
      const svc = new ArtifactsServices({ artifactIndexService: customIdx });
      expect(svc.artifactIndexService).toBe(customIdx);
    });

    it('uses provided backendHealthProbe', () => {
      const customProbe = { check: jest.fn() };
      const svc = new ArtifactsServices({ backendHealthProbe: customProbe });
      expect(svc.backendHealthProbe).toBe(customProbe);
    });

    it('mixes injected and default instances', () => {
      const customCache = { get: jest.fn() };
      const svc = new ArtifactsServices({ artifactCache: customCache });
      expect(svc.artifactCache).toBe(customCache);
      // Other services created normally
      expect(ArtifactRepository).toHaveBeenCalled();
      expect(ArtifactService).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Re-exports
  // =========================================================================
  describe('module re-exports', () => {
    it('exports CodeExecutionValidator as a constructor', () => {
      expect(typeof CodeExecutionValidator).toBe('function');
    });

    it('exports FileExportValidator as a constructor', () => {
      expect(typeof FileExportValidator).toBe('function');
    });

    it('exports ExecutionResultFormatter as a constructor', () => {
      expect(typeof ExecutionResultFormatter).toBe('function');
    });

    it('exports ArtifactRouter as a constructor', () => {
      expect(typeof ArtifactRouter).toBe('function');
    });

    it('exports ArtifactEnricher as a constructor', () => {
      expect(typeof ArtifactEnricher).toBe('function');
    });

    it('all 6 expected exports present in module', () => {
      const mod = require('../../../src/application/artifacts/ArtifactsServices');
      expect(Object.keys(mod).sort()).toEqual([
        'ArtifactEnricher',
        'ArtifactRouter',
        'ArtifactsServices',
        'CodeExecutionValidator',
        'ExecutionResultFormatter',
        'FileExportValidator',
      ]);
    });
  });
});
