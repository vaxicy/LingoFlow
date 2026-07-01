// LingoFlow Background Script
// Handles context menus, extension initialization, and message passing

// Broadcast settings changes to all content scripts (handles direct storage writes too)
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace !== 'local' || !changes.lingoflow_settings) return;
  const settings = changes.lingoflow_settings.newValue;
  if (!settings) return;
  chrome.tabs.query({}, (tabs) => {
    (tabs || []).forEach(tab => {
      try {
        chrome.tabs.sendMessage(tab.id, { action: 'sync_settings', settings }).catch(() => {});
      } catch (_) {}
    });
  });
});

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    // Create multiple items without parentId — Chrome MV3 will automatically
    // group them under a parent menu named after the extension.
    // Child items will NOT have the "ExtensionName:" prefix.
    chrome.contextMenus.create({
      id: 'lingoflow-translate',
      title: chrome.i18n.getMessage('translate_selection') || 'Translate',
      contexts: ['selection']
    });

    chrome.contextMenus.create({
      id: 'lingoflow-save',
      title: chrome.i18n.getMessage('save_to_vocabulary') || 'Save',
      contexts: ['selection']
    });
  });
}

chrome.runtime.onStartup.addListener(setupContextMenus);

// Initialize context menus when extension is installed
chrome.runtime.onInstalled.addListener(() => {
  console.log('LingoFlow: Extension installed');
  setupContextMenus();

  // Initialize default settings
  chrome.storage.local.get(['lingoflow_settings'], (result) => {
    if (!result.lingoflow_settings) {
        chrome.storage.local.set({
          lingoflow_settings: {
            translationEngine: 'google',
            siliconflowApiKey: '',
            siliconflowModel: 'tencent/Hunyuan-MT-7B',
            microsoftApiKey: '',
            geminiApiKey: '',
            geminiModel: 'gemini-3.1-flash-lite',
            youdaoAppKey: '',
            youdaoAppSecret: '',
            youdaoLLMModel: '3',
            targetLanguage: 'zh',
            uiLanguage: 'auto',
            theme: 'light',
            autoSaveSettings: true,
            hoverParagraphTranslation: false,
            existingBilingualStrategy: 'skip',
            saveHistory: true,
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
  // Skip chrome:// and other restricted URLs where content scripts can't run
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') ||
      tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://')) {
    return;
  }
  const targetOptions = typeof info.frameId === 'number' && info.frameId >= 0
    ? { frameId: info.frameId }
    : undefined;

  switch (info.menuItemId) {
    case 'lingoflow-translate':
      chrome.tabs.sendMessage(tab.id, {
        action: 'translate_selection',
        text: info.selectionText
      }, targetOptions).catch(() => {});
      break;

    case 'lingoflow-save':
      chrome.tabs.sendMessage(tab.id, {
        action: 'save_selection',
        text: info.selectionText
      }, targetOptions).catch(() => {});
      break;
  }
});

// Listen for messages from content script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'translate':
      translateText(request.text, request.targetLang, sendResponse);
      return true; // Keep channel open for async response

    case 'translate_batch':
      translateBatch(request.texts, request.targetLang, sendResponse);
      return true;

    case 'lookup_dictionary':
      lookupDictionary(request.text, request.targetLang, sendResponse);
      return true;

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
      paragraphs: Array.isArray(data.paragraphs) ? data.paragraphs : null,
      dictionary: data.dictionary || null,
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
    const settings = result.lingoflow_settings || {};
    // Honor saveHistory toggle — when disabled, silently skip recording
    if (settings.saveHistory === false) return;

    const history = result.lingoflow_history || [];
    const limit = settings.historyLimit || 50;

    history.unshift({
      id: generateId(),
      text: data.text,
      translation: data.translation || '',
      paragraphs: Array.isArray(data.paragraphs) ? data.paragraphs : null,
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
  chrome.storage.local.get(['lingoflow_history', 'lingoflow_settings'], (result) => {
    const settings = result.lingoflow_settings || {};
    sendResponse({
      history: result.lingoflow_history || [],
      historyEnabled: settings.saveHistory !== false
    });
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
      console.log('LingoFlow: Settings updated', {
        translationEngine: merged.translationEngine,
        geminiModel: merged.geminiModel
      });
      // Broadcast is handled by storage.onChanged listener above (covers all write paths)
      sendResponse({ success: true });
    });
  });
}

function getDefaultSettings(overrides = {}) {
  return {
    translationEngine: 'google',
    geminiApiKey: '',
    geminiModel: 'gemini-3.1-flash-lite',
    youdaoAppKey: '',
    youdaoAppSecret: '',
    targetLanguage: 'zh',
    uiLanguage: 'auto',
    theme: 'light',
    selectionTranslation: true,
    autoSaveSettings: true,
    hoverParagraphTranslation: false,
    saveHistory: true,
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
function lookupDictionary(text, targetLang, sendResponse) {
  const word = String(text || '').trim().replace(/^[^A-Za-z]+|[^A-Za-z'-]+$/g, '');
  if (!/^[A-Za-z][A-Za-z'-]*$/.test(word)) {
    translateText(text, targetLang || 'zh', (response) => {
      sendResponse({
        success: !!(response && response.success),
        result: {
          mode: 'sentence',
          translation: response && response.translation ? response.translation : ''
        },
        error: response && response.error
      });
    });
    return;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`;

  fetch(url, { signal: controller.signal })
    .then(response => {
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(data => {
      const result = normalizeDictionaryResult(word, data);
      if (result && result.translation) {
        translateText(word, targetLang || 'zh', (translationResponse) => {
          if (translationResponse && translationResponse.success && translationResponse.translation) {
            result.translation = translationResponse.translation;
          }
          localizeDictionaryMeanings(result, targetLang || 'zh')
            .then(localized => sendResponse({ success: true, result: localized }))
            .catch(() => sendResponse({ success: true, result }));
        });
        return;
      }
      fallbackDictionaryTranslation(word, targetLang, sendResponse);
    })
    .catch(error => {
      clearTimeout(timeoutId);
      console.warn('LingoFlow: Dictionary lookup failed:', error && error.message ? error.message : String(error));
      fallbackDictionaryTranslation(word, targetLang, sendResponse);
    });
}

function normalizeDictionaryResult(word, data) {
  const entry = Array.isArray(data) && data.length ? data[0] : null;
  if (!entry) return null;

  const phonetic = entry.phonetic ||
    ((entry.phonetics || []).find(item => item && item.text) || {}).text ||
    '';

  const meanings = [];
  (entry.meanings || []).forEach(meaning => {
    const partOfSpeech = meaning.partOfSpeech || '';
    (meaning.definitions || []).slice(0, 2).forEach(definition => {
      if (!definition || !definition.definition) return;
      meanings.push({
        partOfSpeech,
        definition: definition.definition,
        synonyms: Array.isArray(definition.synonyms) ? definition.synonyms.slice(0, 4) : []
      });
    });
  });

  const examples = [];
  (entry.meanings || []).forEach(meaning => {
    (meaning.definitions || []).forEach(definition => {
      if (definition && definition.example && examples.length < 2) examples.push(definition.example);
    });
  });

  const firstDefinition = meanings[0] && meanings[0].definition ? meanings[0].definition : word;
  return {
    mode: 'word',
    translation: firstDefinition,
    phonetic,
    meanings: meanings.slice(0, 4),
    examples
  };
}

function fallbackDictionaryTranslation(word, targetLang, sendResponse) {
  translateText(word, targetLang || 'zh', (response) => {
    const translation = response && response.translation ? response.translation : word;
    sendResponse({
      success: !!(response && response.success),
      result: {
        mode: 'word',
        translation,
        phonetic: '',
        meanings: translation ? [{ partOfSpeech: '', definition: translation, synonyms: [] }] : [],
        examples: []
      },
      error: response && response.error
    });
  });
}

function localizeDictionaryMeanings(result, targetLang) {
  const target = targetLang || 'zh';
  if (target !== 'zh' && target !== 'zh-CN' && target !== 'zh-Hans') {
    return Promise.resolve(result);
  }

  const meanings = Array.isArray(result.meanings) ? result.meanings : [];
  const definitions = meanings.map(item => item.definition || '').filter(Boolean);
  if (!definitions.length) return Promise.resolve(result);

  return translateTextsForDictionary(definitions, target).then(translations => {
    let cursor = 0;
    result.meanings = meanings.map(item => {
      if (!item.definition) return item;
      const translated = translations[cursor++];
      return {
        ...item,
        originalDefinition: item.definition,
        definition: translated && !String(translated).startsWith('[LingoFlow') ? translated : item.definition
      };
    });
    return result;
  });
}

function translateTextsForDictionary(texts, targetLang) {
  return new Promise((resolve) => {
    const list = Array.isArray(texts) ? texts : [];
    if (!list.length) {
      resolve([]);
      return;
    }

    chrome.storage.local.get(['lingoflow_settings'], (result) => {
      const engine = (result.lingoflow_settings && result.lingoflow_settings.translationEngine) || 'google';
      const translations = new Array(list.length);
      let index = 0;

      function next() {
        if (index >= list.length) {
          resolve(translations);
          return;
        }

        const current = index++;
        translateOneForBatch(list[current], targetLang, engine)
          .then(translation => {
            translations[current] = translation;
            next();
          })
          .catch(() => {
            translations[current] = list[current];
            next();
          });
      }

      next();
    });
  });
}

function translateText(text, targetLang, sendResponse) {
  // Read engine preference from settings
  chrome.storage.local.get(['lingoflow_settings'], (result) => {
    const engine = (result.lingoflow_settings && result.lingoflow_settings.translationEngine) || 'google';
    console.log('LingoFlow: Selected translation engine:', engine);
        if (engine === 'siliconflow') {
      translateWithSiliconFlow(text, targetLang, sendResponse);
    } else if (engine === 'microsoft') {
      translateWithMicrosoft(text, targetLang, sendResponse);
    } else if (engine === 'gemini') {
      translateWithGemini(text, targetLang, sendResponse);
    } else if (engine === 'mymemory') {
      translateWithMyMemory(text, targetLang, sendResponse);
    } else if (engine === 'youdao') {
      translateWithYoudao(text, targetLang, sendResponse);
    } else if (engine === 'youdaollm') {
      translateWithYoudaoLLM(text, targetLang, sendResponse);
    } else {
      translateWithGoogle(text, targetLang, sendResponse);
    }
  });
}

function translateBatch(texts, targetLang, sendResponse) {
  const list = Array.isArray(texts) ? texts.filter(text => typeof text === 'string' && text.trim()) : [];
  if (!list.length) {
    sendResponse({ success: true, translations: [] });
    return;
  }

  chrome.storage.local.get(['lingoflow_settings'], (result) => {
    const engine = (result.lingoflow_settings && result.lingoflow_settings.translationEngine) || 'google';
    console.log('LingoFlow: Selected batch translation engine:', engine, `(${list.length} items)`);

    if (engine === 'gemini') {
      translateBatchWithGemini(list, targetLang, sendResponse);
      return;
    }

    if (engine === 'siliconflow') {
      translateBatchWithSiliconFlow(list, targetLang, sendResponse);
      return;
    }

    if (engine === 'youdao') {
      translateBatchWithYoudao(list, targetLang, sendResponse);
      return;
    }

    if (engine === 'youdaollm') {
      translateBatchWithYoudaoLLM(list, targetLang, sendResponse);
      return;
    }

    const translations = new Array(list.length);
    const concurrency = 3;
    let cursor = 0;
    let active = 0;
    let finished = 0;

    function runNext() {
      while (active < concurrency && cursor < list.length) {
        const index = cursor++;
        active++;

        translateOneForBatch(list[index], targetLang, engine)
          .then(translation => {
            translations[index] = translation;
          })
          .catch(error => {
            const message = error && error.message ? error.message : String(error);
            console.warn('LingoFlow: Batch translation item failed:', message);
            translations[index] = `[LingoFlow translation failed] ${list[index]}`;
          })
          .finally(() => {
            active--;
            finished++;

            if (finished === list.length) {
              sendResponse({ success: true, translations });
              return;
            }

            runNext();
          });
      }
    }

    runNext();
  });
}

function translateOneForBatch(text, targetLang, engine) {
  return new Promise((resolve) => {
    const respond = (response) => {
      if (response && response.success && response.translation) {
        resolve(response.translation);
      } else {
        resolve(`[LingoFlow translation failed] ${text}`);
      }
    };

    if (engine === 'siliconflow') {
      translateWithSiliconFlow(text, targetLang, respond);
    } else if (engine === 'microsoft') {
      translateWithMicrosoft(text, targetLang, respond);
    } else if (engine === 'gemini') {
      translateWithGemini(text, targetLang, respond);
    } else if (engine === 'mymemory') {
      translateWithMyMemory(text, targetLang, respond);
    } else {
      translateWithGoogle(text, targetLang, respond);
    }
  });
}

// SiliconFlow models - auto fallback in order
// Priority: verified working models first, then untested ones as backup
const SILICONFLOW_FALLBACK_MODELS = [
  'tencent/Hunyuan-MT-7B',          // ✅ Verified working - dedicated MT model, fast & reliable
  'MiniMaxAI/MiniMax-M2.5',
  'deepseek-ai/DeepSeek-V4-Flash',   // ✅ Fast, cheap, good quality
  'Pro/deepseek-ai/DeepSeek-V3.2',
  'deepseek-ai/DeepSeek-V3'
];

const SILICONFLOW_MODEL_META = {
  'tencent/Hunyuan-MT-7B':        { pricing: 'free', maxItems: 70, maxChars: 20000, chunkDelay: 50 },
  'MiniMaxAI/MiniMax-M2.5':       { pricing: 'paid', maxItems: 70, maxChars: 24000, chunkDelay: 60 },
  'deepseek-ai/DeepSeek-V4-Flash': { pricing: 'paid', maxItems: 80, maxChars: 24000, chunkDelay: 40 },
  'Pro/deepseek-ai/DeepSeek-V3.2': { pricing: 'paid', maxItems: 70, maxChars: 22000, chunkDelay: 60 },
  'deepseek-ai/DeepSeek-V3':       { pricing: 'paid', maxItems: 70, maxChars: 20000, chunkDelay: 60 }
};

const translationMemory = new Map();
const TRANSLATION_MEMORY_LIMIT = 800;

function getTranslationCacheKey(engine, model, targetLang, text) {
  return [engine, model || '', targetLang || '', String(text || '').trim()].join('\u0001');
}

function getCachedTranslation(engine, model, targetLang, text) {
  return translationMemory.get(getTranslationCacheKey(engine, model, targetLang, text));
}

function setCachedTranslation(engine, model, targetLang, text, translation) {
  if (!translation || String(translation).startsWith('[LingoFlow')) return;
  const key = getTranslationCacheKey(engine, model, targetLang, text);
  if (translationMemory.has(key)) translationMemory.delete(key);
  translationMemory.set(key, translation);
  if (translationMemory.size > TRANSLATION_MEMORY_LIMIT) {
    const firstKey = translationMemory.keys().next().value;
    translationMemory.delete(firstKey);
  }
}

function getSiliconFlowFallbackModels(selectedModel) {
  const selected = selectedModel || 'tencent/Hunyuan-MT-7B';
  const selectedMeta = SILICONFLOW_MODEL_META[selected] || {};
  const fallbacks = [selected];

  SILICONFLOW_FALLBACK_MODELS.forEach(model => {
    if (model === selected) return;
    const meta = SILICONFLOW_MODEL_META[model] || {};
    if (selectedMeta.pricing === 'paid' && meta.pricing === 'paid') return;
    fallbacks.push(model);
  });

  return fallbacks;
}

function getSiliconFlowTargetName(targetLang) {
  return targetLang === 'zh' || targetLang === 'zh-CN' ? 'Simplified Chinese' :
         targetLang === 'en' ? 'English' : 'Simplified Chinese';
}

function createSiliconFlowTextChunks(texts, model) {
  const meta = SILICONFLOW_MODEL_META[model] || { maxItems: 18, maxChars: 4200 };
  const chunks = [];
  let current = [];
  let currentChars = 0;

  texts.forEach((text, index) => {
    const value = String(text || '');
    const itemChars = value.length;
    if (current.length && (current.length >= meta.maxItems || currentChars + itemChars > meta.maxChars)) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push({ index, text: value });
    currentChars += itemChars;
  });

  if (current.length) chunks.push(current);
  return chunks;
}

function translateBatchWithSiliconFlow(texts, targetLang, sendResponse) {
  const list = Array.isArray(texts) ? texts : [];
  if (!list.length) {
    sendResponse({ success: true, translations: [] });
    return;
  }

  chrome.storage.local.get(['lingoflow_settings'], (result) => {
    const settings = result.lingoflow_settings || {};
    const apiKey = (settings.siliconflowApiKey || '').trim();
    const selectedModel = settings.siliconflowModel || 'tencent/Hunyuan-MT-7B';

    if (!apiKey) {
      console.warn('LingoFlow: SiliconFlow API key not set for batch, falling back to Google');
      translateBatchWithGoogleFallback(list, targetLang).then(translations => {
        sendResponse({ success: true, translations });
      });
      return;
    }

    const translations = new Array(list.length);
    let pendingCount = 0;

    list.forEach((text, index) => {
      const cached = getCachedTranslation('siliconflow', selectedModel, targetLang, text);
      if (cached) {
        translations[index] = cached;
      } else {
        pendingCount++;
      }
    });

    if (!pendingCount) {
      console.log('LingoFlow: SiliconFlow batch served from cache', list.length, 'items');
      sendResponse({ success: true, translations });
      return;
    }

    const uniquePendingMap = new Map();
    list.forEach((text, index) => {
      if (!translations[index]) {
        const key = String(text || '').trim();
        if (!uniquePendingMap.has(key)) {
          uniquePendingMap.set(key, { text, indexes: [] });
        }
        uniquePendingMap.get(key).indexes.push(index);
      }
    });

    const uniquePending = Array.from(uniquePendingMap.values());
    const compactTexts = uniquePending.map(item => item.text);
    const chunks = createSiliconFlowTextChunks(compactTexts, selectedModel);
    const compactTranslations = new Array(compactTexts.length);
    const fallbackModels = getSiliconFlowFallbackModels(selectedModel);
    console.log('LingoFlow: SiliconFlow batch translating', compactTexts.length, 'unique uncached items in', chunks.length, 'request(s) with', selectedModel);

    runSiliconFlowChunkQueue(chunks, {
      apiKey,
      targetLang,
      selectedModel,
      fallbackModels,
      translations: compactTranslations
    })
      .then(() => {
        uniquePending.forEach((item, offset) => {
          const translated = compactTranslations[offset] || item.text;
          item.indexes.forEach(index => {
            translations[index] = translated;
          });
          setCachedTranslation('siliconflow', selectedModel, targetLang, item.text, translated);
        });
        sendResponse({ success: true, translations: translations.map((item, index) => item || list[index]) });
      })
      .catch(error => {
        const message = error && error.message ? error.message : String(error);
        console.warn('LingoFlow: SiliconFlow batch failed:', message, '- falling back to Google batch');
        translateBatchWithGoogleBatch(list, targetLang).then(fallbackTranslations => {
          sendResponse({ success: true, translations: fallbackTranslations });
        });
      });
  });
}

// Model failure tracker: demote models that fail 2+ times consecutively
const modelFailureTracker = {
  _data: {},           // { [model]: { failures: number, demotedUntil: number } }
  _demotionMs: 5 * 60 * 1000,  // demote for 5 minutes

  recordFailure(model) {
    const entry = this._data[model] || { failures: 0, demotedUntil: 0 };
    entry.failures++;
    if (entry.failures >= 2) {
      entry.demotedUntil = Date.now() + this._demotionMs;
      console.warn(`LingoFlow: Model ${model} demoted for 5 min (${entry.failures} consecutive failures)`);
    }
    this._data[model] = entry;
  },

  recordSuccess(model) {
    if (this._data[model]) {
      this._data[model].failures = 0;
    }
  },

  isDemoted(model) {
    const entry = this._data[model];
    return entry && entry.demotedUntil > Date.now();
  },

  getOrderedModels(models) {
    // Move demoted models to the end
    const active = models.filter(m => !this.isDemoted(m));
    const demoted = models.filter(m => this.isDemoted(m));
    return active.concat(demoted);
  }
};

async function runSiliconFlowChunkQueue(chunks, context) {
  const meta = SILICONFLOW_MODEL_META[context.selectedModel] || { chunkDelay: 80 };
  const CONCURRENCY = Math.min(5, Math.max(3, chunks.length));  // 3-5 concurrent chunk requests
  let nextIndex = 0;
  let activeCount = 0;
  let finishedCount = 0;
  const total = chunks.length;
  const results = context.translations;

  return new Promise((resolve) => {
    function runWorker() {
      while (activeCount < CONCURRENCY && nextIndex < total) {
        const i = nextIndex++;
        const chunk = chunks[i];
        activeCount++;

        // Stagger chunk starts slightly to avoid rate-limit spikes
        const staggerMs = (i % CONCURRENCY) * (meta.chunkDelay || 80);

        setTimeout(() => {
          translateSiliconFlowChunkWithFallbacks(chunk, context.targetLang, context.apiKey, context.fallbackModels)
            .then(result => {
              chunk.forEach((item, offset) => {
                results[item.index] = result[offset] || item.text;
              });
            })
            .catch(error => {
              const message = error && error.message ? error.message : String(error);
              console.warn(`LingoFlow: SiliconFlow chunk ${i + 1}/${total} failed:`, message);

              // Retry strategy: split failed chunk into smaller sub-chunks
              if (chunk.length > 1) {
                const mid = Math.ceil(chunk.length / 2);
                const subChunks = [
                  chunk.slice(0, mid),
                  chunk.slice(mid)
                ].filter(cc => cc.length > 0);
                console.log(`LingoFlow: Retrying chunk ${i + 1} as ${subChunks.length} sub-chunk(s)`);
                return Promise.all(subChunks.map(sub =>
                  translateSiliconFlowChunkWithFallbacks(sub, context.targetLang, context.apiKey, context.fallbackModels)
                    .then(result => {
                      sub.forEach((item, offset) => {
                        results[item.index] = result[offset] || item.text;
                      });
                    })
                    .catch(subErr => {
                      const subMsg = subErr && subErr.message ? subErr.message : String(subErr);
                      console.warn('LingoFlow: Sub-chunk also failed:', subMsg, '- falling back to Google');
                      return translateBatchWithGoogleBatch(sub.map(item => item.text), context.targetLang)
                        .then(fallback => {
                          sub.forEach((item, offset) => {
                            results[item.index] = fallback[offset] || item.text;
                          });
                        });
                    })
                ));
              }

              // Single-item or retry exhausted: fall back to Google
              console.warn(`LingoFlow: Falling back to Google for chunk ${i + 1}/${total}`);
              return translateBatchWithGoogleBatch(chunk.map(item => item.text), context.targetLang)
                .then(fallback => {
                  chunk.forEach((item, offset) => {
                    results[item.index] = fallback[offset] || item.text;
                  });
                });
            })
            .finally(() => {
              activeCount--;
              finishedCount++;
              if (finishedCount === total) {
                resolve();
              } else {
                runWorker(); // start next waiting chunk
              }
            });
        }, staggerMs);
      }
    }
    runWorker();
  });
}

async function translateSiliconFlowChunkWithFallbacks(chunk, targetLang, apiKey, models) {
  const orderedModels = modelFailureTracker.getOrderedModels(models);
  let lastError = null;
  for (let i = 0; i < orderedModels.length; i++) {
    const model = orderedModels[i];
    try {
      const result = await translateSiliconFlowChunk(chunk, targetLang, apiKey, model, 0, i === 0);
      modelFailureTracker.recordSuccess(model);
      return result;
    } catch (error) {
      lastError = error;
      const message = error && error.message ? error.message : String(error);
      console.warn(`LingoFlow: SiliconFlow batch model ${model} failed:`, message);
      modelFailureTracker.recordFailure(model);
    }
  }
  throw lastError || new Error('SiliconFlow batch failed');
}

function translateSiliconFlowChunk(chunk, targetLang, apiKey, model, attempt, isPrimary) {
  const target = getSiliconFlowTargetName(targetLang);
  const payload = chunk.map((item, offset) => ({
    id: offset,
    text: item.text
  }));
  const url = 'https://api.siliconflow.cn/v1/chat/completions';
  const body = {
    model,
    messages: [
      {
        role: 'system',
        content: [
          'You are a professional translation engine.',
          `Translate each text value to ${target}.`,
          'Return ONLY a valid JSON array. No markdown. No explanations.',
          'The output array must have the same length and order as the input array.',
          'Each output item must be a string translation.'
        ].join(' ')
      },
      { role: 'user', content: JSON.stringify(payload) }
    ],
    temperature: 0.1,
    top_p: 0.9,
    max_tokens: Math.min(Math.max(JSON.stringify(payload).length * 2, 512), 8192)
  };

  console.log('LingoFlow: SiliconFlow batch chunk translating', chunk.length, 'items with', model);

  const controller = new AbortController();
  // Timeout: primary gets 30s, fallbacks get 15s (increased for larger chunks)
  const timeoutId = setTimeout(() => controller.abort(), isPrimary ? 30000 : 15000);

  return fetch(url, {
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
      clearTimeout(timeoutId);
      const text = data &&
        data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content
          ? data.choices[0].message.content.trim()
          : '';
      const translations = parseGeminiTranslationArray(text, chunk.length);
      console.log('LingoFlow: SiliconFlow batch chunk succeeded, items:', translations.length);
      return translations;
    })
    .catch(error => {
      clearTimeout(timeoutId);
      const message = error && error.message ? error.message : String(error);
      if (attempt < 1 && /HTTP (429|500|502|503|504)|abort/i.test(message)) {
        console.warn('LingoFlow: SiliconFlow batch chunk retrying after:', message);
        return delay(1400).then(() => translateSiliconFlowChunk(chunk, targetLang, apiKey, model, attempt + 1, isPrimary));
      }
      throw error;
    });
}

// SiliconFlow AI Translation (requires API key; model pricing depends on the selected model)
// Tries user-selected model first, then falls back through remaining models, then Google
function translateWithSiliconFlow(text, targetLang, sendResponse) {
  const tl = getSiliconFlowTargetName(targetLang);

  // Overall safety timeout: force fallback to Google after this
  const overallTimeoutMs = 18000; // 18 seconds total max (was 30s)
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
    const cached = getCachedTranslation('siliconflow', selectedModel, targetLang, text);

    if (cached) {
      sendResponse({ success: true, translation: cached });
      return;
    }

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
    SILICONFLOW_FALLBACK_MODELS.forEach(m => { if (m !== selectedModel) fallbackModels.push(m); });

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
      // Primary model gets more time (8s), backup models get less (3s)
      const timeoutMs = isPrimary ? 8000 : 3000;
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
            setCachedTranslation('siliconflow', selectedModel, targetLang, text, translatedText);
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

// Gemini AI Translation (Google AI Studio API key required)
// Docs: https://ai.google.dev/gemini-api/docs/text-generation
function translateWithGemini(text, targetLang, sendResponse) {
  const target = targetLang === 'zh' ? 'Simplified Chinese' :
                 targetLang === 'en' ? 'English' : 'Simplified Chinese';

  chrome.storage.local.get(['lingoflow_settings'], (result) => {
    const settings = result.lingoflow_settings || {};
    const apiKey = (settings.geminiApiKey || '').trim();
    const model = settings.geminiModel || 'gemini-3.1-flash-lite';

    if (!apiKey) {
      console.warn('LingoFlow: Gemini API key not set, falling back to Google');
      translateWithGoogle(text, targetLang, sendResponse);
      return;
    }

    const maxLen = 6000;
    const truncated = text.length > maxLen ? text.substring(0, maxLen) : text;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `Translate the following text to ${target}. Only output the translated text. Do not add explanations, notes, quotation marks, or markdown.\n\n${truncated}`
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        topP: 0.9,
        maxOutputTokens: Math.min(Math.max(truncated.length * 2, 256), 4096)
      }
    };

    console.log('LingoFlow: Gemini translating', truncated.length, 'chars with', model);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.warn('LingoFlow: Gemini request timed out after 15s');
      controller.abort();
    }, 15000);

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
      .then(response => {
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(data => {
        const parts = data &&
          data.candidates &&
          data.candidates[0] &&
          data.candidates[0].content &&
          Array.isArray(data.candidates[0].content.parts)
            ? data.candidates[0].content.parts
            : [];
        const translatedText = parts
          .map(part => part && part.text ? part.text : '')
          .join('')
          .trim();

        if (translatedText) {
          console.log('LingoFlow: Gemini succeeded, result length:', translatedText.length);
          sendResponse({ success: true, translation: translatedText });
          return;
        }

        console.warn('LingoFlow: Gemini returned empty translation, falling back to Google');
        translateWithGoogle(text, targetLang, sendResponse);
      })
      .catch(error => {
        clearTimeout(timeoutId);
        const message = error && error.message ? error.message : String(error);
        console.warn('LingoFlow: Gemini error:', message, '- falling back to Google');
        translateWithGoogle(text, targetLang, sendResponse);
      });
  });
}

function translateBatchWithGemini(texts, targetLang, sendResponse) {
  const list = Array.isArray(texts) ? texts : [];
  if (!list.length) {
    sendResponse({ success: true, translations: [] });
    return;
  }

  chrome.storage.local.get(['lingoflow_settings'], (result) => {
    const settings = result.lingoflow_settings || {};
    const apiKey = (settings.geminiApiKey || '').trim();
    const model = settings.geminiModel || 'gemini-3.1-flash-lite';

    if (!apiKey) {
      console.warn('LingoFlow: Gemini API key not set for batch, falling back to Google');
      translateBatchWithGoogleFallback(list, targetLang).then(translations => {
        sendResponse({ success: true, translations });
      });
      return;
    }

    const chunks = createGeminiTextChunks(list);
    const translations = new Array(list.length);
    console.log('LingoFlow: Gemini batch translating', list.length, 'items in', chunks.length, 'request(s) with', model);

    runGeminiChunkQueue(chunks, {
      apiKey,
      model,
      targetLang,
      translations,
      attempt: 0
    })
      .then(() => {
        sendResponse({ success: true, translations: translations.map((item, index) => item || list[index]) });
      })
      .catch(error => {
        const message = error && error.message ? error.message : String(error);
        console.warn('LingoFlow: Gemini batch failed:', message, '- falling back to Google batch');
        translateBatchWithGoogleBatch(list, targetLang).then(fallbackTranslations => {
          sendResponse({ success: true, translations: fallbackTranslations });
        });
      });
  });
}

function createGeminiTextChunks(texts) {
  const chunks = [];
  let current = [];
  let currentChars = 0;
  const maxItems = 24;
  const maxChars = 6000;

  texts.forEach((text, index) => {
    const value = String(text || '');
    const itemChars = value.length;
    if (current.length && (current.length >= maxItems || currentChars + itemChars > maxChars)) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push({ index, text: value });
    currentChars += itemChars;
  });

  if (current.length) chunks.push(current);
  return chunks;
}

async function runGeminiChunkQueue(chunks, context) {
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const result = await translateGeminiChunk(chunk, context.targetLang, context.apiKey, context.model, 0);
      chunk.forEach((item, offset) => {
        context.translations[item.index] = result[offset] || item.text;
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn(`LingoFlow: Gemini chunk ${i + 1}/${chunks.length} failed:`, message, '- falling back to Google for this chunk');
      const fallback = await translateBatchWithGoogleBatch(chunk.map(item => item.text), context.targetLang);
      chunk.forEach((item, offset) => {
        context.translations[item.index] = fallback[offset] || item.text;
      });
    }

    if (i < chunks.length - 1) {
      await delay(700);
    }
  }
}

function translateGeminiChunk(chunk, targetLang, apiKey, model, attempt) {
  const target = targetLang === 'zh' || targetLang === 'zh-CN' ? 'Simplified Chinese' :
                 targetLang === 'en' ? 'English' : 'Simplified Chinese';
  const payload = chunk.map((item, offset) => ({
    id: offset,
    text: item.text
  }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: [
              `Translate each "text" value to ${target}.`,
              'Return ONLY a valid JSON array. No markdown. No explanations.',
              'The output array must have the same length and order as the input array.',
              'Each output item must be a string translation.',
              '',
              JSON.stringify(payload)
            ].join('\n')
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      topP: 0.9,
      responseMimeType: 'application/json',
      maxOutputTokens: 8192
    }
  };

  console.log('LingoFlow: Gemini batch chunk translating', chunk.length, 'items with', model);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal
  })
    .then(response => {
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(data => {
      const text = extractGeminiText(data);
      const translations = parseGeminiTranslationArray(text, chunk.length);
      console.log('LingoFlow: Gemini batch chunk succeeded, items:', translations.length);
      return translations;
    })
    .catch(error => {
      clearTimeout(timeoutId);
      const message = error && error.message ? error.message : String(error);
      if (attempt < 1 && /HTTP (429|500|502|503|504)|abort/i.test(message)) {
        console.warn('LingoFlow: Gemini batch chunk retrying after:', message);
        return delay(1600).then(() => translateGeminiChunk(chunk, targetLang, apiKey, model, attempt + 1));
      }
      throw error;
    });
}

function extractGeminiText(data) {
  const parts = data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    Array.isArray(data.candidates[0].content.parts)
      ? data.candidates[0].content.parts
      : [];
  return parts
    .map(part => part && part.text ? part.text : '')
    .join('')
    .trim();
}

function parseGeminiTranslationArray(text, expectedLength) {
  const cleaned = String(text || '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Try to extract array from markdown-wrapped or partial JSON
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { parsed = JSON.parse(arrMatch[0]); } catch (_) {}
    }
    if (!Array.isArray(parsed)) throw new Error('Cannot parse translation response as array');
  }
  if (!Array.isArray(parsed)) {
    if (parsed && Array.isArray(parsed.translations)) parsed = parsed.translations;
    else if (parsed && Array.isArray(parsed.data)) parsed = parsed.data;
    else throw new Error('Gemini batch response is not an array');
  }

  const translations = parsed.map(item => {
    if (typeof item === 'string') return item.trim();
    if (item && typeof item.translation === 'string') return item.translation.trim();
    if (item && typeof item.text === 'string') return item.text.trim();
    return '';
  });

  // Tolerance: pad with empty strings or truncate instead of throwing
  if (translations.length < expectedLength) {
    console.warn(`LingoFlow: Translation array short ${translations.length}/${expectedLength}, padding`);
    while (translations.length < expectedLength) translations.push('');
  } else if (translations.length > expectedLength) {
    console.warn(`LingoFlow: Translation array long ${translations.length}/${expectedLength}, truncating`);
    translations.length = expectedLength;
  }
  return translations;
}

// Google Batch Translation — uses Google Translate's multi-q parameter for true bulk translation
// Much faster than sequential single-item calls (1 request vs N requests)
// Free endpoint limit: ~5000 chars per request, we split at 4000 for safety
function translateBatchWithGoogleBatch(texts, targetLang) {
  const list = Array.isArray(texts) ? texts.filter(t => typeof t === 'string' && t.trim()) : [];
  if (!list.length) return Promise.resolve([]);

  const tl = targetLang === 'zh' ? 'zh-CN' :
             targetLang === 'en' ? 'en' : 'zh-CN';

  // Split into batches of ~4000 chars each (Google free endpoint soft limit)
  const batches = [];
  let current = [];
  let currentChars = 0;
  const maxBatchChars = 4000;

  list.forEach((text, index) => {
    const value = text.length > 2000 ? text.substring(0, 2000) : text;
    if (current.length && currentChars + value.length > maxBatchChars) {
      batches.push({ indexes: current.map(i => i), texts: current.map(i => list[i]) });
      current = [];
      currentChars = 0;
    }
    current.push(index);
    currentChars += value.length;
  });

  if (current.length) {
    batches.push({ indexes: current, texts: current.map(i => list[i]) });
  }

  console.log(`LingoFlow: Google batch translating ${list.length} items in ${batches.length} bulk request(s)`);

  const results = new Array(list.length);
  let chain = Promise.resolve();

  batches.forEach(batch => {
    chain = chain.then(() => new Promise(resolve => {
      // Build URL with multiple q params
      const qParams = batch.texts.map(t => encodeURIComponent(t)).join('&q=');
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${qParams}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      fetch(url, { signal: controller.signal })
        .then(response => {
          clearTimeout(timeoutId);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        })
        .then(data => {
          clearTimeout(timeoutId);
          if (data && data[0] && Array.isArray(data[0])) {
            // Google returns flat array of [text, ...][src_text, ...][...]
            // Every odd index (0,2,4...) is a translated segment
            const segments = data[0];
            batch.indexes.forEach((origIndex, batchOffset) => {
              if (segments[batchOffset] && segments[batchOffset][0]) {
                results[origIndex] = segments[batchOffset][0];
              } else {
                results[origIndex] = list[origIndex];
              }
            });
          } else {
            // Fallback: fill with original text
            batch.indexes.forEach(origIndex => { results[origIndex] = list[origIndex]; });
          }
        })
        .catch(error => {
          clearTimeout(timeoutId);
          const message = error && error.message ? error.message : String(error);
          console.warn('LingoFlow: Google batch request failed:', message, '- falling back to sequential');
          // Last resort: sequential fallback for this batch
          return Promise.all(batch.texts.map(text =>
            new Promise(r => translateWithGoogle(text, targetLang, resp => {
              r(resp && resp.success && resp.translation ? resp.translation : text);
            }))
          )).then(seqs => {
            batch.indexes.forEach((origIndex, offset) => { results[origIndex] = seqs[offset]; });
          });
        })
        .then(() => resolve());
    }));
  });

  return chain.then(() => results);
}

// Legacy sequential fallback (only used as last resort inside Google batch)
function translateBatchWithGoogleFallback(texts, targetLang) {
  return translateBatchWithGoogleBatch(texts, targetLang);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// MyMemory Translation (free, no API key required)
// Docs: https://mymemory.translated.net/doc/spec.php
// Note: MyMemory free tier may return the input text UNCHANGED when no match exists
//       in its community database. We detect this case and fall back to Google.
function translateWithMyMemory(text, targetLang, sendResponse) {
  // MyMemory does NOT support 'auto' as source language.
  // We infer source from the target: if target is 'zh' we assume source is 'en'.
  const src = targetLang === 'zh' || targetLang.startsWith('zh') ? 'en' : 'zh-CN';
  const tgt = targetLang === 'zh' ? 'zh-CN' : (targetLang === 'en' ? 'en' : 'zh-CN');

  const maxLen = 1000; // Increased from 500; MyMemory free tier supports up to ~1000 chars
  const truncated = text.length > maxLen ? text.substring(0, maxLen) : text;

  // Use email parameter to enable private translation memory (improves match quality)
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(truncated)}&langpair=${encodeURIComponent(src)}|${encodeURIComponent(tgt)}&email=${encodeURIComponent('lingoflow@app.placeholder')}`;

  console.log('LingoFlow: MyMemory translating', truncated.length, 'chars', src, '->', tgt);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn('LingoFlow: MyMemory request timed out after 10s');
    controller.abort();
  }, 10000);

  function tryWithFallback(attempt) {
    fetch(url + (attempt > 0 ? '&de=lingoflow' : ''), { signal: controller.signal }) // add different param to bust cache on retry
      .then(response => {
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(data => {
        if (data && data.responseStatus === 200 && data.responseData && data.responseData.translatedText) {
          const translatedText = data.responseData.translatedText;

          // CRITICAL FIX: Detect when MyMemory returns the original text unchanged.
          // When no match is found in its community DB, MyMemory echoes the input.
          // We compare normalized versions to catch this case.
          const normalizedInput = truncated.replace(/\s+/g, '').toLowerCase();
          const normalizedOutput = translatedText.replace(/\s+/g, '').toLowerCase();

          if (normalizedInput && normalizedInput === normalizedOutput) {
            console.warn('LingoFlow: MyMemory returned untranslated text (no match in DB), falling back to Google');
            translateWithGoogle(text, targetLang, sendResponse);
            return;
          }

          // Also check quality: very short or suspicious responses
          if (translatedText.length < Math.max(1, Math.floor(truncated.length * 0.15)) && truncated.length > 10) {
            console.warn('LingoFlow: MyMemory result seems too short vs input, falling back to Google');
            translateWithGoogle(text, targetLang, sendResponse);
            return;
          }

          console.log('LingoFlow: MyMemory succeeded, result length:', translatedText.length,
            '(matchQuality:', ((data.responseData && data.responseData.match) || '-'), ')');
          sendResponse({ success: true, translation: translatedText });
        } else {
          const msg = (data && data.responseStatus) ? `MyMemory error ${data.responseStatus}` : 'Invalid response';
          console.warn('LingoFlow: MyMemory failed:', msg);

          if (attempt < 1) {
            console.log('LingoFlow: Retrying MyMemory...');
            tryWithFallback(attempt + 1);
          } else {
            translateWithGoogle(text, targetLang, sendResponse);
          }
        }
      })
      .catch(error => {
        clearTimeout(timeoutId);
        const message = error && error.message ? error.message : String(error);
        console.warn('LingoFlow: MyMemory error:', message);

        if (attempt < 1 && !/abort/i.test(message)) {
          console.log('LingoFlow: Retrying MyMemory...');
          tryWithFallback(attempt + 1);
        } else {
          console.log('LingoFlow: Falling back to Google Translate');
          translateWithGoogle(text, targetLang, sendResponse);
        }
      });
  }

  tryWithFallback(0);
}

// Youdao Translate (Youdao Zhiyun NMT API v3)
// Docs: https://ai.youdao.com/DOCSIRMA/html/trans/api/wbfy/
function translateWithYoudao(text, targetLang, sendResponse) {
  const youdaoTarget = targetLang === 'zh' ? 'zh-CHS' :
                       targetLang === 'en' ? 'en' : 'zh-CHS';

  chrome.storage.local.get(['lingoflow_settings'], (result) => {
    const settings = result.lingoflow_settings || {};
    const appKey = (settings.youdaoAppKey || '').trim();
    const appSecret = (settings.youdaoAppSecret || '').trim();

    if (!appKey || !appSecret) {
      console.warn('LingoFlow: Youdao appKey or appSecret not set, falling back to Google');
      translateWithGoogle(text, targetLang, sendResponse);
      return;
    }

    const maxLen = 5000;
    const truncated = text.length > maxLen ? text.substring(0, maxLen) : text;
    const salt = generateYoudaoSalt();
    const curtime = Math.floor(Date.now() / 1000).toString();
    const input = getYoudaoInput(truncated);
    const signSrc = appKey + input + salt + curtime + appSecret;

    // Compute SHA256 sign, then send request
    sha256Youdao(signSrc).then(sign => {
      const params = new URLSearchParams();
      params.append('q', truncated);
      params.append('from', 'auto');
      params.append('to', youdaoTarget);
      params.append('appKey', appKey);
      params.append('salt', salt);
      params.append('sign', sign);
      params.append('signType', 'v3');
      params.append('curtime', curtime);

      const url = 'https://openapi.youdao.com/api';
      console.log('LingoFlow: Youdao translating', truncated.length, 'chars to', youdaoTarget);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => { controller.abort(); }, 10000);

      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: controller.signal
      })
        .then(response => {
          clearTimeout(timeoutId);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        })
        .then(data => {
          if (data && String(data.errorCode) === '0' && data.translation && data.translation[0]) {
            const translatedText = data.translation[0];
            console.log('LingoFlow: Youdao succeeded, result length:', translatedText.length);
            sendResponse({ success: true, translation: translatedText });
          } else {
            const errMsg = (data && data.errorCode) ? `Youdao error ${data.errorCode}` : 'Invalid response';
            console.warn('LingoFlow: Youdao failed:', errMsg, '- falling back to Google');
            translateWithGoogle(text, targetLang, sendResponse);
          }
        })
        .catch(error => {
          clearTimeout(timeoutId);
          const message = error && error.message ? error.message : String(error);
          console.warn('LingoFlow: Youdao error:', message, '- falling back to Google');
          translateWithGoogle(text, targetLang, sendResponse);
        });
    }).catch(() => {
      console.warn('LingoFlow: Youdao sign computation failed, falling back to Google');
      translateWithGoogle(text, targetLang, sendResponse);
    });
  });
}

function translateBatchWithYoudao(texts, targetLang, sendResponse) {
  // Translate each item individually via the proven single-text endpoint,
  // with concurrency control — avoids multi-q signing issues (error 202).
  const list = Array.isArray(texts) ? texts.filter(t => typeof t === 'string' && t.trim()) : [];
  if (!list.length) {
    sendResponse({ success: true, translations: [] });
    return;
  }

  const translations = new Array(list.length);
  let cursor = 0, active = 0, finished = 0;
  const concurrency = 1; // Youdao free tier has strict rate limits

  function runNext() {
    while (active < concurrency && cursor < list.length) {
      const index = cursor++;
      active++;

      translateOneYoudao(list[index], targetLang)
        .then(result => { translations[index] = result; })
        .catch(() => { translations[index] = `[LingoFlow]`; })
        .finally(() => {
          active--;
          finished++;
          if (finished === list.length) {
            sendResponse({ success: true, translations });
          } else {
            // Small delay between requests to avoid Youdao rate limiting (411)
            setTimeout(runNext, 300);
          }
        });
    }
  }

  runNext();
}

function translateOneYoudao(text, targetLang) {
  return new Promise((resolve, reject) => {
    translateWithYoudao(text, targetLang, (resp) => {
      if (resp && resp.success) {
        resolve(resp.translation);
      } else {
        reject(new Error('youdao_single_failed'));
      }
    });
  });
}

function generateYoudaoSalt() {
  return 'salt_' + Date.now().toString(36) + Math.random().toString(36).substring(2);
}

function getYoudaoInput(text) {
  if (text.length <= 20) return text;
  return text.substring(0, 10) + text.length + text.substring(text.length - 10);
}

function sha256Youdao(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  return crypto.subtle.digest('SHA-256', data).then(hash => {
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  });
}

// Youdao LLM Translate (Youdao Zhiyun Large Model Translation API)
// Docs: https://ai.youdao.com/DOCSIRMA/html/trans/api/dmxfy/
function translateWithYoudaoLLM(text, targetLang, sendResponse) {
  const youdaoTarget = targetLang === 'zh' ? 'zh-CHS' :
                       targetLang === 'en' ? 'en' : 'zh-CHS';

  chrome.storage.local.get(['lingoflow_settings'], (result) => {
    const settings = result.lingoflow_settings || {};
    const appKey = (settings.youdaoAppKey || '').trim();
    const appSecret = (settings.youdaoAppSecret || '').trim();

    if (!appKey || !appSecret) {
      console.warn('LingoFlow: Youdao LLM appKey or appSecret not set, falling back to Google');
      translateWithGoogle(text, targetLang, sendResponse);
      return;
    }

    const maxLen = 5000;
    const truncated = text.length > maxLen ? text.substring(0, maxLen) : text;
    const salt = generateYoudaoSalt();
    const curtime = Math.floor(Date.now() / 1000).toString();
    const input = getYoudaoInput(truncated);
    const signSrc = appKey + input + salt + curtime + appSecret;

    sha256Youdao(signSrc).then(sign => {
      const params = new URLSearchParams();
      params.append('appKey', appKey);
      params.append('salt', salt);
      params.append('curtime', curtime);
      params.append('sign', sign);
      params.append('signType', 'v3');
      params.append('i', truncated);
      params.append('from', 'auto');
      params.append('to', youdaoTarget);
      // handleOption: '0' = Youdao Ziyue Pro (14B), '3' = Youdao Ziyue Lite (1.5B, free)
      // Only these two values are accepted by the llm-trans API. External models like deepseek-v4-flash
      // are NOT supported as handleOption values for this endpoint.
      const validOptions = { '0': '0', '3': '3', 'pro': '0', 'lite': '3' };
      const handleOpt = (settings.youdaoLLMModel || '3').trim().toLowerCase();
      const actualHandleOption = validOptions[handleOpt] || '3';
      params.append('handleOption', actualHandleOption);
      params.append('streamType', 'full');

      const url = 'https://openapi.youdao.com/proxy/http/llm-trans';
      console.log(`LingoFlow: Youdao LLM → handleOption=${actualHandleOption} (${actualHandleOption === '0' ? 'Pro(14B)' : 'Lite(1.5B)'}), target=${youdaoTarget}, chars=${truncated.length}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => { controller.abort(); }, 15000);

      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: controller.signal
      })
        .then(response => {
          clearTimeout(timeoutId);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return parseYoudaoLLMSSE(response);
        })
        .then(translatedText => {
          console.log('LingoFlow: Youdao LLM succeeded, result length:', translatedText.length);
          sendResponse({ success: true, translation: translatedText });
        })
        .catch(error => {
          clearTimeout(timeoutId);
          const message = error && error.message ? error.message : String(error);
          console.warn('LingoFlow: Youdao LLM error:', message, '- falling back to Google');
          translateWithGoogle(text, targetLang, sendResponse);
        });
    }).catch(() => {
      console.warn('LingoFlow: Youdao LLM sign computation failed, falling back to Google');
      translateWithGoogle(text, targetLang, sendResponse);
    });
  });
}



// Parse Youdao LLM SSE response:
// Format: {"code":"0","message":"success","data":{"transFull":"...","langType":"..."},"requestId":"...","successful":true}
// With streamType=full, each event's data.transFull contains the full translation so far (monotonically growing).
// We take the last non-empty transFull as the final result.
function parseYoudaoLLMSSE(response) {
  return response.text().then(raw => {
    console.log('LingoFlow: Youdao LLM raw SSE response (first 800 chars):', raw.substring(0, 800));
    let lastTranslation = '';
    let eventCount = 0;
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data:' || trimmed === 'data: [DONE]') continue;
      let jsonStr = trimmed;
      if (trimmed.startsWith('data:')) {
        jsonStr = trimmed.substring(5).trim();
      }
      try {
        const obj = JSON.parse(jsonStr);
        eventCount++;
        // Per official docs: translation is in data.transFull (streamType=full) or data.transIncre
        const d = typeof obj.data === 'object' && obj.data !== null ? obj.data : {};
        const trans = d.transFull || d.transIncre || d.translation || d.result || d.text || '';
        if (typeof trans === 'string' && trans.length > 0) {
          lastTranslation = trans; // keep latest (longest in full mode)
        }
      } catch (_) {
        // ignore parse errors for individual SSE lines
      }
    }
    console.log('LingoFlow: Youdao LLM parsed', eventCount, 'SDE events, result length:', lastTranslation.length);
    return lastTranslation || '';
  });
}

function translateBatchWithYoudaoLLM(texts, targetLang, sendResponse) {
  const list = Array.isArray(texts) ? texts.filter(t => typeof t === 'string' && t.trim()) : [];
  if (!list.length) {
    sendResponse({ success: true, translations: [] });
    return;
  }

  const translations = new Array(list.length);
  let cursor = 0, active = 0, finished = 0;
  const concurrency = 1;

  function runNext() {
    while (active < concurrency && cursor < list.length) {
      const index = cursor++;
      active++;

      translateOneYoudaoLLM(list[index], targetLang)
        .then(result => { translations[index] = result; })
        .catch(() => { translations[index] = `[LingoFlow]`; })
        .finally(() => {
          active--;
          finished++;
          if (finished === list.length) {
            sendResponse({ success: true, translations });
          } else {
            setTimeout(runNext, 300);
          }
        });
    }
  }

  runNext();
}

function translateOneYoudaoLLM(text, targetLang) {
  return new Promise((resolve, reject) => {
    translateWithYoudaoLLM(text, targetLang, (resp) => {
      if (resp && resp.success) {
        resolve(resp.translation);
      } else {
        reject(new Error('youdao_llm_failed'));
      }
    });
  });
}

// Microsoft Translator (Azure AI Translator - free tier: 2M chars/month)
// Docs: https://learn.microsoft.com/azure/ai-services/translator/
function translateWithMicrosoft(text, targetLang, sendResponse) {
  const target = targetLang === 'zh' ? 'zh-Hans' :
                 targetLang === 'en' ? 'en' : 'zh-Hans';

  chrome.storage.local.get(['lingoflow_settings'], (result) => {
    const settings = result.lingoflow_settings || {};
    const apiKey = settings.microsoftApiKey || '';
    const region = 'eastasia'; // Fixed region, no UI input needed

    if (!apiKey) {
      console.warn('LingoFlow: Microsoft API key not set, falling back to Google');
      translateWithGoogle(text, targetLang, sendResponse);
      return;
    }

    const maxLen = 50000; // Microsoft supports up to 50K chars per request
    const truncated = text.length > maxLen ? text.substring(0, maxLen) : text;

    const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(target)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => { controller.abort(); }, 10000);

    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': apiKey,
        'Ocp-Apim-Subscription-Region': region
      },
      body: JSON.stringify([{ Text: truncated }]),
      signal: controller.signal
    })
      .then(response => {
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(data => {
        if (data && data[0] && data[0].translations && data[0].translations[0]) {
          const translatedText = data[0].translations[0].text;
          console.log('LingoFlow: Microsoft Translator succeeded, result length:', translatedText.length);
          sendResponse({ success: true, translation: translatedText });
        } else {
          console.warn('LingoFlow: Microsoft Translator invalid response, falling back to Google');
          translateWithGoogle(text, targetLang, sendResponse);
        }
      })
      .catch(error => {
        clearTimeout(timeoutId);
        const message = error && error.message ? error.message : String(error);
        console.warn('LingoFlow: Microsoft Translator error:', message, '– falling back to Google');
        translateWithGoogle(text, targetLang, sendResponse);
      });
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
