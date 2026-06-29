// LingoFlow Popup Script

document.addEventListener('DOMContentLoaded', () => {
  console.log('LingoFlow: Popup loaded');

  // Initialize mode switches + buttons
  initModeSwitches();
  initPanels();
  loadPopupLanguage();

  // Restore active mode state from storage
  restoreModeState();

  // Update status
  updateStatus();
});

const panelState = {
  history: [],
  vocabulary: [],
  historyQuery: '',
  vocabularyQuery: '',
  vocabularyFilter: 'all',
  savedSettings: null,
  settingsDirty: false
};

// ======================== Mode Switches ========================

function initModeSwitches() {
  const translateToggle = document.getElementById('mode-translate');
  const bilingualToggle = document.getElementById('mode-bilingual');
  const restoreButton = document.getElementById('restore-original-btn');

  if (translateToggle) {
    translateToggle.addEventListener('change', () => onModeToggle('translate'));
  }
  if (bilingualToggle) {
    bilingualToggle.addEventListener('change', () => onModeToggle('bilingual'));
  }
  if (restoreButton) {
    restoreButton.addEventListener('click', () => {
      setActiveMode(null);
      updateModeUI(null);
      sendMessageToContent({ action: 'restore_original' });
    });
  }

  // Secondary nav buttons (vocabulary / history / settings)
  const vocabBtn = document.querySelector('[data-action="vocabulary"]');
  const historyBtn = document.querySelector('[data-action="history"]');
  const settingsBtn = document.querySelector('[data-action="settings"]');
  if (vocabBtn) vocabBtn.addEventListener('click', () => openVocabularyPanel());
  if (historyBtn) historyBtn.addEventListener('click', () => openHistoryPanel());
  if (settingsBtn) settingsBtn.addEventListener('click', () => openSettingsPanel());
}

let _modeToggleLock = false;

function onModeToggle(mode) {
  if (_modeToggleLock) return;
  _modeToggleLock = true;
  // Prevent rapid re-toggle for 400ms
  setTimeout(() => { _modeToggleLock = false; }, 400);

  const translateToggle = document.getElementById('mode-translate');
  const bilingualToggle = document.getElementById('mode-bilingual');

  if (mode === 'translate') {
    if (translateToggle && translateToggle.checked) {
      // Activating translate → turn off bilingual
      if (bilingualToggle) bilingualToggle.checked = false;
      setActiveMode('translate');
      updateModeUI('translate');
      sendMessageToContent({ action: 'translate_page' });
    } else {
      // Deactivating translate → restore original
      setActiveMode(null);
      updateModeUI(null);
      sendMessageToContent({ action: 'restore_original' });
    }
  }

  if (mode === 'bilingual') {
    if (bilingualToggle && bilingualToggle.checked) {
      // Activating bilingual → turn off translate
      if (translateToggle) translateToggle.checked = false;
      setActiveMode('bilingual');
      updateModeUI('bilingual');
      sendMessageToContent({ action: 'bilingual_mode' });
    } else {
      // Deactivating bilingual → restore original
      setActiveMode(null);
      updateModeUI(null);
      sendMessageToContent({ action: 'restore_original' });
    }
  }
}

function setActiveMode(mode) {
  chrome.runtime.sendMessage(
    { action: 'update_settings', settings: { activeMode: mode } },
    () => {}
  );
}

function restoreModeState() {
  sendMessageToContent({ action: 'get_page_state' }, (response) => {
    if (response && response.received) {
      updateModeUI(response.mode || null);
      setActiveMode(response.mode || null);
    }
  }, { silent: true });

  chrome.runtime.sendMessage({ action: 'get_settings' }, (response) => {
    const settings = response && response.settings;
    const activeMode = settings && settings.activeMode;
    updateModeUI(activeMode || null);
  });
}

function updateModeUI(mode) {
  const translateToggle = document.getElementById('mode-translate');
  const bilingualToggle = document.getElementById('mode-bilingual');
  const restoreButton = document.getElementById('restore-original-btn');
  const status = document.getElementById('mode-status');
  const statusText = status && status.querySelector('.mode-status-text');

  if (translateToggle) translateToggle.checked = mode === 'translate';
  if (bilingualToggle) bilingualToggle.checked = mode === 'bilingual';

  if (restoreButton) {
    restoreButton.disabled = !mode;
    restoreButton.classList.toggle('is-active', !!mode);
  }

  if (statusText) {
    const key = mode === 'bilingual'
      ? 'mode_bilingual'
      : mode === 'translate'
        ? 'mode_translation'
        : 'mode_original';
    statusText.textContent = getMessage(key);
  }

  if (status) {
    status.classList.toggle('is-active', !!mode);
  }
}

function initPanels() {
  document.querySelectorAll('[data-panel-close]').forEach(button => {
    button.addEventListener('click', closePanels);
  });

  const historySearch = document.getElementById('history-search');
  if (historySearch) {
    historySearch.addEventListener('input', () => {
      panelState.historyQuery = historySearch.value.trim().toLowerCase();
      renderHistoryPanel();
    });
  }

  const vocabularySearch = document.getElementById('vocabulary-search');
  if (vocabularySearch) {
    vocabularySearch.addEventListener('input', () => {
      panelState.vocabularyQuery = vocabularySearch.value.trim().toLowerCase();
      renderVocabularyPanel();
    });
  }

  document.querySelectorAll('[data-vocab-filter]').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-vocab-filter]').forEach(item => item.classList.remove('active'));
      button.classList.add('active');
      panelState.vocabularyFilter = button.getAttribute('data-vocab-filter') || 'all';
      renderVocabularyPanel();
    });
  });

  const clearHistory = document.getElementById('history-clear-btn');
  if (clearHistory) {
    clearHistory.addEventListener('click', () => {
      if (!confirm(getMessage('clear_confirm'))) return;
      chrome.runtime.sendMessage({ action: 'clear_history' }, (response) => {
        if (response && response.success) {
          panelState.history = [];
          renderHistoryPanel();
          showStatus(getMessage('cleared'), 'success');
        }
      });
    });
  }

  const exportVocabulary = document.getElementById('vocabulary-export-btn');
  if (exportVocabulary) {
    exportVocabulary.addEventListener('click', () => exportVocabularyFile('csv'));
  }

  initSettingsPanel();
}

