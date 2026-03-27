'use strict';

const { ArtifactEnricher } = require('../../../../../src/domain/artifacts/services/ArtifactEnricher');

// --- Helpers ---

function validArtifact(overrides = {}) {
  return { id: 'art-001', type: 'code', content: 'const x = 1;', ...overrides };
}

function validClassification(overrides = {}) {
  return { role: 'assistant', type: 'code', format: 'javascript', viewer: 'code', tab: 'code', ...overrides };
}

// --- enrich() ---

describe('ArtifactEnricher', () => {
  describe('enrich()', () => {
    it('creates enriched artifact with classification data', () => {
      const art = validArtifact();
      const cls = validClassification();
      const enriched = ArtifactEnricher.enrich(art, cls);

      expect(enriched.id).toBe('art-001');
      expect(enriched.role).toBe('assistant');
      expect(enriched.type).toBe('code');
      expect(enriched.format).toBe('javascript');
      expect(enriched.__viewer).toBe('code');
      expect(enriched.__tab).toBe('code');
      expect(enriched.__enriched).toBe(true);
      expect(enriched.__enrichedBy).toBe('ArtifactEnricher');
      expect(enriched.__enrichedAt).toBeGreaterThan(0);
    });

    it('preserves original artifact properties', () => {
      const art = validArtifact({ custom: 'value', nested: { a: 1 } });
      const enriched = ArtifactEnricher.enrich(art, validClassification());
      expect(enriched.custom).toBe('value');
      expect(enriched.nested).toEqual({ a: 1 });
    });

    it('does NOT modify original artifact (immutable input)', () => {
      const art = validArtifact();
      ArtifactEnricher.enrich(art, validClassification());
      expect(art.__enriched).toBeUndefined();
      expect(art.role).toBeUndefined();
    });

    it('prefers artifact.language over classification.language', () => {
      const art = validArtifact({ language: 'python' });
      const enriched = ArtifactEnricher.enrich(art, validClassification({ language: 'javascript' }));
      expect(enriched.language).toBe('python');
    });

    it('falls back to classification.language when artifact lacks it', () => {
      const enriched = ArtifactEnricher.enrich(validArtifact(), validClassification({ language: 'rust' }));
      expect(enriched.language).toBe('rust');
    });

    it('sets language to null when neither has it', () => {
      const enriched = ArtifactEnricher.enrich(validArtifact(), validClassification());
      expect(enriched.language).toBeNull();
    });

    it('prefers artifact.filename over classification.filename', () => {
      const art = validArtifact({ filename: 'app.js' });
      const enriched = ArtifactEnricher.enrich(art, validClassification({ filename: 'other.js' }));
      expect(enriched.filename).toBe('app.js');
    });

    it('returns mutable object (not frozen)', () => {
      const enriched = ArtifactEnricher.enrich(validArtifact(), validClassification());
      expect(() => { enriched.newProp = 'allowed'; }).not.toThrow();
    });

    // Validation
    it('throws on null artifact', () => {
      expect(() => ArtifactEnricher.enrich(null, validClassification())).toThrow('Artifact must be a plain object');
    });

    it('throws on array artifact', () => {
      expect(() => ArtifactEnricher.enrich([], validClassification())).toThrow('Artifact must be a plain object');
    });

    it('throws on artifact without id or artifactId', () => {
      expect(() => ArtifactEnricher.enrich({}, validClassification())).toThrow('id or artifactId');
    });

    it('accepts artifactId as alternative to id', () => {
      const art = { artifactId: 'alt-id', content: 'x' };
      expect(() => ArtifactEnricher.enrich(art, validClassification())).not.toThrow();
    });

    it('throws on null classification', () => {
      expect(() => ArtifactEnricher.enrich(validArtifact(), null)).toThrow('Classification must be a plain object');
    });

    it('throws on classification missing role', () => {
      expect(() => ArtifactEnricher.enrich(validArtifact(), { type: 'code', format: 'js', viewer: 'code' }))
        .toThrow('role (string)');
    });

    it('throws on classification missing type', () => {
      expect(() => ArtifactEnricher.enrich(validArtifact(), { role: 'assistant', format: 'js', viewer: 'code' }))
        .toThrow('type (string)');
    });

    it('throws on classification missing format', () => {
      expect(() => ArtifactEnricher.enrich(validArtifact(), { role: 'assistant', type: 'code', viewer: 'code' }))
        .toThrow('format (string)');
    });

    it('throws on classification missing viewer', () => {
      expect(() => ArtifactEnricher.enrich(validArtifact(), { role: 'assistant', type: 'code', format: 'js' }))
        .toThrow('viewer (string)');
    });
  });

  describe('enrichWithMetadata()', () => {
    it('merges custom metadata', () => {
      const art = validArtifact({ metadata: { existing: 'yes' } });
      const enriched = ArtifactEnricher.enrichWithMetadata(art, { custom: 'value' });
      expect(enriched.metadata.existing).toBe('yes');
      expect(enriched.metadata.custom).toBe('value');
      expect(enriched.metadata.updatedAt).toBeGreaterThan(0);
    });

    it('does NOT modify original artifact', () => {
      const art = validArtifact();
      ArtifactEnricher.enrichWithMetadata(art, { key: 'val' });
      expect(art.metadata).toBeUndefined();
    });

    it('throws on null metadata', () => {
      expect(() => ArtifactEnricher.enrichWithMetadata(validArtifact(), null)).toThrow('Metadata must be a plain object');
    });

    it('throws on array metadata', () => {
      expect(() => ArtifactEnricher.enrichWithMetadata(validArtifact(), [1, 2])).toThrow('Metadata must be a plain object');
    });
  });

  describe('enrichBatch()', () => {
    it('enriches array of artifacts', () => {
      const arts = [validArtifact({ id: 'a1' }), validArtifact({ id: 'a2' })];
      const enrichFn = () => validClassification();
      const result = ArtifactEnricher.enrichBatch(arts, enrichFn);
      expect(result).toHaveLength(2);
      expect(result[0].__enriched).toBe(true);
      expect(result[1].__enriched).toBe(true);
    });

    it('passes artifact and index to enrichFn', () => {
      const arts = [validArtifact({ id: 'a1' })];
      const enrichFn = jest.fn(() => validClassification());
      ArtifactEnricher.enrichBatch(arts, enrichFn);
      expect(enrichFn).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), 0);
    });

    it('throws on non-array artifacts', () => {
      expect(() => ArtifactEnricher.enrichBatch('not array', jest.fn())).toThrow('Artifacts must be an array');
    });

    it('throws on non-function enrichFn', () => {
      expect(() => ArtifactEnricher.enrichBatch([], 'not fn')).toThrow('Enrich function must be a function');
    });

    it('wraps enrichment errors with index', () => {
      const arts = [validArtifact(), { noId: true }]; // second lacks id
      const enrichFn = () => validClassification();
      expect(() => ArtifactEnricher.enrichBatch(arts, enrichFn)).toThrow('index 1');
    });
  });

  describe('stripMetadata()', () => {
    it('removes internal metadata fields', () => {
      const enriched = ArtifactEnricher.enrich(validArtifact(), validClassification());
      const clean = ArtifactEnricher.stripMetadata(enriched);

      expect(clean.__viewer).toBeUndefined();
      expect(clean.__tab).toBeUndefined();
      expect(clean.__enriched).toBeUndefined();
      expect(clean.__enrichedAt).toBeUndefined();
      expect(clean.__enrichedBy).toBeUndefined();
      expect(clean.id).toBe('art-001');
    });

    it('returns frozen object', () => {
      const clean = ArtifactEnricher.stripMetadata(validArtifact());
      expect(() => { clean.newProp = 'x'; }).toThrow();
    });

    it('throws on null/non-object', () => {
      expect(() => ArtifactEnricher.stripMetadata(null)).toThrow('Artifact must be an object');
      expect(() => ArtifactEnricher.stripMetadata('string')).toThrow('Artifact must be an object');
    });
  });

  describe('merge()', () => {
    it('merges base and updates into new object', () => {
      const base = validArtifact({ content: 'old' });
      const merged = ArtifactEnricher.merge(base, { content: 'new' });
      expect(merged.content).toBe('new');
      expect(merged.id).toBe('art-001');
      expect(merged.updatedAt).toBeGreaterThan(0);
    });

    it('preserves base id when updates.id is undefined', () => {
      const merged = ArtifactEnricher.merge(validArtifact(), { content: 'updated' });
      expect(merged.id).toBe('art-001');
    });

    it('allows updates.id to override base.id', () => {
      const merged = ArtifactEnricher.merge(validArtifact(), { id: 'new-id' });
      expect(merged.id).toBe('new-id');
    });

    it('returns frozen object', () => {
      const merged = ArtifactEnricher.merge(validArtifact(), { content: 'x' });
      expect(() => { merged.extra = 'y'; }).toThrow();
    });

    it('does NOT modify base artifact', () => {
      const base = validArtifact();
      ArtifactEnricher.merge(base, { content: 'new' });
      expect(base.content).toBe('const x = 1;');
    });

    it('throws on non-object updates', () => {
      expect(() => ArtifactEnricher.merge(validArtifact(), null)).toThrow('Updates must be a plain object');
      expect(() => ArtifactEnricher.merge(validArtifact(), [1])).toThrow('Updates must be a plain object');
    });
  });

  describe('isEnriched()', () => {
    it('returns true for enriched artifacts', () => {
      const enriched = ArtifactEnricher.enrich(validArtifact(), validClassification());
      expect(ArtifactEnricher.isEnriched(enriched)).toBe(true);
    });

    it('returns false for non-enriched artifacts', () => {
      expect(ArtifactEnricher.isEnriched(validArtifact())).toBe(false);
    });

    it('returns false for null/non-objects', () => {
      expect(ArtifactEnricher.isEnriched(null)).toBe(false);
      expect(ArtifactEnricher.isEnriched('string')).toBe(false);
    });
  });

  describe('getEnrichmentMetadata()', () => {
    it('returns frozen metadata for enriched artifact', () => {
      const enriched = ArtifactEnricher.enrich(validArtifact(), validClassification());
      const meta = ArtifactEnricher.getEnrichmentMetadata(enriched);
      expect(meta.enrichedBy).toBe('ArtifactEnricher');
      expect(meta.viewer).toBe('code');
      expect(meta.tab).toBe('code');
      expect(meta.enrichedAt).toBeGreaterThan(0);
      expect(() => { meta.extra = 'x'; }).toThrow();
    });

    it('returns null for non-enriched artifact', () => {
      expect(ArtifactEnricher.getEnrichmentMetadata(validArtifact())).toBeNull();
    });

    it('returns null for null input', () => {
      expect(ArtifactEnricher.getEnrichmentMetadata(null)).toBeNull();
    });
  });
});
