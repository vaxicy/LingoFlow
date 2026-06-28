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
          siliconflowApiKey: '',
          siliconflowModel: 'tencent/Hunyuan-MT-7B',
          targetLanguage: 'zh',
          uiLanguage: 'auto',
          theme: 'light',
          bilingualMode: false,
          hoverTranslation: true,
          existingBilingualStrategy: 'skip',
          historyLimit: 50,
          activeMode: null
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
    activeMode: null,
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
    if (engine === 'siliconflow') {
      translateWithSiliconFlow(text, targetLang, sendResponse);
    } else if (engine === 'mymemory') {
      translateWithMyMemory(text, targetLang, sendResponse);
    } else {
      translateWithGoogle(text, targetLang, sendResponse);
    }
  });
}

// SiliconFlow free models - auto fallback in order
// Priority: verified working models first, then untested ones as backup
const SILICONFLOW_FREE_MODELS = [
  'tencent/Hunyuan-MT-7B',          // ✅ Verified working - dedicated MT model, fast & reliable
  'Qwen/Qwen2.5-7B-Instruct',
  'THUDM/GLM-4-9B-0414'
];

// SiliconFlow AI Translation (free tier, requires API key)
// Tries user-selected model first, then falls back through remaining models, then Google
function translateWithSiliconFlow(text, targetLang, sendResponse) {
  const tl = targetLang === 'zh' ? '中文' :
             targetLang === 'en' ? 'English' : '中文';

  // Overall safety timeout: force fallback to Google after this
  const overallTimeoutMs = 30000; // 30 seconds total max
  let overallTimer = setTimeout(() => {
    console.warn('LingoFlow: SiliconFlow overall timeout, falling back to Google');
    translateWithGoogle(text, targetLang, sendResponse);
  }, overallTimeoutMs);
  let responseSent = false;

  function done(result) {
    if (responseSent) return;
    responseSent = true;
    clearTimeout(overallTimer);
    if (result !== undefined) {
      sendResponse({ success: true, translation: result });
    }
  }

  chrome.storage.local.get(['lingoflow_settings'], (result) => {
    const settings = result.lingoflow_settings || {};
    const apiKey = settings.siliconflowApiKey || '';
    const selectedModel = settings.siliconflowModel || 'tencent/Hunyuan-MT-7B';

    if (!apiKey) {
      done();
      console.warn('LingoFlow: SiliconFlow API key not set, falling back to Google');
      translateWithGoogle(text, targetLang, sendResponse);
      return;
    }

    const maxLen = 2000;
    const truncated = text.length > maxLen ? text.substring(0, maxLen) : text;

    // Build fallback list: selected model first, then others (excluding selected)
    const fallbackModels = [selectedModel];
    SILICONFLOW_FREE_MODELS.forEach(m => { if (m !== selectedModel) fallbackModels.push(m); });

    tryNextModel(0);

    function tryNextModel(index) {
      if (responseSent) return; // already handled

      if (index >= fallbackModels.length) {
        done();
        console.warn('LingoFlow: All SiliconFlow models failed, falling back to Google');
        translateWithGoogle(text, targetLang, sendResponse);
        return;
      }

      const model = fallbackModels[index];
      const isPrimary = index === 0;
      const url = 'https://api.siliconflow.cn/v1/chat/completions';
      const body = {
        model: model,
        messages: [
          { role: 'system', content: `You are a professional translator. Translate the following text to ${tl}. Only output the translated text, no explanations, no notes.` },
          { role: 'user', content: truncated }
        ],
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: Math.min(truncated.length * 4, 2000)
      };

      const label = isPrimary ? `[primary] ${model}` : `[${index}/${fallbackModels.length-1}] ${model}`;
      console.log(`LingoFlow: SiliconFlow trying ${label}`);

      const controller = new AbortController();
      // Primary model gets more time (15s), backup models get less (6s)
      const timeoutMs = isPrimary ? 15000 : 6000;
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
        .then(response => {
          clearTimeout(timeoutId);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        })
        .then(data => {
          if (responseSent) return;
          clearTimeout(timeoutId);
          if (data && data.choices && data.choices[0] && data.choices[0].message) {
            const translatedText = data.choices[0].message.content.trim();
            if (translatedText.length === 0) {
              console.warn(`LingoFlow: SiliconFlow ${model} returned empty, trying next...`);
              tryNextModel(index + 1);
              return;
            }
            console.log(`LingoFlow: SiliconFlow ${label} succeeded (${translatedText.length} chars)`);
            done(translatedText);
          } else {
            console.warn(`LingoFlow: SiliconFlow ${model} invalid response, trying next...`);
            tryNextModel(index + 1);
          }
        })
        .catch(error => {
          clearTimeout(timeoutId);
          if (responseSent) return;
          const msg = error && error.message ? error.message : String(error);
          console.warn(`LingoFlow: SiliconFlow ${model}: ${msg}, trying next...`);
          tryNextModel(index + 1);
        });
    }
  });
}

// MyMemory Translation (free, no API key required)
// Docs: https://mymemory.translated.net/doc/spec.php
function translateWithMyMemory(text, targetLang, sendResponse) {
  // MyMemory does NOT support 'auto' as source language.
  // We infer source from the target: if target is 'zh' we assume source is 'en',
  // and vice-versa. This covers the two most common LingoFlow use-cases.
  const src = targetLang === 'zh' ? 'en' : 'zh-CN';
  const tgt = targetLang === 'zh' ? 'zh-CN' : 'en';

  const maxLen = 500; // MyMemory free tier is limited to ~500 chars per request
  const truncated = text.length > maxLen ? text.substring(0, maxLen) : text;

  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(truncated)}&langpair=${encodeURIComponent(src)}|${encodeURIComponent(tgt)}`;

  console.log('LingoFlow: MyMemory translating', truncated.length, 'chars', src, '->', tgt);

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
      if (data && data.responseStatus === 200 && data.responseData && data.responseData.translatedText) {
        const translatedText = data.responseData.translatedText;
        console.log('LingoFlow: MyMemory succeeded, result length:', translatedText.length);
        sendResponse({ success: true, translation: translatedText });
      } else {
        const msg = (data && data.responseStatus) ? `MyMemory error ${data.responseStatus}` : 'Invalid response';
        console.warn('LingoFlow: MyMemory failed:', msg);
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
