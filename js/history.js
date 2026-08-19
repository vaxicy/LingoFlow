// LingoFlow History Script

let allItems = [];

document.addEventListener('DOMContentLoaded', () => {
  console.log('LingoFlow: History loaded');

  // Load history
  loadHistory();

  // Initialize event listeners
  initEventListeners();
});

// Load history from storage
function loadHistory() {
  chrome.runtime.sendMessage({ action: 'get_history' }, (response) => {
    if (response && response.history) {
      allItems = response.history;
      renderHistory(allItems);
    }
  });
}

// Initialize event listeners
function initEventListeners() {
  // Search
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', handleSearch);
  }

  // Clear all
  const clearAllBtn = document.getElementById('clear-all-btn');
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', showClearConfirm);
  }

  // Confirm / cancel buttons
  const confirmBtn = document.getElementById('confirm-clear-btn');
  if (confirmBtn) confirmBtn.addEventListener('click', handleClearAll);
  const cancelBtn = document.getElementById('cancel-clear-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', hideClearConfirm);
}

// Handle search
function handleSearch(e) {
  const query = e.target.value.toLowerCase();
  const filtered = allItems.filter(item =>
    item.text.toLowerCase().includes(query) ||
    (item.translation && item.translation.toLowerCase().includes(query))
  );
  renderHistory(filtered);
}

// Show inline clear-all confirmation bar (instead of native confirm)
let clearConfirmTimer = null;
function showClearConfirm() {
  const bar = document.getElementById('clear-confirm');
  if (!bar) return;
  bar.hidden = false;
  const textEl = document.getElementById('clear-confirm-text');
  if (textEl) textEl.textContent = getMessage('clear_confirm', '确定要清空所有记录吗？');
  // Auto-dismiss after 6s so the user isn't stuck on an open confirm
  clearTimeout(clearConfirmTimer);
  clearConfirmTimer = setTimeout(hideClearConfirm, 6000);
}

function hideClearConfirm() {
  clearTimeout(clearConfirmTimer);
  const bar = document.getElementById('clear-confirm');
  if (bar) bar.hidden = true;
}

// Actually clear history
function handleClearAll() {
  hideClearConfirm();
  chrome.runtime.sendMessage({ action: 'clear_history' }, (response) => {
    if (response && response.success) {
      allItems = [];
      renderHistory([]);
    }
  });
}

// Render history list
function renderHistory(items) {
  const listContainer = document.getElementById('history-list');
  const emptyState = document.getElementById('empty-state');

  if (!listContainer || !emptyState) return;

  if (items.length === 0) {
    listContainer.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }

  listContainer.style.display = 'flex';
  emptyState.style.display = 'none';

  listContainer.innerHTML = items.map(item => createHistoryItem(item)).join('');
}

// Create history item HTML
function createHistoryItem(item) {
  const date = new Date(item.createdAt).toLocaleString();
  const source = item.sourceUrl ? new URL(item.sourceUrl).hostname : '';

  return `
    <div class="history-item" data-id="${item.id}">
      <div class="item-content">
        <div class="item-original">${escapeHtml(item.text)}</div>
        ${item.translation ? `<div class="item-translation">${escapeHtml(item.translation)}</div>` : ''}
      </div>
      <div class="item-meta">
        <span class="item-source" title="${escapeHtml(item.sourceUrl || '')}">${escapeHtml(source)}</span>
        <span class="item-date">${date}</span>
        <div class="item-actions">
          <button class="item-action-btn delete" onclick="deleteItem('${item.id}')" data-i18n="delete">Delete</button>
        </div>
      </div>
    </div>
  `;
}

// Delete item
function deleteItem(id) {
  chrome.runtime.sendMessage(
    { action: 'delete_history_item', id: id },
    (response) => {
      if (response && response.success) {
        allItems = allItems.filter(item => item.id !== id);
        renderHistory(allItems);
      }
    }
  );
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
