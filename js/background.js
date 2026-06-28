// LingoFlow Background Script
// Handles context menus, extension initialization, and message passing

// Initialize context menus when extension is installed
chrome.runtime.onInstalled.addListener(() => {
  console.log('LingoFlow: Extension installed');

  // Create context menu items
  chrome.contextMenus.create({
    id: 'lingoflow-translate',
    title: chrome.i18n.getMessage('translate_selection') || 'Translate Selection',
    contexts: ['selection']
  });

  chrome.contextMenus.create({
    id: 'lingoflow-save',
    title: chrome.i18n.getMessage('save_to_vocabulary') || 'Save to Vocabulary',
    contexts: ['selection']
  });

  chrome.contextMenus.create({
    id: 'lingoflow-copy',
    title: chrome.i18n.getMessage('copy_text') || 'Copy Text',
    contexts: ['selection']
  });

  // Initialize default settings
  chrome.storage.local.get(['lingoflow_settings'], (result) => {
    if (!result.lingoflow_settings) {
      chrome.storage.local.set({
        lingoflow_settings: {
          translationEngine: 'google',
          targetLanguage: 'zh',
          uiLanguage: 'auto',
          theme: 'light',
          bilingualMode: false,
          hoverTranslation: true,
          existingBilingualStrategy: 'skip',
          historyLimit: 50
        }
      });
    }
  });

  // Initialize empty vocabulary and history
  chrome.storage.local.get(['lingoflow_vocabulary'], (result) => {
    if (!result.lingoflow_vocabulary) {
      chrome.storage.local.set({ lingoflow_vocabulary: [] });
    }
  });

  chrome.storage.local.get(['lingoflow_history'], (result) => {
    if (!result.lingoflow_history) {
      chrome.storage.local.set({ lingoflow_history: [] });
    }
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;

  switch (info.menuItemId) {
    case 'lingoflow-translate':
      chrome.tabs.sendMessage(tab.id, {
        action: 'translate_selection',
        text: info.selectionText
      });
      break;

    case 'lingoflow-save':
      chrome.tabs.sendMessage(tab.id, {
        action: 'save_selection',
        text: info.selectionText
      });
      break;

    case 'lingoflow-copy':
      // Copy is handled by browser naturally
      break;
  }
});

// Listen for messages from content script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'translate':
      translateText(request.text, request.targetLang, sendResponse);
      return true; // Keep channel open for async response

    case 'save_to_vocabulary':
      saveToVocabulary(request.data);
      break;

    case 'add_to_history':
      addToHistory(request.data);
      break;

    case 'get_vocabulary':
      getVocabulary(sendResponse);
      return true; // Keep channel open for async response

    case 'get_history':
      getHistory(sendResponse);
      return true;

    case 'delete_vocabulary_item':
      deleteVocabularyItem(request.id, sendResponse);
      return true;

    case 'delete_history_item':
      deleteHistoryItem(request.id, sendResponse);
      return true;

    case 'clear_history':
      clearHistory(sendResponse);
      return true;

    case 'export_vocabulary':
      exportVocabulary(request.format, sendResponse);
      return true;

    case 'get_settings':
      getSettings(sendResponse);
      return true;

    case 'update_settings':
      updateSettings(request.settings, sendResponse);
      return true;
  }
});

// Vocabulary management
function saveToVocabulary(data) {
  chrome.storage.local.get(['lingoflow_vocabulary'], (result) => {
    const vocabulary = result.lingoflow_vocabulary || [];

    // Check for duplicates
    const exists = vocabulary.some(item => item.text === data.text);
    if (exists) return;

    vocabulary.push({
      id: generateId(),
      text: data.text,
      translation: data.translation || '',
      type: data.type || 'word',
      sourceUrl: data.sourceUrl || '',
      createdAt: Date.now()
    });

    chrome.storage.local.set({ lingoflow_vocabulary: vocabulary });
  });
}

