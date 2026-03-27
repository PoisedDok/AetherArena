/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */

'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../../../../src/renderer/shared/components/Toast', () => ({
  success: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
}));

const ContentExporter = require('../../../../src/renderer/shared/utils/ContentExporter');
const Toast = require('../../../../src/renderer/shared/components/Toast');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeData(overrides = {}) {
  return {
    answer: 'Summary of findings with [1] and [2] citations.',
    results: [
      { title: 'Result One', url: 'https://example.com/1', content: 'Content one' },
      { title: 'Result Two', url: 'https://example.com/2', content: 'Content two' },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe('ContentExporter.escapeHtml', () => {
  test('escapes all five HTML-sensitive characters', () => {
    const input = '<div class="foo" id=\'bar\'>&</div>';
    const result = ContentExporter.escapeHtml(input);

    expect(result).toBe('&lt;div class=&quot;foo&quot; id=&#039;bar&#039;&gt;&amp;&lt;/div&gt;');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).not.toContain('"');
    expect(result).not.toContain("'");
    // & should only appear as escape prefixes
    expect(result.replace(/&amp;|&lt;|&gt;|&quot;|&#039;/g, '')).not.toContain('&');
  });

  test('handles null input via String() coercion', () => {
    expect(ContentExporter.escapeHtml(null)).toBe('null');
  });

  test('handles undefined input via String() coercion', () => {
    expect(ContentExporter.escapeHtml(undefined)).toBe('undefined');
  });

  test('handles numeric input via String() coercion', () => {
    expect(ContentExporter.escapeHtml(42)).toBe('42');
    expect(ContentExporter.escapeHtml(0)).toBe('0');
    expect(ContentExporter.escapeHtml(-1.5)).toBe('-1.5');
  });

  test('handles empty string', () => {
    expect(ContentExporter.escapeHtml('')).toBe('');
  });

  test('passes through safe text unchanged', () => {
    const safe = 'Hello world 123 !@#$%^*()_+-=[]{}|;:,./? ';
    // Only &, <, >, ", ' are escaped
    const result = ContentExporter.escapeHtml(safe);
    expect(result).not.toContain('&lt;');
    expect(result).not.toContain('&gt;');
  });

  test('handles XSS payloads', () => {
    const xss = '<script>alert("xss")</script>';
    const result = ContentExporter.escapeHtml(xss);
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  test('handles object input via String() coercion', () => {
    expect(ContentExporter.escapeHtml({})).toBe('[object Object]');
  });

  test('handles boolean input', () => {
    expect(ContentExporter.escapeHtml(true)).toBe('true');
    expect(ContentExporter.escapeHtml(false)).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// formatMarkdown
// ---------------------------------------------------------------------------

describe('ContentExporter.formatMarkdown', () => {
  test('returns empty string for falsy input', () => {
    expect(ContentExporter.formatMarkdown(null)).toBe('');
    expect(ContentExporter.formatMarkdown(undefined)).toBe('');
    expect(ContentExporter.formatMarkdown('')).toBe('');
    expect(ContentExporter.formatMarkdown(0)).toBe('');
    expect(ContentExporter.formatMarkdown(false)).toBe('');
  });

  test('converts ### headings to <h4>', () => {
    const result = ContentExporter.formatMarkdown('### My Heading');
    expect(result).toContain('<h4>My Heading</h4>');
  });

  test('converts **bold** to <strong>', () => {
    const result = ContentExporter.formatMarkdown('This is **bold** text');
    expect(result).toContain('<strong>');
    expect(result).toContain('bold');
  });

  test('converts newlines to <br/>', () => {
    const result = ContentExporter.formatMarkdown('line1\nline2');
    expect(result).toContain('line1<br/>line2');
  });

  test('strips raw URLs from text (parenthesized)', () => {
    const text = 'See source (https://example.com/long/path) for details.';
    const result = ContentExporter.formatMarkdown(text);
    expect(result).not.toContain('https://');
    expect(result).toContain('See source');
    expect(result).toContain('for details');
  });

  test('strips raw URLs from text (bare)', () => {
    const text = 'Read more at https://example.com/page for context';
    const result = ContentExporter.formatMarkdown(text);
    expect(result).not.toContain('https://');
    expect(result).toContain('Read more at');
  });

  test('links [N] citations to matching item URLs', () => {
    const items = [
      { url: 'https://example.com/1' },
      { url: 'https://example.com/2' },
    ];
    const text = 'Findings from [1] and [2].';
    const result = ContentExporter.formatMarkdown(text, items);
    expect(result).toContain('href="https://example.com/1"');
    expect(result).toContain('href="https://example.com/2"');
    expect(result).toContain('<strong>[1]</strong>');
    expect(result).toContain('<strong>[2]</strong>');
  });

  test('links [Context citation: N] format to matching item URLs', () => {
    const items = [
      { url: 'https://example.com/ctx1' },
    ];
    const text = 'Source [Context citation: 1] confirms this.';
    const result = ContentExporter.formatMarkdown(text, items);
    expect(result).toContain('href="https://example.com/ctx1"');
  });

  test('falls back to metadata.url for citations', () => {
    const items = [
      { metadata: { url: 'https://meta.example.com/1' } },
    ];
    const text = 'See [1].';
    const result = ContentExporter.formatMarkdown(text, items);
    expect(result).toContain('href="https://meta.example.com/1"');
  });

  test('falls back to link property for citations', () => {
    const items = [
      { link: 'https://link.example.com/1' },
    ];
    const text = 'See [1].';
    const result = ContentExporter.formatMarkdown(text, items);
    expect(result).toContain('href="https://link.example.com/1"');
  });

  test('renders citation without href when item has no URL', () => {
    const items = [{ title: 'No URL item' }];
    const text = 'See [1].';
    const result = ContentExporter.formatMarkdown(text, items);
    expect(result).toContain('<strong>[1]</strong>');
    expect(result).not.toContain('href=');
  });

  test('out-of-bounds citation renders without href', () => {
    const items = [{ url: 'https://example.com/1' }];
    const text = 'See [5].';
    const result = ContentExporter.formatMarkdown(text, items);
    expect(result).toContain('<strong>[5]</strong>');
    expect(result).not.toContain('href=');
  });

  test('handles text with no markdown or citations', () => {
    const plain = 'Just plain text with no special markers.';
    const result = ContentExporter.formatMarkdown(plain);
    expect(result).toContain('Just plain text');
  });

  test('handles multiple bold spans correctly (non-greedy)', () => {
    const text = '**first** middle **second**';
    const result = ContentExporter.formatMarkdown(text);
    const strongCount = (result.match(/<strong>/g) || []).length;
    expect(strongCount).toBe(2);
    expect(result).toContain('<strong>first</strong>');
    expect(result).toContain('<strong>second</strong>');
    expect(result).toContain('middle');
  });

  test('handles empty items array for citations', () => {
    const text = 'See [1] and [2].';
    const result = ContentExporter.formatMarkdown(text, []);
    // Citations reference beyond array bounds — should render as plain strong
    expect(result).toContain('<strong>[1]</strong>');
    expect(result).not.toContain('href=');
  });
});

// ---------------------------------------------------------------------------
// generateFindingsHtml
// ---------------------------------------------------------------------------

describe('ContentExporter.generateFindingsHtml', () => {
  test('generates valid HTML document structure', () => {
    const html = ContentExporter.generateFindingsHtml('Web', makeData(), 'TestAgent');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html>');
    expect(html).toContain('</html>');
    expect(html).toContain('<head>');
    expect(html).toContain('</head>');
    expect(html).toContain('<body>');
    expect(html).toContain('</body>');
  });

  test('includes escaped source and agent name in header', () => {
    const html = ContentExporter.generateFindingsHtml('<XSS>', makeData(), '<Agent>');
    expect(html).toContain('&lt;Agent&gt; Findings: &lt;XSS&gt;');
    expect(html).not.toContain('<XSS>');
    expect(html).not.toContain('<Agent>');
  });

  test('renders executive summary when answer is present', () => {
    const data = makeData({ answer: 'Key finding summary.' });
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).toContain('Executive Summary');
    expect(html).toContain('Key finding summary');
  });

  test('omits executive summary when answer is empty', () => {
    const data = makeData({ answer: '' });
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).not.toContain('Executive Summary');
  });

  test('renders finding cards for results array', () => {
    const data = makeData();
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).toContain('Detailed Evidence (2 items)');
    expect(html).toContain('Result One');
    expect(html).toContain('Result Two');
    expect(html).toContain('Content one');
    expect(html).toContain('Content two');
  });

  test('falls back to items array when results missing', () => {
    const data = {
      answer: 'Summary',
      items: [{ title: 'Item From Items', content: 'Item content' }],
    };
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).toContain('Item From Items');
    expect(html).toContain('Detailed Evidence (1 items)');
  });

  test('falls back to sources array when results and items missing', () => {
    const data = {
      answer: 'Summary',
      sources: [{ title: 'Source Item', content: 'Source content' }],
    };
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).toContain('Source Item');
  });

  test('handles empty results gracefully', () => {
    const data = { answer: 'Summary', results: [] };
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).not.toContain('Detailed Evidence');
    expect(html).toContain('Executive Summary');
  });

  test('handles missing all arrays — no evidence section', () => {
    const data = { answer: 'Summary only' };
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).not.toContain('Detailed Evidence');
  });

  test('escapes finding titles and content', () => {
    const data = makeData({
      results: [{ title: '<script>alert(1)</script>', content: '&dangerous' }],
    });
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;dangerous');
  });

  test('renders URLs as links in finding cards', () => {
    const data = makeData();
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).toContain('href="https://example.com/1"');
    expect(html).toContain('href="https://example.com/2"');
  });

  test('omits URL div when item has no URL', () => {
    const data = makeData({
      results: [{ title: 'No URL', content: 'Stuff' }],
    });
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).not.toContain('class="finding-url"');
  });

  test('uses metadata.url as fallback for finding card URL', () => {
    const data = makeData({
      results: [{ title: 'Meta', content: 'C', metadata: { url: 'https://meta.example.com' } }],
    });
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).toMatch(/href="https:\/\/meta\.example\.com\/?"/);
  });

  test('uses link property as fallback for finding card URL', () => {
    const data = makeData({
      results: [{ title: 'Link', content: 'C', link: 'https://link.example.com' }],
    });
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).toMatch(/href="https:\/\/link\.example\.com\/?"/);
  });

  test('generates fallback titles for items without title', () => {
    const data = makeData({
      results: [{ content: 'Untitled content' }],
    });
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).toContain('Finding #1');
  });

  test('uses metadata.title as title fallback', () => {
    const data = makeData({
      results: [{ metadata: { title: 'Meta Title' }, content: 'C' }],
    });
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).toContain('Meta Title');
  });

  test('uses name property as title fallback', () => {
    const data = makeData({
      results: [{ name: 'Named Item', content: 'C' }],
    });
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).toContain('Named Item');
  });

  test('uses snippet property as content fallback', () => {
    const data = makeData({
      results: [{ title: 'T', snippet: 'Snippet text' }],
    });
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).toContain('Snippet text');
  });

  test('uses description property as content fallback', () => {
    const data = makeData({
      results: [{ title: 'T', description: 'Description text' }],
    });
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).toContain('Description text');
  });

  test('uses pageContent property as content fallback', () => {
    const data = makeData({
      results: [{ title: 'T', pageContent: 'Page content text' }],
    });
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).toContain('Page content text');
  });

  test('includes Aether branding', () => {
    const html = ContentExporter.generateFindingsHtml('Web', makeData(), 'Agent');
    expect(html).toContain('Aether');
    expect(html).toContain('AetherArena');
  });

  test('includes footer without confidential marking', () => {
    const html = ContentExporter.generateFindingsHtml('Web', makeData(), 'Agent');
    expect(html).toContain('End of Document');
    expect(html).toContain('Generated by AetherArena');
    expect(html).not.toContain('Confidential');
  });
});