function openPanel(panelId) {
  resetUnsavedSettingsPreview(panelId);
  document.querySelectorAll('.popup-panel').forEach(panel => {
    panel.hidden = panel.id !== panelId;
  });
}

function closePanels() {
  resetUnsavedSettingsPreview(null);
  document.querySelectorAll('.popup-panel').forEach(panel => {
    panel.hidden = true;
  });
}

function resetUnsavedSettingsPreview(nextPanelId) {
  const settingsPanel = document.getElementById('settings-panel');
  if (!settingsPanel || settingsPanel.hidden || nextPanelId === 'settings-panel') return;
  if (!panelState.settingsDirty || !panelState.savedSettings) return;

  applyPopupSettings(panelState.savedSettings);
  if (typeof setLanguage === 'function') {
    setLanguage(panelState.savedSettings.uiLanguage || 'auto');
    syncEngineSelect(document.getElementById('popup-translation-engine')?.value || 'google');
  }
  setSettingsDirty(false);
}

function loadPopupLanguage() {
  chrome.runtime.sendMessage({ action: 'get_settings' }, (response) => {
    const settings = response && response.settings;
    if (settings && typeof setLanguage === 'function') {
      setLanguage(settings.uiLanguage || 'auto');
      syncEngineSelect(document.getElementById('popup-translation-engine')?.value || 'google');
    }
  });
}

function openHistoryPanel() {
  openPanel('history-panel');
  chrome.runtime.sendMessage({ action: 'get_history' }, (response) => {
    panelState.history = (response && response.history) || [];
    renderHistoryPanel();
  });
}

function openVocabularyPanel() {
  openPanel('vocabulary-panel');
  chrome.runtime.sendMessage({ action: 'get_vocabulary' }, (response) => {
    panelState.vocabulary = (response && response.vocabulary) || [];
    renderVocabularyPanel();
  });
}

function openSettingsPanel() {
  openPanel('settings-panel');
  chrome.runtime.sendMessage({ action: 'get_settings' }, (response) => {
    panelState.savedSettings = cloneSettings((response && response.settings) || getDefaultSettings());
    applyPopupSettings(panelState.savedSettings);
    setSettingsDirty(false);
  });
}

// SiliconFlow free models list (must match background.js)
const SILICONFLOW_MODELS = [
  { id: 'tencent/Hunyuan-MT-7B',       name: 'Hunyuan-MT-7B（推荐·翻译专用）' },
  { id: 'THUDM/GLM-4-9B-0414',          name: 'GLM-4-9B' }
];

function initSettingsPanel() {
  const controls = [
    'popup-translation-engine',
    'popup-siliconflow-key',
    'popup-siliconflow-model',
    'popup-microsoft-key',
    'popup-translate-to',
    'popup-ui-language',
    'popup-bilingual-mode',
    'popup-hover-translation',
    'popup-existing-bilingual-strategy',
    'popup-history-limit'
  ];

  controls.forEach(id => {
    const control = document.getElementById(id);
    if (!control) return;
    control.addEventListener('change', () => {
      setSettingsDirty(true);
      if (id === 'popup-translation-engine') {
        const isSF = control.value === 'siliconflow';
        const isMS = control.value === 'microsoft';
        toggleApiKeyRow(isSF);
        toggleModelRow(isSF);
        toggleMicrosoftRow(isMS);
        syncEngineSelect(control.value);
      }
      if (id === 'popup-ui-language' && typeof setLanguage === 'function') {
        setLanguage(control.value || 'auto');
        syncEngineSelect(document.getElementById('popup-translation-engine')?.value || 'google');
      }
    });
  });

  initEngineSelect();

  // Also listen on input events for the API key fields
  const apiKeyInput = document.getElementById('popup-siliconflow-key');
  if (apiKeyInput) {
    apiKeyInput.addEventListener('input', () => { setSettingsDirty(true); });
  }
  const microsoftKeyInput = document.getElementById('popup-microsoft-key');
  if (microsoftKeyInput) {
    microsoftKeyInput.addEventListener('input', () => { setSettingsDirty(true); });
  }

  // Populate model selector options
  populateModelSelect('popup-siliconflow-model');

  document.querySelectorAll('[data-popup-theme]').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-popup-theme]').forEach(item => item.classList.remove('active'));
      button.classList.add('active');
      setSettingsDirty(true);
    });
  });

  const saveButton = document.getElementById('popup-settings-save');
  if (saveButton) saveButton.addEventListener('click', savePopupSettings);

  const cancelButton = document.getElementById('popup-settings-cancel');
  if (cancelButton) {
    cancelButton.addEventListener('click', () => {
      if (panelState.savedSettings) {
        applyPopupSettings(panelState.savedSettings);
        if (typeof setLanguage === 'function') {
          setLanguage(panelState.savedSettings.uiLanguage || 'auto');
          syncEngineSelect(document.getElementById('popup-translation-engine')?.value || 'google');
        }
      }
      setSettingsDirty(false);
      closePanels();
    });
  }
}

const ENGINE_SELECT_META = {
  google: { label: 'Google 翻译', description: '快速通用' },
  microsoft: { label: 'Microsoft Translator', description: '稳定专业' },
  siliconflow: { label: '硅基流动 AI（免费）', description: 'AI 翻译' },
  mymemory: { label: 'MyMemory（免费）', description: '免费备用' }
};

