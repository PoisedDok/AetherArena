'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  })),
}));

const { createRendererLogger } = require('../../../src/renderer/shared/utils/logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  };
}

function createContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('MediaRenderer', () => {
  let MediaRenderer;
  let renderer;
  let container;
  let mockLog;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    mockLog = createLogger();
    createRendererLogger.mockReturnValue(mockLog);

    MediaRenderer = require('../../../src/renderer/artifacts/modules/output/renderers/MediaRenderer');
    renderer = new MediaRenderer();
    renderer.log = mockLog;
    container = createContainer();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('creates instance extending BaseRenderer', () => {
      expect(renderer.injectedStyles).toBeInstanceOf(Set);
      expect(renderer.options).toEqual({});
    });

    it('stores provided options', () => {
      const r = new MediaRenderer({ maxSize: '100MB' });
      expect(r.options.maxSize).toBe('100MB');
    });
  });

  // =========================================================================
  // _detectMediaType
  // =========================================================================

  describe('_detectMediaType', () => {
    it('returns explicit type when provided (lowercased)', () => {
      expect(renderer._detectMediaType('file.txt', 'IMAGE')).toBe('image');
      expect(renderer._detectMediaType('file.txt', 'Video')).toBe('video');
      expect(renderer._detectMediaType('file.txt', 'Audio')).toBe('audio');
    });

    it('detects image extensions', () => {
      const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'];
      for (const ext of imageExts) {
        expect(renderer._detectMediaType(`photo.${ext}`)).toBe('image');
      }
    });

    it('detects video extensions', () => {
      const videoExts = ['mp4', 'webm', 'ogg', 'mov'];
      for (const ext of videoExts) {
        expect(renderer._detectMediaType(`clip.${ext}`)).toBe('video');
      }
    });

    it('detects audio extensions', () => {
      const audioExts = ['mp3', 'wav', 'aac'];
      for (const ext of audioExts) {
        expect(renderer._detectMediaType(`song.${ext}`)).toBe('audio');
      }
    });

    it('ogg is detected as video (first match wins in the code)', () => {
      // ogg appears in both VIDEO and AUDIO. Since VIDEO is checked first,
      // ogg maps to video, NOT audio.
      expect(renderer._detectMediaType('file.ogg')).toBe('video');
    });

    it('returns unknown for unsupported extensions', () => {
      expect(renderer._detectMediaType('doc.pdf')).toBe('unknown');
      expect(renderer._detectMediaType('data.json')).toBe('unknown');
    });

    it('detects image URLs with query strings', () => {
      expect(renderer._detectMediaType('https://example.com/photo.jpg?v=1')).toBe('image');
    });

    it('detects image URLs with fragments', () => {
      expect(renderer._detectMediaType('https://example.com/photo.png#section')).toBe('image');
    });

    it('detects video URLs with query and hash', () => {
      expect(renderer._detectMediaType('https://cdn.example.com/clip.mp4?token=abc')).toBe('video');
      expect(renderer._detectMediaType('https://cdn.example.com/clip.webm#t=2')).toBe('video');
    });

    it('detects audio URLs with query and hash', () => {
      expect(renderer._detectMediaType('https://cdn.example.com/song.mp3?download=1')).toBe('audio');
      expect(renderer._detectMediaType('https://cdn.example.com/song.wav#preview')).toBe('audio');
    });

    it('detects data URI media types', () => {
      expect(renderer._detectMediaType('data:image/png;base64,AAAA')).toBe('image');
      expect(renderer._detectMediaType('data:video/mp4;base64,AAAA')).toBe('video');
      expect(renderer._detectMediaType('data:audio/mpeg;base64,AAAA')).toBe('audio');
    });

    it('handles case-insensitive extensions', () => {
      // .pop().toLowerCase() normalizes case
      expect(renderer._detectMediaType('photo.JPG')).toBe('image');
      expect(renderer._detectMediaType('clip.MP4')).toBe('video');
    });

    it('handles URLs without dots (returns unknown)', () => {
      expect(renderer._detectMediaType('http://localhost/media')).toBe('unknown');
    });
  });

  // =========================================================================
  // render - data extraction
  // =========================================================================

  describe('render - data extraction', () => {
    it('accepts string URL', async () => {
      await renderer.render('https://example.com/photo.jpg', container);
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
    });

    it('accepts object with url property', async () => {
      await renderer.render({ url: 'https://example.com/photo.png' }, container);
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
    });

    it('accepts object with src property', async () => {
      await renderer.render({ src: 'https://example.com/photo.gif' }, container);
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
    });

    it('accepts object with content property', async () => {
      await renderer.render({ content: 'https://example.com/photo.webp' }, container);
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
    });

    it('prefers url over src over content', async () => {
      await renderer.render({ url: 'a.jpg', src: 'b.jpg', content: 'c.jpg' }, container);
      const img = container.querySelector('img');
      expect(img.src).toContain('a.jpg');
    });

    it('shows empty message when no URL provided', async () => {
      await renderer.render({ url: '' }, container);
      const empty = container.querySelector('.render-empty');
      expect(empty).not.toBeNull();
      expect(container.textContent).toContain('No media URL provided');
    });

    it('shows empty message for object with no URL fields', async () => {
      await renderer.render({ title: 'test' }, container);
      const empty = container.querySelector('.render-empty');
      expect(empty).not.toBeNull();
    });

    it('handles render error from null data', async () => {
      await renderer.render(null, container);
      const error = container.querySelector('.render-error');
      expect(error).not.toBeNull();
      expect(mockLog.error).toHaveBeenCalledWith(
        '[MediaRenderer] Render failed:',
        expect.any(Error)
      );
    });
  });

  // =========================================================================
  // render - image
  // =========================================================================

  describe('render - image', () => {
    it('creates img element for image URLs', async () => {
      await renderer.render('https://cdn.example.com/photo.jpg', container);
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      expect(img.src).toContain('photo.jpg');
    });

    it('sets image className', async () => {
      await renderer.render('photo.png', container);
      const img = container.querySelector('img');
      expect(img.className).toBe('media-image');
    });

    it('sets alt text from data object', async () => {
      await renderer.render({ url: 'photo.jpg', alt: 'A sunset' }, container);
      const img = container.querySelector('img');
      expect(img.alt).toBe('A sunset');
    });

    it('defaults alt to "Media image"', async () => {
      await renderer.render('photo.jpg', container);
      const img = container.querySelector('img');
      expect(img.alt).toBe('Media image');
    });

    it('sets title from data object', async () => {
      await renderer.render({ url: 'photo.jpg', title: 'Sunset' }, container);
      const img = container.querySelector('img');
      expect(img.title).toBe('Sunset');
    });

    it('onerror handler shows error message', async () => {
      await renderer.render('broken.jpg', container);
      const img = container.querySelector('img');

      // Manually trigger onerror (jsdom doesn't fire media events)
      img.onerror();

      const error = container.querySelector('.render-error');
      expect(error).not.toBeNull();
      expect(container.textContent).toContain('Failed to load image');
      // Original img should be removed (container cleared)
      expect(container.querySelector('img')).toBeNull();
    });

    it('adds container class', async () => {
      await renderer.render('photo.jpg', container);
      expect(container.classList.contains('media-renderer-container')).toBe(true);
    });
  });

  // =========================================================================
  // render - video
  // =========================================================================

  describe('render - video', () => {
    it('creates video element for video URLs', async () => {
      await renderer.render('clip.mp4', container);
      const video = container.querySelector('video');
      expect(video).not.toBeNull();
      expect(video.src).toContain('clip.mp4');
    });

    it('sets video controls', async () => {
      await renderer.render('clip.mp4', container);
      const video = container.querySelector('video');
      expect(video.controls).toBe(true);
    });

    it('sets video className', async () => {
      await renderer.render('clip.webm', container);
      const video = container.querySelector('video');
      expect(video.className).toBe('media-video');
    });

    it('sets poster when provided', async () => {
      await renderer.render({ url: 'clip.mp4', poster: 'thumb.jpg' }, container);
      const video = container.querySelector('video');
      expect(video.poster).toContain('thumb.jpg');
    });

    it('does not set poster when not provided', async () => {
      await renderer.render('clip.mp4', container);
      const video = container.querySelector('video');
      expect(video.poster).toBe('');
    });

    it('onerror handler shows error message', async () => {
      await renderer.render('broken.mp4', container);
      const video = container.querySelector('video');

      video.onerror();

      const error = container.querySelector('.render-error');
      expect(error).not.toBeNull();
      expect(container.textContent).toContain('Failed to load video');
    });
  });

  // =========================================================================
  // render - audio
  // =========================================================================

  describe('render - audio', () => {
    it('creates audio element for audio URLs', async () => {
      await renderer.render('song.mp3', container);
      const audio = container.querySelector('audio');
      expect(audio).not.toBeNull();
      expect(audio.src).toContain('song.mp3');
    });

    it('sets audio controls', async () => {
      await renderer.render('song.wav', container);
      const audio = container.querySelector('audio');
      expect(audio.controls).toBe(true);
    });

    it('sets audio className', async () => {
      await renderer.render('song.aac', container);
      const audio = container.querySelector('audio');
      expect(audio.className).toBe('media-audio');
    });

    it('onerror handler shows error message', async () => {
      await renderer.render('broken.mp3', container);
      const audio = container.querySelector('audio');

      audio.onerror();

      const error = container.querySelector('.render-error');
      expect(error).not.toBeNull();
      expect(container.textContent).toContain('Failed to load audio');
    });
  });

  // =========================================================================
  // render - unknown type
  // =========================================================================

  describe('render - unknown type', () => {
    it('shows error for unsupported media type', async () => {
      await renderer.render({ url: 'file.xyz', type: 'unknown' }, container);
      const error = container.querySelector('.render-error');
      expect(error).not.toBeNull();
      expect(container.textContent).toContain('Unsupported media type');
    });
  });

  // =========================================================================
  // render - explicit type override
  // =========================================================================

  describe('render - explicit type override', () => {
    it('uses explicit type over extension detection', async () => {
      await renderer.render({ url: 'data.bin', type: 'image' }, container);
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
    });

    it('renders as video when type is video regardless of extension', async () => {
      await renderer.render({ url: 'file.txt', type: 'video' }, container);
      const video = container.querySelector('video');
      expect(video).not.toBeNull();
    });

    it('renders as audio when type is audio regardless of extension', async () => {
      await renderer.render({ url: 'file.txt', type: 'audio' }, container);
      const audio = container.querySelector('audio');
      expect(audio).not.toBeNull();
    });
  });

  // =========================================================================
  // _injectStyles
  // =========================================================================

  describe('_injectStyles', () => {
    it('injects media renderer styles', async () => {
      await renderer.render('photo.jpg', container);
      const style = document.getElementById('media-renderer-styles');
      expect(style).not.toBeNull();
    });

    it('style contains expected CSS classes', async () => {
      await renderer.render('photo.jpg', container);
      const style = document.getElementById('media-renderer-styles');
      expect(style.textContent).toContain('media-renderer-container');
      expect(style.textContent).toContain('media-image');
      expect(style.textContent).toContain('media-video');
      expect(style.textContent).toContain('media-audio');
    });

    it('does not inject styles twice', async () => {
      await renderer.render('photo.jpg', container);
      container.innerHTML = '';
      await renderer.render('photo2.jpg', container);
      const styles = document.querySelectorAll('#media-renderer-styles');
      expect(styles.length).toBe(1);
    });
  });

  // =========================================================================
  // container management
  // =========================================================================

  describe('container management', () => {
    it('clears previous container content', async () => {
      container.innerHTML = '<p>old</p>';
      await renderer.render('photo.jpg', container);
      expect(container.querySelector('p')).toBeNull();
    });

    it('adds container class name', async () => {
      await renderer.render('photo.jpg', container);
      expect(container.classList.contains('media-renderer-container')).toBe(true);
    });
  });

  // =========================================================================
  // lifecycle
  // =========================================================================

  describe('lifecycle', () => {
    it('full create-use-dispose cycle', async () => {
      const r = new MediaRenderer();
      r.log = mockLog;

      await r.render('photo.jpg', container);
      expect(container.querySelector('img')).not.toBeNull();

      r.dispose();
      expect(r.injectedStyles.size).toBe(0);
    });
  });

  // =========================================================================
  // window assignment
  // =========================================================================

  describe('window assignment', () => {
    it('assigns MediaRenderer to window', () => {
      expect(window.MediaRenderer).toBe(MediaRenderer);
    });
  });
});