function getVocabulary(sendResponse) {
  chrome.storage.local.get(['lingoflow_vocabulary'], (result) => {
    sendResponse({ vocabulary: result.lingoflow_vocabulary || [] });
  });
}

function deleteVocabularyItem(id, sendResponse) {
  chrome.storage.local.get(['lingoflow_vocabulary'], (result) => {
    const vocabulary = result.lingoflow_vocabulary || [];
    const filtered = vocabulary.filter(item => item.id !== id);
    chrome.storage.local.set({ lingoflow_vocabulary: filtered }, () => {
      sendResponse({ success: true });
    });
  });
}

// History management
function addToHistory(data) {
  chrome.storage.local.get(['lingoflow_history', 'lingoflow_settings'], (result) => {
    const history = result.lingoflow_history || [];
    const limit = (result.lingoflow_settings && result.lingoflow_settings.historyLimit) || 50;

    history.unshift({
      id: generateId(),
      text: data.text,
      translation: data.translation || '',
      sourceUrl: data.sourceUrl || '',
      createdAt: Date.now()
    });

    // Keep only the latest N items
    if (history.length > limit) {
      history.splice(limit);
    }

    chrome.storage.local.set({ lingoflow_history: history });
  });
}

function getHistory(sendResponse) {
  chrome.storage.local.get(['lingoflow_history'], (result) => {
    sendResponse({ history: result.lingoflow_history || [] });
  });
}

function deleteHistoryItem(id, sendResponse) {
  chrome.storage.local.get(['lingoflow_history'], (result) => {
    const history = result.lingoflow_history || [];
    const filtered = history.filter(item => item.id !== id);
    chrome.storage.local.set({ lingoflow_history: filtered }, () => {
      sendResponse({ success: true });
    });
  });
}

function clearHistory(sendResponse) {
  chrome.storage.local.set({ lingoflow_history: [] }, () => {
    sendResponse({ success: true });
  });
}

// Export vocabulary
function exportVocabulary(format, sendResponse) {
  chrome.storage.local.get(['lingoflow_vocabulary'], (result) => {
    const vocabulary = result.lingoflow_vocabulary || [];

    if (format === 'csv') {
      const csv = convertToCSV(vocabulary);
      sendResponse({ data: csv, type: 'csv' });
    } else {
      const json = JSON.stringify(vocabulary, null, 2);
      sendResponse({ data: json, type: 'json' });
    }
  });
}

function convertToCSV(data) {
  const headers = ['Text', 'Translation', 'Type', 'Source URL', 'Created At'];
  const rows = data.map(item => [
    `"${item.text}"`,
    `"${item.translation}"`,
    item.type,
    item.sourceUrl,
    new Date(item.createdAt).toISOString()
  ]);

  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}

// Settings management
function getSettings(sendResponse) {
  chrome.storage.local.get(['lingoflow_settings'], (result) => {
    sendResponse({
      settings: getDefaultSettings(result.lingoflow_settings)
    });
  });
}

function updateSettings(settings, sendResponse) {
  chrome.storage.local.get(['lingoflow_settings'], (result) => {
    const merged = getDefaultSettings({
      ...(result.lingoflow_settings || {}),
      ...(settings || {})
    });

    chrome.storage.local.set({ lingoflow_settings: merged }, () => {
      sendResponse({ success: true });
    });
  });
}

function getDefaultSettings(overrides = {}) {
  return {
    translationEngine: 'google',
    targetLanguage: 'zh',
    uiLanguage: 'auto',
    theme: 'light',
    bilingualMode: false,
    hoverTranslation: true,
    existingBilingualStrategy: 'skip',
    historyLimit: 50,
    ...overrides
  };
}

// Utility functions
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Translation dispatcher — routes to the selected engine
function translateText(text, targetLang, sendResponse) {
  // Read engine preference from settings
  chrome.storage.local.get(['lingoflow_settings'], (result) => {
    const engine = (result.lingoflow_settings && result.lingoflow_settings.translationEngine) || 'google';
    if (engine === 'libretranslate') {
      translateWithLibreTranslate(text, targetLang, sendResponse);
    } else {
      translateWithGoogle(text, targetLang, sendResponse);
    }
  });
}

