// LingoFlow Popup Script

document.addEventListener('DOMContentLoaded', () => {
  console.log('LingoFlow: Popup loaded');
  applyPopupTheme('light');

  // Preload saved settings to avoid losing data on force-save.
  // Also pre-fill all hidden API key inputs so they have correct values
  // even if the settings panel hasn't been opened yet.
  chrome.runtime.sendMessage({ action: 'get_settings' }, (response) => {
    if (response && response.settings) {
      panelState.savedSettings = cloneSettings(response.settings);
      // Pre-fill hidden inputs to prevent force-save from overwriting keys
      prefillHiddenInputs(response.settings);
      console.log('LingoFlow: Preloaded settings', {
        translationEngine: panelState.savedSettings.translationEngine,
        hasSiliconflowKey: !!panelState.savedSettings.siliconflowApiKey,
        hasMicrosoftKey: !!panelState.savedSettings.microsoftApiKey,
        hasGeminiKey: !!panelState.savedSettings.geminiApiKey,
        hasDeepseekKey: !!panelState.savedSettings.deepseekApiKey,
        hasBaiduAppId: !!panelState.savedSettings.baiduAppId,
        hasBaiduSecretKey: !!panelState.savedSettings.baiduSecretKey,
        hasBaiduLLMKey: !!panelState.savedSettings.baiduLLMApiKey,
        hasYoudaoAppKey: !!panelState.savedSettings.youdaoAppKey,
        hasYoudaoAppSecret: !!panelState.savedSettings.youdaoAppSecret
      });
    }
  });

  // Initialize mode switches + buttons
  initModeSwitches();
  initPanels();
  initBackup();
  loadPopupLanguage();

  // Restore active mode state from storage
  restoreModeState();

  // Update status
  updateStatus();
});

const panelState = {
  history: [],
  historyEnabled: true,
  vocabulary: [],
  historyQuery: '',
  vocabularyQuery: '',
  vocabularyFilter: 'all',
  savedSettings: null,
  settingsDirty: false,
  settingsSaveState: 'saved'
};

let settingsAutoSaveTimer = null;

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
    } else {
      // Content script 无响应，fallback 读 storage
      chrome.runtime.sendMessage({ action: 'get_settings' }, (resp) => {
        const settings = resp && resp.settings;
        updateModeUI(settings && settings.activeMode || null);
      });
    }
  }, { silent: true });
}

function updateModeUI(mode) {
  const translateToggle = document.getElementById('mode-translate');
  const bilingualToggle = document.getElementById('mode-bilingual');
  const restoreButton = document.getElementById('restore-original-btn');
  const status = document.getElementById('mode-status');
  const statusText = status && status.querySelector('.mode-status-text');

  if (translateToggle) translateToggle.checked = mode === 'translate';
  if (bilingualToggle) bilingualToggle.checked = mode === 'bilingual';

  // Restore button is ALWAYS enabled — user can force-restore at any time
  if (restoreButton) {
    restoreButton.disabled = false;
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

  if (isSettingsAutoSaveEnabled()) {
    clearTimeout(settingsAutoSaveTimer);
    persistPopupSettings({ closeOnSuccess: false, auto: true });
    return;
  }

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
      applyPopupTheme(settings.theme || 'light');
      setLanguage(settings.uiLanguage || 'auto');
      syncEngineSelect(document.getElementById('popup-translation-engine')?.value || 'google');
    }
  });
}

function openHistoryPanel() {
  openPanel('history-panel');
  chrome.runtime.sendMessage({ action: 'get_history' }, (response) => {
    panelState.history = (response && response.history) || [];
    panelState.historyEnabled = !response || response.historyEnabled !== false;
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
    const settings = (response && response.settings) || getDefaultSettings();
    
    console.log('LingoFlow: Loading settings', {
      translationEngine: settings.translationEngine,
      siliconflowApiKey: settings.siliconflowApiKey ? '***' : '(empty)',
      microsoftApiKey: settings.microsoftApiKey ? '***' : '(empty)',
      geminiApiKey: settings.geminiApiKey ? '***' : '(empty)',
      deepseekApiKey: settings.deepseekApiKey ? '***' : '(empty)',
      baiduAppId: settings.baiduAppId ? '***' : '(empty)',
      baiduSecretKey: settings.baiduSecretKey ? '***' : '(empty)',
      baiduLLMApiKey: settings.baiduLLMApiKey ? '***' : '(empty)',
      youdaoAppKey: settings.youdaoAppKey ? '***' : '(empty)',
      youdaoAppSecret: settings.youdaoAppSecret ? '***' : '(empty)'
    });
    
    panelState.savedSettings = cloneSettings(settings);
    applyPopupSettings(panelState.savedSettings);
    setSettingsDirty(false);
  });
}

// SiliconFlow models list (must match background.js)
const SILICONFLOW_MODELS = [
  // 免费模型
  {
    id: 'tencent/Hunyuan-MT-7B',
    name: 'Hunyuan-MT-7B',
    badge: 'free',
    descZh: '翻译专用 · 默认推荐',
    descEn: 'Translation · Default'
  },
  // 付费模型 - DeepSeek
  {
    id: 'deepseek-ai/DeepSeek-V4-Flash',
    name: 'DeepSeek-V4-Flash',
    badge: 'paid',
    descZh: '极速 · 高性价比',
    descEn: 'Fast · Cost-effective'
  },
  {
    id: 'deepseek-ai/DeepSeek-V3.2',
    name: 'DeepSeek-V3.2',
    badge: 'paid',
    descZh: '最新 · 高性能',
    descEn: 'Latest · High performance'
  },
  {
    id: 'deepseek-ai/DeepSeek-V3',
    name: 'DeepSeek-V3',
    badge: 'paid',
    descZh: '稳定 · 高性价比',
    descEn: 'Stable · Cost-effective'
  },
  // 付费模型 - MiniMax
  {
    id: 'MiniMaxAI/MiniMax-M2.5',
    name: 'MiniMax-M2.5',
    badge: 'paid',
    descZh: 'MiniMax · 长文本',
    descEn: 'MiniMax · Long context'
  }
];

const BAILIAN_MODELS = [
  { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', badge: 'free', descZh: '通用 · 免费额度', descEn: 'General · Free quota' },
  { id: 'qwen-max-latest', name: 'Qwen Max', badge: 'free', descZh: '最高质量', descEn: 'Highest quality' },
  { id: 'qwen-turbo', name: 'Qwen Turbo', badge: 'free', descZh: '极速', descEn: 'Fastest' },
  { id: 'qwen-plus', name: 'Qwen Plus', badge: 'free', descZh: '均衡', descEn: 'Balanced' }
];

const GEMINI_MODELS = [
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite（推荐·500次/天）' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash（备用）' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash（备用）' },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite（低成本）' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash（质量备用）' }
];

const YOUDAO_LLM_MODELS = [
  // 有道大模型翻译 API (llm-trans) 仅支持以下 handleOption 值：
  // '0' = 子曰 Pro (14B) — 高质量，需付费
  // '3' = 子曰 Lite (1.5B) — 免费轻量，推荐
  { id: '3', group: '有道子曰', name: '子曰 Lite (1.5B)', descZh: '免费 · 推荐' },
  { id: '0', group: '有道子曰', name: '子曰 Pro (14B)', descZh: '高质量 · 付费' }
];

const DEEPSEEK_MODELS = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', desc: '推荐 · 极速 · 便宜' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', desc: '高质量 · 思考模式' }
];

function populateDeepSeekModelSelect(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.textContent = '';
  DEEPSEEK_MODELS.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name + (m.desc ? '  ' + m.desc : '');
    select.appendChild(opt);
  });
}

