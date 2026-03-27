'use strict';

const Utils = require('./MemoryBrowserUtils');
const Toast = require('../../../../shared/components/Toast');

function renderUI(ctx) {
  ctx._clearListeners();
  ctx.bodyEl.innerHTML = '';
  
  // Header row: Search bar + Add Memory button
  const headerRow = document.createElement('div');
  headerRow.className = 'memory-header-row';
  
  // Search wrapper with icon
  const searchWrapper = document.createElement('div');
  searchWrapper.className = 'memory-search-wrapper';
  searchWrapper.innerHTML = `
    <svg class="memory-search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
      <circle cx="11" cy="11" r="8"></circle>
      <path d="m21 21-4.35-4.35"></path>
    </svg>
  `;
  
  ctx.searchInput = document.createElement('input');
  ctx.searchInput.type = 'text';
  ctx.searchInput.className = 'memory-search-input';
  ctx.searchInput.placeholder = 'Search memories...';
  if (ctx.searchQuery) {
    ctx.searchInput.value = ctx.searchQuery;
  }
  ctx._trackListener(ctx.searchInput, 'input', (e) => ctx._handleSearch(e.target.value));
  searchWrapper.appendChild(ctx.searchInput);
  
  // Configure Agent button (icon only)
  const configBtn = document.createElement('button');
  configBtn.className = 'memory-action-icon-btn';
  configBtn.title = 'Configure Memory Agent';
  configBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
    </svg>
  `;
  ctx._trackListener(configBtn, 'click', () => {
    ctx.log.debug('[ConfigureAgent] Button clicked');
    ctx.close();
    ctx.onConfigureAgent();
  });

  // Add Memory button
  const addBtn = document.createElement('button');
  addBtn.className = 'memory-add-btn';
  addBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
    <span>Add Memory</span>
  `;
  ctx._trackListener(addBtn, 'click', () => {
    ctx.log.debug('[AddMemory] Button clicked');
    ctx.isCreatingMemory = true;
    renderCreateForm(ctx);
  });

  headerRow.appendChild(searchWrapper);
  headerRow.appendChild(configBtn);
  headerRow.appendChild(addBtn);
  
  // Tabs
  const tabsContainer = document.createElement('div');
  tabsContainer.className = 'memory-tabs';
  
  Utils.MEMORY_SCOPES.forEach(scope => {
    const count = Utils.getScopeCount(ctx.memories, scope.id, ctx.currentChatId);
    const tab = createTab(ctx, scope, count);
    tabsContainer.appendChild(tab);
  });
  
  // Content container
  const contentContainer = document.createElement('div');
  contentContainer.className = 'memory-content';
  
  if (ctx.isCreatingMemory) {
    // If we're creating a memory, render the form instead of tab content
    renderCreateForm(ctx, contentContainer);
  } else {
    renderTabContent(ctx, contentContainer);
  }
  
  // Stats
  ctx.statsEl = document.createElement('div');
  ctx.statsEl.className = 'memory-stats';
  updateStats(ctx);
  
  ctx.bodyEl.appendChild(headerRow);
  ctx.bodyEl.appendChild(tabsContainer);
  ctx.bodyEl.appendChild(contentContainer);
  if (!ctx.isCreatingMemory) {
    ctx.bodyEl.appendChild(ctx.statsEl);
  }
  
  ctx._trackTimer(() => ctx.searchInput && ctx.searchInput.focus(), 100);
}

function createTab(ctx, scope, count) {
  const isActive = ctx.activeTab === scope.id;
  const tab = document.createElement('button');
  tab.className = `memory-tab${isActive ? ' is-active' : ''}`;
  tab.dataset.type = scope.id;
  tab.dataset.tone = scope.tone;
  
  const icon = document.createElement('span');
  icon.className = 'memory-tab-icon';
  if (scope.icon.startsWith('<svg')) {
    icon.innerHTML = scope.icon;
  } else {
    icon.textContent = scope.icon;
  }
  
  const label = document.createElement('span');
  label.className = 'memory-tab-label';
  label.textContent = scope.label;
  
  const badge = document.createElement('span');
  badge.className = 'memory-tab-badge';
  badge.textContent = count;
  
  tab.appendChild(icon);
  tab.appendChild(label);
  tab.appendChild(badge);
  
  ctx._trackListener(tab, 'click', () => {
    ctx.log.debug('[Tab] Switching to:', scope.id);
    ctx._handleTabSwitch(scope.id);
  });
  
  return tab;
}