function initEngineSelect() {
  const nativeSelect = document.getElementById('popup-translation-engine');
  const customSelect = document.getElementById('engine-select');
  const trigger = document.getElementById('engine-select-trigger');
  const menu = document.getElementById('engine-select-menu');
  if (!nativeSelect || !customSelect || !trigger || !menu) return;

  trigger.addEventListener('click', () => {
    setEngineSelectOpen(!customSelect.classList.contains('open'));
  });

  menu.querySelectorAll('[data-engine-value]').forEach(option => {
    option.addEventListener('click', () => {
      const value = option.getAttribute('data-engine-value') || 'google';
      nativeSelect.value = value;
      nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      setEngineSelectOpen(false);
    });
  });

  document.addEventListener('click', (event) => {
    if (!customSelect.contains(event.target)) {
      setEngineSelectOpen(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setEngineSelectOpen(false);
    }
  });

  syncEngineSelect(nativeSelect.value || 'google');
}

function setEngineSelectOpen(open) {
  const customSelect = document.getElementById('engine-select');
  const trigger = document.getElementById('engine-select-trigger');
  const menu = document.getElementById('engine-select-menu');
  if (!customSelect || !trigger || !menu) return;

  customSelect.classList.toggle('open', open);
  trigger.setAttribute('aria-expanded', String(open));
  menu.hidden = !open;
}

function getEngineSelectLabel(value) {
  const nativeSelect = document.getElementById('popup-translation-engine');
  const nativeOption = nativeSelect && nativeSelect.querySelector(`option[value="${value}"]`);
  const meta = ENGINE_SELECT_META[value] || ENGINE_SELECT_META.google;
  return (nativeOption && nativeOption.textContent.trim()) || meta.label;
}

function syncEngineSelect(value) {
  const currentValue = value || 'google';
  const label = document.getElementById('engine-select-label');
  const desc = document.getElementById('engine-select-desc');
  const meta = ENGINE_SELECT_META[currentValue] || ENGINE_SELECT_META.google;

  if (label) label.textContent = getEngineSelectLabel(currentValue);
  if (desc) desc.textContent = meta.description;

  document.querySelectorAll('[data-engine-value]').forEach(option => {
    const selected = option.getAttribute('data-engine-value') === currentValue;
    const optionValue = option.getAttribute('data-engine-value') || 'google';
    const optionLabel = option.querySelector('strong');
    const optionDesc = option.querySelector('small');
    const optionMeta = ENGINE_SELECT_META[optionValue] || ENGINE_SELECT_META.google;

    option.setAttribute('aria-selected', String(selected));
    if (optionLabel) optionLabel.textContent = getEngineSelectLabel(optionValue);
    if (optionDesc) optionDesc.textContent = optionMeta.description;
  });
}

function populateModelSelect(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.textContent = '';
  SILICONFLOW_MODELS.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    select.appendChild(opt);
  });
}

function toggleApiKeyRow(show) {
  const row = document.getElementById('popup-api-key-row');
  if (row) row.hidden = !show;
}

function toggleModelRow(show) {
  const row = document.getElementById('popup-model-row');
  if (row) row.hidden = !show;
}

function toggleMicrosoftRow(show) {
  const keyRow = document.getElementById('popup-microsoft-key-row');
  if (keyRow) keyRow.hidden = !show;
}

function applyPopupSettings(settings) {
  const translationEngine = document.getElementById('popup-translation-engine');
  const apiKeyInput = document.getElementById('popup-siliconflow-key');
  const modelSelect = document.getElementById('popup-siliconflow-model');
  const microsoftKeyInput = document.getElementById('popup-microsoft-key');
  const translateTo = document.getElementById('popup-translate-to');
  const uiLanguage = document.getElementById('popup-ui-language');
  const bilingualMode = document.getElementById('popup-bilingual-mode');
  const hoverTranslation = document.getElementById('popup-hover-translation');
  const existingBilingualStrategy = document.getElementById('popup-existing-bilingual-strategy');
  const historyLimit = document.getElementById('popup-history-limit');
  const theme = settings.theme || 'light';

  if (translationEngine) {
    translationEngine.value = settings.translationEngine || 'google';
    const isSF = translationEngine.value === 'siliconflow';
    const isMS = translationEngine.value === 'microsoft';
    toggleApiKeyRow(isSF);
    toggleModelRow(isSF);
    toggleMicrosoftRow(isMS);
    syncEngineSelect(translationEngine.value);
  }
  if (apiKeyInput) apiKeyInput.value = settings.siliconflowApiKey || '';
  if (modelSelect) modelSelect.value = settings.siliconflowModel || 'tencent/Hunyuan-MT-7B';
  if (microsoftKeyInput) microsoftKeyInput.value = settings.microsoftApiKey || '';
  if (translateTo) translateTo.value = settings.targetLanguage || 'zh';
  if (uiLanguage) uiLanguage.value = settings.uiLanguage || 'auto';
  if (bilingualMode) bilingualMode.checked = !!settings.bilingualMode;
  if (hoverTranslation) hoverTranslation.checked = settings.hoverTranslation !== false;
  if (existingBilingualStrategy) existingBilingualStrategy.value = settings.existingBilingualStrategy || 'skip';
  if (historyLimit) historyLimit.value = String(settings.historyLimit || 50);

  document.querySelectorAll('[data-popup-theme]').forEach(button => {
    button.classList.toggle('active', button.getAttribute('data-popup-theme') === theme);
  });
}

function getPopupSettingsFromUI() {
  return {
    translationEngine: document.getElementById('popup-translation-engine')?.value || 'google',
    siliconflowApiKey: document.getElementById('popup-siliconflow-key')?.value || '',
    siliconflowModel: document.getElementById('popup-siliconflow-model')?.value || 'tencent/Hunyuan-MT-7B',
    microsoftApiKey: document.getElementById('popup-microsoft-key')?.value || '',
    targetLanguage: document.getElementById('popup-translate-to')?.value || 'zh',
    uiLanguage: document.getElementById('popup-ui-language')?.value || 'auto',
    theme: document.querySelector('[data-popup-theme].active')?.getAttribute('data-popup-theme') || 'light',
    bilingualMode: document.getElementById('popup-bilingual-mode')?.checked || false,
    hoverTranslation: document.getElementById('popup-hover-translation')?.checked !== false,
    existingBilingualStrategy: document.getElementById('popup-existing-bilingual-strategy')?.value || 'skip',
    historyLimit: parseInt(document.getElementById('popup-history-limit')?.value, 10) || 50
  };
}

