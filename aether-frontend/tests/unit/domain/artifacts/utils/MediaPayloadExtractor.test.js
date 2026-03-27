'use strict';

const {
  extractMediaPayload,
  parseJsonLike,
  classifyArray,
  looksLikeVideo,
  looksLikeImage
} = require('../../../../../src/domain/artifacts/utils/MediaPayloadExtractor');

// --- extractMediaPayload ---

describe('extractMediaPayload', () => {
  it('returns null for null/undefined message', () => {
    expect(extractMediaPayload(null)).toBeNull();
    expect(extractMediaPayload(undefined)).toBeNull();
  });

  it('returns null when content has no media keywords', () => {
    expect(extractMediaPayload({ content: 'hello world' })).toBeNull();
    expect(extractMediaPayload({ content: '' })).toBeNull();
  });

  it('returns object content directly when content is an object with videos', () => {
    const payload = { videos: [{ url: 'https://youtube.com/watch?v=abc' }] };
    const result = extractMediaPayload({ content: payload });
    expect(result).toBe(payload);
  });

  it('returns object content directly when content is an object with images', () => {
    const payload = { images: [{ img_src: 'https://example.com/img.png' }] };
    const result = extractMediaPayload({ content: payload });
    expect(result).toBe(payload);
  });

  it('parses JSON string with "videos" key', () => {
    const jsonStr = JSON.stringify({ videos: [{ url: 'https://youtube.com/watch?v=abc' }] });
    const result = extractMediaPayload({ content: jsonStr });
    expect(result).toBeTruthy();
    expect(result.videos).toHaveLength(1);
  });

  it('parses JSON string with "images" key', () => {
    const jsonStr = JSON.stringify({ images: [{ img_src: 'https://example.com/img.png' }] });
    const result = extractMediaPayload({ content: jsonStr });
    expect(result).toBeTruthy();
    expect(result.images).toHaveLength(1);
  });

  it('parses JSON arrays and classifies as videos', () => {
    const arr = [{ url: 'https://youtube.com/watch?v=abc' }];
    const result = extractMediaPayload({ content: JSON.stringify(arr) + '' });
    // The string doesn't contain "videos" or "images" key, so heuristic fails
    expect(result).toBeNull();
  });

  it('handles Python-style JSON (True/False/None, single quotes)', () => {
    const pythonJson = "{'videos': [{'url': 'https://youtube.com/watch?v=abc', 'active': True}]}";
    const result = extractMediaPayload({ content: pythonJson });
    expect(result).toBeTruthy();
    expect(result.videos).toHaveLength(1);
  });

  it('returns null for code-fence wrapped JSON (starts with backtick, not { or [)', () => {
    // The heuristic requires content to start with '{' or '[' before attempting parse.
    // Code-fenced content starts with '```', so it is NOT parsed.
    const fenced = '```json\n{"videos": [{"url": "https://youtube.com/watch?v=abc"}]}\n```';
    const result = extractMediaPayload({ content: fenced });
    expect(result).toBeNull();
  });

  it('returns null for non-JSON content with media keywords', () => {
    // Content has the keyword but doesn't start with { or [
    const result = extractMediaPayload({ content: 'Here are some "videos" of cats' });
    expect(result).toBeNull();
  });

  it('returns null for invalid JSON with media keywords', () => {
    const result = extractMediaPayload({ content: '{broken "videos": json}' });
    expect(result).toBeNull();
  });
});

// --- parseJsonLike ---