function renderTabContent(ctx, container) {
  if (ctx._clearListenersFor) {
    ctx._clearListenersFor(container);
  }
  container.innerHTML = '';
  
  const filteredMemories = Utils.filterMemories(
    ctx.memories, 
    ctx.activeTab, 
    ctx.currentChatId, 
    ctx.searchQuery, 
    ctx._searchResults
  );
  
  if (filteredMemories.length === 0) {
    container.innerHTML = `
      <div class="modal-empty-state">
        <svg class="memory-empty-icon" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
          <path d="M12 8v4"></path>
          <path d="M12 16h.01"></path>
        </svg>
        <div class="memory-empty-title">
          ${ctx.searchQuery ? 'No matches found' : 'No memories yet'}
        </div>
        <div class="memory-empty-subtitle">
          ${ctx.searchQuery ? 'Try a different search term' : 'Memories will appear here as they are created'}
        </div>
      </div>
    `;
    return;
  }
  
  // If in chat-specific tab, group by chat
  if (ctx.activeTab === 'chat' && filteredMemories.length > 0) {
    renderChatGroupedMemories(ctx, container, filteredMemories);
  } else {
    // Standard list view
    const list = document.createElement('div');
    list.className = 'memory-list';
    
    filteredMemories.forEach(memory => {
      const card = createMemoryCard(ctx, memory);
      list.appendChild(card);
    });
    
    container.appendChild(list);
  }
}

function renderChatGroupedMemories(ctx, container, memories) {
  const sortedChats = Utils.groupMemoriesByChat(memories);
  
  sortedChats.forEach(([chatId, chatMemories]) => {
    const chatGroup = document.createElement('div');
    chatGroup.className = 'memory-chat-group';
    
    // Chat header
    const chatHeader = document.createElement('div');
    chatHeader.className = 'memory-chat-header';
    
    const chatInfo = document.createElement('div');
    chatInfo.className = 'memory-chat-info';
    chatInfo.innerHTML = `
      <span class="memory-chat-icon">C</span>
      <span class="memory-chat-name">Chat ${chatId.substring(0, 8)}</span>
    `;
    
    const chatCount = document.createElement('span');
    chatCount.className = 'memory-chat-count';
    chatCount.textContent = `${chatMemories.length} ${chatMemories.length === 1 ? 'memory' : 'memories'}`;
    
    chatHeader.appendChild(chatInfo);
    chatHeader.appendChild(chatCount);
    
    // Memory cards
    const chatList = document.createElement('div');
    chatList.className = 'memory-chat-list';
    
    chatMemories.forEach(memory => {
      const card = createMemoryCard(ctx, memory);
      chatList.appendChild(card);
    });
    
    chatGroup.appendChild(chatHeader);
    chatGroup.appendChild(chatList);
    container.appendChild(chatGroup);
  });
}

