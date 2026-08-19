// LingoFlow Content Script
// Handles all in-page interactions

(function () {
  'use strict';

  // =========================================================================
  // CRITICAL: Message listener MUST be registered FIRST, before any other code.
  // This ensures popup can always communicate with us even if later code throws.
  // =========================================================================
  let _dispatchMessage = null; // Set after EventHandlers is defined below

  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) {
    console.warn('LingoFlow: chrome.runtime unavailable in this context, content script inactive');
    return;
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
      if (_dispatchMessage) {
        _dispatchMessage(request, sender, sendResponse);
      } else {
        console.warn('LingoFlow: Handler not ready yet');
        sendResponse({ received: false, error: 'Handler not ready' });
      }
    } catch (err) {
      console.error('LingoFlow: Message handler error:', err);
      try { sendResponse({ received: false, error: err.message }); } catch (_) {}
    }
  });
  console.log('LingoFlow: Message listener registered');

  // State management
  const state = {
    isBilingualMode: false,
    isTranslating: false,
    isTranslated: false,       // whether page currently has active translation
    selectionTranslationEnabled: true,
    hoverParagraphTranslationEnabled: false,
    hoverParagraphTimer: null,
    hoverParagraphTarget: null,
    hoverParagraphInFlight: 0,
    hoverParagraphCache: new Map(),
    toolbarPosition: 'above',
    uiLanguage: 'auto',
    targetLanguage: 'zh',
    existingBilingualStrategy: 'skip',
    activeTranslationMode: null,
    mutationObserver: null,
    mutationTimer: null,
    observerStopTimer: null,
    translationRoot: null,      // detected main content area (for incremental translation)
    originalContent: new Map(), // Store original content for restoration
    translatedNodes: new Set(), // Track translated nodes
    translationIdCounter: 0
  };

  const NotificationText = {
    translationFailed: {
      en: 'Translation failed. Check your network.',
      zh: '翻译失败，请检查网络连接'
    },
    translationInProgress: {
      en: 'Translation in progress...',
      zh: '正在翻译中，请稍候...'
    },
    scanning: {
      en: 'Scanning page text...',
      zh: '正在查找页面文本...'
    },
    noText: {
      en: 'No translatable text found.',
      zh: '未找到可翻译的文本'
    },
    found: {
      en: count => `Found ${count} text blocks. Translating...`,
      zh: count => `找到 ${count} 个文本块，开始翻译...`
    },
    reloaded: {
      en: 'LingoFlow was reloaded. Refresh this page and try again.',
      zh: 'LingoFlow 已重新加载，请刷新页面后再试'
    },
    partial: {
      en: (success, fail) => `Translated ${success} blocks, ${fail} failed`,
      zh: (success, fail) => `已翻译 ${success} 个文本块，${fail} 个失败`
    },
    done: {
      en: count => `Bilingual mode: translated ${count} text blocks`,
      zh: count => `双语模式：已翻译 ${count} 个文本块`
    },
    translationOnlyDone: {
      en: count => `Translation mode: translated ${count} text blocks`,
      zh: count => `译文模式：已翻译 ${count} 个文本块`
    },
    translating: {
      en: 'Translating page with translate.js...',
      zh: '正在用 translate.js 整页翻译...'
    },
    translatejsDone: {
      en: 'translate.js: page translated',
      zh: 'translate.js：整页翻译完成'
    },
    translatejsFailed: {
      en: 'translate.js failed to load (check network)',
      zh: 'translate.js 加载失败（请检查网络）'
    },
    translatejsError: {
      en: err => `translate.js error: ${err}`,
      zh: err => `translate.js 出错：${err}`
    }
  };

  function isChineseUi() {
    if (state.uiLanguage && state.uiLanguage !== 'auto') {
      return state.uiLanguage.toLowerCase().startsWith('zh');
    }
    try {
      const i18n = (typeof chrome !== 'undefined' && chrome != null && chrome.i18n) || null;
      return i18n && typeof i18n.getUILanguage === 'function'
        ? i18n.getUILanguage().toLowerCase().startsWith('zh')
        : false;
    } catch (_) {
      return false;
    }
  }

  // Built-in Chinese fallback dictionary: when getMessage (from i18n.js) is
  // unavailable — e.g. extension context invalidated, or i18n.js failed to load
  // — we still render the toolbar in Chinese instead of English.
  const _ZH_FALLBACK = {
    translate: '翻译',
    save: '保存',
    copy: '复制',
    close: '关闭',
    retry: '重试',
    loading: '翻译中…',
    rarr: '→',
    mode_word: '单词',
    mode_sentence: '句子',
    mode_paragraph: '段落',
    dictionary_title: '词典',
    pronunciation: '发音',
    saveSuccess: '已收藏',
    saveFailed: '收藏失败',
    notLoggedIn: '未登录',
    login: '登录',
    settings: '设置',
    feedback: '反馈',
  };

  // Safety wrapper for getMessage: guard against i18n.js not loaded
  // or getMessage being undefined (e.g., extension context invalidated).
  const _getMessage = (typeof getMessage === 'function')
    ? getMessage
    : (key, fallback) => _ZH_FALLBACK[key] || fallback || key;

  // NOTE: getMessage() is already defined in i18n.js (loaded before this file).
  // Do NOT re-define it here — that would break _manualMessages support and
  // cause "chrome.i18n is undefined" errors when extension context invalidates.

  // Safe wrapper for chrome.runtime.sendMessage that handles
  // "Extension context invalidated" errors gracefully (Service Worker terminated).
  function safeSendMessage(message, callback) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        console.warn('LingoFlow: chrome.runtime unavailable, message dropped:', message.action);
        if (callback) try { callback(); } catch (_) {}
        return;
      }
      chrome.runtime.sendMessage(message, (response) => {
        // Suppress "Extension context invalidated" and similar errors
        if (chrome.runtime.lastError) {
          const msg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '';
          if (msg.includes('context invalidated') || msg.includes('not exist')) {
            console.warn('LingoFlow: Extension context invalidated, message dropped:', message.action);
            return; // Silent — Service Worker will restart on next user interaction
          }
        }
        if (callback) try { callback(response); } catch (_) {}
      });
    } catch (err) {
      console.warn('LingoFlow: sendMessage error:', err && err.message ? err.message : err);
      if (callback) try { callback(); } catch (_) {}
    }
  }

  function statusText(key, ...args) {
    const entry = NotificationText[key];
    if (!entry) return key;
    const value = isChineseUi() ? entry.zh : entry.en;
    return typeof value === 'function' ? value(...args) : value;
  }

  // Helper: Check if translation result is a fallback/error text (not a real translation)
  function isFallbackText(text) {
    if (!text) return true;
    return text.startsWith('[LingoFlow translation failed]') ||
           text.startsWith('[LingoFlow translation timeout]') ||
           text.startsWith('[LingoFlow context invalidated]');
  }

  function isContextInvalidatedText(text) {
    return !!text && text.startsWith('[LingoFlow context invalidated]');
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
    const message = getErrorMessage(error).toLowerCase();
    return message.includes('extension context invalidated') ||
           message.includes('context invalidated') ||
           message.includes('receiving end does not exist') ||
           message.includes('message port closed') ||
           message.includes('extension has been reloaded');
  }

  // Helper: Check if text is primarily Chinese/CJK (skip translation for already-Chinese content)
  function isChineseText(text) {
    const cleaned = (text || '').replace(/[\s\d\p{P}\p{S}]/gu, '');
    if (cleaned.length < 5) return false;
    let cjkCount = 0;
    for (const ch of cleaned) {
      if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) cjkCount++;
    }
    return cjkCount / cleaned.length >= 0.45;
  }

  function hasMixedLatinAndChinese(text) {
    const value = text || '';
    return /[A-Za-z]{2,}/.test(value) && /[\u4e00-\u9fff\u3400-\u4dbf]/.test(value);
  }

  function isAllCapsShortLabel(text) {
    const normalized = (text || '').replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length > 24) return false;

    const words = normalized.split(/\s+/);
    if (words.length > 3) return false;

    const cleaned = normalized.replace(/[^A-Za-z0-9+#.&/-]/g, '');
    if (!cleaned || cleaned.length < 2) return false;
    if (!/[A-Z]{2,}/.test(cleaned)) return false;
    if (/[a-z]/.test(cleaned)) return false;

    const letters = cleaned.replace(/[^A-Za-z]/g, '');
    return letters.length >= 2 && letters.length <= 12;
  }

  // Translation Engine - Pluggable architecture
  const TranslationEngine = {
    // Current active engine (loaded from settings)
    activeEngine: 'google',

    // Google Translate via background script (bypasses page CSP)
    googleTranslator: {
      translate: async (text, targetLang) => {
        // Map target language to Google format
        const tl = targetLang === 'zh' ? 'zh-CN' :
                   targetLang === 'en' ? 'en' : 'zh-CN';

        // Truncate very long text
        const maxLen = 2000;
        const truncated = text.length > maxLen ? text.substring(0, maxLen) : text;

        return new Promise((resolve) => {
          const timeoutId = setTimeout(() => {
            console.warn('LingoFlow: Translation request timed out');
            resolve(`[LingoFlow translation timeout] ${text}`);
          }, 50000); // 50s - must be longer than background.js overall timeout (45s)

          try {
            // Guard: chrome.runtime may be invalidated (Service Worker terminated)
            if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
              clearTimeout(timeoutId);
              resolve(`[LingoFlow context invalidated] ${text}`);
              return;
            }
            chrome.runtime.sendMessage(
              {
                action: 'translate',
                text: truncated,
                targetLang: tl
              },
              (response) => {
                clearTimeout(timeoutId);

                if (chrome.runtime.lastError) {
                  console.warn('LingoFlow: Background translate error:', getErrorMessage(chrome.runtime.lastError));
                  resolve(`[LingoFlow translation failed] ${text}`);
                  return;
                }

                if (response && response.success && response.translation) {
                  resolve(response.translation);
                } else {
                  console.warn('LingoFlow: Translation failed:', getErrorMessage(response && response.error));
                  resolve(`[LingoFlow translation failed] ${text}`);
                }
              }
            );
          } catch (err) {
            clearTimeout(timeoutId);
            console.warn('LingoFlow: sendMessage error:', getErrorMessage(err));
            if (isContextInvalidatedError(err)) {
              resolve(`[LingoFlow context invalidated] ${text}`);
              return;
            }
            resolve(`[LingoFlow translation failed] ${text}`);
          }
        });
      }
    },

    // Generic translator that sends requests to background.js for any engine.
    // Background.js reads translationEngine from settings and dispatches to the correct API.
    backgroundTranslator: {
      translate: async (text, targetLang) => {
        const tl = targetLang === 'zh' ? 'zh-CN' :
                   targetLang === 'en' ? 'en' : 'zh-CN';
        const maxLen = 5000;
        const truncated = text.length > maxLen ? text.substring(0, maxLen) : text;

        return new Promise((resolve) => {
          const timeoutId = setTimeout(() => {
            console.warn('LingoFlow: Background translator timed out');
            resolve(`[LingoFlow translation timeout] ${text}`);
          }, 50000);

          try {
            if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
              clearTimeout(timeoutId);
              resolve(`[LingoFlow context invalidated] ${text}`);
              return;
            }
            chrome.runtime.sendMessage(
              { action: 'translate', text: truncated, targetLang: tl },
              (response) => {
                clearTimeout(timeoutId);
                if (chrome.runtime.lastError) {
                  console.warn('LingoFlow: Background translate error:', getErrorMessage(chrome.runtime.lastError));
                  resolve(`[LingoFlow translation failed] ${text}`);
                  return;
                }
                if (response && response.success && response.translation) {
                  resolve(response.translation);
                } else {
                  console.warn('LingoFlow: Translation failed:', getErrorMessage(response && response.error));
                  resolve(`[LingoFlow translation failed] ${text}`);
                }
              }
            );
          } catch (err) {
            clearTimeout(timeoutId);
            console.warn('LingoFlow: sendMessage error:', getErrorMessage(err));
            if (isContextInvalidatedError(err)) {
              resolve(`[LingoFlow context invalidated] ${text}`);
              return;
            }
            resolve(`[LingoFlow translation failed] ${text}`);
          }
        });
      }
    },

    // Translate text — all engines route through background script (which has full engine dispatch)
    async translate(text, targetLang = 'zh') {
      switch (this.activeEngine) {
        case 'google':
          return await this.googleTranslator.translate(text, targetLang);

        case 'siliconflow':
        case 'microsoft':
        case 'gemini':
        case 'mymemory':
        case 'youdao':
        case 'youdaollm':
        case 'deepseek':
        case 'baidu':
        case 'baidullm':
        case 'bailian':
          // All non-Google engines delegate to background.js which has the real API logic
          return await this.backgroundTranslator.translate(text, targetLang);

        default:
          return await this.googleTranslator.translate(text, targetLang);
      }
    },

    async translateMany(texts, targetLang = 'zh') {
      const list = Array.isArray(texts) ? texts : [];
      if (!list.length) return [];

      const tl = targetLang === 'zh' ? 'zh-CN' :
                 targetLang === 'en' ? 'en' : 'zh-CN';

      return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
          console.warn('LingoFlow: Batch translation timed out, falling back to single requests');
          Promise.all(list.map(text => this.translate(text, targetLang))).then(resolve);
        }, 120000); // Increased from 55s to 120s for slow LLM engines like DeepSeek

        try {
          // Guard: chrome.runtime may be invalidated (SW may be killed by browser)
          if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
            clearTimeout(timeoutId);
            console.warn('LingoFlow: chrome.runtime unavailable, falling back to single requests');
            Promise.all(list.map(text => this.translate(text, targetLang))).then(resolve);
            return;
          }
          chrome.runtime.sendMessage(
            {
              action: 'translate_batch',
              texts: list.map(text => text.length > 2000 ? text.substring(0, 2000) : text),
              targetLang: tl
            },
            (response) => {
              clearTimeout(timeoutId);

              // Check for extension context errors (SW killed/restarted)
              if (chrome.runtime.lastError) {
                const errMsg = getErrorMessage(chrome.runtime.lastError);
                console.warn('LingoFlow: Batch translation send failed:', errMsg,
                  '- falling back to single requests');
                Promise.all(list.map(text => this.translate(text, targetLang))).then(resolve);
                return;
              }

              console.log('LingoFlow: Batch translate response received:',
                response ? (Array.isArray(response.translations)
                  ? `${response.translations.length} translations, first="${(response.translations[0] || '').substring(0, 60)}"`
                  : 'non-array response') : 'null/undefined');

              if (response && Array.isArray(response.translations)) {
                resolve(response.translations);
                return;
              }

              console.warn('LingoFlow: Invalid batch response format, falling back to single requests');
              Promise.all(list.map(text => this.translate(text, targetLang))).then(resolve);
            }
          );
        } catch (err) {
          clearTimeout(timeoutId);
          console.warn('LingoFlow: Batch translation error:', getErrorMessage(err),
            '- falling back to single requests');
          Promise.all(list.map(text => this.translate(text, targetLang))).then(resolve);
        }
      });
    }
  };

  const SelectionLookup = {
    cache: new Map(),

    isSingleEnglishWord(text) {
      return /^[A-Za-z][A-Za-z'-]*$/.test(String(text || '').trim());
    },

    getType(text) {
      return this.isSingleEnglishWord(text) ? 'word' : 'sentence';
    },

    splitParagraphs(text) {
      const normalized = String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ')
        .trim();
      if (!normalized) return [];

      const blankSeparated = normalized
        .split(/\n\s*\n+/)
        .map(part => part.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean);
      if (blankSeparated.length > 1) return blankSeparated;

      const lineSeparated = normalized
        .split(/\n+/)
        .map(part => part.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean);
      if (lineSeparated.length > 1 && lineSeparated.some(part => part.length >= 12)) {
        return lineSeparated;
      }

      return [normalized.replace(/\s+/g, ' ')];
    },

    getCacheKey(text) {
      return `${this.getType(text)}:${state.targetLanguage}:${String(text || '').trim().toLowerCase()}`;
    },

    async resolve(text) {
      const normalized = String(text || '').trim();
      const cacheKey = this.getCacheKey(normalized);
      if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

      const result = this.isSingleEnglishWord(normalized)
        ? await this.lookupWord(normalized)
        : await this.translateText(normalized);

      this.cache.set(cacheKey, result);
      return result;
    },

    async resolveWithParagraphs(text, paragraphs) {
      const cleanParagraphs = Array.isArray(paragraphs)
        ? paragraphs.map(part => String(part || '').trim()).filter(Boolean)
        : [];
      if (this.isSingleEnglishWord(text) || cleanParagraphs.length <= 1) {
        return this.resolve(text);
      }

      const normalized = cleanParagraphs.join('\n\n');
      const cacheKey = `${this.getType(normalized)}:${state.targetLanguage}:${normalized.toLowerCase()}`;
      if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

      const result = await this.translateParagraphs(cleanParagraphs, text);
      this.cache.set(cacheKey, result);
      return result;
    },

    lookupWord(word) {
      return new Promise((resolve) => {
        try {
          // Guard: chrome.runtime may be invalidated
          if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
            this.translateText(word).then(resolve);
            return;
          }
          chrome.runtime.sendMessage(
            {
              action: 'lookup_dictionary',
              text: word,
              targetLang: state.targetLanguage || 'zh'
            },
            (response) => {
              if (chrome.runtime.lastError || !response || !response.success || !response.result) {
                this.translateText(word).then(resolve);
                return;
              }
              resolve({
                mode: 'word',
                text: word,
                translation: response.result.translation || word,
                dictionary: response.result
              });
            }
          );
        } catch (_) {
          this.translateText(word).then(resolve);
        }
      });
    },

    async translateText(text) {
      const paragraphs = this.splitParagraphs(text);
      if (paragraphs.length > 1) {
        return this.translateParagraphs(paragraphs, text);
      }

      const translation = await TranslationEngine.translate(text, state.targetLanguage || 'zh');
      if (isFallbackText(translation)) {
        return {
          mode: this.getType(text),
          text,
          translation: '',
          error: true
        };
      }
      return {
        mode: this.getType(text),
        text,
        translation,
        paragraphs: null,
        dictionary: null
      };
    },

    async translateParagraphs(paragraphs, originalText) {
      const sourceParagraphs = paragraphs.map(part => String(part || '').trim()).filter(Boolean);
      const translations = await TranslationEngine.translateMany(sourceParagraphs, state.targetLanguage || 'zh');
      const paragraphResults = sourceParagraphs.map((source, index) => ({
        text: source,
        translation: translations[index] || ''
      })).filter(item => item.translation && !isFallbackText(item.translation));

      if (!paragraphResults.length) {
        return {
          mode: this.getType(originalText),
          text: originalText,
          translation: '',
          paragraphs: [],
          error: true
        };
      }

      return {
        mode: this.getType(originalText),
        text: originalText,
        translation: paragraphResults.map(item => item.translation).join('\n\n'),
        paragraphs: paragraphResults,
        dictionary: null
      };
    },

    getCopyText(result) {
      if (!result) return '';
      if (result.mode === 'word' && result.dictionary) {
        return result.dictionary.translation || result.translation || result.text || '';
      }
      if (Array.isArray(result.paragraphs) && result.paragraphs.length) {
        return result.paragraphs.map(item => item.translation || '').filter(Boolean).join('\n\n');
      }
      return result.translation || result.text || '';
    },

    getSavePayload(result) {
      return {
        text: result.text || '',
        translation: result.translation || '',
        paragraphs: Array.isArray(result.paragraphs) ? result.paragraphs : null,
        dictionary: result.dictionary || null,
        type: result.mode === 'word' ? 'word' : 'sentence',
        sourceUrl: window.location.href
      };
    }
  };

  // DOM Processor - Handle DOM manipulation
  const DOMProcessor = {
    // Tags to skip
    skipTags: ['SCRIPT', 'STYLE', 'CODE', 'PRE', 'INPUT', 'TEXTAREA', 'BUTTON', 'NAV', 'FOOTER'],

    // Check if element should be translated
    shouldTranslate(element) {
      if (!element) return false;
      if (state.translatedNodes.has(element)) return false;
      if (state.originalContent.has(element)) return false;
      if (this.skipTags.includes(element.tagName)) return false;
      if (element.classList.contains('lingoflow-translated')) return false;
      return true;
    },

    // Save original content
    saveOriginal(element) {
      if (state.originalContent.has(element)) return;
      state.originalContent.set(element, Array.from(element.childNodes).map(node => node.cloneNode(true)));
    },

    // Restore original content
    restoreOriginal(element) {
      const originalNodes = state.originalContent.get(element);
      if (originalNodes) {
        element.replaceChildren(...originalNodes.map(node => node.cloneNode(true)));
        state.originalContent.delete(element);
        state.translatedNodes.delete(element);
        element.classList.remove('lingoflow-translated');
      }
    },

    // Get text nodes from element
    getTextNodes(element) {
      const textNodes = [];
      const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            // Skip empty nodes
            if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;

            // Skip if parent is in skip list
            let parent = node.parentElement;
            while (parent) {
              if (this.skipTags.includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
              if (parent.classList.contains('lingoflow-translated')) return NodeFilter.FILTER_REJECT;
              parent = parent.parentElement;
            }

            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      let node;
      while (node = walker.nextNode()) {
        textNodes.push(node);
      }

      return textNodes;
    }
  };

  // UI Components
  const UI = {
    selectionContext: null,
    currentResult: null,

    // Create floating toolbar
    createFloatingToolbar(selectionContext) {
      this.removeFloatingToolbar();
      this.removeTranslationResult();

      this.selectionContext = selectionContext;
      const selectedText = selectionContext.text;

      const toolbar = document.createElement('div');
      toolbar.id = 'lingoflow-toolbar';
      toolbar.className = 'lingoflow-ui';

      toolbar.innerHTML = `
        <div class="lingoflow-toolbar-content">
          <button class="lingoflow-btn lingoflow-translate-btn" data-action="translate" data-text="${this.escapeHtml(selectedText)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
              <path d="M2 12h20"/>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
            </svg>
            <span data-i18n="translate">${this.escapeHtml(_getMessage('translate', 'Translate'))}</span>
          </button>
          <button class="lingoflow-btn lingoflow-save-btn" data-action="save" data-text="${this.escapeHtml(selectedText)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
              <polyline points="17 21 17 13 7 13 7 21"/>
              <polyline points="7 3 7 8 15 8"/>
            </svg>
            <span data-i18n="save">${this.escapeHtml(_getMessage('save', 'Save'))}</span>
          </button>
        </div>
      `;

      const handleToolbarAction = (e) => {
        const button = e.target && e.target.closest ? e.target.closest('.lingoflow-btn') : null;
        if (!button || !toolbar.contains(button) || button.disabled) return;
        if (toolbar.dataset.lfActionLock === 'true') return;
        toolbar.dataset.lfActionLock = 'true';
        setTimeout(() => {
          if (toolbar && toolbar.dataset) delete toolbar.dataset.lfActionLock;
        }, 250);

        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();

        const action = button.getAttribute('data-action');
        if (action === 'translate') {
          this.handleTranslate(selectedText, selectionContext);
          return;
        }

        if (action === 'save') {
          this.handleSave(selectedText);
        }
      };

      toolbar.addEventListener('pointerdown', handleToolbarAction, true);
      toolbar.addEventListener('mousedown', handleToolbarAction, true);
      toolbar.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('.lingoflow-btn')) {
          e.preventDefault();
          e.stopPropagation();
          if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        }
      }, true);

      document.body.appendChild(toolbar);

      this.positionFloatingElement(toolbar, selectionContext.rect, {
        preferred: state.toolbarPosition,
        offset: 10
      });
    },

    // Remove floating toolbar
    removeFloatingToolbar() {
      const toolbar = document.getElementById('lingoflow-toolbar');
      if (toolbar) toolbar.remove();
      this.selectionContext = null;
      // Clear the dedupe key so selecting the same text/position again
      // (e.g. after the translate button dismissed the toolbar) re-shows
      // the toolbar without requiring a long-press.
      this.lastSelectionKey = '';
    },

    positionFloatingElement(element, anchorRect, options = {}) {
      const preferred = options.preferred || 'below';
      const offset = options.offset || 8;
      const margin = 10;
      const rect = element.getBoundingClientRect();
      const anchorLeft = anchorRect.left;
      const anchorTop = anchorRect.top;
      const anchorBottom = anchorRect.bottom;

      let left = anchorLeft + (anchorRect.width / 2) - (rect.width / 2);
      left = Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin));

      const aboveTop = anchorTop - rect.height - offset;
      const belowTop = anchorBottom + offset;
      const hasSpaceAbove = aboveTop >= margin;
      const hasSpaceBelow = belowTop + rect.height <= window.innerHeight - margin;

      let top;
      if (preferred === 'above') {
        top = hasSpaceAbove ? aboveTop : belowTop;
      } else if (preferred === 'below') {
        top = hasSpaceBelow ? belowTop : aboveTop;
      } else {
        // auto mode: prefer above, fallback intelligently
        top = hasSpaceAbove ? aboveTop : belowTop;
        if (!hasSpaceBelow && hasSpaceAbove) {
          top = aboveTop;
        }
      }

      top = Math.max(margin, Math.min(top, window.innerHeight - rect.height - margin));

      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
    },

    // Show translation result
    showTranslationResult(selectionContext, resultData) {
      this.removeFloatingToolbar();
      this.removeTranslationResult();
      this.currentResult = resultData;

      const originalText = resultData.text || '';
      const translation = resultData.translation || '';
      const dictionary = resultData.dictionary || null;
      const isWord = resultData.mode === 'word';
      const meanings = dictionary && Array.isArray(dictionary.meanings) ? dictionary.meanings : [];
      const examples = dictionary && Array.isArray(dictionary.examples) ? dictionary.examples : [];
      const renderParagraphs = (items, key, fallbackText) => {
        const values = Array.isArray(items) && items.length
          ? items.map(item => item && item[key]).filter(Boolean)
          : SelectionLookup.splitParagraphs(fallbackText);
        return values.map(value => (
          `<p class="lingoflow-result-paragraph">${this.escapeHtml(value)}</p>`
        )).join('');
      };

      const result = document.createElement('div');
      result.id = 'lingoflow-translation-result';
      result.className = 'lingoflow-ui';

      const body = isWord
        ? `
          <div class="lingoflow-word-head">
            <div>
              <div class="lingoflow-word-text">${this.escapeHtml(originalText)}</div>
              ${dictionary && dictionary.phonetic ? `<div class="lingoflow-word-phonetic">${this.escapeHtml(dictionary.phonetic)}</div>` : ''}
            </div>
            <span class="lingoflow-word-badge">${this.escapeHtml(_getMessage('word', 'Word'))}</span>
          </div>
          <div class="lingoflow-result-translation">${this.escapeHtml(translation)}</div>
          ${meanings.length ? `<div class="lingoflow-meaning-list">${meanings.map(item => `
            <div class="lingoflow-meaning-item">
              ${item.partOfSpeech ? `<span class="lingoflow-pos">${this.escapeHtml(item.partOfSpeech)}</span>` : ''}
              <span>${this.escapeHtml(item.definition || '')}</span>
            </div>
          `).join('')}</div>` : ''}
          ${examples.length ? `<div class="lingoflow-example-list">${examples.map(example => `
            <div class="lingoflow-example">"${this.escapeHtml(example)}"</div>
          `).join('')}</div>` : ''}
        `
        : `
          <div class="lingoflow-result-original">${renderParagraphs(resultData.paragraphs, 'text', originalText)}</div>
          <div class="lingoflow-result-translation">${renderParagraphs(resultData.paragraphs, 'translation', translation)}</div>
        `;

      result.innerHTML = `
        <div class="lingoflow-result-header">
          <span class="lingoflow-result-title">${this.escapeHtml(isWord ? _getMessage('word', 'Word') : _getMessage('translate', 'Translate'))}</span>
          <button class="lingoflow-result-close" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="lingoflow-result-content">
          ${body}
          <div class="lingoflow-result-actions">
            <button class="lingoflow-result-btn" type="button" data-result-action="copy">${this.escapeHtml(_getMessage('copy', 'Copy'))}</button>
            <button class="lingoflow-result-btn" type="button" data-result-action="save">${this.escapeHtml(_getMessage('save', 'Save'))}</button>
            <button class="lingoflow-result-close" type="button" aria-label="Close">×</button>
          </div>
        </div>
      `;

      document.body.appendChild(result);
      this.positionFloatingElement(result, selectionContext.rect, {
        preferred: state.toolbarPosition,
        offset: 10
      });

      const handleResultAction = (e) => {
        const actionButton = e.target && e.target.closest
          ? e.target.closest('[data-result-action], .lingoflow-result-close')
          : null;
        if (!actionButton || !result.contains(actionButton)) return;
        if (result.dataset.lfActionLock === 'true') return;
        result.dataset.lfActionLock = 'true';
        setTimeout(() => {
          if (result && result.dataset) delete result.dataset.lfActionLock;
        }, 250);

        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();

        const action = actionButton.getAttribute('data-result-action');

        if (action === 'copy') {
          this.handleCopy(SelectionLookup.getCopyText(resultData));
          return;
        }

        if (action === 'save') {
          this.saveResolvedResult(resultData);
          return;
        }

        if (actionButton.classList.contains('lingoflow-result-close')) {
          this.removeTranslationResult();
        }
      };

      result.addEventListener('pointerdown', handleResultAction, true);
      result.addEventListener('mousedown', handleResultAction, true);
      result.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('[data-result-action], .lingoflow-result-close')) {
          e.preventDefault();
          e.stopPropagation();
          if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        }
      }, true);

      setTimeout(() => this.removeTranslationResult(), 12000);
    },

    // Remove translation result
    removeTranslationResult() {
      const result = document.getElementById('lingoflow-translation-result');
      if (result) result.remove();
      this.currentResult = null;
    },

    // Handle translate action
    setToolbarLoading(isLoading) {
      const toolbar = document.getElementById('lingoflow-toolbar');
      if (!toolbar) return;

      toolbar.classList.toggle('lingoflow-toolbar-loading', isLoading);
      toolbar.querySelectorAll('.lingoflow-btn').forEach(button => {
        button.disabled = isLoading;
      });

      const label = toolbar.querySelector('.lingoflow-translate-btn span');
      if (label) label.textContent = isLoading ? (_getMessage('translation_in_progress', 'Translating...')) : (_getMessage('translate', 'Translate'));
    },

    // Handle translate action
    async handleTranslate(text, selectionContext = this.selectionContext) {
      if (!selectionContext) {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          let paragraphs = null;
          if (typeof EventHandlers.extractSelectionParagraphs === 'function') {
            try {
              paragraphs = EventHandlers.extractSelectionParagraphs(selection.getRangeAt(0), text);
            } catch (e) {
              console.warn('LingoFlow: extractSelectionParagraphs failed in handleTranslate', e);
            }
          }
          selectionContext = {
            text,
            paragraphs,
            rect: selection.getRangeAt(0).getBoundingClientRect()
          };
        }
      }

      this.setToolbarLoading(true);
      const result = await SelectionLookup.resolveWithParagraphs(text, selectionContext && selectionContext.paragraphs);
      this.setToolbarLoading(false);

      // If translation failed (fallback text), show notification instead of result
      if (!result || result.error || !result.translation) {
        this.showNotification(statusText('translationFailed'));
        return;
      }

      // Save to history
      safeSendMessage({
        action: 'add_to_history',
        data: {
          text: text,
          translation: result.translation,
          paragraphs: Array.isArray(result.paragraphs) ? result.paragraphs : null,
          sourceUrl: window.location.href
        }
      });

      // Show result
      if (selectionContext && selectionContext.rect) {
        this.showTranslationResult(selectionContext, result);
      } else {
        this.showNotification(result.translation);
      }
    },

    getContextSelectionContext(text) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        if (rect && (rect.width || rect.height)) {
          // 安全调用 extractSelectionParagraphs，防止运行时报错
          let paragraphs = null;
          if (typeof EventHandlers.extractSelectionParagraphs === 'function') {
            try {
              paragraphs = EventHandlers.extractSelectionParagraphs(selection.getRangeAt(0), text);
            } catch (e) {
              console.warn('LingoFlow: extractSelectionParagraphs failed', e);
            }
          }
          return {
            text,
            paragraphs,
            rect: {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height
            }
          };
        }
      }

      const width = 1;
      const height = 1;
      const left = Math.max(12, (window.innerWidth / 2) - 1);
      const top = Math.max(12, window.innerHeight * 0.32);
      return {
        text,
        paragraphs: null,
        rect: {
          left,
          right: left + width,
          top,
          bottom: top + height,
          width,
          height
        }
      };
    },

    async showResultForText(text) {
      try {
        // 尝试获取选中位置，如果失败则使用屏幕中间位置
        let selectionContext = this.getContextSelectionContext(text);

        // 检查选中位置是否有效（右键翻译时可能丢失选中状态）
        // 注意：getContextSelectionContext可能返回width=1, height=1的默认位置
        if (!selectionContext || !selectionContext.rect ||
            (selectionContext.rect.width <= 1 && selectionContext.rect.height <= 1) ||
            (selectionContext.rect.width === 0 && selectionContext.rect.height === 0)) {
          // 使用屏幕中间位置作为备用
          const width = 300;
          const height = 200;
          const left = Math.max(12, (window.innerWidth / 2) - width / 2);
          const top = Math.max(12, window.innerHeight * 0.3);
          selectionContext = {
            text,
            paragraphs: null,
            rect: { left, right: left + width, top, bottom: top + height, width, height }
          };
        }

        this.showNotification(_getMessage('translation_in_progress', 'Translating...'));
        const result = await SelectionLookup.resolveWithParagraphs(text, selectionContext && selectionContext.paragraphs);
        if (!result || result.error || !result.translation) {
          const errorMsg = result && result.error ? result.error : statusText('translationFailed');
          this.showNotification(errorMsg, true);
          return false;
        }

        safeSendMessage({
          action: 'add_to_history',
          data: {
            text,
            translation: result.translation,
            paragraphs: Array.isArray(result.paragraphs) ? result.paragraphs : null,
            sourceUrl: window.location.href
          }
        });

        this.showTranslationResult(selectionContext, result);
        return true;
      } catch (err) {
        this.showNotification(statusText('translationFailed'), true);
        return false;
      }
    },

    async saveTextWithResolvedResult(text) {
      this.showNotification(_getMessage('saving', 'Saving...'));
      const selectionContext = this.getContextSelectionContext(text);
      const result = await SelectionLookup.resolveWithParagraphs(text, selectionContext && selectionContext.paragraphs);
      if (!result || result.error || !result.translation) {
        this.showNotification(statusText('translationFailed'));
        return false;
      }
      this.saveResolvedResult(result);
      return true;
    },

    // Handle copy action
    handleCopy(text) {
      navigator.clipboard.writeText(text).then(() => {
        this.showNotification(_getMessage('copied', 'Copied!'));
      });
    },

    // Handle save action
    async handleSave(text, translation) {
      if (!translation) {
        this.setToolbarLoading(true);
        const result = await SelectionLookup.resolveWithParagraphs(text, this.selectionContext && this.selectionContext.paragraphs);
        this.setToolbarLoading(false);
        if (!result || result.error || !result.translation) {
          this.showNotification(statusText('translationFailed'));
          return;
        }
        this.saveResolvedResult(result);
        return;
      }

      this.saveResolvedResult({
        mode: SelectionLookup.getType(text),
        text,
        translation,
        dictionary: null
      });
    },

    saveResolvedResult(result) {
      safeSendMessage({
        action: 'save_to_vocabulary',
        data: SelectionLookup.getSavePayload(result)
      }, (response) => {
        this.showNotification(_getMessage('saved', 'Saved!'));
      });
    },

    // Show notification (singleton: reuse existing element, update text + reset timer)
    // - persistent=true: notification stays on screen until updated by a non-persistent call
    // - persistent=false (default): auto-dismiss after delay (random 2300-2800ms)
    // This design ensures only ONE notification is ever visible per translation session.
    showNotification(message, persistent = false) {
      // Reuse existing notification or create new one — never destroy+recreate
      let notification = document.querySelector('.lingoflow-notification');

      if (notification) {
        // Update text content of existing notification
        notification.textContent = message;
        // Ensure it's in visible state (re-apply show class if it was fading out)
        notification.classList.remove('lingoflow-notification-hiding');
        notification.classList.add('lingoflow-notification-show');

        // Cancel pending auto-dismiss from previous message
        if (notification._lfDismissTimer) {
          clearTimeout(notification._lfDismissTimer);
          notification._lfDismissTimer = null;
        }
        if (notification._lfRemoveTimer) {
          clearTimeout(notification._lfRemoveTimer);
          notification._lfRemoveTimer = null;
        }
      } else {
        // First call: create the singleton notification element
        notification = document.createElement('div');
        notification.className = 'lingoflow-notification';
        notification.textContent = message;
        document.body.appendChild(notification);

        // Trigger entrance animation on next frame
        requestAnimationFrame(() => {
          notification.classList.add('lingoflow-notification-show');
        });
      }

      if (!persistent) {
        // Random jitter: 2300-2800ms so consecutive notifications don't all
        // dismiss at the exact same moment (visual overlap prevention)
        const dismissDelay = 2300 + Math.floor(Math.random() * 500);

        // Auto-dismiss after delay
        notification._lfDismissTimer = setTimeout(() => {
          notification.classList.remove('lingoflow-notification-show');
          notification.classList.add('lingoflow-notification-hiding');

          // Remove DOM element after fade-out transition completes
          notification._lfRemoveTimer = setTimeout(() => {
            if (notification.parentNode) notification.remove();
          }, 300);
        }, dismissDelay);
      }
      // If persistent=true: no dismiss timer is set; notification stays until
      // a subsequent non-persistent call updates it and sets the timer.
    },

    // Escape HTML
    escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  };

  // Event Handlers
  const EventHandlers = {
    selectionTimer: null,
    lastSelectionKey: '',

    // Handle text selection
    scheduleSelectionToolbar(e, delay = 100) {
      if (!state.selectionTranslationEnabled) return;
      if (e.target && e.target.closest && e.target.closest('.lingoflow-ui')) return;
      clearTimeout(this.selectionTimer);
      this.selectionTimer = window.setTimeout(() => this.handleTextSelection(e), delay);
    },

    handleTextSelection(e) {
      if (!state.selectionTranslationEnabled) return;
      if (e && e.target && e.target.closest && e.target.closest('.lingoflow-ui')) return;

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        this.lastSelectionKey = '';
        UI.removeFloatingToolbar();
        return;
      }

      const selectedText = selection.toString().trim();

      if (selectedText.length > 0) {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) return;
        const paragraphs = EventHandlers.extractSelectionParagraphs(range, selectedText);

        const selectionKey = `${selectedText}|${Math.round(rect.left)}|${Math.round(rect.top)}|${Math.round(rect.width)}|${Math.round(rect.height)}`;
        if (selectionKey === this.lastSelectionKey && document.getElementById('lingoflow-toolbar')) return;
        this.lastSelectionKey = selectionKey;

        UI.createFloatingToolbar({
          text: selectedText,
          paragraphs,
          rect: {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height
          },
          scrollX: window.scrollX,
          scrollY: window.scrollY
        });
      } else {
        this.lastSelectionKey = '';
        UI.removeFloatingToolbar();
      }
    },

    extractSelectionParagraphs(range, selectedText) {
      const blockSelector = 'p, li, blockquote, dd, dt, figcaption, h1, h2, h3, h4, h5, h6';
      const root = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
      if (!root) return SelectionLookup.splitParagraphs(selectedText);

      const candidates = [];
      if (root.matches && root.matches(blockSelector)) candidates.push(root);
      root.querySelectorAll && candidates.push(...root.querySelectorAll(blockSelector));

      const selectedNormalized = PageTranslator.normalizeText(selectedText);
      const parts = [];
      const seen = new Set();

      candidates.forEach(el => {
        if (!range.intersectsNode(el)) return;
        if (el.closest && el.closest('[data-lingoflow], .lingoflow-ui')) return;
        const text = PageTranslator.normalizeText(el.innerText || el.textContent || '');
        if (!text || seen.has(text)) return;
        if (text.length < 2 || !selectedNormalized.includes(text.slice(0, Math.min(24, text.length)))) return;
        seen.add(text);
        parts.push(text);
      });

      if (parts.length > 1) return parts;
      return SelectionLookup.splitParagraphs(selectedText);
    },

    findHoverParagraphTarget(target) {
      if (!target || !state.hoverParagraphTranslationEnabled) return null;
      if (target.closest && target.closest('.lingoflow-ui, [data-lingoflow]')) return null;
      if (window.getSelection && String(window.getSelection()).trim()) return null;

      let el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
      const paragraphTags = new Set(['P', 'LI', 'BLOCKQUOTE', 'DD', 'DT', 'FIGCAPTION', 'ARTICLE', 'SECTION', 'ASIDE']);

      for (let depth = 0; el && el !== document.body && depth < 7; depth++, el = el.parentElement) {
        if (PageTranslator.skipTags.has(el.tagName)) return null;
        if (PageTranslator.shouldSkipContainer(el)) continue;
        if (el.dataset.lingoflowProcessed === 'true' || el.dataset.lingoflowHoverLoading === 'true') return null;
        if (PageTranslator.hasExistingTranslation(el) || PageTranslator.hasLinkedTranslation(el)) return null;

        const text = PageTranslator.normalizeText(PageTranslator.getElementText(el));
        const isParagraphTag = paragraphTags.has(el.tagName);
        const isReadableDiv = el.tagName === 'DIV' &&
          text.length >= 40 &&
          text.length <= 1500 &&
          el.children.length <= 6 &&
          !PageTranslator.isDataContentElement(el);

        if ((isParagraphTag || isReadableDiv) && PageTranslator.shouldTranslateText(text)) {
          return el;
        }
      }

      return null;
    },

    scheduleHoverParagraphTranslation(e) {
      const target = this.findHoverParagraphTarget(e.target);
      if (!target) return;
      if (state.hoverParagraphTarget === target) return;

      clearTimeout(state.hoverParagraphTimer);
      state.hoverParagraphTarget = target;
      state.hoverParagraphTimer = window.setTimeout(() => {
        this.translateHoveredParagraph(target);
      }, 300);
    },

    cancelHoverParagraphTranslation(e) {
      const target = state.hoverParagraphTarget;
      if (!target) return;
      if (e && e.relatedTarget && target.contains(e.relatedTarget)) return;
      clearTimeout(state.hoverParagraphTimer);
      state.hoverParagraphTimer = null;
      state.hoverParagraphTarget = null;
    },

    async translateHoveredParagraph(container) {
      if (!state.hoverParagraphTranslationEnabled || !container || !container.isConnected) return;
      if (state.hoverParagraphInFlight >= 2) return;
      if (container.dataset.lingoflowProcessed === 'true' || container.dataset.lingoflowHoverLoading === 'true') return;
      if (PageTranslator.hasExistingTranslation(container) || PageTranslator.hasLinkedTranslation(container)) return;

      const text = PageTranslator.normalizeText(PageTranslator.getElementText(container));
      if (!PageTranslator.shouldTranslateText(text)) return;

      const cacheKey = `${state.targetLanguage}:${text.toLowerCase()}`;
      const cached = state.hoverParagraphCache.get(cacheKey);
      container.dataset.lingoflowHoverLoading = 'true';
      state.hoverParagraphInFlight++;

      try {
        const translation = cached || await TranslationEngine.translate(text, state.targetLanguage || 'zh');
        if (!cached && translation && !isFallbackText(translation)) {
          state.hoverParagraphCache.set(cacheKey, translation);
        }
        if (!translation || isFallbackText(translation)) return;
        if (!container.isConnected) return;
        if (PageTranslator.hasExistingTranslation(container) || PageTranslator.hasLinkedTranslation(container)) return;

        PageTranslator.markProcessed(container);
        const rendered = PageTranslator.renderTranslationUnit(container, translation);
        if (rendered) {
          container.setAttribute('data-lingoflow-hover-rendered', 'true');
          state.isTranslated = true;
        } else {
          container.removeAttribute('data-lingoflow-processed');
        }
      } catch (err) {
        console.warn('LingoFlow: Hover paragraph translation failed:', getErrorMessage(err));
      } finally {
        state.hoverParagraphInFlight = Math.max(0, state.hoverParagraphInFlight - 1);
        container.removeAttribute('data-lingoflow-hover-loading');
        if (state.hoverParagraphTarget === container) {
          state.hoverParagraphTarget = null;
        }
      }
    },

    // Handle messages from background script (exposed globally for top-level listener)
    handleMessage(request, sender, sendResponse) {
      switch (request.action) {
        case 'sync_settings':
          // Immediately apply settings pushed from popup (no reload needed)
          {
            const s = request.settings || {};
            const wasSelectionEnabled = state.selectionTranslationEnabled;
            const wasHoverEnabled = state.hoverParagraphTranslationEnabled;
            state.selectionTranslationEnabled = s.selectionTranslation !== false;
            state.hoverParagraphTranslationEnabled = s.hoverParagraphTranslation === true;
            state.toolbarPosition = s.toolbarPosition || 'above';
            state.uiLanguage = s.uiLanguage || 'auto';
            state.targetLanguage = s.targetLanguage || 'zh';
            state.existingBilingualStrategy = s.existingBilingualStrategy || 'skip';
            TranslationEngine.activeEngine = s.translationEngine || 'google';
            if (wasSelectionEnabled && !state.selectionTranslationEnabled) {
              UI.removeFloatingToolbar();
              UI.removeTranslationResult();
            }
            if (wasHoverEnabled && !state.hoverParagraphTranslationEnabled) {
              clearTimeout(state.hoverParagraphTimer);
              state.hoverParagraphTimer = null;
              state.hoverParagraphTarget = null;
            }
          }
          sendResponse({ received: true });
          break;

        case 'translate_selection':
          UI.showResultForText(request.text);
          sendResponse({ received: true });
          break;

        case 'save_selection':
          UI.saveTextWithResolvedResult(request.text);
          sendResponse({ received: true });
          break;

        case 'copy_selection':
          UI.handleCopy(request.text || '');
          sendResponse({ received: true });
          break;

        case 'translate_page':
          PageTranslator.enableTranslationMode();
          sendResponse({ received: true });
          break;

        case 'bilingual_mode':
          PageTranslator.toggleBilingualMode();
          sendResponse({ received: true });
          break;

        case 'restore_original':
          // Force restore: ignore isTranslating lock, reset state first
          state.isTranslating = false;
          PageTranslator.restoreOriginal();
          sendResponse({ received: true });
          break;

        case 'get_page_state':
          sendResponse({
            received: true,
            mode: this.getPageMode()
          });
          break;

        default:
          sendResponse({ received: false });
      }
    }