// ---------------------------------------------------------------------------
// generateContentHtml / sanitizeOutputHtml
// ---------------------------------------------------------------------------

describe('ContentExporter.generateContentHtml', () => {
  beforeEach(() => {
    ContentExporter._sanitizer = null;
  });

  test('sanitizes HTML exports to remove scriptable payloads', () => {
    const html = ContentExporter.generateContentHtml(
      '<div>Safe block</div><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">bad</a>',
      'Artifact',
      'html'
    );
    expect(html).toContain('Safe block');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
  });

  test('preserves visible markdown content while neutralizing embedded script tags', () => {
    const html = ContentExporter.generateContentHtml(
      '# Heading\n\n<script>alert(1)</script>\n\n- item',
      'Artifact',
      'markdown'
    );
    expect(html).toContain('Heading');
    expect(html).toContain('item');
    expect(html).not.toContain('<script');
  });
});

describe('ContentExporter.sanitizeOutputHtml', () => {
  beforeEach(() => {
    ContentExporter._sanitizer = null;
  });

  test('strips direct-execution vectors from HTML fragments', () => {
    const sanitized = ContentExporter.sanitizeOutputHtml(
      '<p>ok</p><iframe src="https://example.com"></iframe><img src="x" onerror="alert(1)">'
    );
    expect(sanitized).toContain('<p>ok</p>');
    expect(sanitized).not.toContain('<iframe');
    expect(sanitized).not.toContain('onerror');
  });
});

