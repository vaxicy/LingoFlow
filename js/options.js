// LingoFlow Options Script
// Deferred-save mode: changes are only persisted when "Save Changes" is clicked.
// "Cancel" reverts all controls to the last-saved values.

let savedSettings = {};   // last persisted settings
let hasUnsavedChanges = false;

document.addEventListener('DOMContentLoaded', () => {
  console.log('LingoFlow: Options loaded');
  loadSettings();
  initEventListeners();
});

// ======================== Load & Apply ========================

function loadSettings() {
  chrome.runtime.sendMessage({ action: 'get_settings' }, (response) => {
    if (response && response.settings) {
      savedSettings = JSON.parse(JSON.stringify(response.settings)); // deep copy
      applySettings(savedSettings);
    }
  });
}

function applySettings(settings) {
  // Translate to
  const translateTo = document.getElementById('translate-to');
  if (translateTo) translateTo.value = settings.targetLanguage || 'zh';

  // UI Language
  const uiLang = document.getElementById('ui-language');
  if (uiLang) uiLang.value = settings.uiLanguage || 'auto';

  // Theme
  const themeButtons = document.querySelectorAll('.toggle-btn[data-value]');
  themeButtons.forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-value') === (settings.theme || 'light'));
  });

  // Bilingual mode
  const bilingualMode = document.getElementById('bilingual-mode');
  if (bilingualMode) bilingualMode.checked = settings.bilingualMode || false;

  // Hover translation
  const hoverTranslation = document.getElementById('hover-translation');
  if (hoverTranslation) hoverTranslation.checked = settings.hoverTranslation !== false;

  // History limit
  const historyLimit = document.getElementById('history-limit');
  if (historyLimit) historyLimit.value = settings.historyLimit || 50;

  // Apply UI language on load
  setLanguage(settings.uiLanguage || 'auto');

  hasUnsavedChanges = false;
  updateButtonStates();
}

// ======================== UI State ========================

function markChanged() {
  hasUnsavedChanges = true;
  updateButtonStates();
}

function updateButtonStates() {
  const saveBtn = document.getElementById('btn-save');
  const cancelBtn = document.getElementById('btn-cancel');
  if (saveBtn) saveBtn.disabled = !hasUnsavedChanges;
  if (cancelBtn) cancelBtn.disabled = !hasUnsavedChanges;
}

// ======================== Event Listeners ========================

function initEventListeners() {
  // Translate to
  const translateTo = document.getElementById('translate-to');
  if (translateTo) translateTo.addEventListener('change', markChanged);

  // UI Language
  const uiLang = document.getElementById('ui-language');
  if (uiLang) uiLang.addEventListener('change', () => {
    markChanged();
    // Live preview: apply language immediately (visual only, not saved yet)
    previewLanguage(uiLang.value);
  });

  // Theme toggle buttons
  const themeButtons = document.querySelectorAll('.toggle-btn[data-value]');
  themeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      themeButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      markChanged();
    });
  });

  // Bilingual mode
  const bilingualMode = document.getElementById('bilingual-mode');
  if (bilingualMode) bilingualMode.addEventListener('change', markChanged);

  // Hover translation
  const hoverTranslation = document.getElementById('hover-translation');
  if (hoverTranslation) hoverTranslation.addEventListener('change', markChanged);

  // History limit
  const historyLimit = document.getElementById('history-limit');
  if (historyLimit) historyLimit.addEventListener('change', markChanged);

  // Clear history
  const clearHistory = document.getElementById('clear-history');
  if (clearHistory) {
    clearHistory.addEventListener('click', () => {
      if (confirm(getMessage('clear_confirm'))) {
        chrome.runtime.sendMessage({ action: 'clear_history' }, (response) => {
          if (response && response.success) showNotification(getMessage('cleared'));
        });
      }
    });
  }

  // Export CSV
  const exportCsv = document.getElementById('export-csv');
  if (exportCsv) exportCsv.addEventListener('click', () => exportVocabulary('csv'));

  // Export JSON
  const exportJson = document.getElementById('export-json');
  if (exportJson) exportJson.addEventListener('click', () => exportVocabulary('json'));

  // Save button
  const saveBtn = document.getElementById('btn-save');
  if (saveBtn) saveBtn.addEventListener('click', saveSettings);

  // Cancel button
  const cancelBtn = document.getElementById('btn-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', cancelChanges);

  // Warn on unload if there are unsaved changes
  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedChanges) {
      e.preventDefault();
      e.returnValue = getMessage('unsaved_changes');
    }
  });
}

// ======================== Save / Cancel ========================

function getSettingsFromUI() {
  const targetLanguage = document.getElementById('translate-to')?.value || 'zh';
  const uiLanguage = document.getElementById('ui-language')?.value || 'auto';
  const theme = document.querySelector('.toggle-btn.active')?.getAttribute('data-value') || 'light';
  const bilingualMode = document.getElementById('bilingual-mode')?.checked || false;
  const hoverTranslation = document.getElementById('hover-translation')?.checked !== false;
  const historyLimit = parseInt(document.getElementById('history-limit')?.value) || 50;

  return { targetLanguage, uiLanguage, theme, bilingualMode, hoverTranslation, historyLimit };
}

function saveSettings() {
  const settings = getSettingsFromUI();

  chrome.runtime.sendMessage(
    { action: 'update_settings', settings: settings },
    (response) => {
      if (response && response.success) {
        savedSettings = JSON.parse(JSON.stringify(settings));
        hasUnsavedChanges = false;
        updateButtonStates();
        showNotification(getMessage('settings_saved'));
        // Apply UI language for real now
        setLanguage(settings.uiLanguage);
      }
    }
  );
}

function cancelChanges() {
  applySettings(savedSettings);
  showNotification(getMessage('settings_canceled'));
}

// ======================== UI Language ========================

function previewLanguage(lang) {
  // Live preview: apply language immediately without saving
  setLanguage(lang);
}

// ======================== Export ========================

function exportVocabulary(format) {
  chrome.runtime.sendMessage(
    { action: 'export_vocabulary', format: format },
    (response) => {
      if (response && response.data) {
        downloadFile(
          response.data,
          `lingoflow_vocabulary.${format}`,
          format === 'csv' ? 'text/csv' : 'application/json'
        );
      }
    }
  );
}

function downloadFile(content, filename, contentType) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ======================== Notification ========================

function showNotification(message) {
  // Remove any existing notification
  const existing = document.querySelector('.options-notification');
  if (existing) existing.remove();

  const notification = document.createElement('div');
  notification.className = 'options-notification';
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: #10b981;
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 9999;
    animation: slideIn 0.3s ease;
  `;

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 2000);
}

// Inject slideIn/slideOut keyframes once
(function injectKeyframes() {
  if (document.getElementById('lf-keyframes')) return;
  const style = document.createElement('style');
  style.id = 'lf-keyframes';
  style.textContent = `
    @keyframes slideIn {
      from { transform: translateX(400px); opacity: 0; }
      to   { transform: translateX(0);    opacity: 1; }
    }
    @keyframes slideOut {
      from { transform: translateX(0);    opacity: 1; }
      to   { transform: translateX(400px); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
})();