function savePopupSettings() {
  const settings = getPopupSettingsFromUI();
  chrome.runtime.sendMessage({ action: 'update_settings', settings }, (response) => {
    if (!response || !response.success) {
      showStatus(getMessage('error_cannot_access'), 'error');
      return;
    }

    panelState.savedSettings = cloneSettings(settings);
    setSettingsDirty(false);
    if (typeof setLanguage === 'function') {
      setLanguage(settings.uiLanguage || 'auto');
      syncEngineSelect(document.getElementById('popup-translation-engine')?.value || 'google');
    }
    showStatus(getMessage('settings_saved'), 'success');
    closePanels();
  });
}

function setSettingsDirty(isDirty) {
  panelState.settingsDirty = isDirty;
  const saveButton = document.getElementById('popup-settings-save');
  const cancelButton = document.getElementById('popup-settings-cancel');
  if (saveButton) saveButton.disabled = !isDirty;
  if (cancelButton) cancelButton.disabled = !panelState.savedSettings && !isDirty;
}

function cloneSettings(settings) {
  return JSON.parse(JSON.stringify(settings));
}

function getDefaultSettings() {
  return {
    translationEngine: 'google',
    siliconflowApiKey: '',
    siliconflowModel: 'tencent/Hunyuan-MT-7B',
    microsoftApiKey: '',
    targetLanguage: 'zh',
    uiLanguage: 'auto',
    theme: 'light',
    bilingualMode: false,
    hoverTranslation: true,
    existingBilingualStrategy: 'skip',
    historyLimit: 50,
    activeMode: null
  };
}

function renderHistoryPanel() {
  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  if (!list || !empty) return;

  const items = panelState.history.filter(item => matchesPanelQuery(item, panelState.historyQuery));
  list.textContent = '';
  empty.hidden = items.length > 0;
  list.hidden = items.length === 0;

  items.forEach(item => {
    list.appendChild(createPanelItem(item, {
      type: 'history',
      meta: formatDateTime(item.createdAt),
      onDelete: () => deleteHistoryItem(item.id)
    }));
  });
}

function renderVocabularyPanel() {
  const list = document.getElementById('vocabulary-list');
  const empty = document.getElementById('vocabulary-empty');
  if (!list || !empty) return;

  const items = panelState.vocabulary
    .filter(item => panelState.vocabularyFilter === 'all' || item.type === panelState.vocabularyFilter)
    .filter(item => matchesPanelQuery(item, panelState.vocabularyQuery));

  list.textContent = '';
  empty.hidden = items.length > 0;
  list.hidden = items.length === 0;

  items.forEach(item => {
    list.appendChild(createPanelItem(item, {
      type: 'vocabulary',
      badge: getVocabularyTypeLabel(item.type),
      meta: formatDate(item.createdAt),
      onDelete: () => deleteVocabularyItem(item.id)
    }));
  });
}

function createPanelItem(item, options) {
  const row = document.createElement('article');
  row.className = 'panel-item';

  const top = document.createElement('div');
  top.className = 'panel-item-top';

  const text = document.createElement('div');
  text.className = 'panel-item-text';
  text.textContent = item.text || '';
  top.appendChild(text);

  if (options.badge) {
    const badge = document.createElement('span');
    badge.className = 'panel-badge';
    badge.textContent = options.badge;
    top.appendChild(badge);
  }

  const translation = document.createElement('div');
  translation.className = 'panel-item-translation';
  translation.textContent = item.translation || '';

  const meta = document.createElement('div');
  meta.className = 'panel-item-meta';

  const source = document.createElement('span');
  source.textContent = getSourceLabel(item.sourceUrl);
  source.title = item.sourceUrl || '';
  meta.appendChild(source);

  const date = document.createElement('span');
  date.textContent = options.meta || '';
  meta.appendChild(date);

  const actions = document.createElement('div');
  actions.className = 'panel-item-actions';

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'panel-mini-btn';
  copyButton.textContent = getMessage('copy') || 'Copy';
  copyButton.addEventListener('click', () => copyPanelText(item));
  actions.appendChild(copyButton);

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'panel-mini-btn danger';
  deleteButton.textContent = getMessage('delete') || 'Delete';
  deleteButton.addEventListener('click', options.onDelete);
  actions.appendChild(deleteButton);

  meta.appendChild(actions);
  row.appendChild(top);
  if (item.translation) row.appendChild(translation);
  row.appendChild(meta);
  return row;
}

function matchesPanelQuery(item, query) {
  if (!query) return true;
  const text = `${item.text || ''} ${item.translation || ''} ${item.sourceUrl || ''}`.toLowerCase();
  return text.includes(query);
}

function deleteHistoryItem(id) {
  chrome.runtime.sendMessage({ action: 'delete_history_item', id }, (response) => {
    if (response && response.success) {
      panelState.history = panelState.history.filter(item => item.id !== id);
      renderHistoryPanel();
    }
  });
}

function deleteVocabularyItem(id) {
  if (!confirm(getMessage('delete_confirm'))) return;
  chrome.runtime.sendMessage({ action: 'delete_vocabulary_item', id }, (response) => {
    if (response && response.success) {
      panelState.vocabulary = panelState.vocabulary.filter(item => item.id !== id);
      renderVocabularyPanel();
    }
  });
}

function exportVocabularyFile(format) {
  chrome.runtime.sendMessage({ action: 'export_vocabulary', format }, (response) => {
    if (response && response.data) {
      downloadFile(response.data, `lingoflow_vocabulary.${format}`, format === 'csv' ? 'text/csv' : 'application/json');
    }
  });
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

async function copyPanelText(item) {
  const text = [item.text, item.translation].filter(Boolean).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showStatus(getMessage('copied'), 'success');
  } catch (error) {
    showStatus(getMessage('error_cannot_access'), 'error');
  }
}

function getVocabularyTypeLabel(type) {
  if (type === 'sentence') return getMessage('sentence') || 'Sentence';
  if (type === 'word') return getMessage('word') || 'Word';
  return type || '';
}