function initSettingsPanel() {
  const controls = [
    'popup-translation-engine',
    'popup-siliconflow-key',
    'popup-siliconflow-model',
    'popup-bailian-key',
    'popup-bailian-host',
    'popup-bailian-model',
    'popup-microsoft-key',
    'popup-gemini-key',
    'popup-gemini-model',
    'popup-youdao-app-key',
    'popup-youdao-app-secret',
    'popup-youdao-llm-model',
    'popup-deepseek-key',
    'popup-deepseek-model',
    'popup-baidu-app-id',
    'popup-baidu-secret-key',
    'popup-translate-to',
    'popup-ui-language',
    'popup-selection-translation',
    'popup-hover-paragraph-translation',
    'popup-auto-save-settings',
    'popup-existing-bilingual-strategy',
    'popup-history-limit',
    'popup-save-history'
  ];

  controls.forEach(id => {
    const control = document.getElementById(id);
    if (!control) return;
    control.addEventListener('change', () => {
      if (id === 'popup-translation-engine') {
        const isSF = control.value === 'siliconflow';
        const isMS = control.value === 'microsoft';
        const isGemini = control.value === 'gemini';
        const isYoudao = control.value === 'youdao' || control.value === 'youdaollm';
        const isDeepSeek = control.value === 'deepseek';
        const isBaidu = control.value === 'baidu';
        const isBaiduLLM = control.value === 'baidullm';
        const isBailian = control.value === 'bailian';
        const isCustom = control.value === 'custom';
        toggleApiKeyRow(isSF);
        toggleModelRow(isSF);
        toggleBailianRows(isBailian);
        toggleMicrosoftRow(isMS);
        toggleGeminiRows(isGemini);
        toggleYoudaoRows(isYoudao);
        toggleDeepSeekRows(isDeepSeek);
        toggleBaiduRows(isBaidu);
        // Baidu LLM needs appid (from developer info) + API Key (Bearer token)
        if (isBaiduLLM) {
          document.getElementById('popup-baidu-app-id-row').hidden = false;
        }
        toggleBaiduLLMRows(isBaiduLLM);
        toggleCustomRows(isCustom);
        syncEngineSelect(control.value);
      }
      if (id === 'popup-ui-language' && typeof setLanguage === 'function') {
        Promise.resolve(setLanguage(control.value || 'auto')).then(() => {
          syncEngineSelect(document.getElementById('popup-translation-engine')?.value || 'google');
          syncSiliconFlowModelSelect(document.getElementById('popup-siliconflow-model')?.value || 'tencent/Hunyuan-MT-7B');
          syncPanelCustomSelects();
          updateSettingsFooter();
        });
      }
      // Fix: auto-save setting itself must always be persisted,
      // even when auto-save is being turned off (markSettingsChanged would skip saving).
      if (id === 'popup-auto-save-settings') {
        persistPopupSettings({ closeOnSuccess: false, auto: true });
      }
      markSettingsChanged();
    });
  });

  initEngineSelect();

  // Also listen on input events for the API key fields
  const apiKeyInput = document.getElementById('popup-siliconflow-key');
  if (apiKeyInput) {
    apiKeyInput.addEventListener('input', () => {
      markSettingsChanged();
    });
  }
  const microsoftKeyInput = document.getElementById('popup-microsoft-key');
  if (microsoftKeyInput) {
    microsoftKeyInput.addEventListener('input', () => {
      markSettingsChanged();
    });
  }
  const geminiKeyInput = document.getElementById('popup-gemini-key');
  if (geminiKeyInput) {
    geminiKeyInput.addEventListener('input', () => {
      markSettingsChanged();
    });
  }
  const youdaoAppKeyInput = document.getElementById('popup-youdao-app-key');
  if (youdaoAppKeyInput) {
    youdaoAppKeyInput.addEventListener('input', () => {
      markSettingsChanged();
    });
  }
  const youdaoAppSecretInput = document.getElementById('popup-youdao-app-secret');
  if (youdaoAppSecretInput) {
    youdaoAppSecretInput.addEventListener('input', () => {
      markSettingsChanged();
    });
  }
  const baiduAppIdInput = document.getElementById('popup-baidu-app-id');
  if (baiduAppIdInput) {
    baiduAppIdInput.addEventListener('input', () => {
      markSettingsChanged();
    });
  }
  const baiduSecretKeyInput = document.getElementById('popup-baidu-secret-key');
  if (baiduSecretKeyInput) {
    baiduSecretKeyInput.addEventListener('input', () => {
      markSettingsChanged();
    });
  }
  const baiduLLMAkInput = document.getElementById('popup-baidullm-ak');
  if (baiduLLMAkInput) {
    baiduLLMAkInput.addEventListener('input', () => {
      markSettingsChanged();
    });
  }
  const deepseekKeyInput = document.getElementById('popup-deepseek-key');
  if (deepseekKeyInput) {
    deepseekKeyInput.addEventListener('input', () => {
      markSettingsChanged();
    });
  }
  const bailianKeyInput = document.getElementById('popup-bailian-key');
  if (bailianKeyInput) {
    bailianKeyInput.addEventListener('input', () => {
      markSettingsChanged();
    });
  }
  const bailianHostInput = document.getElementById('popup-bailian-host');
  if (bailianHostInput) {
    bailianHostInput.addEventListener('input', () => {
      markSettingsChanged();
    });
  }
  const customKeyInput = document.getElementById('popup-custom-key');
  if (customKeyInput) {
    customKeyInput.addEventListener('input', () => {
      markSettingsChanged();
    });
  }
  const customHostInput = document.getElementById('popup-custom-host');
  if (customHostInput) {
    customHostInput.addEventListener('input', () => {
      markSettingsChanged();
    });
  }
  const customModelInput = document.getElementById('popup-custom-model');
  if (customModelInput) {
    customModelInput.addEventListener('input', () => {
      markSettingsChanged();
    });
  }


  // Populate model selector options
  populateModelSelect('popup-siliconflow-model');
  populateGeminiModelSelect('popup-gemini-model');
  populateYoudaoLLMModelSelect('popup-youdao-llm-model');
  initSiliconFlowModelSelect();
  initBailianModelSelect();
  initPanelCustomSelects();

  document.querySelectorAll('[data-popup-theme]').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-popup-theme]').forEach(item => item.classList.remove('active'));
      button.classList.add('active');
      applyPopupTheme(button.getAttribute('data-popup-theme') || 'light');
      markSettingsChanged();
    });
  });

  document.querySelectorAll('[data-position]').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-position]').forEach(item => item.classList.remove('active'));
      button.classList.add('active');
      markSettingsChanged();
    });
  });

  const saveButton = document.getElementById('popup-settings-save');
  if (saveButton) saveButton.addEventListener('click', savePopupSettings);

  const cancelButton = document.getElementById('popup-settings-cancel');
  if (cancelButton) {
    cancelButton.addEventListener('click', () => {
      if (isSettingsAutoSaveEnabled()) {
        if (panelState.settingsDirty) {
          clearTimeout(settingsAutoSaveTimer);
          persistPopupSettings({ closeOnSuccess: true, auto: true });
          return;
        }
        closePanels();
        return;
      }

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

  // Force-save unsaved settings before popup closes (handles outside-click dismiss)
  // Chrome destroys popups immediately on outside-click; visibilitychange fires first,
  // pagehide is the last chance.
  // IMPORTANT: We must read existing storage first, then merge with UI values.
  // Otherwise hidden API key inputs (for non-active engines) will have empty values,
  // and directly saving from UI will overwrite those keys with empty strings.
  let forceSaveDone = false;
  const forceSaveOnClose = () => {
    if (forceSaveDone) return;
    forceSaveDone = true;
    clearTimeout(settingsAutoSaveTimer);
    
    // Only save if settings have actually been modified
    if (!panelState.settingsDirty) {
      console.log('LingoFlow: No unsaved settings, skipping force save');
      return;
    }
    
    // Read existing storage first, then merge UI values on top.
    // This preserves API keys for hidden (inactive) engine inputs.
    chrome.storage.local.get(['lingoflow_settings'], (result) => {
      const existing = result.lingoflow_settings || {};
      const current = getPopupSettingsFromUI();
      const merged = getDefaultSettings({ ...existing, ...current });
      
      console.log('LingoFlow: Force saving settings before close', {
        translationEngine: merged.translationEngine,
        hasSiliconflowKey: !!merged.siliconflowApiKey,
        hasMicrosoftKey: !!merged.microsoftApiKey,
        hasGeminiKey: !!merged.geminiApiKey,
        hasDeepseekKey: !!merged.deepseekApiKey,
        hasBaiduAppId: !!merged.baiduAppId,
        hasBaiduSecretKey: !!merged.baiduSecretKey,
        hasBaiduLLMKey: !!merged.baiduLLMApiKey,
        hasYoudaoAppKey: !!merged.youdaoAppKey,
        hasYoudaoAppSecret: !!merged.youdaoAppSecret
      });
      
      chrome.storage.local.set({ lingoflow_settings: merged }, () => {
        if (chrome.runtime.lastError) {
          console.error('LingoFlow: Force save failed', chrome.runtime.lastError);
        } else {
          console.log('LingoFlow: Force save succeeded');
        }
      });
      
      panelState.settingsDirty = false;
    });
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') forceSaveOnClose();
  });
  window.addEventListener('pagehide', forceSaveOnClose);
}

function markSettingsChanged() {
  setSettingsDirty(true);
  if (isSettingsAutoSaveEnabled()) {
    scheduleSettingsAutoSave();
  } else {
    clearTimeout(settingsAutoSaveTimer);
    setSettingsSaveState('unsaved');
  }
}

function isSettingsAutoSaveEnabled() {
  const autoSave = document.getElementById('popup-auto-save-settings');
  return autoSave ? autoSave.checked !== false : true;
}

function scheduleSettingsAutoSave() {
  clearTimeout(settingsAutoSaveTimer);
  if (!isSettingsAutoSaveEnabled()) {
    setSettingsSaveState(panelState.settingsDirty ? 'unsaved' : 'saved');
    return;
  }
  setSettingsSaveState('saving');
  settingsAutoSaveTimer = setTimeout(() => {
    persistPopupSettings({ closeOnSuccess: false, auto: true });
  }, 350);
}

const ENGINE_SELECT_META = {
  google: { label: 'Google 翻译', description: '快速通用' },
  microsoft: { label: 'Microsoft Translator', description: '稳定专业' },
  siliconflow: { label: '硅基流动 AI', description: 'AI 翻译' },
  gemini: { label: 'Gemini AI', description: '便宜快速' },
  mymemory: { label: 'MyMemory（免费）', description: '免费备用' },
  youdao: { label: '有道翻译', description: '国内快速' },
  youdaollm: { label: '有道大模型', description: 'AI 翻译' },
  baidu: { label: '百度翻译', description: '国内稳定' },
  baidullm: { label: '百度大模型', description: 'AI 翻译 · 高质量' },
  translatejs: { label: 'translate.js', description: '免费 · 无需 Key' }
};

const ENGINE_SELECT_API_REQUIRED = new Set([
  'microsoft',
  'siliconflow',
  'gemini',
  'deepseek',
  'youdao',
  'youdaollm',
  'baidu',
  'baidullm'
]);

function engineRequiresApi(value) {
  return ENGINE_SELECT_API_REQUIRED.has(value);
}

function createEngineBadge(text, type) {
  const badge = document.createElement('span');
  badge.className = `engine-select-badge engine-select-badge-${type}`;
  badge.textContent = text;
  if (type === 'api') badge.title = 'Requires API key';
  return badge;
}

function renderEngineBadges(host, value, description) {
  if (!host) return;
  host.textContent = '';
  const hasDescription = !!description;
  const hasApi = engineRequiresApi(value);
  host.hidden = !hasDescription && !hasApi;
  if (!hasDescription && !hasApi) return;

  if (hasDescription) {
    host.appendChild(createEngineBadge(description, 'desc'));
  }
  if (hasApi) {
    host.appendChild(createEngineBadge('API', 'api'));
  }
}

function getOrCreateEngineTriggerBadgeHost() {
  const trigger = document.getElementById('engine-select-trigger');
  if (!trigger) return null;
  let host = document.getElementById('engine-select-badges');
  if (host) return host;

  host = document.createElement('span');
  host.id = 'engine-select-badges';
  host.className = 'engine-select-badges';
  const chevron = trigger.querySelector('.engine-select-chevron');
  trigger.insertBefore(host, chevron || null);
  return host;
}

function getOrCreateEngineOptionBadgeHost(option) {
  if (!option) return null;
  let host = option.querySelector('.engine-select-option-badges');
  if (host) return host;

  host = document.createElement('span');
  host.className = 'engine-select-option-badges';
  const text = option.querySelector(':scope > span');
  if (text) {
    text.appendChild(host);
  }
  return host;
}

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

  if (open) {
    closePanelCustomSelects();
    setSiliconFlowModelSelectOpen(false);
  }
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
  if (desc) {
    desc.textContent = meta.description;
    desc.hidden = true;
  }
  renderEngineBadges(getOrCreateEngineTriggerBadgeHost(), currentValue, meta.description);

  document.querySelectorAll('[data-engine-value]').forEach(option => {
    const selected = option.getAttribute('data-engine-value') === currentValue;
    const optionValue = option.getAttribute('data-engine-value') || 'google';
    const optionLabel = option.querySelector('strong');
    const optionDesc = option.querySelector('small');
    const optionMeta = ENGINE_SELECT_META[optionValue] || ENGINE_SELECT_META.google;

    option.setAttribute('aria-selected', String(selected));
    if (optionLabel) optionLabel.textContent = getEngineSelectLabel(optionValue);
    if (optionDesc) optionDesc.hidden = true;
    renderEngineBadges(getOrCreateEngineOptionBadgeHost(option), optionValue, optionMeta.description);
  });
}

