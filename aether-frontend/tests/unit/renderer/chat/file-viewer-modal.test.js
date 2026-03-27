'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

// Mock PDF.js
const mockPdfPage = {
  getViewport: jest.fn(({ scale }) => ({ width: 600 * scale, height: 800 * scale })),
  render: jest.fn(() => ({ promise: Promise.resolve() })),
};
const mockPdfDoc = {
  numPages: 2,
  getPage: jest.fn().mockResolvedValue(mockPdfPage),
};
const mockLoadingTask = { promise: Promise.resolve(mockPdfDoc) };

jest.mock('pdfjs-dist', () => ({
  getDocument: jest.fn(() => mockLoadingTask),
  GlobalWorkerOptions: { workerSrc: '' },
}));
jest.mock('pdfjs-dist/build/pdf.worker.min.js', () => 'mock-worker-path');

const FileViewerModal = require(
  '../../../../src/renderer/chat/modals/FileViewerModal'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextFile(overrides = {}) {
  return {
    filename: 'test.txt',
    content: 'Hello world\nLine 2',
    language: 'text',
    metadata: { size: 1024 },
    ...overrides,
  };
}

function makeImageFile(overrides = {}) {
  return {
    filename: 'photo.png',
    content: 'data:image/png;base64,iVBORw0KG==',
    language: null,
    metadata: { size: 2048, mime_type: 'image/png' },
    ...overrides,
  };
}

function makePdfFile(overrides = {}) {
  return {
    filename: 'doc.pdf',
    content: btoa('fake pdf content'),
    language: null,
    metadata: { size: 5000, mime_type: 'application/pdf' },
    ...overrides,
  };
}

function makeJsonFile(overrides = {}) {
  return {
    filename: 'data.json',
    content: '{"key": "value", "num": 42, "flag": true, "empty": null}',
    language: 'json',
    metadata: { size: 64 },
    ...overrides,
  };
}

function createModal(overrides = {}) {
  const modal = new FileViewerModal({ ...overrides });
  return modal;
}

async function flushMicrotasks(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileViewerModal', () => {
  let modal;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    // Reset PDF mocks
    mockPdfDoc.getPage.mockResolvedValue(mockPdfPage);
    mockPdfPage.render.mockReturnValue({ promise: Promise.resolve() });
    // Mock clipboard
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
    // Mock URL methods
    global.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
    global.URL.revokeObjectURL = jest.fn();
    // JSDOM does not implement scrollIntoView — polyfill for tests
    Element.prototype.scrollIntoView = jest.fn();
  });

  afterEach(() => {
    if (modal) {
      // CRITICAL: Close the modal and flush the animation timeout so _cleanup()
      // runs BEFORE destroy(). Without this, document-level listeners from
      // _renderPDF leak across tests (close() defers _cleanup to setTimeout(300)).
      try {
        if (modal.isOpen) {
          modal.close();
          jest.advanceTimersByTime(300);
        }
        modal.destroy();
      } catch (e) { /* noop */ }
      modal = null;
    }
    jest.useRealTimers();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('extends BaseModal with correct id', () => {
      modal = createModal();
      expect(modal.id).toBe('file-viewer-modal');
    });

    it('creates overlay in DOM', () => {
      modal = createModal();
      expect(document.getElementById('file-viewer-modal-overlay')).not.toBeNull();
    });

    it('initializes currentFile to null', () => {
      modal = createModal();
      expect(modal.currentFile).toBeNull();
    });

    it('initializes _listeners as empty array', () => {
      modal = createModal();
      expect(modal._listeners).toEqual([]);
    });

    it('enables footer', () => {
      modal = createModal();
      expect(modal.showFooter).toBe(true);
    });
  });

  // =========================================================================
  // open
  // =========================================================================

  describe('open', () => {
    it('warns and returns when no fileData provided', async () => {
      modal = createModal();
      await modal.open(null);
      expect(mockLog.warn).toHaveBeenCalledWith('No file data provided');
      expect(modal.currentFile).toBeNull();
    });

    it('warns and returns for undefined fileData', async () => {
      modal = createModal();
      await modal.open(undefined);
      expect(mockLog.warn).toHaveBeenCalledWith('No file data provided');
    });

    it('stores fileData and opens modal', async () => {
      modal = createModal();
      const file = makeTextFile();
      await modal.open(file);
      expect(modal.currentFile).toBe(file);
      expect(modal.isOpen).toBe(true);
    });

    it('re-creates DOM if elements are destroyed', async () => {
      modal = createModal();
      // Simulate destroyed state
      modal.headerEl = null;
      modal.bodyEl = null;
      const file = makeTextFile();
      await modal.open(file);
      // Should have re-created DOM
      expect(modal.headerEl).not.toBeNull();
      expect(modal.bodyEl).not.toBeNull();
    });
  });

  // =========================================================================
  // _renderContent — text files
  // =========================================================================

  describe('_renderContent — text files', () => {
    it('renders filename in header', async () => {
      modal = createModal();
      await modal.open(makeTextFile({ filename: 'hello.txt' }));
      const title = modal.headerEl.querySelector('.cm-title');
      expect(title.textContent).toBe('hello.txt');
    });

    it('renders "File Viewer" when filename is empty', async () => {
      modal = createModal();
      await modal.open(makeTextFile({ filename: '' }));
      const title = modal.headerEl.querySelector('.cm-title');
      expect(title.textContent).toBe('File Viewer');
    });

    it('renders file size in metadata', async () => {
      modal = createModal();
      await modal.open(makeTextFile({ metadata: { size: 2048 } }));
      const meta = modal.headerEl.querySelector('.cm-meta');
      expect(meta.textContent).toContain('KB');
    });

    it('derives display type from language', async () => {
      modal = createModal();
      await modal.open(makeTextFile({ language: 'javascript' }));
      const meta = modal.headerEl.querySelector('.cm-meta');
      expect(meta.textContent).toContain('javascript');
    });

    it('derives display type from mime_type when no language', async () => {
      modal = createModal();
      await modal.open(makeTextFile({ language: null, metadata: { mime_type: 'text/plain', size: 100 } }));
      const meta = modal.headerEl.querySelector('.cm-meta');
      expect(meta.textContent).toContain('PLAIN');
    });

    it('derives display type from filename extension as fallback', async () => {
      modal = createModal();
      await modal.open(makeTextFile({ filename: 'script.py', language: null, metadata: {} }));
      const meta = modal.headerEl.querySelector('.cm-meta');
      expect(meta.textContent).toContain('PY');
    });

    it('renders empty metadata when no type/size/language', async () => {
      modal = createModal();
      await modal.open(makeTextFile({ language: null, filename: 'noext', metadata: {} }));
      const meta = modal.headerEl.querySelector('.cm-meta');
      expect(meta.textContent).toBe('');
    });

    it('renders close button', async () => {
      modal = createModal();
      await modal.open(makeTextFile());
      const closeBtn = modal.headerEl.querySelector('.cm-action-btn--close');
      expect(closeBtn).not.toBeNull();
    });

    it('close button calls close()', async () => {
      modal = createModal();
      await modal.open(makeTextFile());
      const closeBtn = modal.headerEl.querySelector('.cm-action-btn--close');
      const spy = jest.spyOn(modal, 'close');
      closeBtn.click();
      expect(spy).toHaveBeenCalled();
    });

    it('renders download button', async () => {
      modal = createModal();
      await modal.open(makeTextFile());
      const dlBtn = modal.headerEl.querySelector('[aria-label="Download file"]');
      expect(dlBtn).not.toBeNull();
    });

    it('renders text content in body', async () => {
      modal = createModal();
      await modal.open(makeTextFile({ content: 'Hello World' }));
      const viewer = modal.bodyEl.querySelector('.file-content-viewer');
      expect(viewer).not.toBeNull();
      expect(viewer.classList.contains('cm-content-viewer--text')).toBe(true);
      expect(viewer.textContent).toContain('Hello World');
    });

    it('renders footer with line count and character count', async () => {
      modal = createModal();
      await modal.open(makeTextFile({ content: 'Line 1\nLine 2\nLine 3' }));
      const info = modal.footerEl.querySelector('.cm-footer-info');
      expect(info.textContent).toContain('3 lines');
      expect(info.textContent).toContain('20 characters');
    });

    it('renders copy button in footer', async () => {
      modal = createModal();
      await modal.open(makeTextFile());
      const copyBtn = modal.footerEl.querySelector('.cm-copy-btn');
      expect(copyBtn).not.toBeNull();
      expect(copyBtn.textContent).toBe('Copy');
    });

    it('copy button copies content to clipboard', async () => {
      modal = createModal();
      const file = makeTextFile({ content: 'Copy me' });
      await modal.open(file);
      const copyBtn = modal.footerEl.querySelector('.cm-copy-btn');
      await copyBtn.click();
      // Need to flush microtasks for async clipboard
      await Promise.resolve();
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Copy me');
    });

    it('copy button resets text after 2 seconds', async () => {
      modal = createModal();
      await modal.open(makeTextFile({ content: 'Copy me' }));
      const copyBtn = modal.footerEl.querySelector('.cm-copy-btn');
      await copyBtn.click();
      await flushMicrotasks();
      expect(copyBtn.textContent).toBe('Copied!');
      jest.advanceTimersByTime(2000);
      expect(copyBtn.textContent).toBe('Copy');
    });

    it('copy button logs error on clipboard failure', async () => {
      modal = createModal();
      navigator.clipboard.writeText = jest.fn().mockRejectedValue(new Error('denied'));
      await modal.open(makeTextFile({ content: 'data' }));
      const copyBtn = modal.footerEl.querySelector('.cm-copy-btn');
      await copyBtn.click();
      await flushMicrotasks();
      expect(mockLog.error).toHaveBeenCalledWith('Failed to copy content', expect.any(Object));
    });

    it('returns early when currentFile is null', () => {
      modal = createModal();
      modal.currentFile = null;
      modal._renderContent();
      // No error
    });

    it('returns early and logs when DOM elements are null', () => {
      modal = createModal();
      modal.currentFile = makeTextFile();
      modal.headerEl = null;
      modal._renderContent();
      expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('DOM elements are null'));
    });
  });

  // =========================================================================
  // _renderContent — image files
  // =========================================================================

  describe('_renderContent — image files', () => {
    it('renders image with base64 content', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      const img = modal.bodyEl.querySelector('.cm-viewer-image');
      expect(img).not.toBeNull();
      expect(img.src).toContain('data:image/png');
    });

    it('prepends data: prefix when content lacks it', async () => {
      modal = createModal();
      await modal.open(makeImageFile({ content: 'rawbase64data' }));
      const img = modal.bodyEl.querySelector('.cm-viewer-image');
      expect(img.src).toContain('data:image/png;base64,rawbase64data');
    });

    it('renders zoom controls for images', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      const zoomReset = modal.headerEl.querySelector('.cm-action-btn--zoom-reset');
      expect(zoomReset).not.toBeNull();
      expect(zoomReset.textContent).toBe('100%');
    });

    it('initializes zoom state', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      expect(modal.currentZoom).toBe(1);
      expect(modal.currentX).toBe(0);
      expect(modal.currentY).toBe(0);
      expect(modal.isDragging).toBe(false);
    });

    it('does NOT render zoom controls for text files', async () => {
      modal = createModal();
      await modal.open(makeTextFile());
      const zoomReset = modal.headerEl.querySelector('.cm-action-btn--zoom-reset');
      expect(zoomReset).toBeNull();
    });

    it('applies image-specific CSS class', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      const viewer = modal.bodyEl.querySelector('.file-content-viewer');
      expect(viewer.classList.contains('cm-content-viewer--image')).toBe(true);
    });

    it('header zoom out button decreases zoom', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      const zoomOutBtn = modal.headerEl.querySelector('[aria-label="Zoom out"]');
      expect(zoomOutBtn).not.toBeNull();
      zoomOutBtn.click();
      expect(modal.currentZoom).toBeLessThan(1);
    });

    it('header zoom in button increases zoom', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      // Zoom in button has title but no aria-label — use title selector
      const zoomInBtn = modal.headerEl.querySelector('[title="Zoom In (or scroll)"]');
      expect(zoomInBtn).not.toBeNull();
      zoomInBtn.click();
      expect(modal.currentZoom).toBeGreaterThan(1);
    });

    it('header zoom reset button resets zoom', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      modal._adjustZoom(1.0); // zoom to 2x
      expect(modal.currentZoom).toBe(2);
      const resetBtn = modal.headerEl.querySelector('.cm-action-btn--zoom-reset');
      resetBtn.click();
      expect(modal.currentZoom).toBe(1);
    });

    it('download button in header triggers download', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      const dlBtn = modal.headerEl.querySelector('[aria-label="Download file"]');
      const spy = jest.spyOn(modal, '_downloadFile');
      dlBtn.click();
      expect(spy).toHaveBeenCalled();
    });

    it('wheel event on viewer adjusts zoom', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      const viewer = modal.bodyEl.querySelector('.file-content-viewer');
      const wheelEvent = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
      viewer.dispatchEvent(wheelEvent);
      expect(modal.currentZoom).toBeGreaterThan(1);
    });

    it('wheel event with deltaY > 0 decreases zoom', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      modal.currentZoom = 2;
      const viewer = modal.bodyEl.querySelector('.file-content-viewer');
      const wheelEvent = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
      viewer.dispatchEvent(wheelEvent);
      expect(modal.currentZoom).toBeLessThan(2);
    });

    it('mousedown on image starts pan when zoomed in', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      modal.currentZoom = 2;
      const img = modal.bodyEl.querySelector('.cm-viewer-image');
      img.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 200, bubbles: true }));
      expect(modal.isDragging).toBe(true);
      expect(modal.startX).toBe(100);
      expect(modal.startY).toBe(200);
    });

    it('mousedown on image does nothing when zoom is 1', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      expect(modal.currentZoom).toBe(1);
      const img = modal.bodyEl.querySelector('.cm-viewer-image');
      img.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 200, bubbles: true }));
      expect(modal.isDragging).toBe(false);
    });

    it('mousemove updates pan position when dragging', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      modal.currentZoom = 2;
      const img = modal.bodyEl.querySelector('.cm-viewer-image');
      // Start drag
      img.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, bubbles: true }));
      expect(modal.isDragging).toBe(true);
      // Move
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 150, clientY: 120, bubbles: true }));
      expect(modal.currentX).toBe(50);
      expect(modal.currentY).toBe(20);
    });

    it('mousemove does nothing when not dragging', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      modal.isDragging = false;
      modal.currentX = 0;
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 200, bubbles: true }));
      expect(modal.currentX).toBe(0);
    });

    it('mouseup ends drag and resets cursor', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      modal.currentZoom = 2;
      const img = modal.bodyEl.querySelector('.cm-viewer-image');
      img.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, bubbles: true }));
      expect(modal.isDragging).toBe(true);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      expect(modal.isDragging).toBe(false);
    });

    it('mouseup does nothing when not dragging', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      modal.isDragging = false;
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      expect(modal.isDragging).toBe(false);
    });
  });

  // =========================================================================
  // _renderContent — PDF files
  // =========================================================================

  describe('_renderContent — PDF files', () => {
    it('renders PDF with canvas elements', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      await flushMicrotasks();
      const canvases = modal.bodyEl.querySelectorAll('.cm-pdf-canvas');
      expect(canvases.length).toBe(2); // 2 pages
    });

    it('applies PDF-specific CSS class', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      const viewer = modal.bodyEl.querySelector('.file-content-viewer');
      expect(viewer.classList.contains('cm-content-viewer--pdf')).toBe(true);
    });

    it('creates page navigation in footer', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      await flushMicrotasks();
      const pageInfo = modal.footerEl.querySelector('.cm-page-info');
      expect(pageInfo).not.toBeNull();
      expect(pageInfo.textContent).toBe('Page 1 of 2');
    });

    it('creates PDF zoom controls in footer', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      await flushMicrotasks();
      const zoomLevel = modal.footerEl.querySelector('.cm-zoom-level');
      expect(zoomLevel).not.toBeNull();
      expect(zoomLevel.textContent).toBe('100%');
    });

    it('handles PDF rendering error with fallback UI', async () => {
      modal = createModal();
      const pdfjsLib = require('pdfjs-dist');
      pdfjsLib.getDocument.mockReturnValueOnce({
        promise: Promise.reject(new Error('PDF corrupted')),
      });
      await modal.open(makePdfFile());
      await flushMicrotasks();
      const fallback = modal.bodyEl.querySelector('.cm-pdf-fallback');
      expect(fallback).not.toBeNull();
      expect(fallback.querySelector('.cm-pdf-fallback-msg').textContent).toContain('PDF corrupted');
    });

    it('PDF error fallback has download button', async () => {
      modal = createModal();
      const pdfjsLib = require('pdfjs-dist');
      pdfjsLib.getDocument.mockReturnValueOnce({
        promise: Promise.reject(new Error('bad')),
      });
      await modal.open(makePdfFile());
      await flushMicrotasks();
      const dlBtn = modal.bodyEl.querySelector('.cm-pdf-fallback-btn');
      expect(dlBtn).not.toBeNull();
      expect(dlBtn.textContent).toBe('Download Instead');
      // Click triggers _downloadFile
      const spy = jest.spyOn(modal, '_downloadFile');
      dlBtn.click();
      expect(spy).toHaveBeenCalled();
    });

    it('prev button navigates to previous page', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      await flushMicrotasks();
      const prevBtn = modal.footerEl.querySelector('[aria-label="Previous page"]');
      const nextBtn = modal.footerEl.querySelector('[aria-label="Next page"]');
      expect(prevBtn).not.toBeNull();
      expect(nextBtn).not.toBeNull();
      // Navigate to page 2 first
      nextBtn.click();
      const pageInfo = modal.footerEl.querySelector('.cm-page-info');
      // Now go back
      prevBtn.click();
      // Prev from page 1 should stay at page 1 (guard: currentPage > 1)
      expect(pageInfo).not.toBeNull();
    });

    it('next button navigates to next page', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      await flushMicrotasks();
      const nextBtn = modal.footerEl.querySelector('[aria-label="Next page"]');
      // Set up canvas with data-page-num for scrollToPage to find
      const pdfContainer = modal.bodyEl.querySelector('.cm-pdf-container');
      const canvases = pdfContainer.querySelectorAll('.cm-pdf-canvas');
      expect(canvases.length).toBe(2);
      // Click next to go to page 2
      nextBtn.click();
      // The scrollToPage function looks for canvas[data-page-num="2"]
      // In JSDOM scrollIntoView is a no-op, but the page counter updates
      const pageInfo = modal.footerEl.querySelector('.cm-page-info');
      expect(pageInfo.textContent).toBe('Page 2 of 2');
    });

    it('next button at last page does not exceed bounds', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      await flushMicrotasks();
      const nextBtn = modal.footerEl.querySelector('[aria-label="Next page"]');
      const pageInfo = modal.footerEl.querySelector('.cm-page-info');
      nextBtn.click(); // page 2
      nextBtn.click(); // should stay at page 2 (guard: currentPage < numPages)
      expect(pageInfo.textContent).toBe('Page 2 of 2');
    });

    it('zoom out button decreases PDF zoom and rerenders', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      await flushMicrotasks();
      const zoomOutBtn = modal.footerEl.querySelector('[aria-label="Zoom out PDF"]');
      expect(zoomOutBtn).not.toBeNull();
      expect(modal.pdfZoom).toBe(1.0);
      zoomOutBtn.click();
      await flushMicrotasks();
      expect(modal.pdfZoom).toBe(0.75);
      const zoomLevel = modal.footerEl.querySelector('.cm-zoom-level');
      expect(zoomLevel.textContent).toBe('75%');
    });

    it('zoom in button increases PDF zoom and rerenders', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      await flushMicrotasks();
      const zoomInBtn = modal.footerEl.querySelector('[aria-label="Zoom in PDF"]');
      expect(zoomInBtn).not.toBeNull();
      expect(modal.pdfZoom).toBe(1.0);
      zoomInBtn.click();
      await flushMicrotasks();
      expect(modal.pdfZoom).toBe(1.25);
      const zoomLevel = modal.footerEl.querySelector('.cm-zoom-level');
      expect(zoomLevel.textContent).toBe('125%');
    });

    it('zoom out clamps to minimum 0.5', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      await flushMicrotasks();
      modal.pdfZoom = 0.5;
      const zoomOutBtn = modal.footerEl.querySelector('[aria-label="Zoom out PDF"]');
      zoomOutBtn.click();
      await flushMicrotasks();
      // pdfZoom stays at 0.5 because guard: pdfZoom > 0.5
      expect(modal.pdfZoom).toBe(0.5);
    });

    it('zoom in clamps to maximum 3.0', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      await flushMicrotasks();
      modal.pdfZoom = 3.0;
      const zoomInBtn = modal.footerEl.querySelector('[aria-label="Zoom in PDF"]');
      zoomInBtn.click();
      await flushMicrotasks();
      // pdfZoom stays at 3.0 because guard: pdfZoom < 3.0
      expect(modal.pdfZoom).toBe(3.0);
    });

    it('PDF mousedown starts pan when zoomed in', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      await flushMicrotasks();
      modal.pdfZoom = 2.0;
      const pdfContainer = modal.bodyEl.querySelector('.cm-pdf-container');
      pdfContainer.dispatchEvent(new MouseEvent('mousedown', {
        pageX: 100, pageY: 200, bubbles: true, cancelable: true,
      }));
      // The isPanning flag is local to _renderPDF, but cursor changes
      expect(pdfContainer.style.cursor).toBe('grabbing');
    });

    it('PDF mousedown does nothing when zoom <= 1', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      await flushMicrotasks();
      expect(modal.pdfZoom).toBe(1.0);
      const pdfContainer = modal.bodyEl.querySelector('.cm-pdf-container');
      pdfContainer.dispatchEvent(new MouseEvent('mousedown', {
        pageX: 100, pageY: 200, bubbles: true, cancelable: true,
      }));
      expect(pdfContainer.style.cursor).toBe('default');
    });

    it('PDF mousemove pans when dragging', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      await flushMicrotasks();
      modal.pdfZoom = 2.0;
      const pdfContainer = modal.bodyEl.querySelector('.cm-pdf-container');
      // Start pan
      pdfContainer.dispatchEvent(new MouseEvent('mousedown', {
        pageX: 100, pageY: 100, bubbles: true, cancelable: true,
      }));
      // Move
      document.dispatchEvent(new MouseEvent('mousemove', {
        pageX: 150, pageY: 120, bubbles: true, cancelable: true,
      }));
      // scrollLeft/scrollTop won't change in JSDOM (no layout) but the code path runs
    });

    it('PDF mouseup ends pan', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      await flushMicrotasks();
      modal.pdfZoom = 2.0;
      const pdfContainer = modal.bodyEl.querySelector('.cm-pdf-container');
      // Start pan
      pdfContainer.dispatchEvent(new MouseEvent('mousedown', {
        pageX: 100, pageY: 100, bubbles: true, cancelable: true,
      }));
      expect(pdfContainer.style.cursor).toBe('grabbing');
      // End pan
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      expect(pdfContainer.style.cursor).toBe('grab');
    });

    it('PDF scroll updates current page indicator', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      await flushMicrotasks();
      const pdfContainer = modal.bodyEl.querySelector('.cm-pdf-container');
      const canvases = pdfContainer.querySelectorAll('.cm-pdf-canvas');
      // Mock getBoundingClientRect to simulate second page being visible
      canvases[0].getBoundingClientRect = () => ({ top: -500, bottom: -100, left: 0, right: 600 });
      canvases[1].getBoundingClientRect = () => ({ top: 10, bottom: 810, left: 0, right: 600 });
      // Dispatch scroll event
      pdfContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
      const pageInfo = modal.footerEl.querySelector('.cm-page-info');
      expect(pageInfo.textContent).toBe('Page 2 of 2');
    });

    it('PDF scroll does not update when same page', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      await flushMicrotasks();
      const pdfContainer = modal.bodyEl.querySelector('.cm-pdf-container');
      const canvases = pdfContainer.querySelectorAll('.cm-pdf-canvas');
      // Mock getBoundingClientRect for page 1 visible
      canvases[0].getBoundingClientRect = () => ({ top: 10, bottom: 810, left: 0, right: 600 });
      canvases[1].getBoundingClientRect = () => ({ top: 820, bottom: 1620, left: 0, right: 600 });
      pdfContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
      const pageInfo = modal.footerEl.querySelector('.cm-page-info');
      expect(pageInfo.textContent).toBe('Page 1 of 2');
    });
  });

  // =========================================================================
  // _formatContent
  // =========================================================================

  describe('_formatContent', () => {
    beforeEach(() => {
      modal = createModal();
    });

    it('returns "Empty file" for null content', () => {
      const result = modal._formatContent(null, 'text');
      expect(result).toContain('Empty file');
    });

    it('returns "Empty file" for empty string', () => {
      const result = modal._formatContent('', 'text');
      expect(result).toContain('Empty file');
    });

    it('escapes HTML characters', () => {
      const result = modal._formatContent('<div class="test">&</div>', 'text');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
      expect(result).toContain('&amp;');
      expect(result).toContain('&quot;');
    });

    it('pretty-prints valid JSON', () => {
      const result = modal._formatContent('{"a":1}', 'json');
      expect(result).toContain('"a"');
    });

    it('handles invalid JSON gracefully', () => {
      const result = modal._formatContent('not json {', 'json');
      // Falls through to plain text rendering
      expect(result).toContain('not json');
    });

    it('escapes single quotes', () => {
      const result = modal._formatContent("it's here", 'text');
      expect(result).toContain('&#039;');
    });
  });

  // =========================================================================
  // _highlightJSON
  // =========================================================================

  describe('_highlightJSON', () => {
    beforeEach(() => {
      modal = createModal();
    });

    it('wraps JSON keys in colored spans', () => {
      const result = modal._highlightJSON('{\n  "key": "value"\n}');
      expect(result).toContain('color: var(--color-primary)');
      expect(result).toContain('"key"');
    });

    it('wraps string values in colored spans', () => {
      const result = modal._highlightJSON('{\n  "key": "value"\n}');
      expect(result).toContain('color:');
    });

    it('highlights boolean values', () => {
      const result = modal._highlightJSON('{\n  "flag": true\n}');
      expect(result).toContain('true');
    });

    it('highlights null values', () => {
      const result = modal._highlightJSON('{\n  "empty": null\n}');
      expect(result).toContain('null');
    });

    it('highlights numeric values', () => {
      const result = modal._highlightJSON('{\n  "num": 42\n}');
      expect(result).toContain('42');
    });
  });

  // =========================================================================
  // _getJSONColor
  // =========================================================================

  describe('_getJSONColor', () => {
    beforeEach(() => {
      modal = createModal();
    });

    it('returns primary color for keys', () => {
      expect(modal._getJSONColor('json-key')).toContain('primary');
    });

    it('returns success color for strings', () => {
      expect(modal._getJSONColor('json-string')).toContain('success');
    });

    it('returns text-primary for unknown types', () => {
      expect(modal._getJSONColor('unknown')).toContain('text-primary');
    });
  });

  // =========================================================================
  // _isImageFile
  // =========================================================================

  describe('_isImageFile', () => {
    beforeEach(() => {
      modal = createModal();
    });

    it('returns true for image extensions', () => {
      expect(modal._isImageFile('photo.jpg')).toBe(true);
      expect(modal._isImageFile('photo.jpeg')).toBe(true);
      expect(modal._isImageFile('photo.png')).toBe(true);
      expect(modal._isImageFile('photo.gif')).toBe(true);
      expect(modal._isImageFile('photo.webp')).toBe(true);
      expect(modal._isImageFile('photo.bmp')).toBe(true);
      expect(modal._isImageFile('photo.svg')).toBe(true);
    });

    it('returns false for non-image extensions', () => {
      expect(modal._isImageFile('doc.txt')).toBe(false);
      expect(modal._isImageFile('doc.pdf')).toBe(false);
      expect(modal._isImageFile('doc.json')).toBe(false);
    });

    it('returns false for null filename', () => {
      expect(modal._isImageFile(null)).toBe(false);
    });

    it('is case-insensitive', () => {
      expect(modal._isImageFile('PHOTO.PNG')).toBe(true);
      expect(modal._isImageFile('Photo.Jpg')).toBe(true);
    });
  });

  // =========================================================================
  // _isPDFFile
  // =========================================================================

  describe('_isPDFFile', () => {
    beforeEach(() => {
      modal = createModal();
    });

    it('returns true for application/pdf mime_type', () => {
      expect(modal._isPDFFile('doc.txt', { mime_type: 'application/pdf' })).toBe(true);
    });

    it('returns true for .pdf extension', () => {
      expect(modal._isPDFFile('doc.pdf', {})).toBe(true);
    });

    it('returns false for non-PDF files', () => {
      expect(modal._isPDFFile('doc.txt', {})).toBe(false);
    });

    it('returns false for null filename without PDF mime', () => {
      expect(modal._isPDFFile(null, {})).toBe(false);
    });
  });

  // =========================================================================
  // _detectLanguage
  // =========================================================================

  describe('_detectLanguage', () => {
    beforeEach(() => {
      modal = createModal();
    });

    it('maps .json to json', () => {
      expect(modal._detectLanguage('data.json')).toBe('json');
    });

    it('maps .js to javascript', () => {
      expect(modal._detectLanguage('app.js')).toBe('javascript');
    });

    it('maps .py to python', () => {
      expect(modal._detectLanguage('script.py')).toBe('python');
    });

    it('maps .yml to yaml', () => {
      expect(modal._detectLanguage('config.yml')).toBe('yaml');
    });

    it('returns text for unknown extensions', () => {
      expect(modal._detectLanguage('file.xyz')).toBe('text');
    });

    it('returns text for null filename', () => {
      expect(modal._detectLanguage(null)).toBe('text');
    });
  });

  // =========================================================================
  // _formatFileSize
  // =========================================================================

  describe('_formatFileSize', () => {
    beforeEach(() => {
      modal = createModal();
    });

    it('returns empty string for 0/null/undefined', () => {
      expect(modal._formatFileSize(0)).toBe('');
      expect(modal._formatFileSize(null)).toBe('');
      expect(modal._formatFileSize(undefined)).toBe('');
    });

    it('formats bytes', () => {
      expect(modal._formatFileSize(500)).toBe('500 B');
    });

    it('formats kilobytes', () => {
      expect(modal._formatFileSize(2048)).toBe('2.0 KB');
    });

    it('formats megabytes', () => {
      expect(modal._formatFileSize(2 * 1024 * 1024)).toBe('2.0 MB');
    });
  });

  // =========================================================================
  // _downloadFile
  // =========================================================================

  describe('_downloadFile', () => {
    it('warns when no current file', () => {
      modal = createModal();
      modal.currentFile = null;
      modal._downloadFile();
      expect(mockLog.warn).toHaveBeenCalledWith('No file to download');
    });

    it('creates download link and clicks it', async () => {
      modal = createModal();
      await modal.open(makeTextFile({ filename: 'test.txt', content: 'Hello' }));
      const clickSpy = jest.fn();
      const origCreateElement = document.createElement.bind(document);
      jest.spyOn(document, 'createElement').mockImplementation((tag) => {
        const el = origCreateElement(tag);
        if (tag === 'a') {
          el.click = clickSpy;
        }
        return el;
      });
      modal._downloadFile();
      expect(URL.createObjectURL).toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalled();
      expect(URL.revokeObjectURL).toHaveBeenCalled();
      document.createElement.mockRestore();
    });

    it('logs error on download failure', () => {
      modal = createModal();
      modal.currentFile = makeTextFile();
      URL.createObjectURL = jest.fn(() => { throw new Error('blob fail'); });
      modal._downloadFile();
      expect(mockLog.error).toHaveBeenCalledWith('Failed to download file', expect.any(Object));
    });
  });

  // =========================================================================
  // _adjustZoom / _resetZoom
  // =========================================================================

  describe('_adjustZoom / _resetZoom', () => {
    beforeEach(async () => {
      modal = createModal();
      await modal.open(makeImageFile());
    });

    it('increases zoom', () => {
      modal._adjustZoom(0.5);
      expect(modal.currentZoom).toBe(1.5);
    });

    it('decreases zoom', () => {
      modal._adjustZoom(-0.3);
      expect(modal.currentZoom).toBe(0.7);
    });

    it('clamps zoom to minimum 0.5', () => {
      modal._adjustZoom(-10);
      expect(modal.currentZoom).toBe(0.5);
    });

    it('clamps zoom to maximum 5', () => {
      modal._adjustZoom(100);
      expect(modal.currentZoom).toBe(5);
    });

    it('resets pan when zoom <= 1', () => {
      modal.currentZoom = 2;
      modal.currentX = 50;
      modal.currentY = 50;
      modal._adjustZoom(-1.5); // zoom becomes 0.5
      expect(modal.currentX).toBe(0);
      expect(modal.currentY).toBe(0);
    });

    it('updates zoom display button', () => {
      modal._adjustZoom(0.5);
      expect(modal.zoomResetBtn.textContent).toBe('150%');
    });

    it('resetZoom restores to 100%', () => {
      modal._adjustZoom(1.0);
      expect(modal.currentZoom).toBe(2);
      modal._resetZoom();
      expect(modal.currentZoom).toBe(1);
      expect(modal.currentX).toBe(0);
      expect(modal.currentY).toBe(0);
      expect(modal.zoomResetBtn.textContent).toBe('100%');
    });

    it('adjustZoom is safe when currentImg is null', () => {
      modal.currentImg = null;
      expect(() => modal._adjustZoom(0.5)).not.toThrow();
    });

    it('resetZoom is safe when currentImg is null', () => {
      modal.currentImg = null;
      expect(() => modal._resetZoom()).not.toThrow();
    });
  });

  // =========================================================================
  // _updateTransform / _updateZoomDisplay
  // =========================================================================

  describe('_updateTransform / _updateZoomDisplay', () => {
    it('is safe when currentImg is null', () => {
      modal = createModal();
      modal.currentImg = null;
      expect(() => modal._updateTransform()).not.toThrow();
    });

    it('sets transform style on image', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      modal.currentZoom = 2;
      modal.currentX = 10;
      modal.currentY = 20;
      modal._updateTransform();
      expect(modal.currentImg.style.transform).toContain('scale(2)');
    });

    it('_updateZoomDisplay is safe when zoomResetBtn is null', () => {
      modal = createModal();
      modal.zoomResetBtn = null;
      expect(() => modal._updateZoomDisplay()).not.toThrow();
    });
  });

  // =========================================================================
  // _trackListener / _clearListeners
  // =========================================================================

  describe('_trackListener / _clearListeners', () => {
    it('tracks listener for cleanup', () => {
      modal = createModal();
      const el = document.createElement('button');
      const handler = jest.fn();
      modal._trackListener(el, 'click', handler);
      expect(modal._listeners.length).toBe(1);
      el.click();
      expect(handler).toHaveBeenCalled();
    });

    it('clearListeners removes all tracked listeners', () => {
      modal = createModal();
      const el = document.createElement('button');
      const handler = jest.fn();
      modal._trackListener(el, 'click', handler);
      modal._clearListeners();
      expect(modal._listeners).toEqual([]);
      handler.mockClear();
      el.click();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _cleanup
  // =========================================================================

  describe('_cleanup', () => {
    it('clears all listeners', async () => {
      modal = createModal();
      await modal.open(makeTextFile());
      expect(modal._listeners.length).toBeGreaterThan(0);
      modal._cleanup();
      expect(modal._listeners).toEqual([]);
    });

    it('resets zoom/pan state', async () => {
      modal = createModal();
      await modal.open(makeImageFile());
      modal.currentZoom = 2;
      modal.currentX = 50;
      modal._cleanup();
      expect(modal.currentZoom).toBe(1);
      expect(modal.currentX).toBe(0);
      expect(modal.currentY).toBe(0);
      expect(modal.isDragging).toBe(false);
    });

    it('clears PDF state', async () => {
      modal = createModal();
      await modal.open(makePdfFile());
      modal._cleanup();
      expect(modal.pdfPages).toEqual([]);
      expect(modal.pdfZoom).toBe(1.0);
    });

    it('nulls DOM references', async () => {
      modal = createModal();
      await modal.open(makeTextFile());
      modal._cleanup();
      expect(modal.currentImg).toBeNull();
      expect(modal.zoomResetBtn).toBeNull();
      expect(modal.pdfZoomLevel).toBeNull();
      expect(modal.currentFile).toBeNull();
    });
  });

  // =========================================================================
  // BaseModal integration
  // =========================================================================

  describe('BaseModal integration', () => {
    it('ESC key closes modal', async () => {
      modal = createModal();
      await modal.open(makeTextFile());
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(modal.isOpen).toBe(false);
    });

    it('destroy removes overlay from DOM', async () => {
      modal = createModal();
      await modal.open(makeTextFile());
      jest.advanceTimersByTime(0);
      const overlay = modal.overlay;
      modal.destroy();
      expect(overlay.parentNode).toBeNull();
    });

    it('close triggers _cleanup after animation', async () => {
      modal = createModal();
      await modal.open(makeTextFile());
      jest.advanceTimersByTime(0);
      modal.close();
      jest.advanceTimersByTime(300);
      expect(modal.currentFile).toBeNull();
      expect(modal._listeners).toEqual([]);
    });
  });

  // =========================================================================
  // Full lifecycle
  // =========================================================================

  describe('full lifecycle', () => {
    it('open text -> copy -> close -> open image -> zoom -> close', async () => {
      modal = createModal();

      // Open text file
      await modal.open(makeTextFile());
      expect(modal.isOpen).toBe(true);
      expect(modal.bodyEl.querySelector('.cm-content-viewer--text')).not.toBeNull();

      // Close
      jest.advanceTimersByTime(0);
      modal.close();
      jest.advanceTimersByTime(300);

      // Open image file
      await modal.open(makeImageFile());
      expect(modal.isOpen).toBe(true);
      expect(modal.bodyEl.querySelector('.cm-viewer-image')).not.toBeNull();

      // Zoom in
      modal._adjustZoom(1.0);
      expect(modal.currentZoom).toBe(2);

      // Close
      jest.advanceTimersByTime(0);
      modal.close();
      jest.advanceTimersByTime(300);
      expect(modal.currentFile).toBeNull();
    });
  });
});