function getSourceLabel(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch (error) {
    return '';
  }
}

function formatDateTime(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString();
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleDateString();
}

// Check if URL is supported (content script can be injected)
function isSupportedUrl(url) {
  if (!url) return false;
  return !(
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('moz-extension://') ||
    url.startsWith('file://')
  );
}

// Send message to content script (with retry + explicit injection fallback)
function sendMessageToContent(message, callback, options = {}, retries = 2) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0] || !tabs[0].id) {
      if (!options.silent) showStatus(getMessage('error_cannot_access'), 'error');
      return;
    }

    const url = tabs[0].url;
    if (!isSupportedUrl(url)) {
      if (!options.silent) showStatus(getMessage('error_cannot_access'), 'error');
      return;
    }

    const tabId = tabs[0].id;

    console.log('LingoFlow Popup: Sending message to tab', tabId, ', action:', message.action, ', retries left:', retries);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        if (retries > 0) {
          // If we still have normal retries left, first try a quick retry
          setTimeout(() => sendMessageToContent(message, callback, options, retries - 1), 600);
          return;
        }
        if (options.silent) return;
        // All normal retries exhausted; try injecting content script explicitly as last resort.
        console.log('LingoFlow Popup: Attempting explicit content script injection for tab', tabId);
        injectContentScriptAndSend(tabId, message, callback, options);
        return;
      }
      console.log('LingoFlow Popup: Message sent successfully, response:', response);
      if (callback) callback(response);
    });
  });
}

// Fallback: inject content script then send message (with multi-attempt retry)
function injectContentScriptAndSend(tabId, message, callback, options = {}) {
  console.log('LingoFlow Popup: Attempting explicit content script injection for tab', tabId);
  chrome.scripting.executeScript({
    target: { tabId },
    files: ['js/i18n.js', 'js/content.js']
  }, () => {
    if (chrome.runtime.lastError) {
      console.error('LingoFlow Popup: Script injection failed:', chrome.runtime.lastError.message);

      // If file injection fails, try injecting a minimal inline script as last resort
      // This creates a bare-bones message handler that can respond to our actions
      console.log('LingoFlow Popup: Trying inline injection fallback...');
      chrome.scripting.executeScript({
        target: { tabId },
        func: createInlineHandler,
        args: [message]
      }, (result2) => {
        if (chrome.runtime.lastError) {
          console.error('LingoFlow Popup: Inline injection also failed:', chrome.runtime.lastError.message);
          if (!options.silent) showStatus(getMessage('error_cannot_access'), 'error');
          return;
        }
        console.log('LingoFlow Popup: Inline handler injected successfully');
        if (!options.silent) showStatus(getMessage('ready'), 'success');
      });
      return;
    }

    console.log('LingoFlow Popup: Content script injected successfully');

    // Try sending message with progressive delays (content script needs init time)
    attemptSendAfterInjection(tabId, message, 3, callback, options);
  });
}

// Retry sending message after injection with backoff
function attemptSendAfterInjection(tabId, message, attemptsLeft, callback, options = {}) {
  const delay = [300, 600, 1000][3 - attemptsLeft] || 1000;
  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('LingoFlow Popup: Post-injection send failed, attempts left:', attemptsLeft - 1,
          '-', chrome.runtime.lastError.message);
        if (attemptsLeft > 1) {
          attemptSendAfterInjection(tabId, message, attemptsLeft - 1, callback, options);
          return;
        }
        console.error('LingoFlow Popup: All post-injection attempts exhausted');
        if (!options.silent) showStatus(getMessage('error_cannot_access'), 'error');
        return;
      }
      console.log('LingoFlow Popup: Message sent after injection, response:', response);
      if (!options.silent) showStatus(getMessage('ready'), 'success');
      if (callback) callback(response);
    });
  }, delay);
}