function initPanelCustomSelects() {
  document.querySelectorAll('select.panel-select').forEach(select => {
    if (select.id === 'popup-translation-engine') return;
    if (select.id === 'popup-siliconflow-model') return;
    if (select.id === 'popup-bailian-model') return;
    if (select.dataset.customSelectReady === 'true') return;

    select.dataset.customSelectReady = 'true';
    select.classList.add('native-select-hidden');

    const customSelect = document.createElement('div');
    customSelect.className = 'panel-custom-select';
    customSelect.dataset.selectFor = select.id || '';

    const trigger = document.createElement('button');
    trigger.className = 'panel-custom-select-trigger';
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const label = document.createElement('span');
    label.className = 'panel-custom-select-label';

    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('class', 'panel-custom-select-chevron');
    chevron.setAttribute('width', '16');
    chevron.setAttribute('height', '16');
    chevron.setAttribute('viewBox', '0 0 24 24');
    chevron.setAttribute('fill', 'none');
    chevron.setAttribute('stroke', 'currentColor');
    chevron.setAttribute('stroke-width', '2');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm6 9 6 6 6-6');
    chevron.appendChild(path);

    trigger.append(label, chevron);

    const menu = document.createElement('div');
    menu.className = 'panel-custom-select-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;

    customSelect.append(trigger, menu);
    select.insertAdjacentElement('afterend', customSelect);

    trigger.addEventListener('click', () => {
      setPanelCustomSelectOpen(customSelect, !customSelect.classList.contains('open'));
    });

    select.addEventListener('change', () => {
      refreshPanelCustomSelect(select);
    });

    refreshPanelCustomSelect(select);
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.panel-custom-select') && !event.target.closest('.engine-select') && !event.target.closest('.model-select')) {
      closePanelCustomSelects();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePanelCustomSelects();
  });
}

function getPanelCustomSelect(select) {
  if (!select) return null;
  return select.nextElementSibling && select.nextElementSibling.classList.contains('panel-custom-select')
    ? select.nextElementSibling
    : null;
}

function refreshPanelCustomSelect(select) {
  const customSelect = getPanelCustomSelect(select);
  if (!select || !customSelect) return;

  const trigger = customSelect.querySelector('.panel-custom-select-trigger');
  const label = customSelect.querySelector('.panel-custom-select-label');
  const menu = customSelect.querySelector('.panel-custom-select-menu');
  if (!trigger || !label || !menu) return;

  const selectedOption = select.selectedOptions && select.selectedOptions[0];
  label.textContent = selectedOption ? selectedOption.textContent.trim() : '';
  menu.textContent = '';

  Array.from(select.options).forEach(option => {
    const item = document.createElement('button');
    item.className = 'panel-custom-select-option';
    item.type = 'button';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(option.value === select.value));
    item.textContent = option.textContent.trim();
    item.addEventListener('click', () => {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      setPanelCustomSelectOpen(customSelect, false);
    });
    menu.appendChild(item);
  });

  trigger.setAttribute('aria-expanded', String(customSelect.classList.contains('open')));
}