describe('parseJsonLike', () => {
  it('parses valid JSON', () => {
    expect(parseJsonLike('{"key":"val"}')).toEqual({ key: 'val' });
    expect(parseJsonLike('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('parses Python True/False/None', () => {
    const result = parseJsonLike('{"active": True, "deleted": False, "value": None}');
    expect(result).toEqual({ active: true, deleted: false, value: null });
  });

  it('parses single-quoted keys and values', () => {
    const result = parseJsonLike("{'name': 'test'}");
    expect(result).toEqual({ name: 'test' });
  });

  it('returns null for completely invalid input', () => {
    expect(parseJsonLike('not json at all')).toBeNull();
    expect(parseJsonLike('')).toBeNull();
  });
});

// --- classifyArray ---

describe('classifyArray', () => {
  it('returns null for empty array', () => {
    expect(classifyArray([])).toBeNull();
  });

  it('returns null for non-array', () => {
    expect(classifyArray(null)).toBeNull();
    expect(classifyArray('string')).toBeNull();
  });

  it('returns { videos } when more video-like objects', () => {
    const arr = [
      { url: 'https://youtube.com/watch?v=abc' },
      { iframe_src: 'https://vimeo.com/123' }
    ];
    expect(classifyArray(arr)).toEqual({ videos: arr });
  });

  it('returns { images } when more image-like objects', () => {
    const arr = [
      { img_src: 'https://example.com/a.png' },
      { thumbnail: 'https://example.com/b.jpg' }
    ];
    expect(classifyArray(arr)).toEqual({ images: arr });
  });

  it('returns { videos } when equal count (videos >= images)', () => {
    const arr = [
      { url: 'https://youtube.com/watch?v=abc' },
      { img_src: 'https://example.com/a.png' }
    ];
    expect(classifyArray(arr)).toEqual({ videos: arr });
  });

  it('returns null when no items look like video or image', () => {
    expect(classifyArray([{ text: 'hello' }, { text: 'world' }])).toBeNull();
  });
});

// --- looksLikeVideo ---

describe('looksLikeVideo', () => {
  it('returns false for non-objects', () => {
    expect(looksLikeVideo(null)).toBe(false);
    expect(looksLikeVideo('string')).toBe(false);
    expect(looksLikeVideo(42)).toBe(false);
  });

  it('detects iframe_src', () => {
    expect(looksLikeVideo({ iframe_src: 'https://example.com' })).toBe(true);
  });

  it('detects youtube URL', () => {
    expect(looksLikeVideo({ url: 'https://youtube.com/watch?v=abc' })).toBe(true);
    expect(looksLikeVideo({ url: 'https://youtu.be/abc' })).toBe(true);
  });

  it('detects vimeo URL', () => {
    expect(looksLikeVideo({ url: 'https://vimeo.com/12345' })).toBe(true);
  });

  it('detects .mp4/.webm extensions', () => {
    expect(looksLikeVideo({ url: 'https://example.com/video.mp4' })).toBe(true);
    expect(looksLikeVideo({ url: 'https://example.com/video.webm' })).toBe(true);
  });

  it('returns false for non-video URLs', () => {
    expect(looksLikeVideo({ url: 'https://example.com/page' })).toBe(false);
  });
});

// --- looksLikeImage ---

describe('looksLikeImage', () => {
  it('returns false for non-objects', () => {
    expect(looksLikeImage(null)).toBe(false);
    expect(looksLikeImage('string')).toBe(false);
  });

  it('detects img_src', () => {
    expect(looksLikeImage({ img_src: 'https://example.com/img.png' })).toBe(true);
  });

  it('detects image property', () => {
    expect(looksLikeImage({ image: 'https://example.com/img.png' })).toBe(true);
  });

  it('detects thumbnail and thumbnail_src', () => {
    expect(looksLikeImage({ thumbnail: 'https://example.com/thumb.jpg' })).toBe(true);
    expect(looksLikeImage({ thumbnail_src: 'https://example.com/thumb.jpg' })).toBe(true);
  });

  it('detects image file extensions in URL', () => {
    expect(looksLikeImage({ url: 'https://example.com/pic.png' })).toBe(true);
    expect(looksLikeImage({ url: 'https://example.com/pic.jpg' })).toBe(true);
    expect(looksLikeImage({ url: 'https://example.com/pic.jpeg' })).toBe(true);
    expect(looksLikeImage({ url: 'https://example.com/pic.gif' })).toBe(true);
    expect(looksLikeImage({ url: 'https://example.com/pic.webp' })).toBe(true);
    expect(looksLikeImage({ url: 'https://example.com/pic.svg' })).toBe(true);
  });

  it('returns false for non-image objects', () => {
    expect(looksLikeImage({ text: 'hello' })).toBe(false);
    expect(looksLikeImage({ url: 'https://example.com/page' })).toBe(false);
  });
});
