'use strict';

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: () => {},
  trace: () => {},
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const ChatSummaryAttacher = require(
  '../../../../src/renderer/chat/controllers/modules/ChatSummaryAttacher'
);

function createAttacher(summaries = []) {
  const aether = {
    chatSummaries: { list: jest.fn().mockResolvedValue(summaries) },
  };
  const attacher = new ChatSummaryAttacher({ aether });
  const fileManager = {
    _addFileToQueue: jest.fn().mockResolvedValue(undefined),
    _updatePreviewUI: jest.fn(),
  };
  return { attacher, aether, fileManager };
}

describe('ChatSummaryAttacher', () => {
  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
  });

  describe('attach', () => {
    it('downloads summary and creates JSON file attachment', async () => {
      const summary = {
        id: 'sum-1',
        summary_text: 'This chat discussed project goals.',
        key_points: ['goal1', 'goal2'],
        entities: { people: ['Alice'] },
        summary_type: 'full',
      };
      const { attacher, fileManager, aether } = createAttacher([summary]);
      const chats = [{ id: 'chat-1', title: 'Project Chat' }];

      await attacher.attach(chats, fileManager);

      expect(aether.chatSummaries.list).toHaveBeenCalledWith('chat-1');
      expect(fileManager._addFileToQueue).toHaveBeenCalledTimes(1);

      const addedFile = fileManager._addFileToQueue.mock.calls[0][0];
      expect(addedFile.name).toBe('Project_Chat_summary.json');
      expect(addedFile.type).toBe('application/json');
      expect(addedFile.size).toBeGreaterThan(0);

      // Read File content via FileReader (jsdom compatible)
      const content = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(addedFile);
      });
      const parsed = JSON.parse(content);
      expect(parsed.type).toBe('chat_summary');
      expect(parsed.chat_id).toBe('chat-1');
      expect(parsed.summary).toBe('This chat discussed project goals.');
      expect(parsed.key_points).toEqual(['goal1', 'goal2']);
      expect(parsed.metadata.api_paths.chat).toBe('/v1/storage/chat/get/chat-1');
    });

    it('skips chats with no summary available', async () => {
      const { attacher, fileManager } = createAttacher([]);
      const chats = [{ id: 'chat-1', title: 'Empty Chat' }];

      await attacher.attach(chats, fileManager);

      expect(fileManager._addFileToQueue).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith(
        'No summary available for chat - skipping attachment',
        expect.objectContaining({ chatId: 'chat-1' })
      );
    });

    it('handles multiple chats', async () => {
      const summary = { id: 's1', summary_text: 'Sum', key_points: [] };
      const { attacher, fileManager, aether } = createAttacher([summary]);
      const chats = [
        { id: 'c1', title: 'Chat 1' },
        { id: 'c2', title: 'Chat 2' },
      ];

      await attacher.attach(chats, fileManager);

      expect(aether.chatSummaries.list).toHaveBeenCalledTimes(2);
      expect(fileManager._addFileToQueue).toHaveBeenCalledTimes(2);
      expect(fileManager._updatePreviewUI).toHaveBeenCalled();
    });

    it('returns early when fileManager is null', async () => {
      const { attacher } = createAttacher();

      await attacher.attach([{ id: 'c1' }], null);

      expect(mockLog.error).toHaveBeenCalledWith('FileManager not initialized');
    });

    it('catches per-chat errors without stopping loop', async () => {
      const { attacher, fileManager, aether } = createAttacher();
      aether.chatSummaries.list
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce([{ id: 's', summary_text: 'ok', key_points: [] }]);

      await attacher.attach([{ id: 'c1' }, { id: 'c2', title: 'C2' }], fileManager);

      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to attach summary for chat',
        expect.objectContaining({ chatId: 'c1' })
      );
      expect(fileManager._addFileToQueue).toHaveBeenCalledTimes(1);
    });

    it('falls back to keyPoints when key_points is missing', async () => {
      const summary = { id: 's1', summary_text: 'Sum', keyPoints: ['kp1'] };
      const { attacher, fileManager } = createAttacher([summary]);

      await attacher.attach([{ id: 'c1', title: 'T' }], fileManager);

      const file = fileManager._addFileToQueue.mock.calls[0][0];
      const content = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(file);
      });
      expect(JSON.parse(content).key_points).toEqual(['kp1']);
    });

    it('uses aether null path gracefully', async () => {
      const attacher = new ChatSummaryAttacher({ aether: null });
      const fileManager = {
        _addFileToQueue: jest.fn(),
        _updatePreviewUI: jest.fn(),
      };

      await attacher.attach([{ id: 'c1' }], fileManager);

      // No chatSummaries API → no summaries → skip
      expect(fileManager._addFileToQueue).not.toHaveBeenCalled();
    });

    it('falls back to key_topics when key_points and keyPoints are missing', async () => {
      const summary = { id: 's1', summary_text: 'Sum', key_topics: ['topic1', 'topic2'] };
      const { attacher, fileManager } = createAttacher([summary]);

      await attacher.attach([{ id: 'c1', title: 'T' }], fileManager);

      const file = fileManager._addFileToQueue.mock.calls[0][0];
      const content = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(file);
      });
      expect(JSON.parse(content).key_points).toEqual(['topic1', 'topic2']);
    });

    it('falls back to summary field when summary_text is missing', async () => {
      const summary = { id: 's1', summary: 'Fallback summary', key_points: [] };
      const { attacher, fileManager } = createAttacher([summary]);

      await attacher.attach([{ id: 'c1', title: 'T' }], fileManager);

      const file = fileManager._addFileToQueue.mock.calls[0][0];
      const content = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(file);
      });
      expect(JSON.parse(content).summary).toBe('Fallback summary');
    });

    it('sanitizes special characters in filename', async () => {
      const summary = { id: 's1', summary_text: 'Sum', key_points: [] };
      const { attacher, fileManager } = createAttacher([summary]);

      await attacher.attach([{ id: 'c1', title: 'My Chat: Special/Chars! (v2)' }], fileManager);

      const file = fileManager._addFileToQueue.mock.calls[0][0];
      expect(file.name).toBe('My_Chat__Special_Chars___v2__summary.json');
      expect(file.name).not.toMatch(/[^a-z0-9_.]/i);
    });
  });

  describe('dispose', () => {
    it('nulls aether', () => {
      const { attacher } = createAttacher();
      attacher.dispose();
      expect(attacher.aether).toBeNull();
    });
  });
});