function setPanelCustomSelectOpen(customSelect, open) {
  if (!customSelect) return;
  if (open) setEngineSelectOpen(false);
  if (open) { setSiliconFlowModelSelectOpen(false); setBailianModelSelectOpen(false); }
  closePanelCustomSelects(customSelect);

  const trigger = customSelect.querySelector('.panel-custom-select-trigger');
  const menu = customSelect.querySelector('.panel-custom-select-menu');
  if (!trigger || !menu) return;

  customSelect.classList.toggle('open', open);
  trigger.setAttribute('aria-expanded', String(open));
  menu.hidden = !open;
}

function closePanelCustomSelects(except = null) {
  document.querySelectorAll('.panel-custom-select.open').forEach(customSelect => {
    if (customSelect === except) return;
    const trigger = customSelect.querySelector('.panel-custom-select-trigger');
    const menu = customSelect.querySelector('.panel-custom-select-menu');
    customSelect.classList.remove('open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (menu) menu.hidden = true;
  });
}

function syncPanelCustomSelects() {
  document.querySelectorAll('select.panel-select[data-custom-select-ready="true"]').forEach(select => {
    refreshPanelCustomSelect(select);
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

function getSiliconFlowModelMeta(value) {
  return SILICONFLOW_MODELS.find(model => model.id === value) || SILICONFLOW_MODELS[0];
}

function getSiliconFlowModelDescription(model) {
  const lang = document.getElementById('popup-ui-language')?.value || 'auto';
  if (lang === 'en') return model.descEn || model.descZh || '';
  return model.descZh || model.descEn || '';
}

function getModelBadgeText(type) {
  return getMessage(type === 'paid' ? 'paid' : 'free');
}

function initSiliconFlowModelSelect() {
  const nativeSelect = document.getElementById('popup-siliconflow-model');
  const customSelect = document.getElementById('siliconflow-model-select');
  const trigger = document.getElementById('siliconflow-model-trigger');
  const menu = document.getElementById('siliconflow-model-menu');
  if (!nativeSelect || !customSelect || !trigger || !menu) return;

  trigger.addEventListener('click', () => {
    setSiliconFlowModelSelectOpen(!customSelect.classList.contains('open'));
  });

  nativeSelect.addEventListener('change', () => {
    syncSiliconFlowModelSelect(nativeSelect.value || 'tencent/Hunyuan-MT-7B');
  });

  document.addEventListener('click', (event) => {
    if (!customSelect.contains(event.target)) {
      setSiliconFlowModelSelectOpen(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setSiliconFlowModelSelectOpen(false);
    }
  });

  syncSiliconFlowModelSelect(nativeSelect.value || 'tencent/Hunyuan-MT-7B');
}

function setSiliconFlowModelSelectOpen(open) {
  const customSelect = document.getElementById('siliconflow-model-select');
  const trigger = document.getElementById('siliconflow-model-trigger');
  const menu = document.getElementById('siliconflow-model-menu');
  if (!customSelect || !trigger || !menu) return;

  if (open) {
    setEngineSelectOpen(false);
    setBailianModelSelectOpen(false);
    closePanelCustomSelects();
  }

  customSelect.classList.toggle('open', open);
  trigger.setAttribute('aria-expanded', String(open));
  menu.hidden = !open;
}

function syncSiliconFlowModelSelect(value) {
  const nativeSelect = document.getElementById('popup-siliconflow-model');
  const menu = document.getElementById('siliconflow-model-menu');
  const label = document.getElementById('siliconflow-model-label');
  const badge = document.getElementById('siliconflow-model-badge');
  const desc = document.getElementById('siliconflow-model-desc');
  if (!nativeSelect || !menu || !label || !badge || !desc) return;

  const currentValue = value || nativeSelect.value || 'tencent/Hunyuan-MT-7B';
  const currentModel = getSiliconFlowModelMeta(currentValue);
  label.textContent = currentModel.name;
  desc.textContent = getSiliconFlowModelDescription(currentModel);
  badge.textContent = getModelBadgeText(currentModel.badge);
  badge.className = `model-select-badge model-select-badge-${currentModel.badge === 'paid' ? 'paid' : 'free'}`;
  menu.textContent = '';

  let lastBadgeType = null;

  SILICONFLOW_MODELS.forEach((model, index) => {
    // Add separator between free and paid models
    if (index > 0 && lastBadgeType !== model.badge) {
      const separator = document.createElement('div');
      separator.className = 'model-select-separator';
      separator.setAttribute('role', 'separator');
      const separatorText = document.createElement('span');
      separatorText.textContent = model.badge === 'paid' ? getMessage('paid_models') : getMessage('free_models');
      separator.appendChild(separatorText);
      menu.appendChild(separator);
    }
    lastBadgeType = model.badge;

    const option = document.createElement('button');
    option.className = 'model-select-option';
    option.type = 'button';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(model.id === currentValue));
    option.dataset.modelValue = model.id;

    const text = document.createElement('span');
    text.className = 'model-select-option-text';

    const top = document.createElement('span');
    top.className = 'model-select-title-row';

    const title = document.createElement('strong');
    title.textContent = model.name;

    const optionBadge = document.createElement('span');
    optionBadge.className = `model-select-badge model-select-badge-${model.badge === 'paid' ? 'paid' : 'free'}`;
    optionBadge.textContent = getModelBadgeText(model.badge);

    const optionDesc = document.createElement('small');
    optionDesc.textContent = getSiliconFlowModelDescription(model);

    const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    check.setAttribute('class', 'model-select-check');
    check.setAttribute('width', '16');
    check.setAttribute('height', '16');
    check.setAttribute('viewBox', '0 0 24 24');
    check.setAttribute('fill', 'none');
    check.setAttribute('stroke', 'currentColor');
    check.setAttribute('stroke-width', '2.4');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M20 6 9 17l-5-5');
    check.appendChild(path);

    top.append(title, optionBadge);
    text.append(top, optionDesc);
    option.append(text, check);

    option.addEventListener('click', () => {
      nativeSelect.value = model.id;
      nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      setSiliconFlowModelSelectOpen(false);
    });

    menu.appendChild(option);
  });
}

function populateBailianModelSelect(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.textContent = '';
  BAILIAN_MODELS.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    select.appendChild(opt);
  });
}

function getBailianModelMeta(value) {
  return BAILIAN_MODELS.find(model => model.id === value) || BAILIAN_MODELS[0];
}

function getBailianModelDescription(model) {
  const lang = document.getElementById('popup-ui-language')?.value || 'auto';
  if (lang === 'en') return model.descEn || model.descZh || '';
  return model.descZh || model.descEn || '';
}

function initBailianModelSelect() {
  const nativeSelect = document.getElementById('popup-bailian-model');
  const trigger = document.getElementById('bailian-model-trigger');
  const menu = document.getElementById('bailian-model-menu');
  if (!nativeSelect || !trigger || !menu) return;

  populateBailianModelSelect('popup-bailian-model');

  trigger.addEventListener('click', () => {
    setBailianModelSelectOpen(!document.getElementById('bailian-model-select').classList.contains('open'));
  });

  nativeSelect.addEventListener('change', () => {
    syncBailianModelSelect(nativeSelect.value || 'qwen3.7-plus');
  });

  document.addEventListener('click', (event) => {
    const customSelect = document.getElementById('bailian-model-select');
    if (customSelect && !customSelect.contains(event.target)) {
      setBailianModelSelectOpen(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setBailianModelSelectOpen(false);
  });

  syncBailianModelSelect(nativeSelect.value || 'qwen3.7-plus');
}

function setBailianModelSelectOpen(open) {
  const customSelect = document.getElementById('bailian-model-select');
  const trigger = document.getElementById('bailian-model-trigger');
  const menu = document.getElementById('bailian-model-menu');
  if (!customSelect || !trigger || !menu) return;
  if (open) {
    setEngineSelectOpen(false);
    setSiliconFlowModelSelectOpen(false);
    closePanelCustomSelects();
  }
  customSelect.classList.toggle('open', open);
  trigger.setAttribute('aria-expanded', String(open));
  menu.hidden = !open;
}

function syncBailianModelSelect(value) {
  const nativeSelect = document.getElementById('popup-bailian-model');
  const menu = document.getElementById('bailian-model-menu');
  const label = document.getElementById('bailian-model-label');
  const badge = document.getElementById('bailian-model-badge');
  const desc = document.getElementById('bailian-model-desc');
  if (!nativeSelect || !menu || !label || !badge || !desc) return;

  const currentValue = value || nativeSelect.value || 'qwen3.7-plus';
  const currentModel = getBailianModelMeta(currentValue);
  label.textContent = currentModel.name;
  desc.textContent = getBailianModelDescription(currentModel);
  badge.textContent = getModelBadgeText(currentModel.badge);
  badge.className = `model-select-badge model-select-badge-${currentModel.badge === 'paid' ? 'paid' : 'free'}`;
  menu.textContent = '';

  let lastBadgeType = null;

  BAILIAN_MODELS.forEach((model, index) => {
    if (index > 0 && lastBadgeType !== model.badge) {
      const separator = document.createElement('div');
      separator.className = 'model-select-separator';
      separator.setAttribute('role', 'separator');
      const separatorText = document.createElement('span');
      separatorText.textContent = model.badge === 'paid' ? getMessage('paid_models') : getMessage('free_models');
      separator.appendChild(separatorText);
      menu.appendChild(separator);
    }
    lastBadgeType = model.badge;

    const option = document.createElement('button');
    option.className = 'model-select-option';
    option.type = 'button';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(model.id === currentValue));
    option.dataset.modelValue = model.id;

    const text = document.createElement('span');
    text.className = 'model-select-option-text';

    const top = document.createElement('span');
    top.className = 'model-select-title-row';

    const title = document.createElement('strong');
    title.textContent = model.name;

    const optionBadge = document.createElement('span');
    optionBadge.className = `model-select-badge model-select-badge-${model.badge === 'paid' ? 'paid' : 'free'}`;
    optionBadge.textContent = getModelBadgeText(model.badge);

    const optionDesc = document.createElement('small');
    optionDesc.textContent = getBailianModelDescription(model);

    const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    check.setAttribute('class', 'model-select-check');
    check.setAttribute('width', '16');
    check.setAttribute('height', '16');
    check.setAttribute('viewBox', '0 0 24 24');
    check.setAttribute('fill', 'none');
    check.setAttribute('stroke', 'currentColor');
    check.setAttribute('stroke-width', '2.4');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M20 6 9 17l-5-5');
    check.appendChild(path);

    top.append(title, optionBadge);
    text.append(top, optionDesc);
    option.append(text, check);

    option.addEventListener('click', () => {
      nativeSelect.value = model.id;
      nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      setBailianModelSelectOpen(false);
    });

    menu.appendChild(option);
  });
}

function populateGeminiModelSelect(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.textContent = '';
  GEMINI_MODELS.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    select.appendChild(opt);
  });
}

function populateYoudaoLLMModelSelect(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.textContent = '';

  let currentGroup = null;
  YOUDAO_LLM_MODELS.forEach((m, i) => {
    // Insert group separator <optgroup>
    if (m.group !== currentGroup) {
      currentGroup = m.group;
      const og = document.createElement('optgroup');
      og.label = currentGroup;
      // Append remaining models of this group as options
      for (let j = i; j < YOUDAO_LLM_MODELS.length && YOUDAO_LLM_MODELS[j].group === currentGroup; j++) {
        const mm = YOUDAO_LLM_MODELS[j];
        const opt = document.createElement('option');
        opt.value = mm.id;
        opt.textContent = mm.name + (mm.descZh ? '  ' + mm.descZh : '');
        og.appendChild(opt);
      }
      select.appendChild(og);
    }
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

function toggleGeminiRows(show) {
  const keyRow = document.getElementById('popup-gemini-key-row');
  const modelRow = document.getElementById('popup-gemini-model-row');
  if (keyRow) keyRow.hidden = !show;
  if (modelRow) modelRow.hidden = !show;
}

function toggleYoudaoRows(show) {
  const keyRow = document.getElementById('popup-youdao-key-row');
  const secretRow = document.getElementById('popup-youdao-secret-row');
  const modelRow = document.getElementById('popup-youdao-llm-model-row');
  if (keyRow) keyRow.hidden = !show;
  if (secretRow) secretRow.hidden = !show;
  if (modelRow) modelRow.hidden = !show;
}

function toggleDeepSeekRows(show) {
  const keyRow = document.getElementById('popup-deepseek-key-row');
  const modelRow = document.getElementById('popup-deepseek-model-row');
  if (keyRow) keyRow.hidden = !show;
  if (modelRow) modelRow.hidden = !show;
}

function toggleBailianRows(show) {
  const keyRow = document.getElementById('popup-bailian-key-row');
  const hostRow = document.getElementById('popup-bailian-host-row');
  const modelRow = document.getElementById('popup-bailian-model-row');
  if (keyRow) keyRow.hidden = !show;
  if (hostRow) hostRow.hidden = !show;
  if (modelRow) modelRow.hidden = !show;
}

function toggleBaiduRows(show) {
  const appIdRow = document.getElementById('popup-baidu-app-id-row');
  const secretKeyRow = document.getElementById('popup-baidu-secret-key-row');
  if (appIdRow) appIdRow.hidden = !show;
  if (secretKeyRow) secretKeyRow.hidden = !show;
}

function toggleBaiduLLMRows(show) {
  const akRow = document.getElementById('popup-baidullm-ak-row');
  if (akRow) akRow.hidden = !show;
}

function toggleCustomRows(show) {
  const keyRow = document.getElementById('popup-custom-key-row');
  const hostRow = document.getElementById('popup-custom-host-row');
  const modelRow = document.getElementById('popup-custom-model-row');
  if (keyRow) keyRow.hidden = !show;
  if (hostRow) hostRow.hidden = !show;
  if (modelRow) modelRow.hidden = !show;
}

function applyPopupSettings(settings) {
  const translationEngine = document.getElementById('popup-translation-engine');
  const apiKeyInput = document.getElementById('popup-siliconflow-key');
  const modelSelect = document.getElementById('popup-siliconflow-model');
  const microsoftKeyInput = document.getElementById('popup-microsoft-key');
  const geminiKeyInput = document.getElementById('popup-gemini-key');
  const geminiModelSelect = document.getElementById('popup-gemini-model');
  const translateTo = document.getElementById('popup-translate-to');
  const uiLanguage = document.getElementById('popup-ui-language');
  const autoSaveSettings = document.getElementById('popup-auto-save-settings');
  const existingBilingualStrategy = document.getElementById('popup-existing-bilingual-strategy');
  const historyLimit = document.getElementById('popup-history-limit');
  const theme = settings.theme || 'light';
  applyPopupTheme(theme);

  if (translationEngine) {
    translationEngine.value = settings.translationEngine || 'google';
    const isSF = translationEngine.value === 'siliconflow';
    const isMS = translationEngine.value === 'microsoft';
    const isGemini = translationEngine.value === 'gemini';
    const isYoudao = translationEngine.value === 'youdao' || translationEngine.value === 'youdaollm';
    const isDeepSeek = translationEngine.value === 'deepseek';
    const isBaidu = translationEngine.value === 'baidu';
    const isBaiduLLM = translationEngine.value === 'baidullm';
    const isBailian = translationEngine.value === 'bailian';
    const isCustom = translationEngine.value === 'custom';
    toggleApiKeyRow(isSF);
    toggleModelRow(isSF);
    toggleMicrosoftRow(isMS);
    toggleGeminiRows(isGemini);
    toggleYoudaoRows(isYoudao);
    toggleDeepSeekRows(isDeepSeek);
    toggleBaiduRows(isBaidu);
    if (isBaiduLLM) {
      document.getElementById('popup-baidu-app-id-row').hidden = false;
    }
    toggleBaiduLLMRows(isBaiduLLM);
    toggleBailianRows(isBailian);
    toggleCustomRows(isCustom);
    syncEngineSelect(translationEngine.value);
  }
  if (apiKeyInput) apiKeyInput.value = settings.siliconflowApiKey || '';
  if (modelSelect) {
    modelSelect.value = settings.siliconflowModel || 'tencent/Hunyuan-MT-7B';
    if (!modelSelect.value) modelSelect.value = 'tencent/Hunyuan-MT-7B';
    syncSiliconFlowModelSelect(modelSelect.value);
  }
  const bailianKeyInput = document.getElementById('popup-bailian-key');
  if (bailianKeyInput) bailianKeyInput.value = settings.bailianApiKey || '';
  const bailianHostInput = document.getElementById('popup-bailian-host');
  if (bailianHostInput) bailianHostInput.value = settings.bailianApiHost || '';
  const bailianModelSelect = document.getElementById('popup-bailian-model');
  if (bailianModelSelect) {
    bailianModelSelect.value = settings.bailianModel || 'qwen3.7-plus';
    if (!bailianModelSelect.value) bailianModelSelect.value = 'qwen3.7-plus';
    syncBailianModelSelect(bailianModelSelect.value);
  }
  if (microsoftKeyInput) microsoftKeyInput.value = settings.microsoftApiKey || '';
  if (geminiKeyInput) geminiKeyInput.value = settings.geminiApiKey || '';
  if (geminiModelSelect) {
    geminiModelSelect.value = settings.geminiModel || 'gemini-3.1-flash-lite';
    if (!geminiModelSelect.value) geminiModelSelect.value = 'gemini-3.1-flash-lite';
  }
  const deepseekKeyInput = document.getElementById('popup-deepseek-key');
  if (deepseekKeyInput) deepseekKeyInput.value = settings.deepseekApiKey || '';
  const deepseekModelSelect = document.getElementById('popup-deepseek-model');
  if (deepseekModelSelect) {
    deepseekModelSelect.value = settings.deepseekModel || 'deepseek-v4-flash';
    if (!deepseekModelSelect.value) deepseekModelSelect.value = 'deepseek-v4-flash';
  }

  const baiduAppIdInput = document.getElementById('popup-baidu-app-id');
  if (baiduAppIdInput) baiduAppIdInput.value = settings.baiduAppId || '';
  const baiduSecretKeyInput = document.getElementById('popup-baidu-secret-key');
  if (baiduSecretKeyInput) baiduSecretKeyInput.value = settings.baiduSecretKey || '';
  const baiduLLMAkInput = document.getElementById('popup-baidullm-ak');
  if (baiduLLMAkInput) baiduLLMAkInput.value = settings.baiduLLMApiKey || '';

  const customKeyInput = document.getElementById('popup-custom-key');
  if (customKeyInput) customKeyInput.value = settings.customApiKey || '';
  const customHostInput = document.getElementById('popup-custom-host');
  if (customHostInput) customHostInput.value = settings.customApiHost || '';
  const customModelInput = document.getElementById('popup-custom-model');
  if (customModelInput) customModelInput.value = settings.customModel || '';

  const youdaoAppKeyInput = document.getElementById('popup-youdao-app-key');
  if (youdaoAppKeyInput) youdaoAppKeyInput.value = settings.youdaoAppKey || '';
  const youdaoAppSecretInput = document.getElementById('popup-youdao-app-secret');
  if (youdaoAppSecretInput) youdaoAppSecretInput.value = settings.youdaoAppSecret || '';
  const youdaoLLMModelSelect = document.getElementById('popup-youdao-llm-model');
  if (youdaoLLMModelSelect) {
    youdaoLLMModelSelect.value = settings.youdaoLLMModel || '3';
    if (!youdaoLLMModelSelect.value) youdaoLLMModelSelect.value = '3';
  }
  if (translateTo) translateTo.value = settings.targetLanguage || 'zh';
  if (uiLanguage) uiLanguage.value = settings.uiLanguage || 'auto';
  const selectionTranslation = document.getElementById('popup-selection-translation');
  if (selectionTranslation) selectionTranslation.checked = settings.selectionTranslation !== false;
  const hoverParagraphTranslation = document.getElementById('popup-hover-paragraph-translation');
  if (hoverParagraphTranslation) hoverParagraphTranslation.checked = settings.hoverParagraphTranslation === true;
  if (autoSaveSettings) autoSaveSettings.checked = settings.autoSaveSettings !== false;
  if (existingBilingualStrategy) existingBilingualStrategy.value = settings.existingBilingualStrategy || 'skip';
  if (historyLimit) historyLimit.value = String(settings.historyLimit || 50);
  const saveHistory = document.getElementById('popup-save-history');
  if (saveHistory) saveHistory.checked = settings.saveHistory !== false;

  document.querySelectorAll('[data-popup-theme]').forEach(button => {
    button.classList.toggle('active', button.getAttribute('data-popup-theme') === theme);
  });
  const toolbarPosition = settings.toolbarPosition || 'above';
  document.querySelectorAll('[data-position]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-position') === toolbarPosition);
  });
  syncPanelCustomSelects();
  syncSiliconFlowModelSelect(modelSelect?.value || 'tencent/Hunyuan-MT-7B');
  updateSettingsFooter();
}

function applyPopupTheme(theme) {
  const normalizedTheme = theme === 'dark' ? 'dark' : 'light';
  if (document.body) {
    document.body.setAttribute('data-theme', normalizedTheme);
  }
}

function getPopupSettingsFromUI() {
  return {
    translationEngine: document.getElementById('popup-translation-engine')?.value || 'google',
    siliconflowApiKey: document.getElementById('popup-siliconflow-key')?.value || '',
    siliconflowModel: document.getElementById('popup-siliconflow-model')?.value || 'tencent/Hunyuan-MT-7B',
    bailianApiKey: document.getElementById('popup-bailian-key')?.value || '',
    bailianApiHost: document.getElementById('popup-bailian-host')?.value || '',
    bailianModel: document.getElementById('popup-bailian-model')?.value || 'qwen3.7-plus',
    microsoftApiKey: document.getElementById('popup-microsoft-key')?.value || '',
    geminiApiKey: document.getElementById('popup-gemini-key')?.value || '',
    geminiModel: document.getElementById('popup-gemini-model')?.value || 'gemini-3.1-flash-lite',
    deepseekApiKey: document.getElementById('popup-deepseek-key')?.value || '',
    deepseekModel: document.getElementById('popup-deepseek-model')?.value || 'deepseek-v4-flash',
    baiduAppId: document.getElementById('popup-baidu-app-id')?.value || '',
    baiduSecretKey: document.getElementById('popup-baidu-secret-key')?.value || '',
    baiduLLMApiKey: document.getElementById('popup-baidullm-ak')?.value || '',
    customApiKey: document.getElementById('popup-custom-key')?.value || '',
    customApiHost: document.getElementById('popup-custom-host')?.value || '',
    customModel: document.getElementById('popup-custom-model')?.value || '',
    youdaoAppKey: document.getElementById('popup-youdao-app-key')?.value || '',
    youdaoAppSecret: document.getElementById('popup-youdao-app-secret')?.value || '',
    youdaoLLMModel: document.getElementById('popup-youdao-llm-model')?.value || '3',
    targetLanguage: document.getElementById('popup-translate-to')?.value || 'zh',
    uiLanguage: document.getElementById('popup-ui-language')?.value || 'auto',
    theme: document.querySelector('[data-popup-theme].active')?.getAttribute('data-popup-theme') || 'light',
    selectionTranslation: document.getElementById('popup-selection-translation')?.checked !== false,
    hoverParagraphTranslation: document.getElementById('popup-hover-paragraph-translation')?.checked === true,
    autoSaveSettings: document.getElementById('popup-auto-save-settings')?.checked !== false,
    toolbarPosition: document.querySelector('[data-position].active')?.getAttribute('data-position') || 'above',
    existingBilingualStrategy: document.getElementById('popup-existing-bilingual-strategy')?.value || 'skip',
    historyLimit: parseInt(document.getElementById('popup-history-limit')?.value, 10) || 50,
    saveHistory: document.getElementById('popup-save-history')?.checked !== false
  };
}

function savePopupSettings() {
  persistPopupSettings({ closeOnSuccess: true, auto: false });
}

function persistPopupSettings(options = {}) {
  const closeOnSuccess = options.closeOnSuccess !== false;
  const isAuto = !!options.auto;
  const settings = getPopupSettingsFromUI();
  
  console.log('LingoFlow: Persisting settings', {
    translationEngine: settings.translationEngine,
    isAuto: isAuto
  });
  
  setSettingsSaveState('saving');
  chrome.runtime.sendMessage({ action: 'update_settings', settings }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('LingoFlow: Error sending message to background', chrome.runtime.lastError);
      setSettingsSaveState('failed');
      showStatus(getMessage('error_cannot_access'), 'error');
      return;
    }
    
    if (!response || !response.success) {
      console.error('LingoFlow: Background script reported failure', response);
      setSettingsSaveState('failed');
      showStatus(getMessage('error_cannot_access'), 'error');
      return;
    }

    panelState.savedSettings = cloneSettings(settings);
    setSettingsDirty(false);
    setSettingsSaveState('saved');
    // Mirror UI language to localStorage so pages opened in their own tab
    // (setup guide, support) can pick up the popup's language choice on next load.
    try {
      localStorage.setItem('lingoflow_ui_lang', settings.uiLanguage || 'auto');
    } catch (e) {}
    if (typeof setLanguage === 'function') {
      Promise.resolve(setLanguage(settings.uiLanguage || 'auto')).then(() => {
        syncEngineSelect(document.getElementById('popup-translation-engine')?.value || 'google');
        syncSiliconFlowModelSelect(document.getElementById('popup-siliconflow-model')?.value || 'tencent/Hunyuan-MT-7B');
        syncPanelCustomSelects();
        updateSettingsFooter();
      });
    }
    showStatus(getMessage(isAuto ? 'settings_auto_saved' : 'settings_saved'), 'success');
    if (closeOnSuccess) closePanels();
  });
}

