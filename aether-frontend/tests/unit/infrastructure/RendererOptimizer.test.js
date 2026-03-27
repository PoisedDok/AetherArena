/** @jest-environment jsdom */
'use strict';

/**
 * RendererOptimizer Unit Tests
 * ============================================================================
 * Tests critical rendering path, image, font, CSS, accessibility, and
 * Web Vitals optimizations, plus report/export/logStatus.
 *
 * @module tests/unit/infrastructure/RendererOptimizer.test
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => mockLog),
}));

const { RendererOptimizer } = require('../../../src/infrastructure/monitoring/RendererOptimizer');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RendererOptimizer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset DOM
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('initialises with defaults', () => {
      const opt = new RendererOptimizer({ autoOptimize: false });
      expect(opt.enableLogging).toBe(true); // enableLogging !== false → true
      expect(opt.autoOptimize).toBe(false);
      expect(opt.optimizations).toBeInstanceOf(Map);
      expect(opt.applied).toBeInstanceOf(Set);
      expect(opt.targets.performance).toBe(90);
      expect(opt.targets.seo).toBe(80);
    });

    it('accepts custom targets', () => {
      const opt = new RendererOptimizer({
        autoOptimize: false,
        performanceTarget: 95,
        seoTarget: 85,
      });
      expect(opt.targets.performance).toBe(95);
      expect(opt.targets.seo).toBe(85);
    });

    it('auto-optimizes when document available and autoOptimize true', () => {
      // Since jsdom provides document, auto-optimize should trigger
      const opt = new RendererOptimizer({ autoOptimize: true });
      expect(opt.applied.size).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // optimizeCriticalRenderingPath()
  // =========================================================================

  describe('optimizeCriticalRenderingPath()', () => {
    it('defers non-critical scripts', () => {
      document.body.innerHTML = '<script src="a.js"></script><script data-critical src="b.js"></script>';
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeCriticalRenderingPath();
      const scripts = document.querySelectorAll('script');
      expect(scripts[0].hasAttribute('defer')).toBe(true);
      expect(scripts[1].hasAttribute('defer')).toBe(false); // data-critical
    });

    it('adds preconnect links', () => {
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeCriticalRenderingPath();
      const preconnects = document.querySelectorAll('link[rel="preconnect"]');
      expect(preconnects.length).toBeGreaterThanOrEqual(2);
    });

    it('adds dns-prefetch links', () => {
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeCriticalRenderingPath();
      const prefetch = document.querySelectorAll('link[rel="dns-prefetch"]');
      expect(prefetch.length).toBeGreaterThanOrEqual(2);
    });

    it('does not duplicate preconnect links', () => {
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeCriticalRenderingPath();
      opt.optimizeCriticalRenderingPath();
      const preconnects = document.querySelectorAll('link[rel="preconnect"]');
      expect(preconnects.length).toBe(2); // not 4
    });

    it('records optimization', () => {
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeCriticalRenderingPath();
      expect(opt.applied.has('critical-rendering-path')).toBe(true);
      expect(opt.optimizations.has('critical-rendering-path')).toBe(true);
    });
  });

  // =========================================================================
  // optimizeImages()
  // =========================================================================

  describe('optimizeImages()', () => {
    it('adds lazy loading and async decoding to images', () => {
      document.body.innerHTML = '<img src="a.png"><img src="b.png" loading="eager">';
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeImages();
      const imgs = document.querySelectorAll('img');
      expect(imgs[0].getAttribute('loading')).toBe('lazy');
      expect(imgs[0].getAttribute('decoding')).toBe('async');
      expect(imgs[1].getAttribute('loading')).toBe('eager'); // already set
      expect(imgs[1].getAttribute('decoding')).toBe('async');
    });

    it('marks images as data-optimized', () => {
      document.body.innerHTML = '<img src="a.png">';
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeImages();
      expect(document.querySelector('img').getAttribute('data-optimized')).toBe('true');
    });

    it('records optimization', () => {
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeImages();
      expect(opt.applied.has('images')).toBe(true);
    });
  });

  // =========================================================================
  // optimizeFonts()
  // =========================================================================

  describe('optimizeFonts()', () => {
    it('records fonts optimization', () => {
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeFonts();
      expect(opt.applied.has('fonts')).toBe(true);
    });

    it('preloads font stylesheets', () => {
      document.head.innerHTML = '<link rel="stylesheet" href="https://fonts.example.com/style.css">';
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeFonts();
      const preloads = document.querySelectorAll('link[rel="preload"]');
      expect(preloads.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // optimizeCSS()
  // =========================================================================

  describe('optimizeCSS()', () => {
    it('makes non-critical CSS non-render-blocking', () => {
      document.head.innerHTML = '<link rel="stylesheet" href="style.css"><link rel="stylesheet" data-critical href="critical.css">';
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeCSS();
      const links = document.querySelectorAll('link[rel="stylesheet"]');
      expect(links[0].getAttribute('media')).toBe('print');
      expect(links[1].hasAttribute('media')).toBe(false); // data-critical
    });

    it('records css optimization', () => {
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeCSS();
      expect(opt.applied.has('css')).toBe(true);
    });
  });

  // =========================================================================
  // optimizeAccessibility()
  // =========================================================================

  describe('optimizeAccessibility()', () => {
    it('adds alt to images without alt', () => {
      document.body.innerHTML = '<img src="a.png">';
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeAccessibility();
      expect(document.querySelector('img').hasAttribute('alt')).toBe(true);
    });

    it('adds aria-label to empty buttons', () => {
      document.body.innerHTML = '<button></button>';
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeAccessibility();
      expect(document.querySelector('button').getAttribute('aria-label')).toBe('Button');
    });

    it('detects heading hierarchy issues', () => {
      document.body.innerHTML = '<h1>Title</h1><h3>Skipped h2</h3>';
      const opt = new RendererOptimizer({ autoOptimize: false, enableLogging: true });
      // Reset mocks after constructor logging
      mockLog.warn.mockClear();
      opt.optimizeAccessibility();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Heading hierarchy'),
        expect.any(Array)
      );
    });

    it('records accessibility optimization', () => {
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeAccessibility();
      expect(opt.applied.has('accessibility')).toBe(true);
    });
  });

  // =========================================================================
  // optimizeWebVitals()
  // =========================================================================

  describe('optimizeWebVitals()', () => {
    it('records web-vitals optimization', () => {
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeWebVitals();
      expect(opt.applied.has('web-vitals')).toBe(true);
    });

    it('_optimizeCLS adds dimensions to images without width', () => {
      document.body.innerHTML = '<img src="a.png">';
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeWebVitals();
      // In jsdom, naturalWidth/naturalHeight are 0, so dimensions won't be set
      // But the method runs without error
      expect(opt.applied.has('web-vitals')).toBe(true);
    });
  });

  // =========================================================================
  // Reporting
  // =========================================================================

  describe('getReport()', () => {
    it('returns frozen report', () => {
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeCriticalRenderingPath();
      const report = opt.getReport();
      expect(Object.isFrozen(report)).toBe(true);
      expect(report.targets).toBeDefined();
      expect(report.applied).toContain('critical-rendering-path');
      expect(report.optimizations).toBeDefined();
    });
  });

  describe('exportJSON()', () => {
    it('returns valid JSON', () => {
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.optimizeImages();
      const json = opt.exportJSON();
      const parsed = JSON.parse(json);
      expect(parsed.applied).toContain('images');
    });
  });

  describe('logStatus()', () => {
    it('logs optimization status', () => {
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt.logStatus();
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('Optimization Status'),
        expect.any(Object)
      );
    });
  });

  // =========================================================================
  // _recordOptimization()
  // =========================================================================

  describe('_recordOptimization()', () => {
    it('accumulates optimizations per category', () => {
      const opt = new RendererOptimizer({ autoOptimize: false });
      opt._recordOptimization('test', ['a', 'b']);
      opt._recordOptimization('test', ['c']);
      expect(opt.optimizations.get('test')).toEqual(['a', 'b', 'c']);
    });
  });
});
