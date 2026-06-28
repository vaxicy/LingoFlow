// LingoFlow Vocabulary Script

let allItems = [];
let currentFilter = 'all';

document.addEventListener('DOMContentLoaded', () => {
  console.log('LingoFlow: Vocabulary loaded');

  // Load vocabulary
  loadVocabulary();

  // Initialize event listeners
  initEventListeners();
});

// Load vocabulary from storage
function loadVocabulary() {
  chrome.runtime.sendMessage({ action: 'get_vocabulary' }, (response) => {
    if (response && response.vocabulary) {
      allItems = response.vocabulary;
      renderVocabulary(allItems);
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

  // Export
  const exportBtn = document.getElementById('export-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', handleExport);
  }

  // Filters
  const filterBtns = document.querySelectorAll('.filter-btn');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.getAttribute('data-filter');
      filterAndRender();
    });
  });
}

// Handle search
function handleSearch(e) {
  const query = e.target.value.toLowerCase();
  filterAndRender(query);
}

// Filter and render
function filterAndRender(query = '') {
  let filtered = allItems;

  // Filter by type
  if (currentFilter !== 'all') {
    filtered = filtered.filter(item => item.type === currentFilter);
  }

  // Filter by search query
  if (query) {
    filtered = filtered.filter(item =>
      item.text.toLowerCase().includes(query) ||
      (item.translation && item.translation.toLowerCase().includes(query))
    );
  }

  renderVocabulary(filtered);
}

// Render vocabulary list
function renderVocabulary(items) {
  const listContainer = document.getElementById('vocabulary-list');
  const emptyState = document.getElementById('empty-state');

  if (!listContainer || !emptyState) return;

  if (items.length === 0) {
    listContainer.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }

  listContainer.style.display = 'flex';
  emptyState.style.display = 'none';

  listContainer.innerHTML = items.map(item => createVocabularyItem(item)).join('');
}

// Create vocabulary item HTML
function createVocabularyItem(item) {
  const date = new Date(item.createdAt).toLocaleDateString();
  const source = item.sourceUrl ? new URL(item.sourceUrl).hostname : '';

  return `
    <div class="vocabulary-item" data-id="${item.id}">
      <div class="item-header">
        <div class="item-text">${escapeHtml(item.text)}</div>
        <span class="item-type">${item.type}</span>
      </div>
      ${item.translation ? `<div class="item-translation">${escapeHtml(item.translation)}</div>` : ''}
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
  if (!confirm(getMessage('delete_confirm'))) return;

  chrome.runtime.sendMessage(
    { action: 'delete_vocabulary_item', id: id },
    (response) => {
      if (response && response.success) {
        allItems = allItems.filter(item => item.id !== id);
        filterAndRender();
      }
    }
  );
}

// Handle export
function handleExport() {
  chrome.runtime.sendMessage(
    { action: 'export_vocabulary', format: 'csv' },
    (response) => {
      if (response && response.data) {
        downloadFile(
          response.data,
          'lingoflow_vocabulary.csv',
          'text/csv'
        );
      }
    }
  );
}

// Download file
function downloadFile(content, filename, contentType) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