function setSettingsDirty(isDirty) {
  panelState.settingsDirty = isDirty;
  updateSettingsFooter();
}

function setSettingsSaveState(state) {
  panelState.settingsSaveState = state || 'saved';
  updateSettingsFooter();
}

function updateSettingsFooter() {
  const footer = document.querySelector('.settings-panel-footer');
  const saveButton = document.getElementById('popup-settings-save');
  const cancelButton = document.getElementById('popup-settings-cancel');
  const status = document.getElementById('popup-settings-save-status');
  const autoSave = isSettingsAutoSaveEnabled();

  if (footer) footer.classList.toggle('settings-footer-auto', autoSave);

  if (saveButton) {
    saveButton.hidden = autoSave;
    saveButton.disabled = !panelState.settingsDirty || panelState.settingsSaveState === 'saving';
    saveButton.textContent = getMessage('save_settings');
  }

  if (cancelButton) {
    cancelButton.disabled = false;
    cancelButton.textContent = getMessage(autoSave ? 'done' : 'cancel');
  }

  if (status) {
    status.hidden = !autoSave;
    status.textContent = getSettingsSaveStatusText();
    status.dataset.state = panelState.settingsSaveState || 'saved';
  }
}

function getSettingsSaveStatusText() {
  if (panelState.settingsSaveState === 'saving') return getMessage('settings_saving');
  if (panelState.settingsSaveState === 'failed') return getMessage('settings_save_failed');
  if (panelState.settingsDirty) return getMessage('settings_unsaved');
  return getMessage('settings_auto_saved');
}