// Inline fallback handler: a minimal self-contained content script.
// This runs inside the page context and handles translate/bilingual actions directly
function createInlineHandler(initialMessage) {
  var existingBilingualStrategy = 'skip';
  var activeInlineMode = null;

  try {
    chrome.storage.local.get(['lingoflow_settings'], function(result) {
      if (result && result.lingoflow_settings) {
        existingBilingualStrategy = result.lingoflow_settings.existingBilingualStrategy || 'skip';
      }
    });

    chrome.storage.onChanged.addListener(function(changes, namespace) {
      if (namespace === 'local' && changes.lingoflow_settings) {
        existingBilingualStrategy = changes.lingoflow_settings.newValue.existingBilingualStrategy || 'skip';
      }
    });
  } catch (_) {}

  injectBilingualStyles();

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
      if (request && request.action === 'get_page_state') {
        sendResponse({ received: true, mode: activeInlineMode });
        return true;
      }
      handleActionInline(request);
      sendResponse({ received: true, mode: activeInlineMode });
    } catch (err) {
      sendResponse({ received: false, error: err && err.message });
    }
    return true;
  });

  handleActionInline(initialMessage);

  function injectBilingualStyles() {
    if (document.getElementById('lingoflow-inline-styles')) return;
    var styleEl = document.createElement('style');
    styleEl.id = 'lingoflow-inline-styles';
    styleEl.textContent = [
      '.lingoflow-block{max-width:100%;min-width:0;text-align:left;color:inherit;background:transparent;box-sizing:border-box;overflow-wrap:anywhere}',
      '.lingoflow-block-external{display:block;width:100%}',
      '.lingoflow-block-internal{display:block;margin:0;padding:0}',
      '.lingoflow-original,.lingoflow-translation{display:block;max-width:100%;min-width:0;margin:0;padding:0;text-align:left;background:transparent;box-sizing:border-box;overflow-wrap:anywhere}',
      '.lingoflow-original{color:inherit;font:inherit;line-height:inherit}',
      '.lingoflow-original>:first-child{margin-top:0!important}',
      '.lingoflow-original>:last-child{margin-bottom:0!important}',
      '.lingoflow-translation{color:inherit;font:inherit;font-size:inherit;font-style:inherit;font-weight:inherit;letter-spacing:inherit;line-height:inherit;text-align:inherit;margin-top:.18em}',
      '.lingoflow-translation-only{display:block;max-width:100%;min-width:0;color:inherit;background:transparent;font:inherit;font-size:inherit;font-style:inherit;font-weight:inherit;letter-spacing:inherit;line-height:inherit;text-align:inherit;box-sizing:border-box;overflow-wrap:anywhere}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function isFallback(text) {
    return !text || text.indexOf('[LingoFlow translation') === 0 || text.indexOf('[translation failed]') === 0;
  }

  function isContextInvalidated(text) {
    return !!text && text.indexOf('[LingoFlow context invalidated]') === 0;
  }

  function getErrorMessage(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    if (error.message) return error.message;
    try {
      return JSON.stringify(error);
    } catch (_) {
      return String(error);
    }
  }

  function isContextInvalidatedError(error) {
    var message = getErrorMessage(error).toLowerCase();
    return message.indexOf('extension context invalidated') >= 0 ||
      message.indexOf('context invalidated') >= 0 ||
      message.indexOf('receiving end does not exist') >= 0 ||
      message.indexOf('message port closed') >= 0 ||
      message.indexOf('extension has been reloaded') >= 0;
  }

  function isChinese(text) {
    var cleaned = (text || '').replace(/[\s\d\p{P}\p{S}]/gu, '');
    if (cleaned.length < 5) return false;
    var cjk = 0;
    for (var i = 0; i < cleaned.length; i++) {
      if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(cleaned[i])) cjk++;
    }
    return cjk / cleaned.length >= 0.45;
  }

  function isAllCapsShortLabel(text) {
    var normalized = (text || '').replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length > 24) return false;
    var words = normalized.split(/\s+/);
    if (words.length > 3) return false;
    var cleaned = normalized.replace(/[^A-Za-z0-9+#.&/-]/g, '');
    if (!cleaned || cleaned.length < 2) return false;
    if (!/[A-Z]{2,}/.test(cleaned)) return false;
    if (/[a-z]/.test(cleaned)) return false;
    var letters = cleaned.replace(/[^A-Za-z]/g, '');
    return letters.length >= 2 && letters.length <= 12;
  }

  function shouldTranslateText(text) {
    var normalized = normalizeText(text);
    if (normalized.length < 3 || normalized.length > 2000) return false;
    if (/^\d+([.,:/-]\d+)*$/.test(normalized)) return false;
    if (!/[A-Za-z]{2,}/.test(normalized)) return false;
    if (isAllCapsShortLabel(normalized)) return false;
    if (/[A-Za-z]{2,}/.test(normalized) && /[\u4e00-\u9fff\u3400-\u4dbf]/.test(normalized)) return false;
    if (isChinese(normalized)) return false;
    return true;
  }

  function getTextStats(text) {
    var normalized = normalizeText(text);
    var content = normalized.replace(/[\s\d\p{P}\p{S}]/gu, '');
    var cjkCount = 0;
    var latinCount = 0;
    for (var i = 0; i < content.length; i++) {
      if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(content[i])) cjkCount++;
      if (/[A-Za-z]/.test(content[i])) latinCount++;
    }
    return {
      normalized: normalized,
      contentLength: content.length,
      cjkCount: cjkCount,
      latinCount: latinCount,
      cjkRatio: content.length ? cjkCount / content.length : 0
    };
  }

  function hasLatinText(text) {
    return getTextStats(text).latinCount >= 2;
  }

  function hasChineseText(text) {
    var stats = getTextStats(text);
    return stats.cjkCount >= 2 && stats.cjkRatio >= 0.3;
  }

  function getElementText(element) {
    if (!element) return '';
    return normalizeText(element.innerText || element.textContent || '');
  }

  function hasChineseSibling(container) {
    var siblings = [container.previousElementSibling, container.nextElementSibling].filter(Boolean);
    return siblings.some(function(sibling) {
      if (sibling.matches && sibling.matches('[data-lingoflow], .lingoflow-ui')) return false;
      return hasChineseText(getElementText(sibling));
    });
  }

  function hasBilingualChildren(scope) {
    if (!scope || scope === document.body || scope === document.documentElement) return false;
    var scopeText = getElementText(scope);
    if (scopeText.length > 700 || scope.children.length > 12) return false;
    var hasEnglishChild = false;
    var hasChineseChild = false;
    var children = Array.from(scope.children).filter(function(child) {
      return !(child.matches && child.matches('[data-lingoflow], .lingoflow-ui'));
    });
    for (var i = 0; i < children.length; i++) {
      var text = getElementText(children[i]);
      if (hasLatinText(text)) hasEnglishChild = true;
      if (hasChineseText(text)) hasChineseChild = true;
      if (hasEnglishChild && hasChineseChild) return true;
    }
    return false;
  }

  function hasBilingualDescendants(scope) {
    if (!scope || scope === document.body || scope === document.documentElement) return false;
    var scopeText = getElementText(scope);
    if (scopeText.length < 6 || scopeText.length > 700) return false;
    if (!hasLatinText(scopeText) || !hasChineseText(scopeText)) return false;
    var candidates = Array.from(scope.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div, span, strong, b'));
    var hasEnglish = false;
    var hasChinese = false;
    var limit = Math.min(candidates.length, 30);
    for (var i = 0; i < limit; i++) {
      var candidate = candidates[i];
      if (candidate.matches && candidate.matches('[data-lingoflow], .lingoflow-ui')) continue;
      var text = getElementText(candidate);
      if (hasLatinText(text)) hasEnglish = true;
      if (hasChineseText(text)) hasChinese = true;
      if (hasEnglish && hasChinese) return true;
    }
    return false;
  }

  function hasBilingualAncestor(container) {
    var scope = container.parentElement;
    for (var depth = 0; scope && depth < 5; depth++, scope = scope.parentElement) {
      if (hasBilingualChildren(scope) || hasBilingualDescendants(scope)) return true;
    }
    return false;
  }

  function hasExistingTranslation(container) {
    if (existingBilingualStrategy === 'translate_english') return false;

    var text = getElementText(container);
    if (hasLatinText(text) && hasChineseText(text)) return true;
    if (hasChineseSibling(container)) return true;
    return hasBilingualAncestor(container);
  }

  function shouldSkipTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.parentElement) return true;
    var skipTags = { SCRIPT:1, STYLE:1, CODE:1, PRE:1, TEXTAREA:1, INPUT:1, BUTTON:1, SVG:1, CANVAS:1, IFRAME:1, NOSCRIPT:1 };
    var element = node.parentElement;
    while (element) {
      if (skipTags[element.tagName]) return true;
      if (element.matches && element.matches('[data-lingoflow],[data-lingoflow-processed="true"],.lingoflow-ui')) return true;
      if (element.isContentEditable) return true;
      element = element.parentElement;
    }
    return !shouldTranslateText(node.textContent);
  }

  function isLeafDiv(element) {
    if (!element || element.tagName !== 'DIV') return false;
    var blockTags = { ADDRESS:1, ARTICLE:1, ASIDE:1, BLOCKQUOTE:1, DETAILS:1, DIALOG:1, DIV:1, DL:1, FIELDSET:1, FIGCAPTION:1, FIGURE:1, FOOTER:1, FORM:1, H1:1, H2:1, H3:1, H4:1, H5:1, H6:1, HEADER:1, HR:1, LI:1, MAIN:1, NAV:1, OL:1, P:1, PRE:1, SECTION:1, TABLE:1, UL:1 };
    for (var i = 0; i < element.children.length; i++) {
      if (blockTags[element.children[i].tagName]) return false;
    }
    return shouldTranslateText(element.textContent);
  }

  function isTranslationContainer(element) {
    if (!element || element === document.body || element === document.documentElement) return false;
    if (element.getAttribute('role') === 'heading') return true;
    var containers = { P:1, LI:1, H1:1, H2:1, H3:1, H4:1, H5:1, H6:1, BLOCKQUOTE:1, TD:1, TH:1, FIGCAPTION:1, DD:1, DT:1 };
    return !!containers[element.tagName] || isLeafDiv(element);
  }

  function findTextContainer(textNode) {
    var skipTags = { SCRIPT:1, STYLE:1, CODE:1, PRE:1, TEXTAREA:1, INPUT:1, BUTTON:1, SVG:1, CANVAS:1, IFRAME:1, NOSCRIPT:1 };
    var element = textNode.parentElement;
    while (element && element !== document.body && element !== document.documentElement) {
      if (skipTags[element.tagName]) return null;
      if (element.matches && element.matches('[data-lingoflow],[data-lingoflow-processed="true"],.lingoflow-ui')) return null;
      if (element.isContentEditable) return null;
      if (isTranslationContainer(element)) return element;
      element = element.parentElement;
    }
    return null;
  }

  function isNestedInDifferentContainer(textNode, container) {
    var element = textNode.parentElement;
    while (element && element !== container) {
      if (isTranslationContainer(element)) return true;
      element = element.parentElement;
    }
    return false;
  }

  function collectTranslationUnits() {
    var units = new Map();
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        return shouldSkipTextNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      var container = findTextContainer(node);
      if (!container || container.dataset.lingoflowProcessed === 'true') continue;
      if (isNestedInDifferentContainer(node, container)) continue;
      if (hasExistingTranslation(container)) {
        continue;
      }
      var text = normalizeText(node.textContent);
      if (!shouldTranslateText(text)) continue;
      if (!units.has(container)) units.set(container, { container: container, textParts: [] });
      units.get(container).textParts.push(text);
    }
    return Array.from(units.values()).map(function(unit) {
      return { container: unit.container, text: normalizeText(unit.textParts.join(' ')) };
    }).filter(function(unit) {
      return shouldTranslateText(unit.text);
    });
  }

  function translate(text, cb) {
    chrome.runtime.sendMessage({ action: 'translate', text: text.substring(0, 2000), targetLang: 'zh-CN' }, function(resp) {
      if (chrome.runtime.lastError) {
        if (isContextInvalidatedError(chrome.runtime.lastError)) {
          cb('[LingoFlow context invalidated] ' + text);
          return;
        }
        cb('[LingoFlow translation failed] ' + text);
        return;
      }
      if (resp && resp.success && resp.translation) cb(resp.translation);
      else cb('[LingoFlow translation failed] ' + text);
    });
  }

  function createBlock(translation, mode) {
    var block = document.createElement('div');
    block.className = 'lingoflow-block lingoflow-block-' + mode;
    block.setAttribute('data-lingoflow', 'true');
    block.setAttribute('data-lingoflow-mode', mode);

    var original = document.createElement('div');
    original.className = 'lingoflow-original';
    original.setAttribute('data-lingoflow', 'true');

    var translated = document.createElement('div');
    translated.className = 'lingoflow-translation';
    translated.setAttribute('data-lingoflow', 'true');
    translated.textContent = translation;

    var fragment = document.createDocumentFragment();
    fragment.appendChild(original);
    fragment.appendChild(translated);
    block.appendChild(fragment);
    return block;
  }

  function createTranslationOnlyBlock(translation) {
    var block = document.createElement('div');
    block.className = 'lingoflow-translation-only';
    block.setAttribute('data-lingoflow', 'true');
    block.textContent = translation;
    return block;
  }

  function copyLayoutMargins(source, block) {
    var style = window.getComputedStyle(source);
    block.style.marginTop = style.marginTop;
    block.style.marginRight = style.marginRight;
    block.style.marginBottom = style.marginBottom;
    block.style.marginLeft = style.marginLeft;
    block.style.textAlign = style.textAlign;
    block.style.color = style.color;
    block.style.fontFamily = style.fontFamily;
    block.style.fontSize = style.fontSize;
    block.style.fontStyle = style.fontStyle;
    block.style.fontWeight = style.fontWeight;
    block.style.letterSpacing = style.letterSpacing;
    block.style.lineHeight = style.lineHeight;
  }

  function shouldRenderInside(container) {
    return ['LI', 'DIV', 'TD', 'TH', 'BLOCKQUOTE', 'DD', 'DT', 'FIGCAPTION'].indexOf(container.tagName) >= 0;
  }

  function renderExternal(container, translation) {
    if (!container || !container.parentNode) return false;
    var range = document.createRange();
    range.selectNode(container);
    var marker = document.createComment('lingoflow-bilingual-anchor');
    range.insertNode(marker);
    var block = createBlock(translation, 'external');
    var original = block.querySelector(':scope > .lingoflow-original');
    copyLayoutMargins(container, block);
    original.appendChild(container);
    marker.replaceWith(block);
    range.detach();
    return true;
  }

  function getInternalInsertionPoint(container) {
    if (container.tagName !== 'LI') return null;
    for (var i = 0; i < container.childNodes.length; i++) {
      var node = container.childNodes[i];
      if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === 'UL' || node.tagName === 'OL')) return node;
    }
    return null;
  }

  function renderInternal(container, translation) {
    if (!container) return false;
    var block = createBlock(translation, 'internal');
    var original = block.querySelector(':scope > .lingoflow-original');
    var stopNode = getInternalInsertionPoint(container);
    var fragment = document.createDocumentFragment();
    while (container.firstChild && container.firstChild !== stopNode) {
      fragment.appendChild(container.firstChild);
    }
    if (!fragment.childNodes.length) return false;
    original.appendChild(fragment);
    container.insertBefore(block, stopNode);
    return true;
  }

  function renderTranslationUnit(container, translation) {
    return shouldRenderInside(container)
      ? renderInternal(container, translation)
      : renderExternal(container, translation);
  }

  function renderTranslationOnlyUnit(container, translation) {
    if (!container || !container.parentNode) return false;
    var range = document.createRange();
    range.selectNode(container);
    var marker = document.createComment('lingoflow-translation-anchor');
    range.insertNode(marker);
    var block = createTranslationOnlyBlock(translation);
    copyLayoutMargins(container, block);
    marker.replaceWith(block);
    range.detach();
    container.setAttribute('data-lingoflow-hidden', 'true');
    container.hidden = true;
    return true;
  }

  function restoreOriginal() {
    var x = window.scrollX, y = window.scrollY;
    document.querySelectorAll('.lingoflow-block[data-lingoflow="true"]').forEach(function(block) {
      var mode = block.getAttribute('data-lingoflow-mode');
      var original = block.querySelector(':scope > .lingoflow-original');
      var fragment = document.createDocumentFragment();
      while (original && original.firstChild) fragment.appendChild(original.firstChild);
      if (mode === 'internal') {
        block.parentNode.insertBefore(fragment, block);
        block.remove();
      } else {
        block.replaceWith(fragment);
      }
    });
    document.querySelectorAll('[data-lingoflow]').forEach(function(node) { node.remove(); });
    document.querySelectorAll('[data-lingoflow-hidden]').forEach(function(el) {
      el.hidden = false;
      el.removeAttribute('data-lingoflow-hidden');
    });
    document.querySelectorAll('[data-lingoflow-processed]').forEach(function(el) { el.removeAttribute('data-lingoflow-processed'); });
    window.scrollTo(x, y);
  }

  async function runTranslation(mode) {
    var units = collectTranslationUnits();
    var stoppedByInvalidContext = false;
    for (var i = 0; i < units.length && !stoppedByInvalidContext; i++) {
      var item = units[i];
      if (!item.container.isConnected || item.container.dataset.lingoflowProcessed === 'true') continue;
      item.container.setAttribute('data-lingoflow-processed', 'true');
      await new Promise(function(resolve) {
        translate(item.text, function(trans) {
          if (isContextInvalidated(trans)) {
            item.container.removeAttribute('data-lingoflow-processed');
            stoppedByInvalidContext = true;
            resolve();
            return;
          }
          if (isFallback(trans)) {
            item.container.removeAttribute('data-lingoflow-processed');
            resolve();
            return;
          }
          var rendered = mode === 'translation'
            ? renderTranslationOnlyUnit(item.container, trans)
            : renderTranslationUnit(item.container, trans);
          if (!rendered) {
            item.container.removeAttribute('data-lingoflow-processed');
          }
          resolve();
        });
      });
    }
  }

  async function enableBilingualMode() {
    return runTranslation('bilingual');
  }

  async function enableTranslationMode() {
    return runTranslation('translation');
  }

  function handleActionInline(msg) {
    if (!msg || !document || !document.body) return;
    if (msg.action === 'restore_original') {
      restoreOriginal();
      activeInlineMode = null;
    }
    if (msg.action === 'translate_page') {
      enableTranslationMode();
      activeInlineMode = 'translate';
    }
    if (msg.action === 'bilingual_mode') {
      enableBilingualMode();
      activeInlineMode = 'bilingual';
    }
  }
}
// Open vocabulary page
function openVocabularyPage() {
  chrome.tabs.create({
    url: chrome.runtime.getURL('pages/vocabulary.html')
  });
}

// Open history page
function openHistoryPage() {
  chrome.tabs.create({
    url: chrome.runtime.getURL('pages/history.html')
  });
}

// Open settings page
function openSettingsPage() {
  chrome.runtime.openOptionsPage();
}

// Update status
function updateStatus() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      const url = tabs[0].url;

      // Check if page is supported
      if (!isSupportedUrl(url)) {
        showStatus(getMessage('page_not_supported'), 'warning');
      } else {
        showStatus(getMessage('ready'), 'success');
      }
    }
  });
}

// Show status
function showStatus(text, type = 'success') {
  const statusElement = document.querySelector('.popup-status');
  const statusText = statusElement.querySelector('.status-text');
  const statusIndicator = statusElement.querySelector('.status-indicator');

  statusText.textContent = text;

  // Update indicator color
  switch (type) {
    case 'success':
      statusIndicator.style.background = '#62a8ff';
      break;
    case 'warning':
      statusIndicator.style.background = '#f59e0b';
      break;
    case 'error':
      statusIndicator.style.background = '#ef4444';
      break;
  }
}