function createMemoryCard(ctx, memory) {
  const isEditing = ctx.editingMemoryId === memory.id;
  const card = document.createElement('div');
  card.className = `memory-card${isEditing ? ' is-editing' : ''}`;
  card.dataset.id = memory.id;
  
  // Content
  const content = document.createElement('div');
  content.className = 'memory-card-content';
  
  if (isEditing) {
    const textarea = document.createElement('textarea');
    textarea.className = 'memory-card-edit-textarea';
    textarea.value = memory.content || '';
    content.appendChild(textarea);
    ctx._trackTimer(() => textarea.focus(), 50);
  } else {
    content.textContent = memory.content || '';
  }
  
  // Metadata row
  const meta = document.createElement('div');
  meta.className = 'memory-card-meta';
  
  const metaLeft = document.createElement('div');
  metaLeft.className = 'memory-meta-left';
  
  // Type badge
  const typeTone = Utils.MEMORY_TYPE_TONES[memory.memory_type] || 'neutral';
  const typeBadge = document.createElement('span');
  typeBadge.className = 'memory-badge';
  typeBadge.dataset.tone = typeTone;
  typeBadge.textContent = memory.memory_type || 'other';
  metaLeft.appendChild(typeBadge);
  
  // Scope badge (show if in All tab)
  if (ctx.activeTab === 'all') {
    const isChat = !!memory.source_chat_id;
    const scopeTone = isChat ? 'info' : 'accent';
    const scopeIcon = isChat ? 'C' : 'G';
    const scopeText = isChat ? 'Chat' : 'Global';
    
    const scopeBadge = document.createElement('span');
    scopeBadge.className = `memory-badge memory-badge-scope${isChat ? ' is-link' : ''}`;
    scopeBadge.dataset.tone = scopeTone;
    scopeBadge.innerHTML = `<span>${scopeIcon}</span><span>${scopeText}</span>`;
    
    if (isChat) {
      scopeBadge.title = `Click to open chat: ${memory.source_chat_id.substring(0, 8)}...`;
      ctx._trackListener(scopeBadge, 'click', (e) => {
        e.stopPropagation();
        ctx.log.debug('[MemoryBrowser] Opening chat:', memory.source_chat_id);
        if (ctx.eventBus) {
          ctx.eventBus.emit('chat:switch', { chatId: memory.source_chat_id });
        } else {
          ctx.aether?.chat?.switchTo?.(memory.source_chat_id);
        }
        ctx.close();
      });
    }
    
    metaLeft.appendChild(scopeBadge);
  }
  
  // Importance badge
  const score = memory.importance_score || 0;
  const scoreTone = score > 0.7 ? 'success' : score > 0.4 ? 'warning' : 'error';
  const importance = document.createElement('span');
  importance.className = 'memory-badge memory-badge-importance';
  importance.dataset.tone = scoreTone;
  importance.textContent = score.toFixed(2);
  metaLeft.appendChild(importance);
  
  // Date
  const date = new Date(memory.extracted_at || Date.now());
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const dateEl = document.createElement('span');
  dateEl.className = 'memory-date';
  dateEl.textContent = dateStr;
  metaLeft.appendChild(dateEl);
  
  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'memory-actions';
  
  if (isEditing) {
    const saveBtn = createButton('Save', 'success', true);
    const cancelBtn = createButton('Cancel', 'neutral', false);
    
    ctx._trackListener(saveBtn, 'click', async (e) => {
      ctx.log.debug('[Save] Button clicked for memory:', memory.id);
      e.stopPropagation();
      
      if (ctx.isSubmitting) return;
      
      const textarea = card.querySelector('textarea');
      if (!textarea) {
        ctx.log.error('Textarea not found in card');
        Toast.error('Edit field not found.');
        return;
      }
      
      const newContent = textarea.value.trim();
      if (!newContent) {
        Toast.warning('Memory content cannot be empty.');
        return;
      }
      
      ctx.isSubmitting = true;
      const originalHtml = saveBtn.innerHTML;
      saveBtn.innerHTML = '<span class="modal-spinner" style="width: 14px; height: 14px; border-width: 2px; border-top-color: currentColor; margin-right: 6px;"></span><span>Saving...</span>';
      saveBtn.disabled = true;

      try {
        await ctx._handleSaveMemory(memory.id, newContent);
      } finally {
        if (ctx.isOpen) {
          ctx.isSubmitting = false;
          saveBtn.innerHTML = originalHtml;
          saveBtn.disabled = false;
        }
      }
    });
    
    ctx._trackListener(cancelBtn, 'click', (e) => {
      ctx.log.debug('[Cancel] Button clicked');
      e.stopPropagation();
      ctx.editingMemoryId = null;
      ctx._renderUI();
    });
    
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
  } else {
    // Promote/Demote button
    if (memory.source_chat_id) {
      const promoteBtn = createButton('Promote', 'success', false, `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="16 12 12 8 8 12"></polyline>
          <line x1="12" y1="16" x2="12" y2="8"></line>
        </svg>
      `);
      ctx._trackListener(promoteBtn, 'click', async (e) => {
        ctx.log.debug('[Promote] Button clicked for memory:', memory.id);
        e.stopPropagation();
        if (ctx.isSubmitting) return;
        ctx.isSubmitting = true;
        promoteBtn.disabled = true;
        try {
          await ctx._handlePromoteMemory(memory);
        } finally {
          if (ctx.isOpen) {
            ctx.isSubmitting = false;
            promoteBtn.disabled = false;
          }
        }
      });
      actions.appendChild(promoteBtn);
    } else {
      const demoteBtn = createButton('Demote', 'warning', false, `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="8 12 12 16 16 12"></polyline>
          <line x1="12" y1="8" x2="12" y2="16"></line>
        </svg>
      `);
      ctx._trackListener(demoteBtn, 'click', async (e) => {
        ctx.log.debug('[Demote] Button clicked for memory:', memory.id);
        e.stopPropagation();
        if (ctx.isSubmitting) return;
        ctx.isSubmitting = true;
        demoteBtn.disabled = true;
        try {
          await ctx._handleDemoteMemory(memory);
        } finally {
          if (ctx.isOpen) {
            ctx.isSubmitting = false;
            demoteBtn.disabled = false;
          }
        }
      });
      actions.appendChild(demoteBtn);
    }
    
    const editBtn = createButton('Edit', 'info', false, `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
      </svg>
    `);
    
    const deleteBtn = createButton('Delete', 'error', false, `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
    `);
    
    ctx._trackListener(editBtn, 'click', (e) => {
      ctx.log.debug('[Edit] Button clicked for memory:', memory.id);
      e.stopPropagation();
      ctx.editingMemoryId = memory.id;
      ctx._renderUI();
    });
    
    ctx._trackListener(deleteBtn, 'click', async (e) => {
      ctx.log.debug('[Delete] Button clicked for memory:', memory.id);
      e.stopPropagation();
      if (ctx.isSubmitting) return;
      ctx.isSubmitting = true;
      deleteBtn.disabled = true;
      try {
        await ctx._handleDeleteMemory(memory);
      } finally {
        if (ctx.isOpen) {
          ctx.isSubmitting = false;
          deleteBtn.disabled = false;
        }
      }
    });
    
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
  }
  
  meta.appendChild(metaLeft);
  meta.appendChild(actions);
  
  card.appendChild(content);
  card.appendChild(meta);
  
  return card;
}