function cloneSettings(settings) {
  return JSON.parse(JSON.stringify(settings));
}

function getDefaultSettings(overrides = {}) {
  return {
    translationEngine: 'google',
    siliconflowApiKey: '',
    siliconflowModel: 'tencent/Hunyuan-MT-7B',
    bailianApiKey: '',
    bailianApiHost: 'https://ws-qs3nf4dw21t7cnw9.cn-beijing.maas.aliyuncs.com',
    bailianModel: 'qwen3.7-plus',
    customApiKey: '',
    customApiHost: 'https://api.openai.com',
    customModel: 'gpt-4o-mini',
    microsoftApiKey: '',
    geminiApiKey: '',
    geminiModel: 'gemini-3.1-flash-lite',
    deepseekApiKey: '',
    deepseekModel: 'deepseek-v4-flash',
    youdaoAppKey: '',
    youdaoAppSecret: '',
    youdaoLLMModel: '3',
    baiduAppId: '',
    baiduSecretKey: '',
    baiduLLMApiKey: '',
    targetLanguage: 'zh',
    uiLanguage: 'auto',
    theme: 'light',
    autoSaveSettings: true,
    hoverParagraphTranslation: false,
    toolbarPosition: 'above',
    existingBilingualStrategy: 'skip',
    historyLimit: 50,
    saveHistory: true,
    activeMode: null,
    ...overrides
  };
}