// ---------------------------------------------------------------------------
// exportAsPdf
// ---------------------------------------------------------------------------

describe('ContentExporter.exportAsPdf', () => {
  beforeEach(() => {
    Toast.info.mockClear();
    Toast.success.mockClear();
    Toast.error.mockClear();
  });

  afterEach(() => {
    delete window.aether;
  });

  test('returns false when html is falsy', async () => {
    expect(await ContentExporter.exportAsPdf(null, 'test.pdf')).toBe(false);
    expect(await ContentExporter.exportAsPdf('', 'test.pdf')).toBe(false);
    expect(await ContentExporter.exportAsPdf(undefined, 'test.pdf')).toBe(false);
  });

  test('returns false when window.aether.ipc is not available', async () => {
    delete window.aether;
    const result = await ContentExporter.exportAsPdf('<html>test</html>', 'test.pdf');
    expect(result).toBe(false);
    expect(Toast.error).toHaveBeenCalledWith('Export not available');
  });

  test('invokes ipc with correct arguments when available', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ success: true });
    window.aether = { ipc: { invoke: mockInvoke } };

    const html = '<html>test</html>';
    const result = await ContentExporter.exportAsPdf(html, 'findings.pdf');

    expect(result).toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('dialog:save-pdf', {
      html,
      filename: 'findings.pdf',
    });
    expect(Toast.info).toHaveBeenCalledWith('Preparing PDF export...');
    expect(Toast.success).toHaveBeenCalledWith('PDF exported successfully');
  });

  test('returns false when ipc invoke rejects', async () => {
    const mockInvoke = jest.fn().mockRejectedValue(new Error('IPC failed'));
    window.aether = { ipc: { invoke: mockInvoke } };

    const result = await ContentExporter.exportAsPdf('<html>test</html>', 'test.pdf');

    expect(result).toBe(false);
    expect(Toast.error).toHaveBeenCalledWith('PDF export failed');
  });

  test('returns false when result.success is false (non-cancel)', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ success: false, error: 'Write failed' });
    window.aether = { ipc: { invoke: mockInvoke } };

    const result = await ContentExporter.exportAsPdf('<html>test</html>', 'test.pdf');

    expect(result).toBe(false);
    expect(Toast.error).toHaveBeenCalledWith('PDF export failed');
  });

  test('returns false without error toast when user cancels', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ success: false, error: 'Canceled' });
    window.aether = { ipc: { invoke: mockInvoke } };

    const result = await ContentExporter.exportAsPdf('<html>test</html>', 'test.pdf');

    expect(result).toBe(false);
    expect(Toast.error).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SECURITY: href attribute hardening
// ---------------------------------------------------------------------------

describe('ContentExporter SECURITY: href attribute hardening', () => {
  test('escapes URL content used inside href attributes', () => {
    const data = makeData({
      results: [{ title: 'T', content: 'C', url: 'https://evil.com/"><script>alert(1)</script>' }],
    });
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).toContain('finding-url');
    expect(html).toMatch(/href="https:\/\/evil\.com\/%22%3E%3Cscript%3Ealert\(1\)%3C\/script%3E"/);
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  test('blocks non-http schemes in finding links', () => {
    const data = makeData({
      results: [{ title: 'Unsafe', content: 'C', url: 'javascript:alert(1)' }],
    });
    const html = ContentExporter.generateFindingsHtml('Web', data, 'Agent');
    expect(html).not.toContain('href="javascript:alert(1)"');
    expect(html).not.toContain('<div class="finding-url"><a href=');
  });

  test('blocks non-http schemes in citation links', () => {
    const result = ContentExporter.formatMarkdown('See [1]', [{ url: 'data:text/html,<script>x</script>' }]);
    expect(result).not.toContain('href=');
    expect(result).toContain('<strong>[1]</strong>');
  });
});