function createButton(text, tone, isPrimary, icon = null) {
  const btn = document.createElement('button');
  btn.className = `memory-btn${isPrimary ? ' is-primary' : ''}`;
  btn.dataset.tone = tone;
  
  if (icon) {
    btn.innerHTML = icon;
    const span = document.createElement('span');
    span.textContent = text;
    btn.appendChild(span);
  } else {
    btn.textContent = text;
  }
  
  return btn;
}

function renderCreateForm(ctx, existingContainer = null) {
  const contentContainer = existingContainer || ctx.bodyEl.querySelector('.memory-content');
  if (!contentContainer) return;
  
  if (ctx._clearListenersFor) {
    ctx._clearListenersFor(contentContainer);
  }
  
  contentContainer.innerHTML = '';
  
  const form = document.createElement('div');
  form.className = 'memory-create-form';
  
  // Form title
  const title = document.createElement('h3');
  title.className = 'memory-form-title';
  title.innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
    <span>Create New Memory</span>
  `;
  
  // Content textarea
  const contentLabel = document.createElement('label');
  contentLabel.className = 'memory-form-label';
  contentLabel.textContent = 'Content *';
  
  const contentTextarea = document.createElement('textarea');
  contentTextarea.className = 'memory-form-textarea';
  contentTextarea.placeholder = 'Enter memory content... (e.g., "User prefers concise summaries")';
  
  // Memory type dropdown
  const typeLabel = document.createElement('label');
  typeLabel.className = 'memory-form-label';
  typeLabel.textContent = 'Memory Type *';
  
  const typeSelect = document.createElement('select');
  typeSelect.className = 'memory-form-select';
  
  const types = [
    { value: 'fact', label: 'Fact' },
    { value: 'decision', label: 'Decision' },
    { value: 'preference', label: 'Preference' },
    { value: 'insight', label: 'Insight' },
    { value: 'action_item', label: 'Action Item' },
    { value: 'reference', label: 'Reference' }
  ];
  
  types.forEach(type => {
    const option = document.createElement('option');
    option.value = type.value;
    option.textContent = type.label;
    typeSelect.appendChild(option);
  });
  
  // Scope selection or note
  const scopeContainer = document.createElement('div');
  let scopeSelect = null;
  
  if (ctx.currentChatId) {
    const scopeLabel = document.createElement('label');
    scopeLabel.className = 'memory-form-label';
    scopeLabel.textContent = 'Memory Scope *';
    
    scopeSelect = document.createElement('select');
    scopeSelect.className = 'memory-form-select';
    
    const globalOption = document.createElement('option');
    globalOption.value = 'global';
    globalOption.textContent = 'Global (All Chats)';
    
    const chatOption = document.createElement('option');
    chatOption.value = 'chat';
    chatOption.textContent = 'Current Chat Only';
    
    if (ctx.activeTab === 'chat') {
      chatOption.selected = true;
    }
    
    scopeSelect.appendChild(globalOption);
    scopeSelect.appendChild(chatOption);
    
    scopeContainer.appendChild(scopeLabel);
    scopeContainer.appendChild(scopeSelect);
  } else {
    const scopeNote = document.createElement('div');
    scopeNote.className = 'memory-form-note';
    scopeNote.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="16" x2="12" y2="12"></line>
        <line x1="12" y1="8" x2="12.01" y2="8"></line>
      </svg>
      <span>This memory will be created as <strong>Global</strong> (available in all chats). Open Memory Browser from a specific chat to add chat-specific memories.</span>
    `;
    scopeContainer.appendChild(scopeNote);
  }
  
  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'memory-form-actions';
  
  const cancelBtn = createButton('Cancel', 'neutral', false);
  const createBtn = createButton('Create Memory', 'success', true);
  
    ctx._trackListener(cancelBtn, 'click', () => {
      ctx.log.debug('[CreateForm] Cancel clicked');
      ctx.isCreatingMemory = false;
      ctx._renderUI();
    });
  
  ctx._trackListener(createBtn, 'click', async () => {
    ctx.log.debug('[CreateForm] Create clicked');
    if (ctx.isSubmitting) return;

    const content = contentTextarea.value.trim();
    const memoryType = typeSelect.value;
    const scope = scopeSelect ? scopeSelect.value : 'global';
    
    if (!content) {
      Toast.warning('Memory content cannot be empty.');
      contentTextarea.focus();
      return;
    }
    
    ctx.isSubmitting = true;
    const originalHtml = createBtn.innerHTML;
    createBtn.innerHTML = '<span class="modal-spinner" style="width: 14px; height: 14px; border-width: 2px; border-top-color: currentColor; margin-right: 6px;"></span><span>Creating...</span>';
    createBtn.disabled = true;

    try {
      const success = await ctx._handleCreateMemory(content, memoryType, scope);
      if (!success) {
        contentTextarea.focus();
      }
    } finally {
      if (ctx.isOpen) {
        ctx.isSubmitting = false;
        createBtn.innerHTML = originalHtml;
        createBtn.disabled = false;
      }
    }
  });
  
  actions.appendChild(cancelBtn);
  actions.appendChild(createBtn);
  
  // Assemble form
  form.appendChild(title);
  form.appendChild(contentLabel);
  form.appendChild(contentTextarea);
  form.appendChild(typeLabel);
  form.appendChild(typeSelect);
  form.appendChild(scopeContainer);
  form.appendChild(actions);
  
  contentContainer.appendChild(form);
  
  ctx._trackTimer(() => contentTextarea.focus(), 100);
}