// Pre-fill hidden API key inputs with saved values.
// This is critical: when popup opens, only the active engine's inputs are visible.
// Hidden inputs still hold their values in DOM, but on fresh popup load they are empty.
// If force-save fires before settings panel is opened, it would read empty strings
// from hidden inputs and overwrite storage. This function prevents that.
function prefillHiddenInputs(settings) {
  const fields = [
    { id: 'popup-siliconflow-key', key: 'siliconflowApiKey' },
    { id: 'popup-siliconflow-model', key: 'siliconflowModel' },
    { id: 'popup-bailian-key', key: 'bailianApiKey' },
    { id: 'popup-bailian-host', key: 'bailianApiHost' },
    { id: 'popup-bailian-model', key: 'bailianModel' },
    { id: 'popup-microsoft-key', key: 'microsoftApiKey' },
    { id: 'popup-gemini-key', key: 'geminiApiKey' },
    { id: 'popup-gemini-model', key: 'geminiModel' },
    { id: 'popup-deepseek-key', key: 'deepseekApiKey' },
    { id: 'popup-deepseek-model', key: 'deepseekModel' },
    { id: 'popup-baidu-app-id', key: 'baiduAppId' },
    { id: 'popup-baidu-secret-key', key: 'baiduSecretKey' },
    { id: 'popup-baidullm-ak', key: 'baiduLLMApiKey' },
    { id: 'popup-custom-key', key: 'customApiKey' },
    { id: 'popup-custom-host', key: 'customApiHost' },
    { id: 'popup-custom-model', key: 'customModel' },
    { id: 'popup-youdao-app-key', key: 'youdaoAppKey' },
    { id: 'popup-youdao-app-secret', key: 'youdaoAppSecret' },
    { id: 'popup-youdao-llm-model', key: 'youdaoLLMModel' }
  ];
  fields.forEach(({ id, key }) => {
    const el = document.getElementById(id);
    if (el && settings[key] !== undefined) {
      if (el.type === 'checkbox') {
        el.checked = !!settings[key];
      } else {
        el.value = settings[key] || '';
      }
    }
  });
}

function renderHistoryPanel() {
  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  const clearButton = document.getElementById('history-clear-btn');
  if (!list || !empty) return;

  const items = panelState.history.filter(item => matchesPanelQuery(item, panelState.historyQuery));
  if (clearButton) {
    clearButton.disabled = !panelState.historyEnabled || panelState.history.length === 0;
  }

  list.textContent = '';
  empty.hidden = items.length > 0;
  list.hidden = items.length === 0;

  if (!panelState.historyEnabled && items.length === 0) {
    const title = empty.querySelector('strong');
    const hint = empty.querySelector('span');
    if (title) title.textContent = getMessage('history_disabled_title');
    if (hint) hint.textContent = getMessage('history_disabled_hint');
  } else if (items.length === 0) {
    const title = empty.querySelector('strong');
    const hint = empty.querySelector('span');
    if (title) title.textContent = getMessage('no_history');
    if (hint) hint.textContent = getMessage('history_hint');
  }

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
  translation.textContent = getPanelTranslationText(item);

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
  if (translation.textContent) row.appendChild(translation);
  row.appendChild(meta);
  return row;
}

