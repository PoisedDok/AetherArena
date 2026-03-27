'use strict';

/**
 * Pure functions and constants for the Memory Browser.
 */

const MEMORY_SCOPES = [
  { id: 'all', label: 'All', tone: 'accent', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect></svg>' },
  { id: 'global', label: 'Global', tone: 'info', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>' },
  { id: 'chat', label: 'Current Chat', tone: 'primary', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>' }
];

const MEMORY_TYPE_TONES = {
  fact: 'accent',
  decision: 'info',
  preference: 'warning',
  insight: 'success',
  action_item: 'error',
  reference: 'primary'
};

function getScopeCount(memories, scopeId, currentChatId) {
  if (scopeId === 'all') return memories.length;
  if (scopeId === 'global') {
    return memories.filter(m => !m.source_chat_id).length;
  }
  if (scopeId === 'chat') {
    if (currentChatId) {
      return memories.filter(m => m.source_chat_id === currentChatId).length;
    }
    return memories.filter(m => m.source_chat_id).length;
  }
  return 0;
}

function filterMemories(memories, activeTab, currentChatId, searchQuery, searchResults) {
  let filtered = memories;
  
  // Filter by scope
  if (activeTab === 'global') {
    filtered = filtered.filter(m => !m.source_chat_id);
  } else if (activeTab === 'chat') {
    if (currentChatId) {
      filtered = filtered.filter(m => m.source_chat_id === currentChatId);
    } else {
      filtered = filtered.filter(m => m.source_chat_id);
    }
  }
  
  // Filter by search query
  if (searchQuery) {
    if (searchResults) {
      const resultIds = new Set(searchResults.map(r => r.id));
      filtered = filtered.filter(m => resultIds.has(m.id));
      
      filtered.sort((a, b) => {
        const aIdx = searchResults.findIndex(r => r.id === a.id);
        const bIdx = searchResults.findIndex(r => r.id === b.id);
        return aIdx - bIdx;
      });
    } else {
      filtered = filtered.filter(m => {
        const content = (m.content || '').toLowerCase();
        return content.includes(searchQuery);
      });
    }
  }
  
  return filtered;
}

function groupMemoriesByChat(memories) {
  const grouped = {};
  memories.forEach(memory => {
    const chatId = memory.source_chat_id || 'unknown';
    if (!grouped[chatId]) {
      grouped[chatId] = [];
    }
    grouped[chatId].push(memory);
  });
  
  return Object.entries(grouped).sort((a, b) => b[1].length - a[1].length);
}

function escapeHtml(text) {
  if (typeof document === 'undefined') {
    // Fallback for tests/environments without DOM
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

module.exports = {
  MEMORY_SCOPES,
  MEMORY_TYPE_TONES,
  getScopeCount,
  filterMemories,
  groupMemoriesByChat,
  escapeHtml
};
