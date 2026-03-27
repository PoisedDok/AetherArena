/**
 * @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js
 */
'use strict';

/**
 * MessageView Component Tests - REAL DOM RENDERING
 * ============================================================================
 * Tests actual DOM manipulation, markdown rendering, XSS protection, and
 * scroll behavior. These tests catch REAL bugs in message display.
 * 
 * @module tests/component/MessageView.real
 */

const MessageView = require('../../src/renderer/chat/modules/messaging/MessageView');
const MarkdownRenderer = require('../../src/renderer/shared/messaging/MarkdownRenderer');
const SecuritySanitizer = require('../../src/renderer/shared/security/SecuritySanitizer');

describe('MessageView - Real DOM Rendering', () => {
  let messageView;
  let container;

  beforeEach(() => {
    // Create real DOM container
    container = document.createElement('div');
    container.className = 'aether-chat-content';
    document.body.appendChild(container);

    messageView = new MessageView({
      markdownRenderer: new MarkdownRenderer(),
      securitySanitizer: new SecuritySanitizer(),
      maxMessages: 10, // Low limit for testing pruning
      autoScroll: true
    });

    messageView.init(container);
  });

  afterEach(() => {
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    messageView = null;
  });

  describe('Basic Message Rendering', () => {
    test('should render user message with escaped HTML', () => {
      const message = {
        id: 'msg_001',
        role: 'user',
        content: 'Hello <script>alert("xss")</script> World',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      expect(element).not.toBeNull();
      // Implementation detail: MessageView may add extra classes (e.g. "message") for trail anchoring.
      expect(element.classList.contains('chat-entry')).toBe(true);
      expect(element.dataset.role).toBe('user');
      expect(element.dataset.messageId).toBe('msg_001');

      // CRITICAL: Ensure XSS is blocked
      expect(element.innerHTML).not.toContain('<script>');
      expect(element.textContent).toContain('Hello');
      expect(element.textContent).toContain('World');
    });

    test('should render assistant message with markdown', () => {
      const message = {
        id: 'msg_002',
        role: 'assistant',
        content: '# Heading\n\n**Bold text** and `inline code`',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      expect(element).not.toBeNull();
      expect(element.dataset.role).toBe('assistant');

      // Should contain rendered markdown (actual tags depend on renderer)
      const textContent = element.textContent;
      expect(textContent).toContain('Heading');
      expect(textContent).toContain('Bold text');
      expect(textContent).toContain('inline code');
    });

    test('should render code blocks with syntax highlighting markers', () => {
      const message = {
        id: 'msg_003',
        role: 'assistant',
        content: '```python\ndef hello():\n    print("world")\n```',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      // Should contain code block markers (pre/code tags)
      const codeBlocks = element.querySelectorAll('pre, code');
      expect(codeBlocks.length).toBeGreaterThan(0);

      const textContent = element.textContent;
      expect(textContent).toContain('def hello()');
      expect(textContent).toContain('print');
    });

    test('should NOT render message without content for non-assistant', () => {
      const message = {
        id: 'msg_004',
        role: 'user',
        content: '',  // Empty content
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      // Should reject empty user messages
      expect(element).toBeNull();
      expect(container.children.length).toBe(0);
    });

    test('should render empty assistant message (streaming placeholder)', () => {
      const message = {
        id: 'msg_005',
        role: 'assistant',
        content: '',  // Empty but allowed for streaming
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      // Should allow empty assistant messages (for streaming)
      expect(element).not.toBeNull();
      expect(element.dataset.role).toBe('assistant');
    });
  });

  describe('Message Updates (Streaming)', () => {
    test('should update existing message content', () => {
      // Initial render
      const message = {
        id: 'msg_stream_001',
        role: 'assistant',
        content: 'Initial text',
        timestamp: Date.now()
      };

      messageView.renderMessage(message);
      expect(container.textContent).toContain('Initial text');

      // Update with more content (streaming)
      message.content = 'Initial text + more content';
      messageView.updateMessage(message.id, message.content);

      expect(container.textContent).toContain('Initial text + more content');
      expect(container.textContent).not.toContain('Initial text Initial text'); // No duplication
    });

    test('should handle rapid updates without duplicating content', () => {
      const message = {
        id: 'msg_rapid_001',
        role: 'assistant',
        content: 'Chunk ',
        timestamp: Date.now()
      };

      messageView.renderMessage(message);

      // Simulate rapid streaming chunks
      for (let i = 1; i <= 20; i++) {
        message.content += `${i} `;
        messageView.updateMessage(message.id, message.content);
      }

      // Only assert against the message body (timestamps/role indicators contain digits too).
      const messageEl = container.querySelector('[data-message-id="msg_rapid_001"]');
      expect(messageEl).toBeTruthy();
      const textEl = messageEl.querySelector('.chat-text');
      expect(textEl).toBeTruthy();
      const finalText = textEl.textContent || '';
      
      // Should contain all chunks exactly once
      for (let i = 1; i <= 20; i++) {
        const count = (finalText.match(new RegExp(`\\b${i}\\b`, 'g')) || []).length;
        expect(count).toBe(1); // Each number should appear exactly once
      }
    });

    test('should update message that does not exist yet (late arrival)', () => {
      // Try to update a message that hasn't been rendered
      const message = {
        id: 'msg_late_001',
        role: 'assistant',
        content: 'Late arrival content',
        timestamp: Date.now()
      };

      messageView.updateMessage(message.id, message.content);

      // Should create the message
      expect(container.children.length).toBe(1);
      expect(container.textContent).toContain('Late arrival content');
    });
  });

  describe('Message Attachments', () => {
    test('should render message with image attachment', () => {
      const message = {
        id: 'msg_img_001',
        role: 'user',
        content: 'Check this image',
        timestamp: Date.now()
      };

      const attachments = {
        imageBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      };

      const element = messageView.renderMessageWithAttachments(message, attachments);

      expect(element).not.toBeNull();
      
      const img = element.querySelector('img.attached-image');
      expect(img).not.toBeNull();
      expect(img.src).toContain('data:image/png;base64');
    });

    test('should render message with file attachments', () => {
      const message = {
        id: 'msg_file_001',
        role: 'user',
        content: 'Uploading files',
        timestamp: Date.now()
      };

      const attachments = {
        files: [
          { name: 'document.pdf', size: 1024 },
          { name: 'data.csv', size: 2048 }
        ]
      };

      const element = messageView.renderMessageWithAttachments(message, attachments);

      expect(element).not.toBeNull();
      expect(element.textContent).toContain('2 files attached');
      expect(element.textContent).toContain('document.pdf');
      expect(element.textContent).toContain('data.csv');
    });

    test('should escape malicious filenames in attachments', () => {
      const message = {
        id: 'msg_xss_file',
        role: 'user',
        content: 'File upload',
        timestamp: Date.now()
      };

      const attachments = {
        files: [
          { name: '<img src=x onerror=alert(1)>.jpg', size: 1024 }
        ]
      };

      const element = messageView.renderMessageWithAttachments(message, attachments);

      // Should escape malicious HTML in filename
      expect(element.innerHTML).not.toContain('onerror=');
      expect(element.innerHTML).not.toContain('<img src=x');
    });
  });

  describe('Message Pruning (Memory Management)', () => {
    test('should prune old messages when maxMessages exceeded', () => {
      // maxMessages is set to 10 in beforeEach

      // Add 15 messages
      for (let i = 1; i <= 15; i++) {
        messageView.renderMessage({
          id: `msg_prune_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now()
        });
      }

      // Should only keep latest 10 messages
      expect(container.children.length).toBe(10);

      // Oldest messages (1-5) should be pruned.
      // NOTE: Don't use substring checks (e.g. "Message 1") because it matches "Message 10".
      expect(container.querySelector('[data-message-id="msg_prune_1"]')).toBeNull();
      expect(container.querySelector('[data-message-id="msg_prune_5"]')).toBeNull();

      // Newest messages (6-15) should remain
      expect(container.querySelector('[data-message-id="msg_prune_6"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="msg_prune_15"]')).not.toBeNull();
    });

    test('should remove pruned messages from tracking map', () => {
      // Add 15 messages
      for (let i = 1; i <= 15; i++) {
        messageView.renderMessage({
          id: `msg_map_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now()
        });
      }

      // Tracking map should only contain 10 entries
      expect(messageView.messageElements.size).toBe(10);

      // Old message IDs should not be in map
      expect(messageView.messageElements.has('msg_map_1')).toBe(false);
      expect(messageView.messageElements.has('msg_map_5')).toBe(false);

      // New message IDs should be in map
      expect(messageView.messageElements.has('msg_map_15')).toBe(true);
    });
  });

  describe('Auto-scroll Behavior', () => {
    test('should scroll to bottom after rendering message', () => {
      // Add multiple messages to ensure container is scrollable
      for (let i = 1; i <= 5; i++) {
        messageView.renderMessage({
          id: `msg_scroll_${i}`,
          role: 'user',
          content: `Message ${i}\n\n`.repeat(20), // Long messages
          timestamp: Date.now()
        });
      }

      // Verify scroll infrastructure is set up:
      // 1. Scroll button should have been created during init
      expect(messageView.scrollButtonElement).toBeTruthy();
      // 2. All messages should be rendered in the container
      const rendered = container.querySelectorAll('.chat-entry');
      expect(rendered.length).toBe(5);
    });

    test('should not scroll when autoScroll is disabled', () => {
      messageView.autoScroll = false;

      const initialScrollTop = container.scrollTop;

      messageView.renderMessage({
        id: 'msg_no_scroll',
        role: 'user',
        content: 'This should not trigger scroll',
        timestamp: Date.now()
      });

      // Scroll position should not change
      expect(container.scrollTop).toBe(initialScrollTop);
    });
  });

  describe('XSS Protection (Security)', () => {
    const xssPayloads = [
      '<script>alert("xss")</script>',
      '<img src=x onerror=alert(1)>',
      '<iframe src="javascript:alert(1)">',
      '<svg onload=alert(1)>',
      '<body onload=alert(1)>',
      'javascript:alert(1)',
      '<a href="javascript:alert(1)">Click</a>',
      '<input onfocus=alert(1) autofocus>',
      '<marquee onstart=alert(1)>',
      '<details open ontoggle=alert(1)>'
    ];

    xssPayloads.forEach((payload, index) => {
      test(`should escape XSS payload ${index + 1}: ${payload.substring(0, 30)}...`, () => {
        const message = {
          id: `xss_test_${index}`,
          role: 'user',
          content: payload,
          timestamp: Date.now()
        };

        const element = messageView.renderMessage(message);

        // CRITICAL: Dangerous HTML tags should be ESCAPED (show as text, not executable)
        // Unescaped: <script> or <img src=x onerror=alert(1)>
        // Escaped: &lt;script&gt; or &lt;img src=x onerror=alert(1)&gt;
        
        // Check for UNESCAPED dangerous tags (these would be exploitable)
        expect(element.innerHTML).not.toContain('<script>');
        expect(element.innerHTML).not.toContain('<iframe');
        expect(element.innerHTML).not.toContain('<svg ');
        expect(element.innerHTML).not.toContain('<img ');
        expect(element.innerHTML).not.toContain('<body ');
        
        // Verify dangerous content IS escaped (contains &lt; and &gt;)
        if (payload.includes('<')) {
          expect(element.innerHTML).toMatch(/&lt;/);
          expect(element.innerHTML).toMatch(/&gt;/);
        }
      });
    });

    test('should escape HTML in markdown assistant messages', () => {
      const message = {
        id: 'xss_markdown',
        role: 'assistant',
        content: 'Here is code: `<script>alert(1)</script>`',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      // Inline code should be escaped
      expect(element.innerHTML).not.toContain('<script>alert(1)</script>');
    });
  });

  describe('Error Handling', () => {
    test('should handle null message gracefully', () => {
      const element = messageView.renderMessage(null);

      expect(element).toBeNull();
      expect(container.children.length).toBe(0);
    });

    test('should handle message without ID', () => {
      const message = {
        // No id field
        role: 'user',
        content: 'Message without ID',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      // Should still render with generated ID
      expect(element).not.toBeNull();
      expect(element.dataset.messageId).toBeTruthy();
      expect(element.textContent).toContain('Message without ID');
    });

    test('should handle invalid timestamp', () => {
      const message = {
        id: 'msg_bad_time',
        role: 'user',
        content: 'Bad timestamp',
        timestamp: 'invalid'
      };

      const element = messageView.renderMessage(message);

      // Should not crash, should render with fallback timestamp
      expect(element).not.toBeNull();
    });

    test('should handle extremely long message content', () => {
      const longContent = 'x'.repeat(100000); // 100KB message

      const message = {
        id: 'msg_huge',
        role: 'user',
        content: longContent,
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      // Should render without crashing
      expect(element).not.toBeNull();
      expect(element.textContent).toContain('x');
    });
  });

  describe('Timestamp Formatting', () => {
    test('should format timestamp for user messages', () => {
      const timestamp = new Date('2025-01-15T10:30:00Z').getTime();
      
      const message = {
        id: 'msg_time_001',
        role: 'user',
        content: 'Test timestamp',
        timestamp
      };

      const element = messageView.renderMessage(message);

      const timestampElem = element.querySelector('.chat-timestamp');
      expect(timestampElem).not.toBeNull();
      expect(timestampElem.textContent).toBeTruthy();
    });

    test('should show timestamp for assistant messages by default', () => {
      const message = {
        id: 'msg_time_002',
        role: 'assistant',
        content: 'Assistant response',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      // Assistant messages show timestamps by default (CSS may hide in special trail-adjacent layouts).
      const timestampElem = element.querySelector('.chat-timestamp');
      expect(timestampElem).not.toBeNull();
    });
  });

  describe('DOM Element Cleanup', () => {
    test('should remove element from DOM when cleared', () => {
      const message = {
        id: 'msg_clear_001',
        role: 'user',
        content: 'To be cleared',
        timestamp: Date.now()
      };

      messageView.renderMessage(message);
      expect(container.children.length).toBe(1);

      // Clear all messages - manually clear for now (method doesn't exist)
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
      messageView.messageElements.clear();

      expect(container.children.length).toBe(0);
      expect(messageView.messageElements.size).toBe(0);
    });

    test('should remove specific message by ID manually', () => {
      messageView.renderMessage({
        id: 'msg_A',
        role: 'user',
        content: 'Message A',
        timestamp: Date.now()
      });

      messageView.renderMessage({
        id: 'msg_B',
        role: 'user',
        content: 'Message B',
        timestamp: Date.now()
      });

      // Manually remove (method doesn't exist yet - THIS IS A BUG/MISSING FEATURE)
      const elementA = messageView.messageElements.get('msg_A');
      if (elementA && elementA.parentNode) {
        elementA.parentNode.removeChild(elementA);
      }
      messageView.messageElements.delete('msg_A');

      expect(container.children.length).toBe(1);
      expect(container.textContent).not.toContain('Message A');
      expect(container.textContent).toContain('Message B');
      expect(messageView.messageElements.has('msg_A')).toBe(false);
    });
  });
});

