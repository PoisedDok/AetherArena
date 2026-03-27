'use strict';

const Toast = require('../../../../shared/components/Toast');
const ConfirmDialog = require('../../../../shared/components/ConfirmDialog');

function handleSearch(ctx, query) {
  ctx.searchQuery = query.toLowerCase().trim();
  
  // Clear existing debounce timer
  if (ctx._searchTimer) {
    if (typeof ctx._clearTimer === 'function') {
      ctx._clearTimer(ctx._searchTimer);
    } else {
      clearTimeout(ctx._searchTimer);
    }
    ctx._searchTimer = null;
  }
  
  // Fast path: if empty, just re-render local tab content instantly
  if (!ctx.searchQuery) {
    ctx._searchResults = null;
    ctx._refreshSearchState();
    return;
  }
  
  // Fallback if not injected or mock
  if (!ctx.aether?.memories?.search) {
    ctx._searchResults = null;
    ctx._refreshSearchState();
    return;
  }

  const currentQuery = ctx.searchQuery;

  // Debounce the semantic search
  ctx._searchTimer = ctx._trackTimer(async () => {
    try {
      ctx.log.debug('Running semantic search for:', currentQuery);
      const searchResult = await ctx.aether?.memories?.search(currentQuery, { searchType: 'hybrid' });
      
      if (!ctx.isOpen) return;

      // Ensure we're still on the same query
      if (ctx.searchQuery === currentQuery) {
        ctx._searchResults = searchResult?.results || [];
        ctx._refreshSearchState();
      }
    } catch (err) {
      if (!ctx.isOpen) return;
      ctx.log.error('Memory search failed:', err);
      if (ctx.searchQuery === currentQuery) {
        // Fallback to local filter if backend search fails
        ctx._searchResults = null;
        ctx._refreshSearchState();
      }
    }
  }, 300);
}

async function handleSaveMemory(ctx, memoryId, newContent) {
  ctx.log.debug('Save memory:', memoryId);
  
  if (!newContent || !newContent.trim()) {
    Toast.warning('Memory content cannot be empty.');
    return false;
  }
  
  try {
    ctx.log.debug('Calling update API...');
    const result = await ctx.aether?.memories?.update(memoryId, { content: newContent });
    
    if (!ctx.isOpen) return;

    ctx.log.debug('Update result:', result);
    ctx.log.debug('Memory updated successfully');
    
    Toast.success('Memory updated successfully.');
    
    // Refresh
    ctx.editingMemoryId = null;
    await ctx._renderContent();
  } catch (error) {
    if (!ctx.isOpen) return;
    ctx.log.error('Failed to update memory:', error);
    ctx.log.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    Toast.error(`Failed to update memory: ${error.message || 'Unknown error'}`);
  }
}

async function handlePromoteMemory(ctx, memory) {
  ctx.log.debug('Promote memory:', { id: memory.id });
  
  const confirmMsg = `Promote this memory to Global scope?\n\nIt will be available in all chats.\n\n"${memory.content.substring(0, 100)}${memory.content.length > 100 ? '...' : ''}"`;
  
  const confirmed = await ConfirmDialog.confirm({
    title: 'Promote memory',
    message: confirmMsg,
    confirmText: 'Promote',
    cancelText: 'Cancel'
  });
  
  if (!confirmed) {
    ctx.log.debug('User cancelled promotion');
    return;
  }
  
  try {
    ctx.log.debug('Calling memories.promote...');
    await ctx.aether?.memories?.promote(memory.id);
    
    if (!ctx.isOpen) return;

    ctx.log.debug('Promotion successful');
    
    // Refresh
    await ctx._renderContent();
    
    ctx.log.debug('UI re-rendered');
  } catch (error) {
    if (!ctx.isOpen) return;
    ctx.log.error('Failed to promote memory:', error);
    Toast.error(`Failed to promote memory: ${error.message || 'Unknown error'}`);
  }
}

async function handleDemoteMemory(ctx, memory) {
  ctx.log.debug('Demote memory:', { id: memory.id });
  
  const chatId = await ConfirmDialog.prompt({
    title: 'Assign memory to chat',
    message: 'Enter Chat ID to assign this memory to.\n\n(In the future, this will be a dropdown of your recent chats)',
    placeholder: 'Chat ID',
    confirmText: 'Assign',
    cancelText: 'Cancel'
  });
  if (!chatId) {
    ctx.log.debug('User cancelled demotion');
    return;
  }
  
  try {
    ctx.log.debug('Calling memories.demote...');
    await ctx.aether?.memories?.demote(memory.id, chatId);
    
    if (!ctx.isOpen) return;

    ctx.log.debug('Demotion successful');
    
    // Refresh
    await ctx._renderContent();
    
    ctx.log.debug('UI re-rendered');
  } catch (error) {
    if (!ctx.isOpen) return;
    ctx.log.error('Failed to demote memory:', error);
    Toast.error(`Failed to demote memory: ${error.message || 'Unknown error'}`);
  }
}

async function handleDeleteMemory(ctx, memory) {
  ctx.log.debug('[MemoryBrowserModal] Delete requested for:', memory.id);

  const snippet = `${memory.content.slice(0, 200)}${memory.content.length > 200 ? '...' : ''}`;
  const confirmed = await ConfirmDialog.confirm({
    title: 'Delete memory',
    message: `Delete this memory?\n\n"${snippet}"`,
    confirmText: 'Delete',
    cancelText: 'Cancel',
    variant: 'danger'
  });
  if (!confirmed) return;

  ctx.log.debug('Delete memory:', memory.id);
  try {
    ctx.log.debug('Calling delete API...');
    await ctx.aether?.memories?.delete(memory.id);
    ctx.log.debug('Memory deleted successfully');

    Toast.success('Memory deleted successfully.');

    // Refresh
    await ctx._renderContent();
  } catch (error) {
    ctx.log.error('Failed to delete memory:', error);
    ctx.log.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    Toast.error(`Failed to delete memory: ${error.message || 'Unknown error'}`);
  }
}

async function handleCreateMemory(ctx, content, memoryType, scope) {
  const sourceChatId = scope === 'chat' ? ctx.currentChatId : null;
  
  if (!content) {
    Toast.warning('Memory content cannot be empty.');
    return false;
  }
  
  try {
    ctx.log.debug('Creating memory:', { content: content.substring(0, 50), memoryType, scope });
    await ctx.aether?.memories?.create({
      content: content,
      memory_type: memoryType,
      source_chat_id: sourceChatId
    });
    
    if (!ctx.isOpen) return true;
    
    ctx.log.debug('Memory created successfully');
    Toast.success('Memory created successfully.');
    
    ctx.isCreatingMemory = false;
    await ctx._renderContent();
    return true;
  } catch (error) {
    if (!ctx.isOpen) return false;
    ctx.log.error('Failed to create memory:', error);
    Toast.error(`Failed to create memory: ${error.message || 'Unknown error'}`);
    return false;
  }
}

module.exports = {
  handleSearch,
  handleSaveMemory,
  handlePromoteMemory,
  handleDemoteMemory,
  handleDeleteMemory,
  handleCreateMemory
};