,

    getPageMode() {
      const hasBilingualDom = document.querySelector(
        '.lingoflow-block[data-lingoflow="true"], .lingoflow-inline-translation[data-lingoflow="true"]'
      );
      const hasTranslationDom = document.querySelector(
        '.lingoflow-translation-only[data-lingoflow="true"], [data-lingoflow-hidden]'
      );

      if (state.isBilingualMode && hasBilingualDom) return 'bilingual';
      if (state.isTranslated && hasTranslationDom) return 'translate';
      if (state.isTranslated && hasBilingualDom && !hasTranslationDom) return 'bilingual';

      if (state.isBilingualMode && !hasBilingualDom) {
        state.isBilingualMode = false;
        state.isTranslated = !!hasTranslationDom;
      }
      if (state.isTranslated && !hasTranslationDom && !hasBilingualDom) {
        state.isTranslated = false;
      }

      if (hasBilingualDom && !hasTranslationDom) return 'bilingual';
      if (hasTranslationDom) return 'translate';
      return null;
    }
  };

  // Bind message dispatcher now that EventHandlers is defined
  _dispatchMessage = (req, sender, res) => EventHandlers.handleMessage(req, sender, res);
  console.log('LingoFlow: Message handler bound');

  // Page Translator
  const PageTranslator = {
    skipTags: new Set([
      'SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'BUTTON',
      'SVG', 'CANVAS', 'IFRAME', 'NOSCRIPT'
    ]),

    skipSelectors: [
      '[data-lingoflow]',
      '[data-lingoflow-processed="true"]',
      '.lingoflow-ui',
      '#lingoflow-translation-result'
    ].join(','),

    blockTags: new Set([
      'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'BLOCKQUOTE', 'TD', 'TH', 'FIGCAPTION', 'DD', 'DT'
    ]),

    nestedBlockTags: new Set([
      'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIALOG',
      'DIV', 'DL', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM',
      'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR',
      'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'UL'
    ]),

    normalizeText(text) {
      return (text || '').replace(/\s+/g, ' ').trim();
    },

    // 常见英文缩写（不在此处断句）
    _ABBREVIATIONS: new Set([
      'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Sr', 'Jr', 'Rev', 'Gen', 'Col',
      'Capt', 'Lt', 'Sgt', 'Rep', 'Sen', 'St', 'Ave', 'Blvd', 'Rd',
      'Co', 'Inc', 'Ltd', 'Corp', 'vs', 'etc', 'eg', 'ie', 'est',
      'vol', 'no', 'pp', 'ch', 'fig', 'ref', 'al', 'ed', 'et'
    ]),

    /**
     * 将长文本按句子边界拆分为多个句子。
     * 规则：以 . ! ? 为分隔符，但排除缩写、数字/版本号等误判场景。
     * 返回拆分后的句子数组；若文本较短或无法拆分则返回 [原文]。
     */
    splitIntoSentences(text) {
      if (!text || text.length < 80) return [text];

      const sentences = [];
      // 按句末标点 + 后跟空格/大写字母/引号/结尾 来分割
      const parts = text.split(/(?<=[.!?])\s+(?=[A-Z"'\u201c\u2018]|$)/);

      for (let i = 0; i < parts.length; i++) {
        let part = this.normalizeText(parts[i]);
        if (!part) continue;

        // 检查是否是缩写导致的误分割（如 "U.S."）
        const lastPeriod = part.lastIndexOf('.');
        if (lastPeriod > 0 && lastPeriod === part.length - 1) {
          const wordBeforeDot = part.slice(0, lastPeriod).replace(/[^a-zA-Z]+$/, '');
          if (this._ABBREVIATIONS.has(wordBeforeDot) || /\d/.test(wordBeforeDot)) {
            // 缩写或数字 → 合并到下一个片段（如果有）
            if (sentences.length > 0) {
              sentences[sentences.length - 1] += ' ' + part;
            } else {
              sentences.push(part);
            }
            continue;
          }
        }

        sentences.push(part);
      }

      // 过滤过短碎片，合并到前一句
      const merged = [];
      for (const s of sentences) {
        if (s.length < 8 && merged.length > 0) {
          merged[merged.length - 1] += ' ' + s;
        } else {
          merged.push(s);
        }
      }

      // 只有拆出2+句且每句都够长才返回拆分结果
      if (merged.length >= 2 && merged.every(s => s.length >= 10)) {
        return merged;
      }
      return [text];
    },

    getTextStats(text) {
      const normalized = this.normalizeText(text);
      const content = normalized.replace(/[\s\d\p{P}\p{S}]/gu, '');
      let cjkCount = 0;
      let latinCount = 0;

      for (const ch of content) {
        if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) cjkCount++;
        if (/[A-Za-z]/.test(ch)) latinCount++;
      }

      return {
        normalized,
        contentLength: content.length,
        cjkCount,
        latinCount,
        cjkRatio: content.length ? cjkCount / content.length : 0
      };
    },

    hasLatinText(text) {
      return this.getTextStats(text).latinCount >= 2;
    },

    hasChineseText(text) {
      const stats = this.getTextStats(text);
      return stats.cjkCount >= 2 && stats.cjkRatio >= 0.3;
    },

    // 页面翻译过滤：固定只翻译英文→中文
    // （"翻译为"设置仅影响划词翻译，不影响页面翻译）
    shouldTranslateText(text) {
      const normalized = this.normalizeText(text);
      if (normalized.length < 3) return false;
      if (normalized.length > 5000) return false;
      if (/^\d+([.,:/-]\d+)*$/.test(normalized)) return false;
      if (!/[A-Za-z0-9]/.test(normalized.replace(/[^\p{L}\p{N}]/gu, ''))) return false;
      if (isAllCapsShortLabel(normalized)) return false;

      // 页面翻译固定英译中：只翻含英文的文本
      if (isChineseText(normalized)) return false;
      if (!/[A-Za-z]{2,}/.test(normalized)) return false;
      if (hasMixedLatinAndChinese(normalized)) return false;
      return true;
    },

    getElementText(element) {
      if (!element) return '';
      return this.normalizeText(element.innerText || element.textContent || '');
    },

    hasChineseSibling(container) {
      const siblings = [
        container.previousElementSibling,
        container.nextElementSibling
      ].filter(Boolean);

      return siblings.some(sibling => {
        if (sibling.matches && sibling.matches('[data-lingoflow], .lingoflow-ui')) return false;
        return this.hasChineseText(this.getElementText(sibling));
      });
    },

    hasBilingualChildren(scope) {
      if (!scope || scope === document.body || scope === document.documentElement) return false;
      const scopeText = this.getElementText(scope);
      if (scopeText.length > 1500 || scope.children.length > 20) return false;

      let hasEnglishChild = false;
      let hasChineseChild = false;
      const children = Array.from(scope.children).filter(child => {
        return !(child.matches && child.matches('[data-lingoflow], .lingoflow-ui'));
      });

      for (const child of children) {
        const text = this.getElementText(child);
        if (this.hasLatinText(text)) hasEnglishChild = true;
        if (this.hasChineseText(text)) hasChineseChild = true;
        if (hasEnglishChild && hasChineseChild) return true;
      }

      return false;
    },

    // Detect data content elements: tables, charts, diagrams, tree structures,
    // and any structured information display. These should NEVER be UI chrome.
    isDataContentElement(el) {
      if (!el || el === document.body || el === document.documentElement) return false;

      const tag = el.tagName;
      const text = this.getElementText(el);

      // Must have some Latin text to be considered content
      if (text.length < 8 || !this.hasLatinText(text)) return false;

      // TABLE elements and their parts are always data content
      if (['TABLE', 'TBODY', 'THEAD', 'TR'].includes(tag)) return true;

      // Check for table-like grid layout (many cells arranged in rows)
      const clsId = (' ' + (el.className || '') + ' ' + ' ' + (el.id || '') + ' ').toLowerCase();
      const dataPatterns = [
        'table', '-table', '_table',
        'chart', '-chart', ' graph', ' diagram',
        'tree', '-tree', ' node', ' branch',
        'grid ', ' grid-', ' grid_',
        ' snapshot', ' report', ' metric',
        'data-', 'data_', '-data',
        ' figure', ' fig-',
        ' visual', ' visualization',
        ' hierarchy', ' org',
        ' flow', '-flow', ' workflow'
      ];
      for (const p of dataPatterns) {
        if (clsId.includes(p)) return true;
      }

      // Check if element contains table rows or a grid of text-bearing children
      const children = Array.from(el.children);
      const hasTableChild = children.some(c =>
        ['TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH'].includes(c.tagName)
      );
      if (hasTableChild && text.length >= 12) return true;

      // Grid detection: many same-level children each with short text
      // (typical for tree diagrams, org charts, flow charts)
      const textChildren = children.filter(c => {
        const ct = this.getElementText(c);
        return ct.length >= 2 && this.hasLatinText(ct) && c.children.length <= 6;
      });
      if (textChildren.length >= 3 && text.length >= 20) return true;

      return false;
    },

    hasBilingualDescendants(scope) {
      if (!scope || scope === document.body || scope === document.documentElement) return false;

      const scopeText = this.getElementText(scope);
      if (scopeText.length < 6 || scopeText.length > 1500) return false;
      if (!this.hasLatinText(scopeText) || !this.hasChineseText(scopeText)) return false;

      const candidates = Array.from(scope.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div, span, strong, b, li, td, th'));
      let hasEnglish = false;
      let hasChinese = false;

      for (const candidate of candidates.slice(0, 50)) {
        if (candidate.matches && candidate.matches('[data-lingoflow], .lingoflow-ui')) continue;
        const text = this.getElementText(candidate);
        if (this.hasLatinText(text)) hasEnglish = true;
        if (this.hasChineseText(text)) hasChinese = true;
        if (hasEnglish && hasChinese) return true;
      }

      return false;
    },

    // Detect data content elements: tables, charts, diagrams, tree structures,
    // and any structured information display. These should NEVER be UI chrome.
    isDataContentElement(el) {
      if (!el || el === document.body || el === document.documentElement) return false;

      const tag = el.tagName;
      const text = this.getElementText(el);

      // Must have some Latin text to be considered content
      if (text.length < 8 || !this.hasLatinText(text)) return false;

      // TABLE elements and their parts are always data content
      if (['TABLE', 'TBODY', 'THEAD', 'TR'].includes(tag)) return true;

      // Check for table-like grid layout (many cells arranged in rows)
      const clsId = (' ' + (el.className || '') + ' ' + ' ' + (el.id || '') + ' ').toLowerCase();
      const dataPatterns = [
        'table', '-table', '_table',
        'chart', '-chart', ' graph', ' diagram',
        'tree', '-tree', ' node', ' branch',
        'grid ', ' grid-', ' grid_',
        ' snapshot', ' report', ' metric',
        'data-', 'data_', '-data',
        ' figure', ' fig-',
        ' visual', ' visualization',
        ' hierarchy', ' org',
        ' flow', '-flow', ' workflow'
      ];
      for (const p of dataPatterns) {
        if (clsId.includes(p)) return true;
      }

      // Check if element contains table rows or a grid of text-bearing children
      const children = Array.from(el.children);
      const hasTableChild = children.some(c =>
        ['TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH'].includes(c.tagName)
      );
      if (hasTableChild && text.length >= 12) return true;

      // Grid detection: many same-level children each with short text
      // (typical for tree diagrams, org charts, flow charts)
      const textChildren = children.filter(c => {
        const ct = this.getElementText(c);
        return ct.length >= 2 && this.hasLatinText(ct) && c.children.length <= 6;
      });
      if (textChildren.length >= 3 && text.length >= 20) return true;

      return false;
    },

    hasBilingualParent(container) {
      const parent = container.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) return false;

      // 过滤掉已翻译的 UI 元素和已处理的元素
      const children = Array.from(parent.children).filter(c => {
        if (c.matches && c.matches('[data-lingoflow], .lingoflow-ui')) return false;
        if (c.dataset && c.dataset.lingoflowProcessed === 'true') return false;
        return true;
      });

      // 只检查当前容器之前的兄弟元素，避免检测到自己之后插入的翻译
      const containerIndex = children.indexOf(container);
      if (containerIndex <= 0) return false; // 没有之前的兄弟元素

      const prevSiblings = children.slice(0, containerIndex);

      const hasEnglish = prevSiblings.some(c => this.hasLatinText(this.getElementText(c)));
      const hasChinese = prevSiblings.some(c => this.hasChineseText(this.getElementText(c)));

      return hasEnglish && hasChinese;
    },

    hasBilingualAncestor(container) {
      let scope = container.parentElement;
      for (let depth = 0; scope && depth < 8; depth++, scope = scope.parentElement) {
        if (this.hasBilingualChildren(scope) || this.hasBilingualDescendants(scope)) {
          return true;
        }
      }
      return false;
    },

    // Detect data content elements: tables, charts, diagrams, tree structures,
    // and any structured information display. These should NEVER be UI chrome.
    isDataContentElement(el) {
      if (!el || el === document.body || el === document.documentElement) return false;

      const tag = el.tagName;
      const text = this.getElementText(el);

      // Must have some Latin text to be considered content
      if (text.length < 8 || !this.hasLatinText(text)) return false;

      // TABLE elements and their parts are always data content
      if (['TABLE', 'TBODY', 'THEAD', 'TR'].includes(tag)) return true;

      // Check for table-like grid layout (many cells arranged in rows)
      const clsId = (' ' + (el.className || '') + ' ' + ' ' + (el.id || '') + ' ').toLowerCase();
      const dataPatterns = [
        'table', '-table', '_table',
        'chart', '-chart', ' graph', ' diagram',
        'tree', '-tree', ' node', ' branch',
        'grid ', ' grid-', ' grid_',
        ' snapshot', ' report', ' metric',
        'data-', 'data_', '-data',
        ' figure', ' fig-',
        ' visual', ' visualization',
        ' hierarchy', ' org',
        ' flow', '-flow', ' workflow'
      ];
      for (const p of dataPatterns) {
        if (clsId.includes(p)) return true;
      }

      // Check if element contains table rows or a grid of text-bearing children
      const children = Array.from(el.children);
      const hasTableChild = children.some(c =>
        ['TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH'].includes(c.tagName)
      );
      if (hasTableChild && text.length >= 12) return true;

      // Grid detection: many same-level children each with short text
      // (typical for tree diagrams, org charts, flow charts)
      const textChildren = children.filter(c => {
        const ct = this.getElementText(c);
        return ct.length >= 2 && this.hasLatinText(ct) && c.children.length <= 6;
      });
      if (textChildren.length >= 3 && text.length >= 20) return true;

      return false;
    },

    // Detect data content elements: tables, charts, diagrams, tree structures,
    // and any structured information display. These should NEVER be UI chrome.
    isDataContentElement(el) {
      if (!el || el === document.body || el === document.documentElement) return false;

      const tag = el.tagName;
      const text = this.getElementText(el);

      // Must have some Latin text to be considered content
      if (text.length < 8 || !this.hasLatinText(text)) return false;

      // TABLE elements and their parts are always data content
      if (['TABLE', 'TBODY', 'THEAD', 'TR'].includes(tag)) return true;

      // Check for table-like grid layout (many cells arranged in rows)
      const clsId = (' ' + (el.className || '') + ' ' + ' ' + (el.id || '') + ' ').toLowerCase();
      const dataPatterns = [
        'table', '-table', '_table',
        'chart', '-chart', ' graph', ' diagram',
        'tree', '-tree', ' node', ' branch',
        'grid ', ' grid-', ' grid_',
        ' snapshot', ' report', ' metric',
        'data-', 'data_', '-data',
        ' figure', ' fig-',
        ' visual', ' visualization',
        ' hierarchy', ' org',
        ' flow', '-flow', ' workflow'
      ];
      for (const p of dataPatterns) {
        if (clsId.includes(p)) return true;
      }

      // Check if element contains table rows or a grid of text-bearing children
      const children = Array.from(el.children);
      const hasTableChild = children.some(c =>
        ['TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH'].includes(c.tagName)
      );
      if (hasTableChild && text.length >= 12) return true;

      // Grid detection: many same-level children each with short text
      // (typical for tree diagrams, org charts, flow charts)
      const textChildren = children.filter(c => {
        const ct = this.getElementText(c);
        return ct.length >= 2 && this.hasLatinText(ct) && c.children.length <= 6;
      });
      if (textChildren.length >= 3 && text.length >= 20) return true;

      return false;
    },

    isHeadingContainer(container) {
      return !!container && (/^H[1-6]$/.test(container.tagName) ||
        container.getAttribute('role') === 'heading');
    },

    hasCatalogCardTranslation(container) {
      let scope = container.parentElement;
      for (let depth = 0; scope && depth < 5; depth++, scope = scope.parentElement) {
        if (scope === document.body || scope === document.documentElement) return false;

        const text = this.getElementText(scope);
        if (text.length > 520 || text.length < 6) continue;
        if (!this.hasLatinText(text) || !this.hasChineseText(text)) continue;

        const hasDate = /\b20\d{2}[\/.-]\d{1,2}([\/.-]\d{1,2})?\b/.test(text);
        const listLike = !!scope.closest('li, [role="listitem"], [role="list"], aside, nav, [role="navigation"]');
        if ((hasDate || listLike) && this.hasBilingualDescendants(scope)) return true;
      }

      return false;
    },

    // Detect data content elements: tables, charts, diagrams, tree structures,
    // and any structured information display. These should NEVER be UI chrome.
    isDataContentElement(el) {
      if (!el || el === document.body || el === document.documentElement) return false;

      const tag = el.tagName;
      const text = this.getElementText(el);

      // Must have some Latin text to be considered content
      if (text.length < 8 || !this.hasLatinText(text)) return false;

      // TABLE elements and their parts are always data content
      if (['TABLE', 'TBODY', 'THEAD', 'TR'].includes(tag)) return true;

      // Check for table-like grid layout (many cells arranged in rows)
      const clsId = (' ' + (el.className || '') + ' ' + ' ' + (el.id || '') + ' ').toLowerCase();
      const dataPatterns = [
        'table', '-table', '_table',
        'chart', '-chart', ' graph', ' diagram',
        'tree', '-tree', ' node', ' branch',
        'grid ', ' grid-', ' grid_',
        ' snapshot', ' report', ' metric',
        'data-', 'data_', '-data',
        ' figure', ' fig-',
        ' visual', ' visualization',
        ' hierarchy', ' org',
        ' flow', '-flow', ' workflow'
      ];
      for (const p of dataPatterns) {
        if (clsId.includes(p)) return true;
      }

      // Check if element contains table rows or a grid of text-bearing children
      const children = Array.from(el.children);
      const hasTableChild = children.some(c =>
        ['TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH'].includes(c.tagName)
      );
      if (hasTableChild && text.length >= 12) return true;

      // Grid detection: many same-level children each with short text
      // (typical for tree diagrams, org charts, flow charts)
      const textChildren = children.filter(c => {
        const ct = this.getElementText(c);
        return ct.length >= 2 && this.hasLatinText(ct) && c.children.length <= 6;
      });
      if (textChildren.length >= 3 && text.length >= 20) return true;

      return false;
    },

    hasExistingTranslation(container) {
      if (state.existingBilingualStrategy === 'translate_english') return false;

      // Only check the container's OWN text for mixed Chinese+English.
      // This is the ONLY reliable signal of genuine pre-existing translation.
      // All sibling/parent/ancestor checks have been removed because they cause
      // severe self-interference during batch rendering (paragraph N+1 detects
      // paragraph N's freshly-inserted Chinese translation as "existing bilingual").
      const text = this.getElementText(container);
      return this.hasLatinText(text) && this.hasChineseText(text);
    },

    shouldSkipTextNode(node) {
      if (!node || node.nodeType !== Node.TEXT_NODE || !node.parentElement) return true;

      // Block-level content tags are NEVER UI chrome — skip _isUiChromeElement check
      const blockContentTags = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
                                        'BLOCKQUOTE', 'TD', 'TH', 'DD', 'DT', 'FIGCAPTION']);

      let element = node.parentElement;
      let depth = 0;
      while (element && depth < 4) {
        if (this.skipTags.has(element.tagName)) return true;
        if (element.matches && element.matches(this.skipSelectors)) return true;
        if (element.isContentEditable) return true;
        // Skip elements hidden by a previous translation (not yet fully restored)
        if (element.hasAttribute && element.hasAttribute('data-lingoflow-hidden')) return true;

        // === NEW: Skip text nodes inside UI chrome elements (nav, sidebar, header) ===
        // Check the ancestor chain for UI patterns, so even deeply nested text
        // nodes in navbars/sidebars are caught early.
        // NOTE: Skip _isUiChromeElement for known block-level content tags —
        // they are never UI chrome, and their geometry (wide+short) can cause false positives.
        if (!blockContentTags.has(element.tagName) && this._isUiChromeElement(element)) return true;

        element = element.parentElement;
        depth++;
      }

      return !this.shouldTranslateText(node.textContent);
    },

    // Detect elements that look like content cards (e.g., course module cards,
    // feature cards, info cards). These should NEVER be treated as UI chrome.
    isCardLikeElement(el) {
      if (!el || el === document.body || el === document.documentElement) return false;

      const tag = el.tagName;
      // Cards are typically DIVs, SECTIONs, ARTICLEs, LIs, or TABLEs
      if (!['DIV', 'SECTION', 'ARTICLE', 'LI', 'TABLE', 'TBODY', 'THEAD'].includes(tag)) return false;

      const text = this.getElementText(el);

      // Must have some Latin text content (but can be short — cards are concise)
      if (text.length < 10 || !this.hasLatinText(text)) return false;

      // === TABLE fast-path: any table with Latin text is content ===
      if (tag === 'TABLE') return true;
      if (tag === 'TBODY' || tag === 'THEAD') return true;

      // Check for card structural patterns:
      const children = Array.from(el.children);

      // Pattern 1: Has at least one heading (H1-H6) + one paragraph/block child
      const hasHeading = children.some(c => /^H[1-6]$/.test(c.tagName));
      const hasBlock = children.some(c => ['P', 'DIV', 'SPAN', 'SECTION', 'ARTICLE'].includes(c.tagName));
      if (hasHeading && hasBlock && text.length >= 20) return true;

      // Pattern 2: Class/id contains card-like tokens
      const clsId = (' ' + (el.className || '') + ' ' + ' ' + (el.id || '') + ' ').toLowerCase();
      const cardPatterns = [
        // Card / tile patterns
        'card ', ' card-', ' card_', ' cards ', '-card', '_card',
        'tile ', ' tile-', ' tile_',
        // Content module patterns
        'module ', ' module-', ' module_',
        'item ', ' item-', ' item_',
        'feature ', ' feature-',
        'course ', ' course-', ' course_',
        'lesson ', ' lesson-', ' lesson_',
        'unit ', ' unit-', ' unit_',
        'topic ', ' topic-', ' topic_',
        'step ', ' step-', ' step_',
        'block ', ' block-', ' block_',
        // Table / data patterns (NEW)
        'table', '-table', '_table',
        'data-table', 'datatable', 'data_grid',
        'chart', '-chart', '_chart', ' graph', ' diagram',
        'grid ', ' grid-', ' grid_',
        'row ', '-row', ' row_', ' cell', ' column',
        'snapshot', '-snapshot',
        // Tree / hierarchy patterns (NEW)
        'tree', '-tree', '_tree', ' node', ' branch',
        'hierarchy', ' org-chart',
        // Info box / panel patterns (NEW)
        'info ', ' info-', ' info_',
        'panel ', ' panel-', ' panel_', ' sheet',
        'container', ' wrapper', ' box', ' frame',
        // Doc site callout/note patterns (NEW)
        'callout', '-callout', '_callout',
        'note', '-note', '_note',
        'alert', '-alert', '_alert',
        'warning', '-warning', '_warning',
        'tip', '-tip', '_tip',
        'admonition', '-admonition',
        'important', '-important',
        'caution', '-caution'
      ];
      for (const p of cardPatterns) {
        if (clsId.includes(p)) return true;
      }

      // Pattern 2b: Contains table rows or cells as direct/indirect children → it's a data table
      const hasTableChild = children.some(c =>
        ['TABLE', 'TBODY', 'THEAD', 'TR'].includes(c.tagName)
      );
      if (hasTableChild && text.length >= 15) return true;

      // Pattern 2c: Contains many small text blocks arranged in a grid-like structure
      // (common for tree diagrams, flow charts, organizational charts)
      const leafDivs = children.filter(c =>
        c.tagName === 'DIV' &&
        this.getElementText(c).length >= 3 &&
        c.children.length <= 4
      );
      if (leafDivs.length >= 3 && text.length >= 20) return true;

      // Pattern 3: Element has visible border/background + substantial text
      // (common for styled card components)
      try {
        const style = window.getComputedStyle(el);
        const hasBorder = style.borderWidth !== '0px' && style.borderStyle !== 'none';
        const hasBg = style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
                      style.backgroundColor !== 'transparent';
        const hasBorderRadius = parseInt(style.borderRadius, 10) > 2;
        if ((hasBorder || hasBg) && hasBorderRadius && text.length >= 20) {
          return true;
        }
      } catch (_) {}

      // Pattern 4: Content section with structured heading pattern
      // (e.g., "1. Data-driven attribution", "2. Paid and organic last click")
      const headingTextMatch = this.getElementText(el).match(
        /^\s*\d+[\.\)]\s+[A-Z]/m
      );
      if (headingTextMatch && text.length >= 15 && this.hasLatinText(text)) {
        // Has a numbered heading + body text → it's a content section/card
        const childCount = el.children.length;
        if (childCount >= 1) return true;
      }

      // Pattern 5: Element contains bold/strong headings followed by paragraphs
      // (typical for info cards, explanation boxes, feature descriptions)
      const boldChildren = children.filter(c => {
        if (!c.querySelector) return false;
        const strongOrBold = c.querySelector('strong, b, [style*="font-weight"]');
        if (!strongOrBold) return false;
        const ct = this.getElementText(c);
        return ct.length >= 5 && this.hasLatinText(ct);
      });
      if (boldChildren.length >= 1 && text.length >= 30) return true;

      return false;
    },

    // Detect data content elements: tables, charts, diagrams, tree structures,
    // and any structured information display. These should NEVER be UI chrome.
    isDataContentElement(el) {
      if (!el || el === document.body || el === document.documentElement) return false;

      const tag = el.tagName;
      const text = this.getElementText(el);

      // Must have some Latin text to be considered content
      if (text.length < 8 || !this.hasLatinText(text)) return false;

      // TABLE elements and their parts are always data content
      if (['TABLE', 'TBODY', 'THEAD', 'TR'].includes(tag)) return true;

      // Check for table-like grid layout (many cells arranged in rows)
      const clsId = (' ' + (el.className || '') + ' ' + ' ' + (el.id || '') + ' ').toLowerCase();
      const dataPatterns = [
        'table', '-table', '_table',
        'chart', '-chart', ' graph', ' diagram',
        'tree', '-tree', ' node', ' branch',
        'grid ', ' grid-', ' grid_',
        ' snapshot', ' report', ' metric',
        'data-', 'data_', '-data',
        ' figure', ' fig-',
        ' visual', ' visualization',
        ' hierarchy', ' org',
        ' flow', '-flow', ' workflow'
      ];
      for (const p of dataPatterns) {
        if (clsId.includes(p)) return true;
      }

      // Check if element contains table rows or a grid of text-bearing children
      const children = Array.from(el.children);
      const hasTableChild = children.some(c =>
        ['TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH'].includes(c.tagName)
      );
      if (hasTableChild && text.length >= 12) return true;

      // Grid detection: many same-level children each with short text
      // (typical for tree diagrams, org charts, flow charts)
      const textChildren = children.filter(c => {
        const ct = this.getElementText(c);
        return ct.length >= 2 && this.hasLatinText(ct) && c.children.length <= 6;
      });
      if (textChildren.length >= 3 && text.length >= 20) return true;

      return false;
    },

    // Internal helper: detect UI chrome by walking up from a given element.
    _isUiChromeElement(el) {
      if (!el) return false;
      const tag = el.tagName;

      // === CARD GUARD: Content cards are NEVER UI chrome ===
      // Detect card-like elements (course cards, feature cards, module cards)
      // and immediately return false — these are always real content.
      if (this.isCardLikeElement(el)) return false;

      // === DATA CONTENT GUARD: Tables, charts, diagrams, trees are NEVER UI chrome ===
      if (this.isDataContentElement(el)) return false;

      // Semantic HTML — unambiguous chrome
      if (['NAV', 'ASIDE', 'HEADER', 'FOOTER'].includes(tag)) return true;

      // ARIA roles — unambiguous chrome
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (['navigation', 'banner', 'contentinfo', 'complementary', 'toolbar',
            'search', 'menu', 'menubar', 'tablist'].includes(role)) return true;

      // Class/id pattern match (fast path)
      const clsId = (' ' + (el.className || '') + ' ' +
                     ' ' + (el.id || '') + ' ').toLowerCase();

      // === GUARD: Check if this element has substantial text content ===
      // If it does, it's likely real content even if its class name matches
      // some UI patterns (e.g., "analytics-course" on a GA course page).
      const elText = this.getElementText(el);
      const hasRealContent = elText.length > 35 && this.hasLatinText(elText);

      const uiPatterns = [
        // Navigation (high confidence)
        'nav ', ' nav-', ' nav_', 'navbar ', 'nav-bar ', 'navitem ', 'nav-item ',
        'gnav ', 'gnav-', 'gb_', 'gb-',
        // Menu (high confidence)
        'menu ', ' menu-', ' menu_', 'menubar ', 'menu-item ', 'menu_item ',
        // Sidebar (high confidence)
        'sidebar ', 'side-bar ', 'side-nav ', 'side_nav ', 'sidepanel ',
        // Header / Footer (high confidence)
        'header ', ' header-', ' header_', 'masthead ', 'topbar ', 'top-bar ', 'toolbar ',
        'footer ', ' footer-', ' footer_', 'foot ', 'foot-', 'foot_',
        // Breadcrumb (medium confidence)
        ' breadcrumb', ' bread-crumb',
        // Drawer / Panel / Overlay (medium-high confidence)
        'drawer ', ' panel', ' panel-', ' panel_', ' overlay', ' modal', ' dialog',
        // Cookie / Consent / Banner (medium-high confidence)
        ' skip-link ', 'skip_to ', ' cookie', ' consent', ' banner- ', ' banner_',
        ' advert', ' ad-', ' sponsor', ' sponsor-',
        // Google-specific Material Design (MEDIUM confidence — may appear in content)
        ' mat-', 'mdc-',
        // Common CMS/framework patterns (MEDIUM confidence)
        ' wp-', 'wp_', ' elementor-', ' shopify-',
        ' ant-', ' mui-', ' chakra-', ' bootstrap-',
        // Generic UI widgets (MEDIUM confidence)
        ' widget-', ' widget_', ' component-', ' component_',
        ' icon-', ' icon_', ' btn-', ' btn_', ' button-', ' button_',
        ' tab-', ' tab_', 'tabs ', 'tablist ', 'tab-list ',
        ' badge-', ' badge_', ' tag-', ' tag_',
        ' pill-', ' pill_', ' chip-', ' chip_'
      ];

      // LOW-CONFIDENCE patterns (often appear in legitimate content pages):
      // These are ONLY checked when the element does NOT have substantial content.
      const lowConfidencePatterns = [
        'google', ' google-', ' goog-', ' goog_',
        'google-', ' material', ' material-', ' material_',
        ' toolbar-', ' toolbar_', ' action-bar', ' action_bar',
        ' control-', ' control_', ' utility-', ' utility_',
        ' analytics-', ' analytics_', ' skillshop-', ' skillshop_',
        ' coursera-', ' coursera_'
      ];

      // ONLY check pattern-based UI detection when element lacks real content.
      // This prevents false positives like "content-panel" or "docs-header" on
      // elements that clearly contain substantial English text.
      if (!hasRealContent) {
        for (const p of uiPatterns) {
          if (clsId.includes(p)) return true;
        }
        for (const p of lowConfidencePatterns) {
          if (clsId.includes(p)) return true;
        }

        // CSS: fixed/sticky positioning → likely chrome (only when no real content)
        try {
          const s = window.getComputedStyle(el);
          if (s.position === 'fixed' || s.position === 'sticky') return true;
        } catch (_) {}

        // Geometry: wide+short strip or narrow+tall sidebar
        // (only when no real content — avoids misclassifying short paragraphs)
        try {
          const r = el.getBoundingClientRect();
          if (r.width > window.innerWidth * 0.5 && r.height > 0 && r.height < 40) return true;
          if (r.width > 0 && r.width < 280 && r.height > window.innerHeight * 0.3) return true;
        } catch (_) {}
      }

      return false;
    },

    // Detect data content elements: tables, charts, diagrams, tree structures,
    // and any structured information display. These should NEVER be UI chrome.
    isDataContentElement(el) {
      if (!el || el === document.body || el === document.documentElement) return false;

      const tag = el.tagName;
      const text = this.getElementText(el);

      // Must have some Latin text to be considered content
      if (text.length < 8 || !this.hasLatinText(text)) return false;

      // TABLE elements and their parts are always data content
      if (['TABLE', 'TBODY', 'THEAD', 'TR'].includes(tag)) return true;

      // Check for table-like grid layout (many cells arranged in rows)
      const clsId = (' ' + (el.className || '') + ' ' + ' ' + (el.id || '') + ' ').toLowerCase();
      const dataPatterns = [
        'table', '-table', '_table',
        'chart', '-chart', ' graph', ' diagram',
        'tree', '-tree', ' node', ' branch',
        'grid ', ' grid-', ' grid_',
        ' snapshot', ' report', ' metric',
        'data-', 'data_', '-data',
        ' figure', ' fig-',
        ' visual', ' visualization',
        ' hierarchy', ' org',
        ' flow', '-flow', ' workflow'
      ];
      for (const p of dataPatterns) {
        if (clsId.includes(p)) return true;
      }

      // Check if element contains table rows or a grid of text-bearing children
      const children = Array.from(el.children);
      const hasTableChild = children.some(c =>
        ['TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH'].includes(c.tagName)
      );
      if (hasTableChild && text.length >= 12) return true;

      // Grid detection: many same-level children each with short text
      // (typical for tree diagrams, org charts, flow charts)
      const textChildren = children.filter(c => {
        const ct = this.getElementText(c);
        return ct.length >= 2 && this.hasLatinText(ct) && c.children.length <= 6;
      });
      if (textChildren.length >= 3 && text.length >= 20) return true;

      return false;
    },

    // Detect containers that are UI chrome (nav, sidebar, header, toolbar, etc.)
    // and should NOT be translated in bilingual mode.
    shouldSkipContainer(container) {
      if (!container) return false;

      const tag = container.tagName;

      // 0. NEVER skip heading elements (H1-H6) — they are always content
      if (/^H[1-6]$/.test(tag)) return false;

      // 0a. NEVER skip card-like elements (course cards, feature cards, etc.)
      if (this.isCardLikeElement(container)) return false;

      // 0a2. NEVER skip data content (tables, charts, diagrams, trees)
      if (this.isDataContentElement(container)) return false;

      // 0b. STRONG GUARD: Elements with substantial Latin text content are REAL CONTENT,
      //     not UI chrome. Skip ONLY for unambiguous structural chrome (NAV/HEADER/FOOTER).
      const containerText = this.getElementText(container);
      if (containerText.length > 35 && this.hasLatinText(containerText)) {
        // Has real content → only skip if it's a pure structural chrome element
        if (!['NAV', 'ASIDE', 'HEADER', 'FOOTER'].includes(tag)) {
          const role = (container.getAttribute('role') || '').toLowerCase();
          if (!['navigation', 'banner', 'contentinfo', 'complementary'].includes(role)) {
            return false; // ← REAL CONTENT, never skip
          }
        }
      }

      // 1. Semantic HTML elements → skip
      if (['NAV', 'ASIDE', 'HEADER', 'FOOTER'].includes(tag)) return true;

      // 2. ARIA roles → skip
      const role = (container.getAttribute('role') || '').toLowerCase();
      const skipRoles = ['navigation', 'banner', 'contentinfo', 'complementary', 'toolbar', 'search', 'menu', 'menubar', 'tablist'];
      if (skipRoles.includes(role)) return true;

      // 3. Class/id patterns for UI chrome (case-insensitive)
      // NOTE: We require the pattern to appear as a separate class/id token,
      // to avoid false positives like "information" matching "nav" inside it.
      const cls = ' ' + (container.className || '') + ' ';
      const id = ' ' + (container.id || '') + ' ';
      const merged = (cls + id).toLowerCase();

      // Pattern-based detection: ONLY applied when element lacks substantial content.
      // This prevents false positives like "content-panel" or "docs-header" on
      // elements that clearly contain substantial English text.
      const containerTextForCheck = this.getElementText(container);
      const hasRealContainerContent = containerTextForCheck.length > 35 && this.hasLatinText(containerTextForCheck);

      if (!hasRealContainerContent) {
        // HIGH-confidence patterns (almost always indicate UI chrome)
        const highConfidencePatterns = [
          // Navigation
          'nav ', ' nav-', ' nav_', ' navbar', ' nav-bar', ' navitem', ' nav-item',
          ' gnav', ' gnav-', ' gnav_', ' gb_', ' gb-',
          // Menu
          ' menu', ' menu-', ' menu_', ' menubar', ' menu-item', ' menu_item',
          // Sidebar
          ' sidebar', ' side-bar', ' side_nav', ' side-nav', ' sidepanel', ' side-panel',
          // Header / Footer
          ' header', ' header-', ' header_', ' masthead', ' topbar', ' top-bar', ' toolbar',
          ' footer', ' footer-', ' footer_', ' foot', ' foot-', ' foot_',
          // Breadcrumb
          ' breadcrumb', ' bread-crumb',
          // Drawer / Panel / Overlay
          ' drawer', ' panel', ' panel-', ' panel_', ' overlay', ' modal', ' dialog',
          // Cookie / Consent / Banner
          ' skip-link', ' skip_to',
          ' cookie', ' consent',
          ' advert', ' ad-', ' ad_', ' sponsor', ' sponsor-', ' sponsor_',
          // Material Design base (high confidence)
          ' mat-', 'mdc-',
          // Common frameworks
          ' wp-', 'wp_', ' elementor-', ' elementor_',
          ' ant-', ' mui-', ' chakra-', ' bootstrap-',
          // Generic UI widgets
          ' widget-', ' widget_', ' component-', ' component_',
          ' icon-', ' icon_',
          ' tablist', ' tab-list', ' tab_list'
        ];
        for (const pat of highConfidencePatterns) {
          if (merged.includes(pat)) return true;
        }

        // LOW-confidence patterns (often appear in legitimate content pages)
        const lowConfidencePatterns = [
          ' skip', ' skip-', ' skip_', ' banner', ' banner-', ' banner_',
          ' google', ' google-', ' goog-', ' goog_',
          ' material', ' material-', ' material_',
          ' toolbar-', ' toolbar_', ' action-bar', ' action_bar',
          ' control-', ' control_', ' utility-', ' utility_',
          ' analytics-', ' analytics_', ' skillshop-', ' skillshop_',
          ' coursera-', ' coursera_',
          ' shopify-', ' shopify_',
          ' btn-', ' btn_', ' button-', ' button_',
          ' tab-', ' tab_', ' tabs ',
          ' badge-', ' badge_', ' tag-', ' tag_',
          ' pill-', ' pill_', ' chip-', ' chip_'
        ];
        for (const pat of lowConfidencePatterns) {
          if (merged.includes(pat)) return true;
        }

        // 4. CSS: position:sticky/fixed → likely a sticky nav/toolbar
        const style = window.getComputedStyle(container);
        if (style.position === 'fixed' || style.position === 'sticky') return true;

        // 5. Geometry: very narrow + tall (sidebar) or very wide + short (top bar)
        const rect = container.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          // Very wide + short → top navigation bar
          if (rect.width > window.innerWidth * 0.6 && rect.height < 40) return true;
          // Very narrow + tall → sidebar
          if (rect.width < 280 && rect.height > window.innerHeight * 0.4) return true;
          // Very short + sticky/fixed ancestor → skip
          if (rect.height < 50) {
            let el = container.parentElement;
            for (let i = 0; el && i < 4; i++, el = el.parentElement) {
              const s = window.getComputedStyle(el);
              if (s.position === 'fixed' || s.position === 'sticky') return true;
            }
          }
        }
      }

      return false;
    },

    // Detect data content elements: tables, charts, diagrams, tree structures,
    // and any structured information display. These should NEVER be UI chrome.
    isDataContentElement(el) {
      if (!el || el === document.body || el === document.documentElement) return false;

      const tag = el.tagName;
      const text = this.getElementText(el);

      // Must have some Latin text to be considered content
      if (text.length < 8 || !this.hasLatinText(text)) return false;

      // TABLE elements and their parts are always data content
      if (['TABLE', 'TBODY', 'THEAD', 'TR'].includes(tag)) return true;

      // Check for table-like grid layout (many cells arranged in rows)
      const clsId = (' ' + (el.className || '') + ' ' + ' ' + (el.id || '') + ' ').toLowerCase();
      const dataPatterns = [
        'table', '-table', '_table',
        'chart', '-chart', ' graph', ' diagram',
        'tree', '-tree', ' node', ' branch',
        'grid ', ' grid-', ' grid_',
        ' snapshot', ' report', ' metric',
        'data-', 'data_', '-data',
        ' figure', ' fig-',
        ' visual', ' visualization',
        ' hierarchy', ' org',
        ' flow', '-flow', ' workflow'
      ];
      for (const p of dataPatterns) {
        if (clsId.includes(p)) return true;
      }

      // Check if element contains table rows or a grid of text-bearing children
      const children = Array.from(el.children);
      const hasTableChild = children.some(c =>
        ['TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH'].includes(c.tagName)
      );
      if (hasTableChild && text.length >= 12) return true;

      // Grid detection: many same-level children each with short text
      // (typical for tree diagrams, org charts, flow charts)
      const textChildren = children.filter(c => {
        const ct = this.getElementText(c);
        return ct.length >= 2 && this.hasLatinText(ct) && c.children.length <= 6;
      });
      if (textChildren.length >= 3 && text.length >= 20) return true;

      return false;
    },

    isLeafDiv(element) {
      if (!element || element.tagName !== 'DIV') return false;
      if (element.children.length === 0) return this.shouldTranslateText(element.textContent);
      // 允许"空壳布局容器"：子元素无实质内容时仍视为 leafDiv
      const hasContentChild = Array.from(element.children).some(child => {
        if (this.nestedBlockTags.has(child.tagName)) {
          const ct = this.getElementText(child);
          return ct.length >= 5 && this.hasLatinText(ct);
        }
        return false;
      });
      return !hasContentChild;
    },

    isTranslationContainer(element) {
      if (!element || element === document.body || element === document.documentElement) return false;
      if (element.getAttribute('role') === 'heading') return true;
      if (this.blockTags.has(element.tagName)) return true;
      return this.isLeafDiv(element);
    },

    findTextContainer(textNode) {
      let element = textNode.parentElement;
      let lastValid = null;
      while (element && element !== document.body && element !== document.documentElement) {
        // 透明穿透：<a> 标签不是内容容器，继续向上查找
        if (element.tagName === 'A') {
          element = element.parentElement;
          continue;
        }
        if (this.skipTags.has(element.tagName)) return null;
        if (element.matches && element.matches(this.skipSelectors)) return null;
        if (element.isContentEditable) return null;
        if (this.isTranslationContainer(element)) return element;
        // 记录最近的有效父元素（非跳过、非可编辑）
        if (!this.shouldSkipContainer(element)) {
          lastValid = element;
        }
        element = element.parentElement;
      }
      // fallback：返回最近的有效父元素，即使不是标准容器
      if (lastValid && this.shouldTranslateText(textNode.textContent)) {
        return lastValid;
      }
      return null;
    },

    isNestedInDifferentContainer(textNode, container) {
      let element = textNode.parentElement;
      while (element && element !== container) {
        if (this.isTranslationContainer(element)) return true;
        element = element.parentElement;
      }
      return false;
    },

    // Detect data content elements: tables, charts, diagrams, tree structures,
    // and any structured information display. These should NEVER be UI chrome.
    isDataContentElement(el) {
      if (!el || el === document.body || el === document.documentElement) return false;

      const tag = el.tagName;
      const text = this.getElementText(el);

      // Must have some Latin text to be considered content
      if (text.length < 8 || !this.hasLatinText(text)) return false;

      // TABLE elements and their parts are always data content
      if (['TABLE', 'TBODY', 'THEAD', 'TR'].includes(tag)) return true;

      // Check for table-like grid layout (many cells arranged in rows)
      const clsId = (' ' + (el.className || '') + ' ' + ' ' + (el.id || '') + ' ').toLowerCase();
      const dataPatterns = [
        'table', '-table', '_table',
        'chart', '-chart', ' graph', ' diagram',
        'tree', '-tree', ' node', ' branch',
        'grid ', ' grid-', ' grid_',
        ' snapshot', ' report', ' metric',
        'data-', 'data_', '-data',
        ' figure', ' fig-',
        ' visual', ' visualization',
        ' hierarchy', ' org',
        ' flow', '-flow', ' workflow'
      ];
      for (const p of dataPatterns) {
        if (clsId.includes(p)) return true;
      }

      // Check if element contains table rows or a grid of text-bearing children
      const children = Array.from(el.children);
      const hasTableChild = children.some(c =>
        ['TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH'].includes(c.tagName)
      );
      if (hasTableChild && text.length >= 12) return true;

      // Grid detection: many same-level children each with short text
      // (typical for tree diagrams, org charts, flow charts)
      const textChildren = children.filter(c => {
        const ct = this.getElementText(c);
        return ct.length >= 2 && this.hasLatinText(ct) && c.children.length <= 6;
      });
      if (textChildren.length >= 3 && text.length >= 20) return true;

      return false;
    },

    collectTranslationUnits(root = document.body) {
      const units = new Map();
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            return this.shouldSkipTextNode(node)
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      let node;
      while ((node = walker.nextNode())) {
        const container = this.findTextContainer(node);
        if (!container || container.dataset.lingoflowProcessed === 'true') continue;
        if (this.isNestedInDifferentContainer(node, container)) continue;
        // Skip UI chrome elements (nav, sidebar, header, toolbar, etc.)
        if (this.shouldSkipContainer(container)) continue;
        if (this.hasExistingTranslation(container)) {
          continue;
        }

        const text = this.normalizeText(node.textContent);
        if (!this.shouldTranslateText(text)) continue;

        if (!units.has(container)) {
          units.set(container, {
            container,
            textParts: []
          });
        }
        units.get(container).textParts.push(text);
      }


      const rawUnits = Array.from(units.values())
        .map(unit => ({
          container: unit.container,
          text: this.normalizeText(unit.textParts.join(' ')),
          targetLang: 'zh-CN'  // 页面翻译固定英译中
        }))
        .filter(unit => this.shouldTranslateText(unit.text));

      // 句级拆分：对长文本（>120字符且包含2+个句子）按句子边界拆分
      const sentenceUnits = [];
      for (const unit of rawUnits) {
        const sentences = this.splitIntoSentences(unit.text);
        if (sentences.length > 1 && unit.text.length > 120) {
          // 标记为句级单元，保留原始容器引用和分组ID
          const groupId = this.getOrCreateTranslationId(unit.container);
          for (let i = 0; i < sentences.length; i++) {
            sentenceUnits.push({
              container: unit.container,
              text: sentences[i],
              targetLang: 'zh-CN',
              _isSentence: true,           // 句级单元标记
              _sentenceIndex: i,          // 句子序号
              _sentenceTotal: sentences.length,  // 总句数
              _groupId: groupId,          // 同组ID（同容器）
              _fullText: unit.text        // 完整原文（渲染时用）
            });
          }
        } else {
          sentenceUnits.push(unit);
        }
      }

      return sentenceUnits;
    },

    markProcessed(container) {
      if (container) {
        container.setAttribute('data-lingoflow-processed', 'true');
      }
    },

    getOrCreateTranslationId(container) {
      if (!container) return '';
      if (!container.dataset.lingoflowSourceId) {
        state.translationIdCounter += 1;
        container.dataset.lingoflowSourceId = `lf-${Date.now()}-${state.translationIdCounter}`;
      }
      return container.dataset.lingoflowSourceId;
    },

    linkTranslationNode(container, node) {
      if (!container || !node) return;
      const id = this.getOrCreateTranslationId(container);
      node.setAttribute('data-lingoflow-source-id', id);
      container.setAttribute('data-lingoflow-rendered', 'true');
    },

    getSourceIdSelector(id) {
      const escaped = (window.CSS && CSS.escape) ? CSS.escape(id) : String(id).replace(/"/g, '\\"');
      return `[data-lingoflow-source-id="${escaped}"]`;
    },

    hasLinkedTranslation(container) {
      if (!container || !container.dataset) return false;
      const id = container.dataset.lingoflowSourceId;
      if (!id) return false;
      return !!document.querySelector(this.getSourceIdSelector(id));
    },

    repairTranslationIntegrity() {
      let repaired = 0;

      document.querySelectorAll('[data-lingoflow-processed="true"][data-lingoflow-rendered="true"]').forEach(container => {
        if (!container.isConnected || this.hasLinkedTranslation(container)) return;
        container.removeAttribute('data-lingoflow-processed');
        container.removeAttribute('data-lingoflow-rendered');
        container.removeAttribute('data-lingoflow-source-id');
        repaired++;
      });

      document.querySelectorAll('[data-lingoflow-source-id][data-lingoflow="true"]').forEach(node => {
        const id = node.getAttribute('data-lingoflow-source-id');
        if (!id) return;
        const owner = document.querySelector(`${this.getSourceIdSelector(id)}[data-lingoflow-rendered="true"]`);
        if (owner) return;
        node.remove();
        repaired++;
      });

      return repaired;
    },

    createBilingualBlock(translation, mode) {
      const block = document.createElement('div');
      block.className = `lingoflow-block lingoflow-block-${mode}`;
      block.setAttribute('data-lingoflow', 'true');
      block.setAttribute('data-lingoflow-mode', mode);

      const original = document.createElement('div');
      original.className = 'lingoflow-original';
      original.setAttribute('data-lingoflow', 'true');

      const translated = document.createElement('div');
      translated.className = 'lingoflow-translation';
      translated.setAttribute('data-lingoflow', 'true');
      translated.textContent = translation;

      const fragment = document.createDocumentFragment();
      fragment.appendChild(original);
      fragment.appendChild(translated);
      block.appendChild(fragment);

      return block;
    },

    createTranslationOnlyBlock(translation) {
      const block = document.createElement('div');
      block.className = 'lingoflow-translation-only';
      block.setAttribute('data-lingoflow', 'true');
      block.textContent = translation;
      return block;
    },

    // =========================================================================
    // Smart main-content detection (whitelist approach)
    // Instead of blacklisting every possible UI chrome pattern (impossible to
    // exhaust), we identify the *real* content area and only translate inside it.
    // =========================================================================

    // Check if an element has enough Latin text to be a real content container
    _hasSufficientContent(el) {
      if (!el) return false;
      const text = this.getElementText(el);
      return text.length > 150 && this.hasLatinText(text);
    },

    // Find the container with the largest amount of Latin text (likely the main article)
    _findLargestTextContainer() {
      // Collect candidates: direct children of body, and common wrapper divs
      const candidates = [];

      // Direct children of body
      for (const child of document.body.children) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (this.skipTags.has(child.tagName)) continue;
        if (['NAV', 'ASIDE', 'HEADER', 'FOOTER', 'SCRIPT', 'STYLE', 'SVG'].includes(child.tagName)) continue;
        candidates.push(child);
      }

      // Also check one level deeper for common wrapper patterns
      for (const child of document.body.children) {
        if (!child.children) continue;
        for (const sub of child.children) {
          if (sub.nodeType !== Node.ELEMENT_NODE) continue;
          if (this.skipTags.has(sub.tagName)) continue;
          if (['NAV', 'ASIDE', 'HEADER', 'FOOTER'].includes(sub.tagName)) continue;
          const r = sub.getBoundingClientRect();
          // Skip tiny elements (likely UI widgets)
          if (r.width > 0 && r.height > 0 && (r.width < 200 || r.height < 80)) continue;
          candidates.push(sub);
        }
      }

      let best = null;
      let bestScore = 0;

      for (const c of candidates) {
        // Skip elements that are clearly UI chrome
        if (this._isUiChromeElement(c)) continue;
        // Skip elements positioned fixed/sticky (overlays, nav bars)
        try {
          const s = window.getComputedStyle(c);
          if (s.position === 'fixed' || s.position === 'sticky') continue;
        } catch (_) {}
        const stats = this.getTextStats(this.getElementText(c));
        // Score = Latin character count (primary metric for "main content")
        if (stats.latinCount > bestScore && stats.contentLength > 100) {
          bestScore = stats.latinCount;
          best = c;
        }
      }

      return best || document.body;
    },

    // Public entry: find the page's main content area
    findMainContentArea() {
      // Step 1: Try semantic / well-known selectors first
      const semanticSelectors = [
        'main',
        '[role="main"]',
        'article',
        '[role="article"]',
        '.main-content', '#main-content',
        '.content-body', '#content-body',
        '.post-content', '.article-content', '.entry-content',
        '.page-content', '.main-body', '#main',
        '.doc-content', '.markdown-body',
        '.course-content', '.lesson-content', '.module-content',
        '.unit-content', '.section-content', '.topic-content',
        '#content', '#bodyContent', '#mw-content-text',
        '[class*="content"][class*="main"]',
        '[class*="article"]', '[class*="post-body"]',
        '#primary', '.primary',
        // Google Skill Shop / Coursera / edX patterns
        '.q介ute-content', '.q介ute-body', '.course-body', '.course-main',
        '.learning-content', '.training-content', '.material-content',
        '[class*="course"]', '[class*="lesson"]', '[class*="training"]',
        // E-commerce / product page patterns
        '.product-description', '#product-description',
        '.product-details', '.product-info',
        '.collection', '.products', '.product-grid',
        '.shop-content', '.store-content',
        '[class*="product"][class*="description"]',
        '[class*="collection"]'
      ];
      for (const sel of semanticSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && this._hasSufficientContent(el)) return el;
        } catch (_) {}
      }

      // Step 2: Fallback — find the container with the most Latin text
      const largest = this._findLargestTextContainer();
      if (largest && largest !== document.body) {
        // Expand: if the largest container's parent is NOT body and also has
        // substantial content, use the parent (catches wrappers like .container)
        const parent = largest.parentElement;
        const containerText = this.getElementText(largest);
        if (parent && parent !== document.body && parent !== document.documentElement) {
          const parentText = this.getElementText(parent);
          if (parentText.length > containerText.length * 1.2) {
            return parent;
          }
        }
        return largest;
      }

      // Step 3: Last resort — body (same as current behavior)
      // But first, try to use the <body>'s largest child as root
      const bodyChildren = Array.from(document.body.children).filter(c => {
        if (c.nodeType !== Node.ELEMENT_NODE) return false;
        if (this.skipTags.has(c.tagName)) return false;
        if (['NAV', 'ASIDE', 'HEADER', 'FOOTER'].includes(c.tagName)) return false;
        return true;
      });
      if (bodyChildren.length === 1) return bodyChildren[0];

      return document.body;
    },

    isConservativePage() {
      const href = String(location.href || '');
      if (/scorm|docebo|skillshop|googleusercontent|static-assets|launcher\.html/i.test(href)) return true;
      return !!document.querySelector('video, iframe, frame, [class*="transcript" i], [id*="transcript" i]');
    },

    createInlineTranslationBlock(translation) {
      const block = document.createElement('div');
      block.className = 'lingoflow-inline-translation';
      block.setAttribute('data-lingoflow', 'true');
      block.textContent = translation;
      // Force horizontal text layout (prevent inherited vertical writing-mode)
      block.style.writingMode = 'horizontal-tb';
      block.style.textOrientation = 'mixed';
      block.style.whiteSpace = 'normal';
      block.style.wordBreak = 'break-word';
      block.style.overflowWrap = 'anywhere';
      // Constrain width to parent — NEVER use max-content
      block.style.maxWidth = '100%';
      return block;
    },

    copyLayoutMargins(source, block) {
      const style = window.getComputedStyle(source);
      // Margins
      block.style.marginTop = style.marginTop;
      block.style.marginRight = style.marginRight;
      block.style.marginBottom = style.marginBottom;
      block.style.marginLeft = style.marginLeft;
      // Padding (important for width calculation)
      block.style.paddingTop = style.paddingTop;
      block.style.paddingRight = style.paddingRight;
      block.style.paddingBottom = style.paddingBottom;
      block.style.paddingLeft = style.paddingLeft;
      // Typography (only copy font styling, NOT whiteSpace/wordBreak which can prevent wrapping)
      block.style.textAlign = style.textAlign;
      block.style.color = style.color;
      block.style.fontFamily = style.fontFamily;
      block.style.fontSize = style.fontSize;
      block.style.fontStyle = style.fontStyle;
      block.style.fontWeight = style.fontWeight;
      block.style.letterSpacing = style.letterSpacing;
      block.style.lineHeight = style.lineHeight;
      // Force wrap-safe values — NEVER inherit nowrap or keep-all from source
      block.style.whiteSpace = 'normal';
      block.style.wordBreak = 'break-word';
      block.style.overflowWrap = 'anywhere';
      // Layout
      block.style.boxSizing = 'border-box';
      block.style.width = '100%';
      block.style.maxWidth = '100%';
      // Display (use block for inserted translation blocks to avoid flex/grid participation)
      block.style.display = 'block';
      // Ensure translation is never clipped by inherited overflow
      block.style.overflow = 'visible';
      block.style.maxHeight = 'none';
      block.style.textOverflow = 'clip';
    },

    shouldRenderInside(container) {
      // H1-H6 can use internal rendering (wrap text inside the heading element)
      if (/^H[1-6]$/.test(container.tagName)) return true;
      return ['LI', 'DIV', 'TD', 'TH', 'BLOCKQUOTE', 'DD', 'DT', 'FIGCAPTION', 'SECTION', 'ARTICLE', 'ASIDE', 'MAIN'].includes(container.tagName);
    },

    // Detect if a container's parent layout is safe for bilingual injection.
    // Returns false for layouts that will break when we wrap/render the container.
    isLayoutSafe(container) {
      if (!container || !container.parentElement) return true;
      const parent = container.parentElement;
      const pStyle = window.getComputedStyle(parent);

      // 1. Parent has overflow:hidden/clip and fixed height — injected content will be clipped
      const overflow = pStyle.overflow + ' ' + pStyle.overflowX + ' ' + pStyle.overflowY;
      const clipsOverflow = /(hidden|clip)/.test(overflow);
      if (clipsOverflow) {
        const parentRect = parent.getBoundingClientRect();
        if (parentRect.height > 0 && parent.scrollHeight > parent.clientHeight + 4) return false;
        // Even without scroll mismatch, hidden overflow + positioned children is risky
        if (parentRect.height > 0 && parentRect.height < 800) return false;
      }

      // 2. Parent is a flex/grid container with strict alignment — wrapping breaks it
      const display = pStyle.display;
      if (/flex|grid/.test(display)) {
        // Safe if flex/grid container has enough gap and wrapping is allowed
        const noWrap = pStyle.flexWrap === 'nowrap' && display === 'flex';
        const strictAlign = /center|space-between|space-around/.test(pStyle.justifyContent + ' ' + pStyle.alignItems);
        if (noWrap || strictAlign) return false;
      }

      // 3. Container or parent uses absolute/fixed positioning
      const cStyle = window.getComputedStyle(container);
      if (/absolute|fixed/.test(cStyle.position) || /absolute|fixed/.test(pStyle.position)) return false;

      // 4. Parent has a fixed height that can't expand
      if (pStyle.height !== 'auto' && pStyle.height !== '' && /px/.test(pStyle.height)) {
        const h = parseInt(pStyle.height, 10);
        if (h > 0 && h < 600) return false;
      }

      // 5. Container is inside a small, fixed-size widget (e.g., Google homepage buttons)
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.width < 120 && rect.height > 0 && rect.height < 60) return false;

      return true;
    },

    renderExternal(container, translation) {
      if (!container || !container.parentNode) return false;

      const range = document.createRange();
      range.selectNode(container);
      const marker = document.createComment('lingoflow-bilingual-anchor');
      range.insertNode(marker);

      const block = this.createBilingualBlock(translation, 'external');
      // Constrain block to available width
      block.style.maxWidth = '100%';
      block.style.overflow = 'visible';
      const original = block.querySelector(':scope > .lingoflow-original');
      this.copyLayoutMargins(container, block);
      original.appendChild(container);
      marker.replaceWith(block);
      range.detach();
      this.linkTranslationNode(container, block);

      return true;
    },

    getInternalInsertionPoint(container) {
      if (container.tagName !== 'LI') return null;
      return Array.from(container.childNodes).find(node => {
        return node.nodeType === Node.ELEMENT_NODE && ['UL', 'OL'].includes(node.tagName);
      }) || null;
    },

    renderInternal(container, translation) {
      if (!container) return false;

      const block = this.createBilingualBlock(translation, 'internal');
      const original = block.querySelector(':scope > .lingoflow-original');
      const stopNode = this.getInternalInsertionPoint(container);
      const fragment = document.createDocumentFragment();

      while (container.firstChild && container.firstChild !== stopNode) {
        fragment.appendChild(container.firstChild);
      }

      if (!fragment.childNodes.length) return false;

      original.appendChild(fragment);
      container.insertBefore(block, stopNode);
      this.linkTranslationNode(container, block);
      return true;
    },

    renderTranslationUnit(container, translation) {
      // For very dangerous layouts (tiny buttons, etc.), use tooltip on hover
      if (this.isVeryDangerousLayout(container)) {
        return this.renderTooltipTranslation(container, translation);
      }

      // Headings (H1-H6) and role=heading
      const isHeading = /^H[1-6]$/.test(container.tagName) ||
                        container.getAttribute('role') === 'heading';

      if (isHeading) {
        // Headings: prefer internal rendering (wraps heading text in a block inside the heading),
        // fallback to conservative only if layout is unsafe.
        if (this.isLayoutSafe(container)) {
          return this.renderInternal(container, translation);
        }
        return this.renderConservativeBilingualUnit(container, translation);
      }

      // Card / data content elements: FORCE proper rendering even on conservative pages.
      // These are clearly content (detected by isCardLikeElement or isDataContentElement),
      // so they should get full bilingual treatment, not the weak conservative rendering.
      const isCardContent = this.isCardLikeElement(container) || this.isDataContentElement(container);
      if (isCardContent && this.isLayoutSafe(container)) {
        return this.shouldRenderInside(container)
          ? this.renderInternal(container, translation)
          : this.renderExternal(container, translation);
      }
      if (isCardContent) {
        // Even if layout is "unsafe", card content should still get proper rendering.
        // Use external rendering as a safe default for cards.
        return this.shouldRenderInside(container)
          ? this.renderInternal(container, translation)
          : this.renderExternal(container, translation);
      }

      // Non-heading elements: conservative page or unsafe layout → conservative
      if (this.isConservativePage() || !this.isLayoutSafe(container)) {
        return this.renderConservativeBilingualUnit(container, translation);
      }

      return this.shouldRenderInside(container)
        ? this.renderInternal(container, translation)
        : this.renderExternal(container, translation);
    },

    findConservativeInsertionTarget(container) {
      let target = container;
      let parent = target.parentElement;

      for (let depth = 0; parent && parent !== document.body && depth < 4; depth++) {
        const style = window.getComputedStyle(parent);
        const clips = /(hidden|clip)/.test(`${style.overflow} ${style.overflowY} ${style.overflowX}`);
        const fixedHeight = parent.getBoundingClientRect().height > 0 && parent.scrollHeight > parent.clientHeight + 8;
        if (!clips && !fixedHeight) break;
        target = parent;
        parent = target.parentElement;
      }

      return target;
    },

    renderConservativeBilingualUnit(container, translation) {
      if (!container || !container.parentNode) return false;
      const target = this.findConservativeInsertionTarget(container);
      if (!target || !target.parentNode) return false;

      const block = this.createInlineTranslationBlock(translation);
      this.copyLayoutMargins(container, block);
      block.style.marginTop = '0.25em';
      block.style.marginBottom = '0.35em';
      // Ensure translation respects parent width — no max-content forcing
      const targetRect = target.getBoundingClientRect();
      if (targetRect.width > 0 && targetRect.width < 200) {
        // Very narrow container: still allow wrapping but don't force expand
        block.style.minWidth = '0';
        block.style.width = '100%';
        block.style.whiteSpace = 'normal';
        block.style.wordBreak = 'break-word';
        block.style.overflowWrap = 'anywhere';
        // Reset any inherited writing-mode
        block.style.writingMode = 'horizontal-tb';
        block.style.textOrientation = 'mixed';
      } else {
        // Normal-width container: always constrain to parent
        block.style.maxWidth = '100%';
        block.style.width = 'auto';
      }
      target.insertAdjacentElement('afterend', block);
      this.linkTranslationNode(container, block);
      return true;
    },

    /**
     * 句级双语渲染：将一个容器的多句拆分翻译结果渲染为规范的原文→逐句译文对照块。
     * 结构：
     *   <div class="lingoflow-block lingoflow-block-external">
     *     <div class="lingoflow-original">  ← 原文完整保留（含HTML结构）
     *     <div class="lingoflow-translation">
     *       第1句译文<br>第2句译文<br>第3句译文...
     *   </div>
     */
    renderSentenceBilingualUnit(container, fullText, translations, renderMode) {
      if (!container || !container.parentNode) return false;
      if (translations.length === 0) return false;

      // translation-only 模式下隐藏原文，只显示句级译文
      if (renderMode === 'translation') {
        const range = document.createRange();
        range.selectNode(container);
        const marker = document.createComment('lingoflow-sentence-anchor');
        range.insertNode(marker);

        const block = this.createTranslationOnlyBlock(
          translations.join('\n')
        );
        block.style.maxWidth = '100%';
        block.style.overflow = 'visible';
        this.copyLayoutMargins(container, block);

        // 每句翻译用视觉分隔（不使用br标签，用CSS伪元素或margin模拟）
        // 直接用换行符 + whiteSpace: pre-wrap 效果更好
        block.style.whiteSpace = 'pre-line';

        marker.replaceWith(block);
        range.detach();
        this.hideOriginalContainer(container);
        this.linkTranslationNode(container, block);
        return true;
      }

      // 双语模式：原文完整保留 + 逐句译文
      const range = document.createRange();
      range.selectNode(container);
      const marker = document.createComment('lingoflow-sentence-bilingual-anchor');
      range.insertNode(marker);

      const block = document.createElement('div');
      block.className = 'lingoflow-block lingoflow-block-external lingoflow-sentence-block';
      block.setAttribute('data-lingoflow', 'true');
      block.setAttribute('data-lingoflow-mode', 'external');

      const originalDiv = document.createElement('div');
      originalDiv.className = 'lingoflow-original';
      originalDiv.setAttribute('data-lingoflow', 'true');

      const translatedDiv = document.createElement('div');
      translatedDiv.className = 'lingoflow-translation';
      translatedDiv.setAttribute('data-lingoflow', 'true');

      // 译文按句子分行显示
      if (translations.length > 1) {
        for (let i = 0; i < translations.length; i++) {
          if (i > 0) {
            translatedDiv.appendChild(document.createElement('br'));
          }
          const span = document.createElement('span');
          span.className = 'lingoflow-sentence-trans';
          span.setAttribute('data-lingoflow', 'true');
          span.textContent = translations[i];
          translatedDiv.appendChild(span);
        }
      } else {
        translatedDiv.textContent = translations[0];
      }

      block.appendChild(originalDiv);
      block.appendChild(translatedDiv);

      block.style.maxWidth = '100%';
      block.style.overflow = 'visible';
      this.copyLayoutMargins(container, block);

      originalDiv.appendChild(container);
      marker.replaceWith(block);
      range.detach();
      this.linkTranslationNode(container, block);

      return true;
    },

    // For very dangerous layouts (tiny buttons, complex positioned widgets),
    // render translation as a tooltip on hover instead of injecting DOM.
    renderTooltipTranslation(container, translation) {
      if (!container || !container.parentNode) return false;
      if (container.dataset.lingoflowTooltip) return false; // already added

      container.dataset.lingoflowTooltip = 'true';
      container.classList.add('lingoflow-tooltip-host');

      const popup = document.createElement('div');
      popup.className = 'lingoflow-tooltip-popup';
      popup.setAttribute('data-lingoflow', 'true');
      popup.textContent = translation;
      this.linkTranslationNode(container, popup);

      container.appendChild(popup);

      const showTooltip = (e) => {
        e.stopPropagation();
        // Position the popup near the container
        const rect = container.getBoundingClientRect();
        popup.style.top = (rect.bottom + 8) + 'px';
        popup.style.left = Math.min(rect.left, window.innerWidth - 380) + 'px';
        popup.classList.add('lingoflow-tooltip-visible');
        container.classList.add('lingoflow-tooltip-active');
      };

      const hideTooltip = () => {
        popup.classList.remove('lingoflow-tooltip-visible');
        container.classList.remove('lingoflow-tooltip-active');
      };

      container.addEventListener('mouseenter', showTooltip);
      container.addEventListener('mouseleave', hideTooltip);
      container.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        if (popup.classList.contains('lingoflow-tooltip-visible')) {
          hideTooltip();
        } else {
          // Hide other tooltips first
          document.querySelectorAll('.lingoflow-tooltip-visible').forEach(el => {
            el.classList.remove('lingoflow-tooltip-visible');
          });
          showTooltip(e);
        }
      }, { passive: true });

      // Hide on scroll
      window.addEventListener('scroll', hideTooltip, { passive: true });

      return true;
    },

    isVeryDangerousLayout(container) {
      if (!container) return false;
      const rect = container.getBoundingClientRect();
      // Tiny elements (buttons, badges) — tooltip is safer
      if (rect.width > 0 && rect.width < 100 && rect.height > 0 && rect.height < 50) return true;
      // Narrow containers (< 80px) — Chinese text will render vertically
      if (rect.width > 0 && rect.width < 80) return true;
      // Elements inside positioned complex widgets
      let el = container.parentElement;
      for (let i = 0; el && i < 5; i++, el = el.parentElement) {
        const s = window.getComputedStyle(el);
        if (s.position === 'absolute' || s.position === 'fixed') return true;
      }
      return false;
    },

    // Detect data content elements: tables, charts, diagrams, tree structures,
    // and any structured information display. These should NEVER be UI chrome.
    isDataContentElement(el) {
      if (!el || el === document.body || el === document.documentElement) return false;

      const tag = el.tagName;
      const text = this.getElementText(el);

      // Must have some Latin text to be considered content
      if (text.length < 8 || !this.hasLatinText(text)) return false;

      // TABLE elements and their parts are always data content
      if (['TABLE', 'TBODY', 'THEAD', 'TR'].includes(tag)) return true;

      // Check for table-like grid layout (many cells arranged in rows)
      const clsId = (' ' + (el.className || '') + ' ' + ' ' + (el.id || '') + ' ').toLowerCase();
      const dataPatterns = [
        'table', '-table', '_table',
        'chart', '-chart', ' graph', ' diagram',
        'tree', '-tree', ' node', ' branch',
        'grid ', ' grid-', ' grid_',
        ' snapshot', ' report', ' metric',
        'data-', 'data_', '-data',
        ' figure', ' fig-',
        ' visual', ' visualization',
        ' hierarchy', ' org',
        ' flow', '-flow', ' workflow'
      ];
      for (const p of dataPatterns) {
        if (clsId.includes(p)) return true;
      }

      // Check if element contains table rows or a grid of text-bearing children
      const children = Array.from(el.children);
      const hasTableChild = children.some(c =>
        ['TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH'].includes(c.tagName)
      );
      if (hasTableChild && text.length >= 12) return true;

      // Grid detection: many same-level children each with short text
      // (typical for tree diagrams, org charts, flow charts)
      const textChildren = children.filter(c => {
        const ct = this.getElementText(c);
        return ct.length >= 2 && this.hasLatinText(ct) && c.children.length <= 6;
      });
      if (textChildren.length >= 3 && text.length >= 20) return true;

      return false;
    },

    hideOriginalContainer(container) {
      container.setAttribute('data-lingoflow-hidden', 'true');
      container.hidden = true;
    },

    renderTranslationOnlyUnit(container, translation) {
      // Skip UI chrome elements in translation-only mode too
      if (!container || !container.parentNode || this.shouldSkipContainer(container)) return false;

      const range = document.createRange();
      range.selectNode(container);
      const marker = document.createComment('lingoflow-translation-anchor');
      range.insertNode(marker);

      const block = this.createTranslationOnlyBlock(translation);
      // Constrain width to prevent overflow
      block.style.maxWidth = '100%';
      block.style.overflow = 'visible';
      this.copyLayoutMargins(container, block);
      marker.replaceWith(block);
      range.detach();

      this.hideOriginalContainer(container);
      this.linkTranslationNode(container, block);
      return true;
    },

    restoreBilingualBlock(block) {
      const mode = block.getAttribute('data-lingoflow-mode');
      const original = block.querySelector(':scope > .lingoflow-original');
      const fragment = document.createDocumentFragment();

      while (original && original.firstChild) {
        fragment.appendChild(original.firstChild);
      }

      if (!fragment.childNodes.length) {
        fragment.appendChild(document.createTextNode(''));
      }

      if (mode === 'internal') {
        block.parentNode.insertBefore(fragment, block);
        block.remove();
      } else {
        block.replaceWith(fragment);
      }
    },

    chunkUnits(units, size = 10) {
      const chunks = [];
      for (let i = 0; i < units.length; i += size) {
        chunks.push(units.slice(i, i + size));
      }
      return chunks;
    },

    async translateAndRenderUnits(units, renderMode) {
      const chunks = this.chunkUnits(units, 10);
      let chunkCursor = 0;
      let successCount = 0;
      let failCount = 0;
      let stoppedByInvalidContext = false;
      const concurrency = 2;

      // 句级分组：收集同一容器的所有句级翻译结果，统一渲染
      const sentenceGroups = new Map();  // groupId → { unit, translation }[]

      const flushSentenceGroup = (groupId) => {
        const group = sentenceGroups.get(groupId);
        if (!group || !group.length) return;
        // 按句子序号排序
        group.sort((a, b) => (a.unit._sentenceIndex || 0) - (b.unit._sentenceIndex || 0));
        const container = group[0].unit.container;
        if (!container.isConnected) {
          sentenceGroups.delete(groupId);
          return;
        }
        this.markProcessed(container);

        const translations = group.map(g => g.translation).filter(Boolean);
        if (!translations.length) {
          container.removeAttribute('data-lingoflow-processed');
          sentenceGroups.delete(groupId);
          return;
        }

        const fullText = group[0].unit._fullText || '';
        console.log('LingoFlow: renderSentenceGroup', translations.length,
          'sentences, container=', container.tagName, 'mode=', renderMode);

        const rendered = this.renderSentenceBilingualUnit(container, fullText, translations, renderMode);
        if (rendered) {
          successCount += translations.length;
        } else {
          container.removeAttribute('data-lingoflow-processed');
          failCount += translations.length;
        }
        sentenceGroups.delete(groupId);
      };

      const renderUnit = (unit, translation) => {
        const container = unit.container;

        // 句级单元：收集到分组中，等齐后统一渲染
        if (unit._isSentence && unit._groupId) {
          const gid = unit._groupId;
          if (!sentenceGroups.has(gid)) {
            sentenceGroups.set(gid, []);
          }
          sentenceGroups.get(gid).push({ unit, translation });

          // 检查是否该组全部翻译完毕
          const total = unit._sentenceTotal || 1;
          if (sentenceGroups.get(gid).length >= total) {
            flushSentenceGroup(gid);
          }
          return;
        }

        // 普通单元：原有逻辑
        if (!container.isConnected || container.dataset.lingoflowProcessed === 'true') return;

        this.markProcessed(container);

        console.log('LingoFlow: renderUnit text=', (unit.text || '').substring(0, 60), 'trans=', (translation || '').substring(0, 80), 'mode=', renderMode);

        if (isContextInvalidatedText(translation)) {
          console.warn('LingoFlow: Context invalidated for unit');
          container.removeAttribute('data-lingoflow-processed');
          stoppedByInvalidContext = true;
          return;
        }

        if (isFallbackText(translation)) {
          console.warn('LingoFlow: Fallback text for unit:', translation.substring(0, 80));
          container.removeAttribute('data-lingoflow-processed');
          failCount++;
          return;
        }

        const rendered = renderMode === 'translation'
          ? this.renderTranslationOnlyUnit(container, translation)
          : this.renderTranslationUnit(container, translation);

        if (rendered) {
          successCount++;
        } else {
          console.warn('LingoFlow: renderUnit returned false for text:', (translation || '').substring(0, 60));
          container.removeAttribute('data-lingoflow-processed');
        }
      };

      const worker = async () => {
        while (chunkCursor < chunks.length && !stoppedByInvalidContext) {
          const chunk = chunks[chunkCursor++];
          const activeChunk = chunk.filter(unit => {
            return unit.container.isConnected && unit.container.dataset.lingoflowProcessed !== 'true';
          });

          if (!activeChunk.length) continue;

          // 页面翻译固定英译中，所有 unit 的 targetLang 都是 'zh-CN'
          const batchTargetLang = activeChunk[0]?.targetLang || 'zh-CN';
          console.log('LingoFlow: translateAndRenderUnits batch:', activeChunk.length, 'texts, engine=', TranslationEngine.activeEngine);
          const translations = await TranslationEngine.translateMany(
            activeChunk.map(unit => unit.text),
            batchTargetLang
          );
          console.log('LingoFlow: translateAndRenderUnits got', Array.isArray(translations) ? translations.length : 'non-array', 'translations, first=', (translations && translations[0] || '').substring(0, 80));
          activeChunk.forEach((unit, index) => {
            renderUnit(unit, translations[index]);
          });
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()));

      // 兜底：处理可能未凑齐的句级分组（部分翻译失败等情况）
      for (const [groupId] of sentenceGroups) {
        flushSentenceGroup(groupId);
      }

      return { successCount, failCount, stoppedByInvalidContext };
    },

    async runIncrementalTranslation(mode, root = null, notify = false) {
      // Use stored translationRoot if available, otherwise fallback to document.body
      const useRoot = root || state.translationRoot || document.body;
      this.repairTranslationIntegrity();
      const units = this.collectTranslationUnits(useRoot);
      if (!units.length) return { successCount: 0, failCount: 0, stoppedByInvalidContext: false };
      if (notify) UI.showNotification(statusText('found', units.length));
      return this.translateAndRenderUnits(units, mode);
    },

    hasEmbeddedFrames() {
      return !!document.querySelector('iframe, frame');
    },

    isTopFrame() {
      try {
        return window.top === window;
      } catch (_) {
        return true;
      }
    },

    async collectInitialTranslationUnits(root = document.body) {
      let units = this.collectTranslationUnits(root);
      if (units.length) return units;

      const delays = [700, 1400, 2400];
      for (const delay of delays) {
        await new Promise(resolve => window.setTimeout(resolve, delay));
        if (!state.isTranslating) return [];
        units = this.collectTranslationUnits(root);
        if (units.length) return units;
      }

      return [];
    },

    scheduleSecondScan(mode) {
      const delays = [800, 2500, 5000];
      delays.forEach((delay, i) => {
        window.setTimeout(() => {
          if (!state.activeTranslationMode || state.isTranslating) return;
          this.repairTranslationIntegrity();
          this.runIncrementalTranslation(mode, null, false);
        }, delay);
      });
    },

    startDynamicTranslationObserver(mode) {
      this.stopDynamicTranslationObserver();
      state.activeTranslationMode = mode;

      state.mutationObserver = new MutationObserver((mutations) => {
        if (!state.activeTranslationMode || state.isTranslating) return;
        const hasLingoflowRemoval = mutations.some(mutation => {
          return Array.from(mutation.removedNodes).some(node => {
            if (node.nodeType !== Node.ELEMENT_NODE) return false;
            if (node.hasAttribute && node.hasAttribute('data-lingoflow')) return true;
            return !!(node.querySelector && node.querySelector('[data-lingoflow]'));
          });
        });

        const hasNewText = mutations.some(mutation => {
          return Array.from(mutation.addedNodes).some(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.hasAttribute && node.hasAttribute('data-lingoflow')) return false;
              if (node.querySelector && node.querySelector('[data-lingoflow]')) return false;
            }
            if (node.nodeType === Node.TEXT_NODE) return this.shouldTranslateText(node.textContent);
            if (node.nodeType === Node.ELEMENT_NODE) return this.shouldTranslateText(node.textContent || '');
            return false;
          });
        });

        if (!hasNewText && !hasLingoflowRemoval) return;

        clearTimeout(state.mutationTimer);
        state.mutationTimer = window.setTimeout(() => {
          if (!state.activeTranslationMode || state.isTranslating) return;
          // Use stored translationRoot (null = use default)
          this.repairTranslationIntegrity();
          this.runIncrementalTranslation(mode, null, false);
        }, hasLingoflowRemoval ? 900 : 500);
      });

      state.mutationObserver.observe(document.body, { childList: true, subtree: true });
      const observerLifetime = this.isConservativePage() ? 90000 : 10000;
      state.observerStopTimer = window.setTimeout(() => this.stopDynamicTranslationObserver(), observerLifetime);
    },

    stopDynamicTranslationObserver() {
      if (state.mutationObserver) {
        state.mutationObserver.disconnect();
        state.mutationObserver = null;
      }

      clearTimeout(state.mutationTimer);
      clearTimeout(state.observerStopTimer);
      state.mutationTimer = null;
      state.observerStopTimer = null;
      state.activeTranslationMode = null;
    },

    async translatePage() {
      return this.enableTranslationMode();
    },

    async enableTranslationMode() {
      try {
        if (state.isTranslating) {
          UI.showNotification(statusText('translationInProgress'));
          return;
        }

        // translate.js engine: delegate full-page translation to the injected library.
        // It rewrites the page DOM directly in the MAIN world, so we do not run
        // LingoFlow's block-by-block bilingual pipeline here.
        if (TranslationEngine.activeEngine === 'translatejs') {
          UI.showNotification(statusText('translating'));
          try {
            const resp = await new Promise((resolve) => {
              chrome.runtime.sendMessage(
                { action: 'inject_translatejs_page', targetLang: state.targetLanguage || 'en' },
                (r) => resolve(r || { success: false, error: 'no_response' })
              );
            });
            if (resp && resp.success) {
              UI.showNotification(statusText('translatejsDone'));
            } else {
              UI.showNotification((resp && resp.error) ? statusText('translatejsError', resp.error) : statusText('translatejsFailed'));
            }
          } catch (e) {
            UI.showNotification(statusText('translatejsFailed'));
          }
          return;
        }

        // If page already has translation, restore first to avoid double-translating
        if (state.isTranslated) {
          this.restoreOriginal();
        }

        state.isTranslating = true;

        // Smart: detect main content area, only translate inside it
        const mainArea = this.findMainContentArea();
        state.translationRoot = mainArea;
        console.log('LingoFlow: Main content area =', mainArea && mainArea.tagName, mainArea && mainArea.className);

        let units = await this.collectInitialTranslationUnits(mainArea);
        console.log('LingoFlow: enableTranslationMode found ' + units.length + ' units in mainArea');

        // Fallback: if mainArea yields no units, try document.body
        if (units.length === 0 && mainArea !== document.body) {
          console.log('LingoFlow: No units in mainArea, trying document.body');
          state.translationRoot = document.body;
          units = await this.collectInitialTranslationUnits(document.body);
          console.log('LingoFlow: enableTranslationMode found ' + units.length + ' units in document.body');
        }

        // Extra diag: if still 0 units, log what's on the page
        if (units.length === 0) {
          const allText = document.body.innerText || '';
          console.log('LingoFlow: Page text length =', allText.length,
            'hasLatin =', /[A-Za-z]{2,}/.test(allText),
            'hasChinese =', /[\u4e00-\u9fff]/.test(allText));
        }

        if (units.length === 0) {
          state.isTranslating = false;
          if (!this.isTopFrame() || !this.hasEmbeddedFrames()) {
            UI.showNotification(statusText('noText'));
          }
          return;
        }

        // Show persistent notification (won't auto-dismiss until result comes in)
        UI.showNotification(statusText('found', units.length), true);

        const result = await this.translateAndRenderUnits(units, 'bilingual');
        const { successCount, failCount, stoppedByInvalidContext } = result;

        if (stoppedByInvalidContext) {
          UI.showNotification(statusText('reloaded'));
        } else if (successCount === 0 && failCount === 0) {
          UI.showNotification(statusText('noText'));
        } else if (failCount > 0 && successCount === 0) {
          UI.showNotification(statusText('translationFailed'));
        } else if (failCount > 0) {
          UI.showNotification(statusText('partial', successCount, failCount));
        } else {
          UI.showNotification(statusText('done', successCount));
        }

        if (successCount > 0) {
          state.isTranslated = true;
          state.isBilingualMode = true;
          this.scheduleSecondScan('bilingual');
          this.startDynamicTranslationObserver('bilingual');
        } else {
          state.isBilingualMode = false;
        }
      } catch (err) {
        console.error('LingoFlow: enableTranslationMode error:', err);
        UI.showNotification(statusText('translationFailed'));
      } finally {
        state.isTranslating = false;
      }
    },

    toggleBilingualMode() {
      const hasBilingualDom = document.querySelector(
        '.lingoflow-block[data-lingoflow="true"], .lingoflow-inline-translation[data-lingoflow="true"]'
      );
      if (state.isBilingualMode && hasBilingualDom) {
        this.restoreOriginal();
      } else {
        this.enableBilingualMode();
      }
    },

    async enableBilingualMode() {
      try {
        if (state.isTranslating) {
          UI.showNotification(statusText('translationInProgress'));
          return;
        }

        // If page already has translation, restore first
        if (state.isTranslated) {
          this.restoreOriginal();
        }

        state.isTranslating = true;

        // Smart: detect main content area, only translate inside it
        const mainArea = this.findMainContentArea();
        state.translationRoot = mainArea;
        console.log('LingoFlow: Main content area =', mainArea && mainArea.tagName, mainArea && mainArea.className);

        let units = await this.collectInitialTranslationUnits(mainArea);
        console.log('LingoFlow: enableBilingualMode found ' + units.length + ' translation units in mainArea');

        // Fallback: if mainArea yields no units, try document.body
        if (units.length === 0 && mainArea !== document.body) {
          console.log('LingoFlow: No units in mainArea, trying document.body');
          state.translationRoot = document.body;
          units = await this.collectInitialTranslationUnits(document.body);
          console.log('LingoFlow: enableBilingualMode found ' + units.length + ' units in document.body');
        }

        // Extra diag: if still 0 units, log what's on the page
        if (units.length === 0) {
          const allText = document.body.innerText || '';
          console.log('LingoFlow: Page text length =', allText.length,
            'hasLatin =', /[A-Za-z]{2,}/.test(allText),
            'hasChinese =', /[\u4e00-\u9fff]/.test(allText));
        }

        if (units.length === 0) {
          if (!this.isTopFrame() || !this.hasEmbeddedFrames()) {
            UI.showNotification(statusText('noText'));
          }
          return;
        }

        // Show persistent notification (won't auto-dismiss until result comes in)
        UI.showNotification(statusText('found', units.length), true);

        const result = await this.translateAndRenderUnits(units, 'bilingual');
        const { successCount, failCount, stoppedByInvalidContext } = result;

        if (stoppedByInvalidContext) {
          UI.showNotification(statusText('reloaded'));
        } else if (successCount === 0 && failCount === 0) {
          UI.showNotification(statusText('noText'));
        } else if (failCount > 0 && successCount === 0) {
          UI.showNotification(statusText('translationFailed'));
        } else if (failCount > 0) {
          UI.showNotification(statusText('partial', successCount, failCount));
        } else {
          UI.showNotification(statusText('done', successCount));
        }

        if (successCount > 0) {
          state.isTranslated = true;
          this.scheduleSecondScan('bilingual');
          this.startDynamicTranslationObserver('bilingual');
        }
        state.isBilingualMode = successCount > 0;
      } catch (err) {
        console.error('LingoFlow: enableBilingualMode error:', err);
        UI.showNotification(statusText('translationFailed'));
      } finally {
        state.isTranslating = false;
      }
    },

    restoreOriginal() {
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      this.stopDynamicTranslationObserver();
      clearTimeout(state.hoverParagraphTimer);
      state.hoverParagraphTimer = null;
      state.hoverParagraphTarget = null;

      document.querySelectorAll('.lingoflow-block[data-lingoflow="true"]').forEach(block => {
        this.restoreBilingualBlock(block);
      });

      document.querySelectorAll('[data-lingoflow]').forEach(node => {
        node.remove();
      });

      document.querySelectorAll('[data-lingoflow-hidden]').forEach(el => {
        el.hidden = false;
        el.removeAttribute('data-lingoflow-hidden');
      });

      document.querySelectorAll('[data-lingoflow-processed]').forEach(el => {
        el.removeAttribute('data-lingoflow-processed');
        el.removeAttribute('data-lingoflow-rendered');
        el.removeAttribute('data-lingoflow-source-id');
        el.removeAttribute('data-lingoflow-tooltip');
        el.removeAttribute('data-lingoflow-hover-loading');
        el.removeAttribute('data-lingoflow-hover-rendered');
        el.classList.remove('lingoflow-translated', 'lingoflow-bilingual');
        el.classList.remove('lingoflow-tooltip-host', 'lingoflow-tooltip-active');
        delete el.dataset.lfTranslated;
      });

      document.querySelectorAll('[data-lingoflow-rendered], [data-lingoflow-source-id], [data-lingoflow-tooltip], [data-lingoflow-hover-loading], [data-lingoflow-hover-rendered]').forEach(el => {
        el.removeAttribute('data-lingoflow-rendered');
        el.removeAttribute('data-lingoflow-source-id');
        el.removeAttribute('data-lingoflow-tooltip');
        el.removeAttribute('data-lingoflow-hover-loading');
        el.removeAttribute('data-lingoflow-hover-rendered');
        el.classList.remove('lingoflow-tooltip-host', 'lingoflow-tooltip-active');
      });

      state.originalContent.clear();
      state.translatedNodes.clear();
      state.isBilingualMode = false;
      state.isTranslated = false;
      state.translationRoot = null;
      window.scrollTo(scrollX, scrollY);
    }
  };
  // Global safety net: catch any unhandled promise rejections (e.g., chrome.i18n
  // undefined after Service Worker termination) to prevent ugly console errors.
  window.addEventListener('unhandledrejection', (e) => {
    const msg = e.reason && (e.reason.message || e.reason.toString()) || '';
    // Only suppress known-harmless context-invalidated errors
    if (msg.includes('getMessage') || msg.includes('i18n') ||
        msg.includes('context invalidated') || msg.includes('Extension context')) {
      e.preventDefault();
      console.warn('LingoFlow: Suppressed unhandled rejection:', msg);
    }
  });
  // Initialize
  function init() {
    try {
      console.log('LingoFlow: Content script loaded');

      // Load settings
      chrome.storage.local.get(['lingoflow_settings'], (result) => {
        if (result.lingoflow_settings) {
          state.selectionTranslationEnabled = result.lingoflow_settings.selectionTranslation !== false;
          state.hoverParagraphTranslationEnabled = result.lingoflow_settings.hoverParagraphTranslation === true;
          state.toolbarPosition = result.lingoflow_settings.toolbarPosition || 'above';
          state.uiLanguage = result.lingoflow_settings.uiLanguage || 'auto';
          state.targetLanguage = result.lingoflow_settings.targetLanguage || 'zh';
          state.existingBilingualStrategy = result.lingoflow_settings.existingBilingualStrategy || 'skip';
          TranslationEngine.activeEngine = result.lingoflow_settings.translationEngine || 'google';
        }
      });

      // Event listeners
      document.addEventListener('mouseup', (e) => EventHandlers.scheduleSelectionToolbar(e, 80));
      document.addEventListener('pointerup', (e) => EventHandlers.scheduleSelectionToolbar(e, 80));
      document.addEventListener('touchend', (e) => EventHandlers.scheduleSelectionToolbar(e, 120), { passive: true });
      document.addEventListener('selectionchange', () => EventHandlers.scheduleSelectionToolbar({ target: document.activeElement }, 140));
      document.addEventListener('keyup', (e) => EventHandlers.scheduleSelectionToolbar(e, 80));
      document.addEventListener('pointerover', (e) => EventHandlers.scheduleHoverParagraphTranslation(e), { passive: true });
      document.addEventListener('pointerout', (e) => EventHandlers.cancelHoverParagraphTranslation(e), { passive: true });
      document.addEventListener('mousedown', (e) => {
        if (e.target && e.target.closest && e.target.closest('.lingoflow-ui')) return;
        // Remove the toolbar on mousedown elsewhere (removeFloatingToolbar
        // also clears the dedupe key, so re-selecting the same text will
        // re-show the toolbar normally). Keep the translation result box
        // visible so a stray click (e.g. taking a screenshot) doesn't dismiss it.
        UI.removeFloatingToolbar();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          UI.removeFloatingToolbar();
          UI.removeTranslationResult();
        }
      });
      window.addEventListener('scroll', () => {
        // Only dismiss the floating toolbar on scroll; keep the translation
        // result box open so a slight scroll while reading doesn't clear it.
        UI.removeFloatingToolbar();
      }, { passive: true });
      // Listen for settings changes
      chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes.lingoflow_settings) {
          const settings = changes.lingoflow_settings.newValue;
          const wasSelectionEnabled = state.selectionTranslationEnabled;
          const wasHoverEnabled = state.hoverParagraphTranslationEnabled;
          state.selectionTranslationEnabled = settings.selectionTranslation !== false;
          state.hoverParagraphTranslationEnabled = settings.hoverParagraphTranslation === true;
          state.toolbarPosition = settings.toolbarPosition || 'above';
          state.uiLanguage = settings.uiLanguage || 'auto';
          state.targetLanguage = settings.targetLanguage || 'zh';
          state.existingBilingualStrategy = settings.existingBilingualStrategy || 'skip';
          TranslationEngine.activeEngine = settings.translationEngine || 'google';

          // If selection translation was just turned off, remove any visible toolbar/result
          if (wasSelectionEnabled && !state.selectionTranslationEnabled) {
            UI.removeFloatingToolbar();
            UI.removeTranslationResult();
          }
          if (wasHoverEnabled && !state.hoverParagraphTranslationEnabled) {
            clearTimeout(state.hoverParagraphTimer);
            state.hoverParagraphTimer = null;
            state.hoverParagraphTarget = null;
          }
        }
      });

      console.log('LingoFlow: Content script initialized successfully');
    } catch (err) {
      console.error('LingoFlow: Content script init error:', err);
    }
  }

  // Start
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  } catch (err) {
    console.error('LingoFlow: Startup error:', err);
  }
})();