// MyMemory Translation API (free, no registration required)
function translateWithLibreTranslate(text, targetLang, sendResponse) {
  const tl = targetLang === 'zh' ? 'zh-CN' :
             targetLang === 'en' ? 'en' : 'zh-CN';

  const maxLen = 2000;
  const truncated = text.length > maxLen ? text.substring(0, maxLen) : text;

  // MyMemory does NOT support 'auto' as source; use 'en' for English-to-Chinese scenarios
  // For Chinese-to-English, use 'zh-CN'
  const srcLang = tl.startsWith('zh') ? 'en' : 'zh-CN';
  const url = `https://api.mymemory.translated.net/get?${new URLSearchParams({ q: truncated, langpair: `${srcLang}|${tl}` })}`;

  console.log('LingoFlow: MyMemory translating', truncated.length, 'chars from', srcLang, 'to', tl);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn('LingoFlow: MyMemory request timed out after 8s');
    controller.abort();
  }, 8000);

  fetch(url, { signal: controller.signal })
    .then(response => {
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    })
    .then(data => {
      if (data && data.responseStatus === 200 && data.responseData) {
        const translatedText = data.responseData.translatedText;
        if (!translatedText) {
          console.warn('LingoFlow: MyMemory returned empty text');
          translateWithGoogle(text, targetLang, sendResponse);
          return;
        }
        // MyMemory sometimes returns original text unchanged when it can't translate
        if (translatedText.trim() === truncated.trim()) {
          console.warn('LingoFlow: MyMemory returned same text as input, falling back to Google');
          translateWithGoogle(text, targetLang, sendResponse);
          return;
        }
        console.log('LingoFlow: MyMemory succeeded, result length:', translatedText.length);
        sendResponse({ success: true, translation: translatedText });
      } else {
        const errMsg = data ? (data.responseDetails || JSON.stringify(data)) : 'Invalid response';
        console.warn('LingoFlow: MyMemory error response:', errMsg);
        translateWithGoogle(text, targetLang, sendResponse);
      }
    })
    .catch(error => {
      clearTimeout(timeoutId);
      const message = error && error.message ? error.message : String(error);
      console.warn('LingoFlow: MyMemory error:', message);
      console.log('LingoFlow: Falling back to Google Translate');
      translateWithGoogle(text, targetLang, sendResponse);
    });
}

// Google Translate (non-official free endpoint)
function translateWithGoogle(text, targetLang, sendResponse) {
  const tl = targetLang === 'zh' ? 'zh-CN' :
             targetLang === 'en' ? 'en' : 'zh-CN';

  const maxLen = 2000;
  const truncated = text.length > maxLen ? text.substring(0, maxLen) : text;

  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(truncated)}`;

  console.log('LingoFlow: Google Translate translating', truncated.length, 'chars to', tl);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn('LingoFlow: Google Translate request timed out after 5s');
    controller.abort();
  }, 5000);

  fetch(url, { signal: controller.signal })
    .then(response => {
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    })
    .then(data => {
      if (data && data[0] && Array.isArray(data[0])) {
        const translation = data[0].map(segment => segment[0]).join('');
        if (translation) {
          console.log('LingoFlow: Google Translate succeeded, result length:', translation.length);
          sendResponse({ success: true, translation: translation });
        } else {
          sendResponse({ success: false, error: 'Empty translation' });
        }
      } else {
        sendResponse({ success: false, error: 'Invalid response format' });
      }
    })
    .catch(error => {
      clearTimeout(timeoutId);
      const message = error && error.message ? error.message : String(error);
      console.warn('LingoFlow: Google Translate error:', message);
      sendResponse({ success: false, error: message });
    });
}