function updateStats(ctx) {
  if (ctx.statsEl) {
    const total = ctx.memories.length;
    const globalCount = ctx.memories.filter(m => !m.source_chat_id).length;
    let chatCount = 0;
    if (ctx.currentChatId) {
      chatCount = ctx.memories.filter(m => m.source_chat_id === ctx.currentChatId).length;
    } else {
      chatCount = ctx.memories.filter(m => m.source_chat_id).length;
    }
    
    let filtered = total;
    
    if (ctx.activeTab === 'global') {
      filtered = globalCount;
    } else if (ctx.activeTab === 'chat') {
      filtered = chatCount;
    }
    
    if (ctx.searchQuery) {
      const contentContainer = ctx.bodyEl.querySelector('.memory-content');
      if (contentContainer) {
        filtered = contentContainer.querySelectorAll('.memory-card').length;
      }
    }
    
    if (ctx.activeTab === 'all' && !ctx.searchQuery) {
      ctx.statsEl.textContent = `${total} total \u2022 ${globalCount} global \u2022 ${chatCount} chat-specific`;
    } else {
      ctx.statsEl.textContent = `Showing ${filtered} of ${total} memories`;
    }
  }
}

module.exports = {
  renderUI,
  createTab,
  renderTabContent,
  renderChatGroupedMemories,
  createMemoryCard,
  createButton,
  renderCreateForm,
  updateStats
};