function getPanelTranslationText(item) {
  if (item.dictionary && Array.isArray(item.dictionary.meanings) && item.dictionary.meanings.length) {
    const first = item.dictionary.meanings[0];
    const pos = first.partOfSpeech ? `${first.partOfSpeech}. ` : '';
    return `${pos}${first.definition || item.dictionary.translation || item.translation || ''}`.trim();
  }
  if (item.dictionary && item.dictionary.translation) return item.dictionary.translation;
  return item.translation || '';
}

function matchesPanelQuery(item, query) {
  if (!query) return true;
  const dictionaryText = item.dictionary
    ? `${item.dictionary.translation || ''} ${(item.dictionary.meanings || []).map(item => item.definition || '').join(' ')}`
    : '';
  const paragraphText = Array.isArray(item.paragraphs)
    ? item.paragraphs.map(part => `${part.text || ''} ${part.translation || ''}`).join(' ')
    : '';
  const text = `${item.text || ''} ${item.translation || ''} ${paragraphText} ${dictionaryText} ${item.sourceUrl || ''}`.toLowerCase();
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
  const text = Array.isArray(item.paragraphs) && item.paragraphs.length
    ? [
        item.paragraphs.map(part => part.text || '').filter(Boolean).join('\n\n'),
        item.paragraphs.map(part => part.translation || '').filter(Boolean).join('\n\n')
      ].filter(Boolean).join('\n\n')
    : [item.text, item.translation].filter(Boolean).join('\n');
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
        if (options.silent) {
          if (callback) callback(null);
          return;
        }
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
    target: { tabId, allFrames: true },
    files: ['js/i18n.js', 'js/content.js']
  }, () => {
    if (chrome.runtime.lastError) {
      console.error('LingoFlow Popup: Script injection failed:', chrome.runtime.lastError.message);

      // If file injection fails, try injecting a minimal inline script as last resort
      // This creates a bare-bones message handler that can respond to our actions
      console.log('LingoFlow Popup: Trying inline injection fallback...');
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: createInlineHandler,
        args: [message]
      }, (result2) => {
        if (chrome.runtime.lastError) {
          console.error('LingoFlow Popup: Inline injection also failed:', chrome.runtime.lastError.message);
          if (!options.silent) showStatus(getMessage('error_cannot_access'), 'error');
          if (callback) callback(null);
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
        if (callback) callback(null);
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
      '.lingoflow-block{max-width:100%!important;min-width:0!important;width:auto!important;text-align:left;color:inherit;background:transparent;box-sizing:border-box!important;overflow-wrap:anywhere!important;word-break:break-word!important}',
      '.lingoflow-block-external{display:block;width:100%}',
      '.lingoflow-block-internal{display:block;margin:0;padding:0}',
      '.lingoflow-original,.lingoflow-translation{display:block;max-width:100%!important;min-width:0!important;width:auto!important;margin:0;padding:0;text-align:left;background:transparent;box-sizing:border-box!important;overflow-wrap:anywhere!important;word-break:break-word!important}',
      '.lingoflow-original{color:inherit;font:inherit;line-height:inherit}',
      '.lingoflow-original>:first-child{margin-top:0!important}',
      '.lingoflow-original>:last-child{margin-bottom:0!important}',
      '.lingoflow-translation{color:inherit;font:inherit;font-size:inherit;font-style:inherit;font-weight:inherit;letter-spacing:inherit;line-height:inherit;text-align:inherit;margin-top:.18em!important;max-height:none!important;overflow:visible!important;display:block!important}',
      '.lingoflow-translation-only{display:block;max-width:100%!important;min-width:0!important;width:auto!important;color:inherit;background:transparent;font:inherit;font-size:inherit;font-style:inherit;font-weight:inherit;letter-spacing:inherit;line-height:inherit;text-align:inherit;box-sizing:border-box!important;overflow-wrap:anywhere!important;word-break:break-word!important;overflow:visible!important}'
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
    return runTranslation('bilingual');
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

// ======================== Backup & Restore (full data) ========================

function initBackup() {
  const exportBtn = document.getElementById('popup-export-data');
  const importBtn = document.getElementById('popup-import-data');
  if (exportBtn) exportBtn.addEventListener('click', exportAllData);
  if (importBtn) importBtn.addEventListener('click', triggerImportData);
}

function exportAllData() {
  chrome.storage.local.get(
    ['lingoflow_settings', 'lingoflow_history', 'lingoflow_vocabulary'],
    (result) => {
      const payload = {
        app: 'LingoFlow',
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        settings: result.lingoflow_settings || null,
        history: result.lingoflow_history || [],
        vocabulary: result.lingoflow_vocabulary || []
      };
      const json = JSON.stringify(payload, null, 2);
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = 'lingoflow-backup-' + stamp + '.json';
      const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
      fallbackDownload(url, filename);
      showStatus(getMessage('export_success'), 'success');
    }
  );
}

let _importFileInput = null;
function triggerImportData() {
  if (!_importFileInput) {
    _importFileInput = document.createElement('input');
    _importFileInput.type = 'file';
    _importFileInput.accept = 'application/json,.json';
    _importFileInput.style.display = 'none';
    _importFileInput.addEventListener('change', onImportFileSelected);
    document.body.appendChild(_importFileInput);
  }
  _importFileInput.value = '';
  _importFileInput.click();
}

function onImportFileSelected(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch (_) {
      showStatus(getMessage('import_invalid'), 'error');
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      showStatus(getMessage('import_invalid'), 'error');
      return;
    }
    // Accept both wrapped shape {settings,history,vocabulary} and flat lingoflow_* shape
    const hasWrapped = ('settings' in parsed) || ('history' in parsed) || ('vocabulary' in parsed);
    const hasFlat = ('lingoflow_settings' in parsed) || ('lingoflow_history' in parsed) || ('lingoflow_vocabulary' in parsed);
    if (!hasWrapped && !hasFlat) {
      showStatus(getMessage('import_invalid'), 'error');
      return;
    }
    if (!confirm(getMessage('import_confirm'))) return;

    const settings = parsed.settings !== undefined ? parsed.settings : parsed.lingoflow_settings;
    const history = parsed.history !== undefined ? parsed.history : parsed.lingoflow_history;
    const vocabulary = parsed.vocabulary !== undefined ? parsed.vocabulary : parsed.lingoflow_vocabulary;

    const toSet = {};
    if (settings !== undefined && settings !== null) toSet.lingoflow_settings = settings;
    if (Array.isArray(history)) toSet.lingoflow_history = history;
    if (Array.isArray(vocabulary)) toSet.lingoflow_vocabulary = vocabulary;

    chrome.storage.local.set(toSet, () => {
      if (chrome.runtime.lastError) {
        showStatus(getMessage('import_failed'), 'error');
        return;
      }
      chrome.storage.local.get(
        ['lingoflow_settings', 'lingoflow_history', 'lingoflow_vocabulary'],
        (res) => {
          const s = res.lingoflow_settings || {};
          panelState.history = (res.lingoflow_history || []).slice();
          panelState.vocabulary = (res.lingoflow_vocabulary || []).slice();
          panelState.savedSettings = cloneSettings(s);
          applyPopupSettings(s);
          if (typeof setLanguage === 'function') {
            Promise.resolve(setLanguage(s.uiLanguage || 'auto')).then(() => {
              syncEngineSelect(document.getElementById('popup-translation-engine')?.value || 'google');
              syncSiliconFlowModelSelect(document.getElementById('popup-siliconflow-model')?.value || 'tencent/Hunyuan-MT-7B');
              syncPanelCustomSelects();
              updateSettingsFooter();
            });
          }
          setSettingsDirty(false);
          const historyPanel = document.getElementById('history-panel');
          const vocabPanel = document.getElementById('vocabulary-panel');
          if (historyPanel && !historyPanel.hidden) renderHistoryPanel();
          if (vocabPanel && !vocabPanel.hidden) renderVocabularyPanel();
          showStatus(getMessage('import_success'), 'success');
        }
      );
    });
  };
  reader.onerror = () => showStatus(getMessage('import_failed'), 'error');
  reader.readAsText(file);
}

function fallbackDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    if (a.parentNode) document.body.removeChild(a);
  }, 1000);
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
