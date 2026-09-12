// LingoFlow Content Script

// ===== 站点补扫配置（按需调整）=====
// 仅 LinkedIn 启用补扫（虚拟化列表 + 懒加载内容需要）；其它网站零补扫、绝不闪烁。
const SITE_REPAIR_CONFIG = {
  passes: 6,              // 翻译完成后的补扫次数（覆盖页面静止时晚出现的内容）
  intervalSec: 3,         // 每次补扫的间隔（秒）
  scrollCooldownSec: 2.5  // 滚动触发补扫的冷却（秒）
};

// 统一目标语言代码映射（供划词翻译与网页翻译共用）
// zh → zh-CN（Google/通用格式）；es → es（西班牙文）；en → en
function mapTargetLang(targetLang) {
  const t = String(targetLang || '').toLowerCase();
  if (t === 'zh' || t.indexOf('zh') === 0) return 'zh-CN';
  if (t.indexOf('es') === 0) return 'es';
  if (t.indexOf('en') === 0) return 'en';
  return 'zh-CN'; // 向后兼容：未知沿用原默认
}
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
    repairPassTimers: [],       // bounded delayed repair passes (no continuous observer)
    _spaHooksInstalled: false,
    _spaRepairTimer: null,
    _lastSpaRepair: 0,
    _descriptionPurged: false,
    _wipeGuard: null,
    _wipeRepairTimer: null,
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
      en: 'No translatable text found. Page translation may not work on some sites (image-based content). Try selection translation instead.',
      zh: '未找到可翻译的文本。网页翻译在部分网站（如全图片内容/特殊框架）可能不适用，可尝试划词翻译：选中文字后使用悬浮工具条'
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

  // Module-level context-invalidated flag + banner. When the extension is
  // reloaded while an old tab's content script is still alive, chrome.storage /
  // chrome.runtime calls throw "Extension context invalidated". We swallow them
  // (fall back to defaults) and show a "refresh this page" banner so the user
  // knows to reload instead of hitting a red console error.
  let _ctxInvalidated = false;
  const LINGOFLOW_CTX_BANNER_ID = '__lingoflow_ctx_banner__';
  function markCtxInvalidated() { _ctxInvalidated = true; }
  function isCtxInvalidated() { return _ctxInvalidated; }

  function showContextInvalidatedBanner() {
    if (document.getElementById(LINGOFLOW_CTX_BANNER_ID)) return;
    const wrap = document.createElement('div');
    wrap.id = LINGOFLOW_CTX_BANNER_ID;
    wrap.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#b8860b;color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    const msg = document.createElement('span');
    msg.textContent = 'LingoFlow 刚刚更新，请刷新此页面以重新连接。LingoFlow was just updated — refresh this page to reconnect.';
    const btn = document.createElement('button');
    btn.textContent = '刷新此页面 / Refresh';
    btn.style.cssText = 'background:#fff;color:#b8860b;border:0;border-radius:6px;padding:6px 12px;font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;cursor:pointer;white-space:nowrap';
    btn.addEventListener('click', () => location.reload());
    wrap.appendChild(msg);
    wrap.appendChild(btn);
    (document.body || document.documentElement).appendChild(wrap);
  }

  // Safe wrapper around chrome.storage.local.get: never throws on an
  // invalidated context, returns defaults instead.
  function storageGet(keys) {
    return new Promise((resolve) => {
      if (_ctxInvalidated || typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve({});
        return;
      }
      try {
        chrome.storage.local.get(keys, (result) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            const msg = (chrome.runtime.lastError.message || '').toLowerCase();
            if (msg.includes('context invalidated') || msg.includes('extension has been reloaded')) {
              markCtxInvalidated();
              showContextInvalidatedBanner();
            }
            resolve({});
            return;
          }
          resolve(result || {});
        });
      } catch (err) {
        if (isContextInvalidatedError(err)) {
          markCtxInvalidated();
          showContextInvalidatedBanner();
        } else {
          console.warn('LingoFlow: storageGet error:', getErrorMessage(err));
        }
        resolve({});
      }
    });
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
        const tl = mapTargetLang(targetLang);

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
                  if (response.model) {
                    console.log(`LingoFlow: ✅ translation served by [${response.model}]`, response.translation.substring(0, 60) + (response.translation.length > 60 ? '…' : ''));
                  }
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
        const tl = mapTargetLang(targetLang);
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
                  if (response.model) {
                    console.log(`LingoFlow: ✅ translation served by [${response.model}]`, response.translation.substring(0, 60) + (response.translation.length > 60 ? '…' : ''));
                  }
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

      const tl = mapTargetLang(targetLang);

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
                  : 'non-array response') : 'null/undefined',
                response && response.model ? `, model=${response.model}` : '');

              if (response && Array.isArray(response.translations)) {
                if (response.model) {
                  console.log(`LingoFlow: ✅ batch translation served by [${response.model}]`);
                }
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

    isLookupWord(text) {
      const t = String(text || '').trim();
      if (!t) return false;
      if (/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*$/.test(t)) return true;
      if (/^[\u3400-\u9FFF\uF900-\uFAFF]{1,8}$/.test(t)) return true;
      return false;
    },

    getType(text) {
      return this.isLookupWord(text) ? 'word' : 'sentence';
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

      if (this.isLookupWord(normalized)) {
        // 单词：优先等离线词典结果（600ms 宽限）；未命中才回退引擎译文，词典结果稍后升级
        const dictP = this.lookupWord(normalized);
        const transP = this.translateText(normalized);
        const graceP = new Promise((resolve) => setTimeout(resolve, 600));
        let quick;
        try {
          quick = await Promise.race([dictP, graceP.then(() => transP)]);
        } catch (_) {
          quick = await transP.catch(() => dictP);
        }
        if (quick && !quick.dictionary && !quick.error) quick.__upgrade = dictP;
        this.cache.set(cacheKey, quick);
        dictP.then(rich => {
          if (rich && rich.dictionary) this.cache.set(cacheKey, rich);
        }).catch(() => {});
        return quick;
      }

      const result = await this.translateText(normalized);
      this.cache.set(cacheKey, result);
      return result;
    },

    async resolveWithParagraphs(text, paragraphs) {
      const cleanParagraphs = Array.isArray(paragraphs)
        ? paragraphs.map(part => String(part || '').trim()).filter(Boolean)
        : [];
      if (this.isLookupWord(text) || cleanParagraphs.length <= 1) {
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
      const meanings = dictionary && Array.isArray(dictionary.meanings)
        ? dictionary.meanings.filter(item => item && item.definition && item.definition !== translation)
        : [];
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
          <div class="lingoflow-result-translation">${renderParagraphs(resultData.paragraphs, 'translation', translation)}</div>
        `;

      result.innerHTML = `
        <div class="lingoflow-result-header">
          <span class="lingoflow-result-title">${this.escapeHtml(isWord ? _getMessage('word', 'Word') : _getMessage('translation_result', 'Translation'))}</span>
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

      // 详细释义稍后到达时，原地升级气泡（先出译文，再补音标/词性/释义/例句）
      if (resultData.__upgrade) {
        const upgradeP = resultData.__upgrade;
        resultData.__upgrade = null;
        upgradeP.then(rich => {
          if (!rich || !rich.dictionary) return;
          if (!document.body.contains(result)) return;
          this.showTranslationResult(selectionContext, {
            text: rich.text || originalText,
            translation: rich.translation || translation,
            mode: 'word',
            dictionary: rich.dictionary
          });
        }).catch(() => {});
      }

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

      // Note: removed 12s auto-dismiss — the result box is now closed manually
      // (× button, Escape, or click outside). User feedback: it disappeared
      // before they could read it.
    },

    // Remove translation result
    removeTranslationResult() {
      const result = document.getElementById('lingoflow-translation-result');
      if (result) result.remove();
      this.currentResult = null;
    },

    // Storage + context-invalidation safety helpers (storageGet, markCtxInvalidated,
    // showContextInvalidatedBanner, isCtxInvalidated) are defined above and retained.

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
            applyTranslationColorStyle(s.translationColor || 'inherit');
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

    // 目标语言感知的"可译内容"判断（主内容区探测用）：
    // 目标 = zh（默认）→ 与原 hasLatinText 行为完全一致（零回归）
    // 目标 = en/es → 中文也算有效内容（支持中→英/西）
    hasTranslatableText(text) {
      if ((state.targetLanguage || 'zh') === 'zh') return this.hasLatinText(text);
      return this.hasLatinText(text) || this.hasChineseText(text);
    },

    // 文本是否"已是目标语言"（翻译时应跳过）：
    // 目标 = zh → 中文文本跳过（与旧版固定英→中行为一致）
    // 目标 = en → 无西语特征字符的纯拉丁文本视为英文，跳过
    // 目标 = es → 含西语特征字符的文本视为西语，跳过
    isTargetLangText(text) {
      const target = state.targetLanguage || 'zh';
      if (target === 'zh') return isChineseText(text);
      if (!this.hasLatinText(text) || this.hasChineseText(text)) return false;
      if (target === 'es') {
        const spanishChars = text.match(/[áéíóúüñ¿¡]/gi);
        return !!(spanishChars && spanishChars.length >= 2);
      }
      return !/[áéíóúüñ¿¡]/i.test(text);
    },

    // 页面翻译过滤：跳过"已是目标语言"的文本
    // （旧版固定只做英→中，中文站点选英文目标时会全部被拒 → "未找到可翻译的文本"）
    shouldTranslateText(text) {
      const normalized = this.normalizeText(text);
      if (normalized.length < 3) return false;
      if (normalized.length > 5000) return false;
      if (/^\d+([.,:/-]\d+)*$/.test(normalized)) return false;
      if (!/\p{L}/u.test(normalized.replace(/[^\p{L}\p{N}]/gu, ''))) return false;
      if (isAllCapsShortLabel(normalized)) return false;

      // 动态语言过滤：目标 = zh 时中文文本跳过（原行为）；目标 = en/es 时对应语言跳过
      if (this.isTargetLangText(normalized)) return false;
      if (!/\p{L}{2,}/u.test(normalized)) return false;
      // 中英混合节点：目标 = zh 时跳过（原行为）；其他目标语言交给引擎整体处理
      if ((state.targetLanguage || 'zh') === 'zh' && hasMixedLatinAndChinese(normalized)) return false;
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
      if (text.length < 8 || !this.hasTranslatableText(text)) return false;

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
        return ct.length >= 2 && this.hasTranslatableText(ct) && c.children.length <= 6;
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
      if (text.length < 8 || !this.hasTranslatableText(text)) return false;

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
        return ct.length >= 2 && this.hasTranslatableText(ct) && c.children.length <= 6;
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
      if (text.length < 8 || !this.hasTranslatableText(text)) return false;

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
        return ct.length >= 2 && this.hasTranslatableText(ct) && c.children.length <= 6;
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
      if (text.length < 8 || !this.hasTranslatableText(text)) return false;

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
        return ct.length >= 2 && this.hasTranslatableText(ct) && c.children.length <= 6;
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
      if (text.length < 8 || !this.hasTranslatableText(text)) return false;

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
        return ct.length >= 2 && this.hasTranslatableText(ct) && c.children.length <= 6;
      });
      if (textChildren.length >= 3 && text.length >= 20) return true;

      return false;
    },

    hasExistingTranslation(container) {
      if (state.existingBilingualStrategy === 'translate_english') return false;

      // 优先用「是否已有 LingoFlow 注入的译文节点」判定——不依赖字符集。
      // 英文与西班牙文同属拉丁字母，无法用字符区分，必须靠注入标记。
      if (container.querySelector && container.querySelector('[data-lingoflow="true"]')) return true;
      if (container.getAttribute && container.getAttribute('data-lingoflow-rendered') === 'true') return true;
      // 容器自身就是注入的译文节点
      if (container.getAttribute && container.getAttribute('data-lingoflow') === 'true') return true;

      // 目标为中文时，保留原来的「中英混排」字符集判定，
      // 用于识别页面自带的双语内容（非 LingoFlow 注入）。
      const target = String(state.targetLanguage || 'zh').toLowerCase();
      if (target === 'zh' || target.indexOf('zh') === 0) {
        const text = this.getElementText(container);
        return this.hasLatinText(text) && this.hasChineseText(text);
      }

      // 目标为英文/西班牙文：拉丁字母之间无法用字符集区分，只依赖上面的注入节点判定。
      return false;
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
      if (text.length < 10 || !this.hasTranslatableText(text)) return false;

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
      if (headingTextMatch && text.length >= 15 && this.hasTranslatableText(text)) {
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
        return ct.length >= 5 && this.hasTranslatableText(ct);
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
      if (text.length < 8 || !this.hasTranslatableText(text)) return false;

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
        return ct.length >= 2 && this.hasTranslatableText(ct) && c.children.length <= 6;
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
      const hasRealContent = elText.length > 35 && this.hasTranslatableText(elText);

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
      if (text.length < 8 || !this.hasTranslatableText(text)) return false;

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
        return ct.length >= 2 && this.hasTranslatableText(ct) && c.children.length <= 6;
      });
      if (textChildren.length >= 3 && text.length >= 20) return true;

      return false;
    },

    // Detect containers that are UI chrome (nav, sidebar, header, toolbar, etc.)
    // and should NOT be translated in bilingual mode.
    shouldSkipContainer(container) {
      if (!container) return false;

      // LinkedIn: 职位描述的折叠/展开容器是正文内容，绝不能按 UI chrome 跳过
      //（折叠态用 max-height + overflow:hidden 裁剪，注入的译文会被藏住，看起来像漏翻）
      if (container.closest && container.closest(
        '[data-testid="inline-show-more-text"], [data-testid="expanded-text-below"], [data-testid="expandable-text-box"], .jobs-description__content'
      )) return false;

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
      if (containerText.length > 35 && this.hasTranslatableText(containerText)) {
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
      const hasRealContainerContent = containerTextForCheck.length > 35 && this.hasTranslatableText(containerTextForCheck);

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
      if (text.length < 8 || !this.hasTranslatableText(text)) return false;

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
        return ct.length >= 2 && this.hasTranslatableText(ct) && c.children.length <= 6;
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
          return ct.length >= 5 && this.hasTranslatableText(ct);
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
      if (text.length < 8 || !this.hasTranslatableText(text)) return false;

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
        return ct.length >= 2 && this.hasTranslatableText(ct) && c.children.length <= 6;
      });
      if (textChildren.length >= 3 && text.length >= 20) return true;

      return false;
    },

    // 文本节点是否真的显示在页面上（Range 取客户端矩形，display:contents 也适用）
    isVisibleTextNode(textNode) {
      if (!textNode || !textNode.isConnected) return false;
      try {
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const rects = range.getClientRects();
        if (rects && rects.length) {
          for (const rect of rects) {
            if (rect.width > 0 && rect.height > 0) return true;
          }
        }
        return false;
      } catch (_) {
        return true;   // 判断失败时不阻塞翻译
      }
    },

    // 元素是否真的显示在页面上（用于区分折叠/展开双副本里"可见的那一份"）。
    // 注意：LinkedIn 大量使用 display:contents（data-display-contents="true"），
    // 这类元素自身没有盒子、getClientRects() 为空，必须再看后代是否有可见盒子，
    // 否则会把"可见副本"误判成隐藏副本。
    isVisibleElement(el) {
      if (!el || !el.isConnected) return false;
      try {
        if (el.getClientRects && el.getClientRects().length) {
          for (const rect of el.getClientRects()) {
            if (rect.width > 0 && rect.height > 0) return true;
          }
        }
        if (el.getBoundingClientRect) {
          const own = el.getBoundingClientRect();
          if (own && own.width > 0 && own.height > 0) return true;
        }
        if (el.querySelectorAll) {
          const kids = el.querySelectorAll('*');
          const limit = Math.min(kids.length, 30);
          for (let i = 0; i < limit; i++) {
            const rect = kids[i].getBoundingClientRect();
            if (rect && rect.width > 0 && rect.height > 0) return true;
          }
        }
      } catch (_) {}
      return false;
    },

    // 职位描述区域专用收集（该区域由本函数全权接管，通用遍历会跳过它）：
    //   - 散文段落（li/ul 之外）→ 聚合为一个「整段译文面板」，旁挂在可见主根之后。
    //     面板在折叠层之外，绝不会被裁掉（逐段旁挂曾反复落进隐藏副本/被限高层）。
    //   - li 列表项 → 逐条旁挂在 LI 之后（与现有表现一致）。
    collectJobDescriptionUnits(root, units) {
      const scope = (root && root.querySelectorAll) ? root : document;
      let descRoots;
      try {
        descRoots = Array.from(scope.querySelectorAll(this.descriptionSelector()));
      } catch (_) {
        return;
      }
      if (!descRoots.length) return;

      // 只取「可见且文本最多」的根作为主描述区（其余是嵌套/隐藏副本）
      const candidates = descRoots
        .filter(r => !r.closest('.lingoflow-ui'))
        .map(r => ({ root: r, text: this.normalizeText(r.textContent || '') }))
        .filter(item => item.text.length > 60);
      if (!candidates.length) return;
      candidates.sort((a, b) => b.text.length - a.text.length);
      const mainRoot = candidates[0].root;
      if (!mainRoot || !this.isVisibleElement(mainRoot)) return;

      let walker;
      try {
        walker = document.createTreeWalker(mainRoot, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) => {
            if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (this.skipTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
            if (parent.closest && parent.closest('[data-lingoflow="true"], .lingoflow-ui')) {
              return NodeFilter.FILTER_REJECT;
            }
            if (!this.isVisibleTextNode(node)) return NodeFilter.FILTER_REJECT;  // 隐藏副本不要
            return NodeFilter.FILTER_ACCEPT;
          }
        });
      } catch (_) {
        return;
      }

      let proseTextRaw = '';           // 散文全文（段落之间用 \n 分隔）
      let prevProseNode = null;        // 上一个散文文本节点（判断段落边界用）
      const blockTextLens = new Map(); // 块级锚点 → 累计文本长度（Map 保持文档顺序）
      let lastProseBlock = null;
      let firstLongTextNode = null;    // 扁平 DOM 用：第一个 ≥100 字符的散文文本节点
      let lastLongTextNode = null;     // 扁平 DOM 用：最后一个 ≥100 字符的散文文本节点
      const listAnchors = new Map();   // LI 锚点 → 文本片段

      let textNode;
      while ((textNode = walker.nextNode())) {
        const ownText = this.normalizeText(textNode.nodeValue);
        if (!ownText || !this.shouldTranslateText(ownText)) continue;

        const inList = textNode.parentElement.closest('li, ul, ol');
        if (inList) {
          // 列表项：逐条旁挂（渲染表现已验证 OK）
          const anchor = inList.tagName === 'LI' ? inList : inList.closest('li');
          if (!anchor) continue;
          const parts = listAnchors.get(anchor) || [];
          parts.push(ownText);
          listAnchors.set(anchor, parts);
          continue;
        }
        if (proseTextRaw) {
          // 段落分行只在 LinkedIn 启用：该函数内部使用 getComputedStyle，
          // 在所有网站都跑会造成布局抖动、其它网页翻译闪烁。
          const useBreak = /(^|\\.)linkedin\\.com$/.test(location.hostname || '');
          proseTextRaw += useBreak && this.hasParagraphBreakBetween(prevProseNode, textNode) ? '\n' : ' ';
        }
        proseTextRaw += ownText;
        prevProseNode = textNode;
        if (ownText.length >= 100) {
          if (!firstLongTextNode) firstLongTextNode = textNode;
          lastLongTextNode = textNode;
        }
        const block = this.findProseBlock(textNode, mainRoot);
        if (block && (block === mainRoot || mainRoot.contains(block))) {
          lastProseBlock = block;
          blockTextLens.set(block, (blockTextLens.get(block) || 0) + ownText.length);
        }
      }

      // 1) 列表项逐条旁挂
      listAnchors.forEach((parts, anchor) => {
        const text = this.normalizeText(parts.join(' '));
        if (!text || text.length < 12 || !this.shouldTranslateText(text)) return;
        const hash = this.hashText(text);
        if (this.hasInlineTextBlock(hash)) return;   // 已渲染过
        if (anchor.querySelector && anchor.querySelector('[data-lingoflow="true"]')) return;
        const neighbours = [anchor.nextElementSibling, anchor.previousElementSibling];
        const covered = neighbours.some(el => el && el.hasAttribute &&
          el.hasAttribute('data-lingoflow') && !el.hasAttribute('data-lingoflow-inline-hash'));
        if (covered) return;
        units.set(anchor, { container: anchor, anchor, _anchorHash: hash, textParts: [text] });
      });

      // 2) 散文段落 → 整段译文面板（旁挂在主根之后，折叠层之外）
      // 注意保留 \n：面板用 pre-line 渲染，按原文段落分行
      const proseText = (proseTextRaw || '').trim();
      if (!proseText || proseText.length < 60 || !this.shouldTranslateText(proseText)) return;
      if (proseText.length > 9000) return;
      const panelHash = this.hashText(proseText);
      if (this.hasInlineTextBlock(panelHash)) return;   // 面板已渲染
      // 面板锚点 = 最后一个「长段落」块（累计 ≥100 字符）。
      // 尾部的 Company / Job ID 等短行不属于描述主体，锚到它们会把面板带到区域最底部。
      let panelAnchor = null;
      for (const [block, len] of blockTextLens) {
        if (len >= 100) panelAnchor = block;
      }
      if (!panelAnchor) panelAnchor = lastProseBlock || mainRoot;   // 短描述兜底：维持原行为

      // 扁平 DOM（正文段落只是 mainRoot 下的裸文本节点 + <br> 分隔，没有任何段落级元素）
      // 时，块级锚点只能落到 mainRoot → 面板会被插到整个区域最底部。
      // 改用「第一个长文本节点」定位：面板插到它之后第一个「章节边界元素」
      // （UL/OL/标题/段落/表格）之前——正好落在正文段落之下、
      // Key job responsibilities / Basic Qualifications 等章节之上。
      // 注意不能用"最后一个"长文本节点：尾部陈述段在所有列表之后，其后没有元素，
      // 会拿不到插入点而回退到底部（1.3.0 初版踩坑）。
      let insertBeforeEl = null;
      const anchorTextNode = firstLongTextNode || lastLongTextNode;
      if (anchorTextNode && anchorTextNode.isConnected) {
        try {
          const after = [];
          for (const el of mainRoot.querySelectorAll('*')) {
            if (el.tagName !== 'BR' &&
                (el.compareDocumentPosition(anchorTextNode) & Node.DOCUMENT_POSITION_PRECEDING)) {
              after.push(el);
            }
          }
          insertBeforeEl = after.find(el => /^(UL|OL|H[1-6]|P|TABLE)$/.test(el.tagName)) || after[0] || null;
        } catch (_) {}
      }

      units.set(panelAnchor, {
        container: mainRoot,
        anchor: panelAnchor,
        _anchorHash: panelHash,
        _descPanel: true,
        _insertBefore: insertBeforeEl,
        textParts: [proseText]
      });
    },

    // 两个文本节点之间是否存在段落边界（<br> 或块级元素）→ 决定面板文本里用换行还是空格
    hasParagraphBreakBetween(prev, cur) {
      if (!prev || !cur || !prev.isConnected || !cur.isConnected) return true;
      const isBlockLike = (el) => {
        if (!el || el.nodeType !== 1) return false;
        if (el.tagName === 'BR') return true;
        if (/^(DIV|P|LI|UL|OL|SECTION|ARTICLE|BLOCKQUOTE|H[1-6]|TABLE|TR)$/.test(el.tagName)) return true;
        try {
          const d = window.getComputedStyle(el).display;
          return /^(block|list-item|flow-root|table)/.test(d) || d.indexOf('flex') === 0 || d.indexOf('grid') === 0;
        } catch (_) { return false; }
      };
      // 最近公共祖先
      const ancestors = new Set();
      let n = prev;
      while (n) { ancestors.add(n); n = n.parentNode; }
      let lca = cur;
      while (lca && !ancestors.has(lca)) lca = lca.parentNode;
      if (!lca) return true;
      // prev → lca：沿途检查每个层级的后续兄弟
      n = prev;
      while (n && n !== lca) {
        for (let s = n.nextSibling; s; s = s.nextSibling) {
          if (isBlockLike(s)) return true;
        }
        n = n.parentNode;
      }
      // cur → lca：沿途检查每个层级的前驱兄弟（碰到 prev 所在子树即停）
      n = cur;
      while (n && n !== lca) {
        for (let s = n.previousSibling; s; s = s.previousSibling) {
          if (s === prev || (s.contains && s.contains(prev))) break;
          if (isBlockLike(s)) return true;
        }
        n = n.parentNode;
      }
      return false;
    },

    // 段落级锚点：从文本节点向上找第一个「块级渲染 且 文本量在段落量级(≤2200字符)」的祖先。
    // LinkedIn 的描述段落常是 display:block 的 <span>（页面上根本没有 <p>），
    // 按 tagName 找块会把「包住全部段落的大 div」当成唯一块 → 面板被锚到区域最底部。
    findProseBlock(textNode, mainRoot) {
      let element = textNode.parentElement;
      let depth = 0;
      while (element && element !== document.body && depth < 14) {
        if (this.skipTags.has(element.tagName)) break;
        if (element.closest && element.closest('.lingoflow-ui')) return null;
        let display = '';
        try { display = window.getComputedStyle(element).display; } catch (_) {}
        const blockLike = display === 'block' || display === 'list-item' ||
                          display === 'flow-root' || display === 'table' ||
                          display.indexOf('flex') === 0 || display.indexOf('grid') === 0 ||
                          display === '-webkit-box';
        if (blockLike) {
          const len = this.normalizeText(element.textContent || '').length;
          if (len > 0 && len <= 2200) return element;   // 段落量级 → 就是它
          // 文本量超出段落量级（包住了多段/整个根）→ 继续向上没有意义，交给兜底
          break;
        }
        element = element.parentElement;
        depth++;
      }
      return this.findDescriptionAnchor(textNode);   // 兜底：旧 tagName 逻辑
    },

    // 找"段落锚点"：文本所在的最小块级祖先（没有就退到最近的非内联祖先）。
    // 旁挂渲染会把译文块插到它之后，所以锚点越贴近段落越好。
    findDescriptionAnchor(textNode) {
      const inlineTags = new Set(['SPAN', 'A', 'B', 'I', 'EM', 'STRONG', 'SMALL', 'LABEL',
                                  'TIME', 'U', 'S', 'MARK', 'SUP', 'SUB', 'ABBR', 'CITE', 'Q']);
      const blockTags = ['DIV', 'P', 'LI', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'TD',
                         'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL'];
      let element = textNode.parentElement;
      let nonInline = null;
      let depth = 0;
      while (element && element !== document.body && depth < 10) {
        if (this.skipTags.has(element.tagName)) return nonInline || textNode.parentElement;
        if (element.closest && element.closest('.lingoflow-ui')) return null;
        if (blockTags.indexOf(element.tagName) >= 0) return element;
        if (!nonInline && !inlineTags.has(element.tagName)) nonInline = element;
        element = element.parentElement;
        depth++;
      }
      return nonInline || textNode.parentElement || null;
    },

    // 从文本节点向上找"只装这一段"的容器。
    // LinkedIn 的包裹层可能很深（嵌套 div + data-display-contents）且大量使用 span，
    // 所以这里逐层评分，最终一定有兜底返回值（绝不返回 null 让整段漏翻）：
    //   1) 最内层"只装这段文字且不含已注入译文块"的非内联容器
    //   2) 最内层"不含已注入译文块"的非内联祖先（内容可能偏大，聊胜于无）
    //   3) 最内层内联包裹层（span 等）
    //   4) 文本节点自身的父元素
    findDescriptionUnitContainer(textNode) {
      const inlineTags = new Set(['SPAN', 'A', 'B', 'I', 'EM', 'STRONG', 'SMALL', 'LABEL',
                                  'TIME', 'U', 'S', 'MARK', 'SUP', 'SUB', 'ABBR', 'CITE', 'Q']);
      const ownLength = this.normalizeText(textNode.nodeValue).length;
      const hasInjectedBlock = (el) =>
        !!(el.querySelector && el.querySelector('[data-lingoflow="true"]'));

      let element = textNode.parentElement;
      let inlineFallback = null;
      let looseFallback = null;
      let depth = 0;

      while (element && element !== document.body && depth < 20) {
        if (this.skipTags.has(element.tagName)) return inlineFallback || textNode.parentElement;
        if (element.closest && element.closest('.lingoflow-ui')) return null;

        const tag = element.tagName;
        const isInline = inlineTags.has(tag);
        const text = this.normalizeText(element.textContent);
        const onlyThisParagraph = text.length <= ownLength * 1.5 + 60;
        const clean = !hasInjectedBlock(element);

        if (!isInline) {
          if (onlyThisParagraph && clean) return element;
          if (!looseFallback && clean) looseFallback = element;
        } else if (onlyThisParagraph && !inlineFallback) {
          inlineFallback = element;
        }

        element = element.parentElement;
        depth++;
      }

      return inlineFallback || looseFallback || textNode.parentElement || null;
    },

    collectTranslationUnits(root = document.body) {
      // 清扫失效标记：LinkedIn 等站点重渲染会清掉注入的译文节点，
      // 但容器上的 processed/rendered/source-id 标记还在 → 不清扫会永久跳过这些段落
      // （这就是"某一段永远不翻译"的隐藏原因：标记残留 + 译文被擦）。
      document.querySelectorAll('[data-lingoflow-processed="true"]').forEach(el => {
        // 容器内还有注入节点 → 正常已翻译，保留标记
        if (el.querySelector && el.querySelector('[data-lingoflow="true"]')) return;
        const id = el.getAttribute('data-lingoflow-source-id');
        if (id) {
          const linked = document.querySelector(this.getSourceIdSelector(id));
          if (linked && linked !== el) return;   // 译文节点挂在别处（仍存在）→ 保留
        }
        el.removeAttribute('data-lingoflow-processed');
        el.removeAttribute('data-lingoflow-rendered');
      });

      // 清理 tooltip 渲染残留：tooltip 只在悬停时显示译文，且 popup 会让
      // hasExistingTranslation 误判"已翻译"→ 段落永久跳过。统一拆掉让它重新渲染。
      document.querySelectorAll('[data-lingoflow-tooltip="true"]').forEach(host => {
        if (!host.closest || !host.closest(this.descriptionSelector())) return;
        host.querySelectorAll('.lingoflow-tooltip-popup').forEach(popup => popup.remove());
        host.removeAttribute('data-lingoflow-tooltip');
        host.classList.remove('lingoflow-tooltip-host', 'lingoflow-tooltip-active');
      });

      // 描述区域一次性复位（清理历史版本留下的块与被搬空后残留的标记元素）
      if (!state._descriptionPurged) {
        state._descriptionPurged = true;
        try { this.purgeDescriptionResidue(); } catch (_) {}
      }

      // 采集前先自愈：被折叠/限高裁掉的译文块会被移除并重新进入队列
      // （初始整页翻译流程不会经过 runIncrementalTranslation，这里必须也跑一次）
      try {
        this.repairTranslationIntegrity();
      } catch (_) {}

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
        // 描述区域由专用收集器接管（面板 + LI 旁挂），通用遍历不再处理，
        // 否则两条路径会各翻一遍造成双重翻译
        if (node.parentElement && node.parentElement.closest &&
            node.parentElement.closest(this.descriptionSelector())) {
          continue;
        }
        let container = this.findTextContainer(node);
        if (!container || container.dataset.lingoflowProcessed === 'true') continue;

        // 容器内已含译文块（同容器其他兄弟元素先前已翻译）→ 不要整包跳过，
        // 沿文本节点向上找"不含译文块"的最内层祖先作为新容器，只包裹剩余文本。
        // （否则外层容器要么被整包吞块，要么被跳过留下漏翻文本）
        if (container.querySelector('.lingoflow-block[data-lingoflow="true"]')) {
          let cand = node.parentElement;
          while (cand && cand !== container &&
                 cand.querySelector('.lingoflow-block[data-lingoflow="true"]')) {
            cand = cand.parentElement;
          }
          if (cand && cand !== container && !cand.closest('.lingoflow-ui')) {
            container = cand;
          }
        }
        if (this.isNestedInDifferentContainer(node, container)) continue;
        // Skip UI chrome elements (nav, sidebar, header, toolbar, etc.)
        if (this.shouldSkipContainer(container)) continue;
        if (this.hasExistingTranslation(container)) {
          // 祖先容器被判定为"已有译文"（如页面自带中英双语段落混排）时，
          // 纯外文段落不应被连坐跳过——降级为以文本节点自身父元素为容器单独翻译。
          // （LinkedIn/AfterShip 等职位描述：英文段落 + 官方中文段落混排，此前会整块漏翻）
          const own = node.parentElement;
          if (own && own !== container &&
              !(own.closest && own.closest('.lingoflow-ui')) &&
              !this.hasExistingTranslation(own)) {
            container = own;
          } else {
            continue;
          }
        }

        // LinkedIn: 折叠副本(inline-show-more-text) 与展开副本(expanded-text-below) 是同一份
        // 文本的双份渲染。只有当「另一份可翻译且可见」时才跳过当前这份，否则跳过的正好是
        // 页面上可见的那一份 → 译文被注入到隐藏副本里，看起来就是"这一段永远不翻译"。
        if (container.closest && container.closest('[data-testid="inline-show-more-text"]')) {
          const expandedEl = document.querySelector('[data-testid="expanded-text-below"]');
          const expandedText = expandedEl ? this.normalizeText(expandedEl.textContent || '') : '';
          const collapsedEl = container.closest('[data-testid="inline-show-more-text"]');
          const collapsedVisible = this.isVisibleElement(collapsedEl);
          const expandedVisible = expandedEl ? this.isVisibleElement(expandedEl) : false;
          const safeToSkip = expandedText && this.shouldTranslateText(expandedText) &&
                             (expandedVisible || !collapsedVisible);
          if (safeToSkip) continue;
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

      // LinkedIn / 招聘站点：职位描述区域兜底收集。
      // 该区域的段落常因「祖先容器被判已有译文」「UI chrome 误判」「折叠双副本」等原因
      // 在通用遍历里整段漏掉，这里按段落（p/li/h3/h4/blockquote）直接补收集。
      this.collectJobDescriptionUnits(root, units);

      const rawUnits = Array.from(units.values())
        .map(unit => ({
          container: unit.container,
          textNode: unit.textNode || null,   // 文本节点级单元（容器被占用时的兜底）
          anchor: unit.anchor || null,       // 段落锚点单元（描述区域专用旁挂渲染）
          anchorHash: unit._anchorHash || null,
          descPanel: !!unit._descPanel,               // 描述面板标记（必须透传，否则按普通内联块处理）
          insertBefore: unit._insertBefore || null,   // 描述面板的精确插入点（扁平 DOM）
          // 单片段（描述面板）保留原文 \n 段落结构；多片段仍按空格合并
          text: unit.textParts.length === 1 ? unit.textParts[0] : this.normalizeText(unit.textParts.join(' ')),
          targetLang: mapTargetLang(state.targetLanguage)  // 按设置的目标语言（中/英/西）
        }))
        .filter(unit => this.shouldTranslateText(unit.text));

      // 去重：LinkedIn 的折叠/展开双副本会产生两份相同文本，只保留一份。
      // 优先保留「页面上可见」的那一份（此前固定偏好 expanded-text-below，
      // 结果译文被注入到隐藏副本里 → 可见副本永远不翻译）。
      const seenTexts = new Map();
      const dedupedUnits = [];
      for (const unit of rawUnits) {
        const key = unit.text.toLowerCase();
        const prev = seenTexts.get(key);
        if (prev) {
          const curVisible = this.isVisibleElement(unit.container);
          const prevVisible = this.isVisibleElement(prev.container);
          let preferCurrent = false;
          if (curVisible !== prevVisible) {
            preferCurrent = curVisible;
          } else if (curVisible) {
            preferCurrent = !!unit.container.closest('[data-testid="expanded-text-below"]') &&
                            !prev.container.closest('[data-testid="expanded-text-below"]');
          }
          // 描述区域/容器被占用时，容器级渲染一定会失败（tooltip / reparent / 残留标记）
          // → 优先保留"段落锚点/文本节点级"的旁挂方案
          if (!preferCurrent && (unit.anchor || unit.textNode) && !(prev.anchor || prev.textNode)) {
            const prevContainer = prev.container;
            const inDescription = prevContainer && prevContainer.closest &&
              prevContainer.closest(this.descriptionSelector ? this.descriptionSelector() :
                '[data-testid="expandable-text-box"], [data-testid="inline-show-more-text"], ' +
                '[data-testid="expanded-text-below"], .jobs-description__content, .show-more-less-html__markup');
            const occupied = inDescription || (prevContainer && (
              prevContainer.dataset.lingoflowProcessed === 'true' ||
              (prevContainer.querySelector && prevContainer.querySelector('[data-lingoflow="true"]'))
            ));
            if (occupied) preferCurrent = true;
          }
          if (preferCurrent) {
            const at = dedupedUnits.indexOf(prev);
            if (at >= 0) dedupedUnits[at] = unit;
            seenTexts.set(key, unit);
          }
          continue;
        }
        seenTexts.set(key, unit);
        dedupedUnits.push(unit);
      }

      // 句级拆分：对长文本（>120字符且包含2+个句子）按句子边界拆分
      const sentenceUnits = [];
      for (const unit of dedupedUnits) {
        // 文本节点级 / 段落锚点级单元不参与句级拆分：它们共享同一个宿主容器，
        // 拆分后按容器分组渲染会整包 reparent，把宿主里其它内容一起搬走
        if (unit.textNode || unit.anchor) {
          sentenceUnits.push(unit);
          continue;
        }
        const sentences = this.splitIntoSentences(unit.text);
        if (sentences.length > 1 && unit.text.length > 120) {
          // 标记为句级单元，保留原始容器引用和分组ID
          const groupId = this.getOrCreateTranslationId(unit.container);
          for (let i = 0; i < sentences.length; i++) {
            sentenceUnits.push({
              container: unit.container,
              text: sentences[i],
              targetLang: mapTargetLang(state.targetLanguage),
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
      // LinkedIn: 职位描述被 show-more-less 折叠（max-height + overflow:hidden），
      // 注入的译文超出折叠高度会被裁剪隐藏，看起来像漏翻 → 注入时自动展开
      try {
        const clamped = container.closest(
          '.show-more-less-html, [data-testid="inline-show-more-text"], [data-testid="expanded-text-below"], [data-testid="expandable-text-box"], .jobs-description__content'
        );
        if (clamped) {
          clamped.classList.remove('show-more-less-html--collapsed', 'show-more-less-html--more');
          clamped.style.maxHeight = 'none';
          clamped.setAttribute('data-lingoflow-unclamped', 'true');
        }
        // LinkedIn 的折叠限高常由 CSS 变量算在别的祖先上（--xxxx: 160px → max-height: var(--xxxx)），
        // selector 覆盖不到 → 译文块注入了却被裁掉。这里沿祖先链把"真正在裁剪"的层解开。
        this.unclampClippingAncestors(node, 8);
      } catch (e) {}
    },

    // 沿祖先链解除"折叠限高"，返回处理过的层数。
    // 只动 max-height 与折叠类，**绝不修改 overflow**：overflow 被改成 visible
    // 会让站点自己的滚动容器失效（曾导致 LinkedIn 详情面板整页滚不动）。
    // 遇到滚动容器（overflow: auto/scroll）立即停止，不再往上动。
    unclampClippingAncestors(startEl, maxDepth = 6) {
      let element = startEl;
      let depth = 0;
      let changed = 0;
      while (element && element !== document.body && element !== document.documentElement && depth < maxDepth) {
        try {
          const style = window.getComputedStyle(element);
          const overflowChain = `${style.overflow} ${style.overflowY} ${style.overflowX}`;
          if (/(auto|scroll)/.test(overflowChain)) break;   // 滚动容器：绝不触碰

          const limited = !!style.maxHeight && style.maxHeight !== 'none' && style.maxHeight !== '0px';
          const collapsed = element.classList &&
                            (element.classList.contains('show-more-less-html--collapsed') ||
                             element.classList.contains('show-more-less-html--more'));
          if (limited || collapsed) {
            if (collapsed) element.classList.remove('show-more-less-html--collapsed', 'show-more-less-html--more');
            if (limited) element.style.maxHeight = 'none';
            element.setAttribute('data-lingoflow-unclamped', 'true');
            changed++;
          }
        } catch (_) {}
        element = element.parentElement;
        depth++;
      }
      return changed;
    },

    // 恢复页面原有布局：撤掉我们加过的限高解除（译文被还原/失效时调用）
    restoreUnclampedAncestors() {
      document.querySelectorAll('[data-lingoflow-unclamped="true"]').forEach(el => {
        if (el.querySelector && el.querySelector('[data-lingoflow="true"]')) return;  // 译文还在 → 保留
        el.style.removeProperty('max-height');
        el.removeAttribute('data-lingoflow-unclamped');
      });
    },

    getSourceIdSelector(id) {
      const escaped = (window.CSS && CSS.escape) ? CSS.escape(id) : String(id).replace(/"/g, '\\"');
      return `[data-lingoflow-source-id="${escaped}"]`;
    },

    hasLinkedTranslation(container) {
      if (!container || !container.dataset) return false;
      const id = container.dataset.lingoflowSourceId;
      if (!id) return false;
      const linked = document.querySelector(this.getSourceIdSelector(id));
      // 容器自身也携带 source-id（getOrCreateTranslationId 设置），
      // 必须排除自身——否则 LinkedIn 重渲染清掉译文块后会误判"译文还在"
      return !!linked && linked !== container;
    },

    repairTranslationIntegrity() {
      let repaired = 0;

      // 译文块"存在但不可见"（被站点折叠/限高裁掉）→ 先尝试解开裁剪，
      // 仍然不可见就移除该块并清掉容器标记，让它重新进入翻译队列。
      // （否则 existing=true 会让采集器认为"这段已翻译"，于是永远显示原文 = 顽固漏翻）
      document.querySelectorAll('[data-lingoflow="true"]').forEach(block => {
        if (!block.isConnected) return;
        // 旁挂的 inline 译文块不参与"不可见就删掉重译"的循环：
        // 它被裁是站点折叠造成的，反复删除/重建只会造成闪烁（去重靠内容哈希）
        if (block.hasAttribute && block.hasAttribute('data-lingoflow-inline-hash')) return;
        if (!block.classList || !block.classList.contains('lingoflow-block') &&
            !block.classList.contains('lingoflow-translation-only') &&
            !block.classList.contains('lingoflow-sentence-trans')) {
          return;
        }
        if (this.isVisibleElement(block)) return;

        const host = block.parentElement;
        if (!host || !this.isVisibleElement(host)) return;   // 宿主本身也在隐藏副本里 → 不动

        // 只解裁剪，**绝不删除重建**。"不可见就删掉重译"会造成删→建→删的
        // 持续闪烁（尤其滚动/懒加载场景，isVisibleElement 偶发误判时无限循环）。
        // 解裁剪后仍不可见的块，等用户展开内容后自然可见。
        this.unclampClippingAncestors(block, 8);
      });

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
        // 排除节点自身，找真正的容器（owner）
        const owner = Array.from(
          document.querySelectorAll(`${this.getSourceIdSelector(id)}[data-lingoflow-rendered="true"]`)
        ).find(el => el !== node);
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
      return text.length > 150 && this.hasTranslatableText(text);
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
      // LinkedIn 描述区域 / 长文本：绝不能走 tooltip——tooltip 只在悬停时显示，
      // 页面上永远看不到译文，用户会以为"这段没翻译"。
      const inJobDescription = container.closest && container.closest(
        '[data-testid="expandable-text-box"], [data-testid="inline-show-more-text"], ' +
        '[data-testid="expanded-text-below"], .jobs-description__content, .show-more-less-html__markup'
      );
      const isLongText = this.getElementText(container).length > 120;

      // For very dangerous layouts (tiny buttons, etc.), use tooltip on hover
      if (!inJobDescription && !isLongText && this.isVeryDangerousLayout(container)) {
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

    // 文本内容哈希（用于文本节点级译文块的去重标记）
    hashText(text) {
      const value = String(text || '');
      let hash = 0;
      for (let i = 0; i < value.length; i++) {
        hash = (hash * 31 + value.charCodeAt(i)) | 0;
      }
      return (hash >>> 0).toString(36) + '-' + value.length.toString(36);
    },

    // 是否已渲染过该内容的旁挂译文块。
    // 必须要求"块可见"：被站点折叠裁掉的块存在但看不到，若算作"已渲染"
    // 就会让这段永远不翻译（LinkedIn 描述段落漏翻的最后一环）。
    hasInlineTextBlock(hash) {
      if (!hash) return false;
      try {
        const blocks = document.querySelectorAll(`[data-lingoflow-inline-hash="${hash}"]`);
        for (const block of blocks) {
          if (this.isVisibleElement(block)) return true;
        }
      } catch (_) {}
      return false;
    },

    // 职位描述区域选择器（多处复用）
    descriptionSelector() {
      return '[data-testid="expandable-text-box"], [data-testid="inline-show-more-text"], ' +
             '[data-testid="expanded-text-below"], .jobs-description__content, ' +
             '.show-more-less-html__markup, .jobs-box__html-content';
    },

    // 描述区域复位：移除历史版本注入的块（popup/inline/block）与被搬空后遗留的
    // 标记元素，让该区域回到干净状态再由"段落锚点旁挂"统一接管。
    purgeDescriptionResidue() {
      let roots;
      try {
        roots = Array.from(document.querySelectorAll(this.descriptionSelector()));
      } catch (_) {
        return;
      }
      roots.forEach(root => {
        root.querySelectorAll('[data-lingoflow="true"]').forEach(node => {
          if (node.hasAttribute('data-lingoflow-inline-hash')) return;   // 新的旁挂块保留
          node.remove();
        });
        root.querySelectorAll(
          '[data-lingoflow-processed="true"], [data-lingoflow-rendered="true"], [data-lingoflow-tooltip="true"]'
        ).forEach(el => {
          const text = (el.textContent || '').trim();
          if (!text && el.children.length === 0) { el.remove(); return; }   // 被搬空的空壳
          el.removeAttribute('data-lingoflow-processed');
          el.removeAttribute('data-lingoflow-rendered');
          el.removeAttribute('data-lingoflow-source-id');
          el.removeAttribute('data-lingoflow-tooltip');
          el.classList.remove('lingoflow-tooltip-host', 'lingoflow-tooltip-active');
        });
      });
    },

    // 段落锚点旁挂渲染：在锚点元素**之后**插入一个纯译文块，
    // 完全不 reparent 站点内容、不改站点元素属性 → 不会踩
    // tooltip / 整包搬走 / processed 残留 这三个坑。
    renderAnchorTranslation(anchor, translation, hash, isDescPanel = false, insertBeforeEl = null) {
      if (!anchor || !anchor.isConnected || !anchor.parentNode) return false;
      const key = hash || this.hashText(translation);
      if (this.hasInlineTextBlock(key)) return true;   // 已渲染过

      // 该锚点已被容器级渲染覆盖（已有 linked 译文，或前后紧邻非旁挂译文块）→ 不重复
      const covered = (anchor.dataset && anchor.dataset.lingoflowRendered === 'true' &&
                       this.hasLinkedTranslation(anchor)) ||
        [anchor.nextElementSibling, anchor.previousElementSibling].some(el => el && el.hasAttribute &&
          el.hasAttribute('data-lingoflow') && !el.hasAttribute('data-lingoflow-inline-hash'));
      if (covered) return true;

      const block = document.createElement('div');
      block.className = 'lingoflow-inline-translation';
      block.setAttribute('data-lingoflow', 'true');
      block.setAttribute('data-lingoflow-inline-hash', key);
      if (isDescPanel) {
        block.setAttribute('data-lingoflow-desc-panel', '1');
      }
      block.textContent = translation;
      block.style.writingMode = 'horizontal-tb';
      block.style.whiteSpace = 'normal';
      if (isDescPanel) block.style.whiteSpace = 'pre-line';   // 面板按原文段落分行
      block.style.wordBreak = 'break-word';
      block.style.overflowWrap = 'anywhere';
      block.style.maxWidth = '100%';
      block.style.marginTop = '0.25em';
      block.style.marginBottom = '0.35em';

      // 面板模式：换职位/内容变化时清掉挂在同一根后面的旧面板，避免堆积
      if (anchor.matches && anchor.matches(this.descriptionSelector())) {
        try {
          let next = anchor.nextElementSibling;
          while (next && next.hasAttribute && next.hasAttribute('data-lingoflow-inline-hash')) {
            const stale = next;
            next = next.nextElementSibling;
            stale.remove();
          }
        } catch (_) {}
      }

      // 清掉同内容的"不可见遗留块"，避免越积越多
      try {
        document.querySelectorAll(`[data-lingoflow-inline-hash="${key}"]`).forEach(el => {
          if (!this.isVisibleElement(el)) el.remove();
        });
      } catch (_) {}

      let inserted = false;
      if (isDescPanel) {
        console.log('LingoFlow: rendering desc panel after', anchor.tagName,
          anchor.className ? String(anchor.className).split(' ').slice(0, 3).join(' ') : '-');
      }
      try {
        if (isDescPanel && insertBeforeEl && insertBeforeEl.isConnected && insertBeforeEl.parentNode) {
          insertBeforeEl.insertAdjacentElement('beforebegin', block);   // 扁平 DOM：插到正文最后一段之后
        } else {
          anchor.insertAdjacentElement('afterend', block);
        }
        inserted = true;
      } catch (_) {
        return false;
      }
      if (isDescPanel) {
        try {
          const p = block.parentElement;
          const prev = block.previousElementSibling;
          const r = block.getBoundingClientRect();
          console.log('LingoFlow: desc panel inserted; parent=' + (p && p.tagName) +
            ' prev=' + (prev && prev.tagName) +
            ' rect=' + Math.round(r.width) + 'x' + Math.round(r.height) +
            '@' + Math.round(r.top) + ',' + Math.round(r.left));
        } catch (_) {}
      }
      // 标准簿记：让容器级路径知道"这里已经有译文了"（source-id 互链 + processed/rendered），
      // 否则两条渲染路径互不知情 → 双重翻译
      try {
        const id = this.getOrCreateTranslationId(anchor);
        block.setAttribute('data-lingoflow-source-id', id);
        anchor.setAttribute('data-lingoflow-rendered', 'true');
        this.markProcessed(anchor);
      } catch (_) {}
      // 描述面板也要解裁剪：插入那一刻描述往往还处于"see more"折叠态（max-height 裁剪），
      // 块在内里不可见 → 自愈逻辑会把面板挪到/重渲染到区域底部。
      // unclamp 只动 max-height 和折叠 class，绝不碰 overflow（滚动容器安全）。
      this.unclampClippingAncestors(block, 8);

      // 插入后仍不可见 → 说明被站点折叠/限高裁掉了：把块上移到最近"不裁剪"的祖先之后，
      // 保证用户真的能看到译文（否则就是"注入了但页面没反应"）。
      // 描述面板锚点已经是最后一段，尽量保持原位；不要再上移到页面底部。
      if (!isDescPanel && inserted && !this.isVisibleElement(block)) {
        let host = block.parentElement;
        let depth = 0;
        while (host && host !== document.body && depth < 10) {
          try {
            const style = window.getComputedStyle(host);
            const clips = /(hidden|clip)/.test(`${style.overflow} ${style.overflowY} ${style.overflowX}`);
            const limited = !!style.maxHeight && style.maxHeight !== 'none' && style.maxHeight !== '0px';
            if (!clips && !limited) break;
          } catch (_) {}
          host = host.parentElement;
          depth++;
        }
        if (host && host !== document.body && host.parentNode) {
          try {
            host.insertAdjacentElement('afterend', block);
            console.log('LingoFlow: moved inline translation out of clipped container');
          } catch (_) {}
        }
      }
      return true;
    },

    // 找最近的“裁剪祖先”（max-height/overflow:hidden 等），描述面板需要插在它之后，
    // 否则译文会被折叠进看不见的区域。
    findClippingAncestor(el) {
      let host = el;
      let depth = 0;
      while (host && host !== document.body && depth < 12) {
        try {
          const style = window.getComputedStyle(host);
          const clips = /(hidden|clip)/.test(`${style.overflow} ${style.overflowY} ${style.overflowX}`);
          const limited = !!style.maxHeight && style.maxHeight !== 'none' && style.maxHeight !== '0px';
          if (clips || limited) return host;
        } catch (_) {}
        host = host.parentElement;
        depth++;
      }
      return null;
    },

    // 文本节点级翻译：宿主容器被占用时，找最近块级祖先做锚点后旁挂译文块。
    renderInlineTextTranslation(textNode, translation) {
      if (!textNode || !textNode.isConnected || !textNode.parentNode) return false;
      const source = this.normalizeText(textNode.nodeValue);
      const hash = this.hashText(source);
      if (this.hasInlineTextBlock(hash)) return true;   // 已渲染过

      const anchor = this.findDescriptionAnchor(textNode);
      if (!anchor) return false;
      return this.renderAnchorTranslation(anchor, translation, hash);
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

      // translation-only 模式：原容器移入 block 的隐藏 original div，只显示逐句译文
      // （与 renderTranslationOnlyUnit 相同的 reparent 结构，避免原地隐藏导致空白页）
      if (renderMode === 'translation') {
        const range = document.createRange();
        range.selectNode(container);
        const marker = document.createComment('lingoflow-sentence-anchor');
        range.insertNode(marker);

        const block = this.createBilingualBlock(translations.join('\n'), 'external');
        const originalDiv = block.querySelector(':scope > .lingoflow-original');
        if (originalDiv) {
          originalDiv.setAttribute('data-lingoflow-hidden', 'true');
          originalDiv.style.display = 'none';
          originalDiv.appendChild(container);
        }
        block.style.maxWidth = '100%';
        block.style.overflow = 'visible';
        this.copyLayoutMargins(container, block);

        // 每句翻译用视觉分隔（不使用br标签，用CSS伪元素或margin模拟）
        // 直接用换行符 + whiteSpace: pre-wrap 效果更好
        block.style.whiteSpace = 'pre-line';

        marker.replaceWith(block);
        range.detach();
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
      if (text.length < 8 || !this.hasTranslatableText(text)) return false;

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
        return ct.length >= 2 && this.hasTranslatableText(ct) && c.children.length <= 6;
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

      // 与双语 external 块相同的 reparent 结构：原容器移动进 block 内部的
      // .lingoflow-original div 并将其隐藏。
      // 不要用 container.hidden 原地隐藏 —— 那会破坏站点布局/嵌套单元，
      // 且站点自身 JS 可能因 DOM 被改动而重渲染（曾导致整页空白）。
      const range = document.createRange();
      range.selectNode(container);
      const marker = document.createComment('lingoflow-translation-anchor');
      range.insertNode(marker);

      const block = this.createBilingualBlock(translation, 'external');
      const originalDiv = block.querySelector(':scope > .lingoflow-original');
      if (originalDiv) {
        originalDiv.setAttribute('data-lingoflow-hidden', 'true');
        originalDiv.style.display = 'none';
        originalDiv.appendChild(container);
      }
      this.copyLayoutMargins(container, block);
      marker.replaceWith(block);
      range.detach();
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

    // LinkedIn 预翻译隐匿：开始翻译前把主内容区（右侧详情 + 左侧列表）设为透明，
    // 译文逐批渲染时用户看不到「跳着出」的过程；译完后再统一淡入（见 revealLinkedInStealth）。
    // 其它网站不启用（它们已稳定，没必要遮罩）。
    applyLinkedInStealth() {
      // 已禁用：LinkedIn 回归与普通网站一致的稳定策略，不再隐藏主内容区。
      // 保留函数名以兼容调用方。
      return null;
    },

    revealLinkedInStealth(els) {
      if (!els || !els.length) return;
      // 下一帧再加 reveal，确保 transition 能触发淡入
      requestAnimationFrame(() => els.forEach(el => el.classList.add('lingoflow-reveal')));
      // 过渡结束后移除标记，避免残留影响后续交互/重渲染
      setTimeout(() => els.forEach(el => {
        el.classList.remove('lingoflow-linkedin-stealth');
        el.classList.remove('lingoflow-reveal');
      }), 700);
    },

    async translateAndRenderUnits(units, renderMode) {
      // 嵌套单元过滤：若某单元容器包含同批其他单元的容器，丢弃外层单元（只译叶子）。
      // 否则译文模式隐藏外层容器的 original div 时，内层已渲染的译文块会被一起藏掉，
      // 表现为整页空白（双语模式因 original 可见而从未暴露此问题）。
      if (units.length > 1) {
        const containers = units.map(u => u.container);
        units = units.filter((u, i) => {
          // 文本节点级/锚点级单元用宿主祖先做 container，会"包含"其它单元（反之亦然），
          // 不能被嵌套过滤误杀
          if (u.textNode || u.anchor) return true;
          for (let j = 0; j < containers.length; j++) {
            if (j === i || units[j].textNode || units[j].anchor) continue;
            // 注意：contains() 对节点自身也返回 true，句级单元共享同一容器，
            // 必须先排除同容器（否则长段落全被误杀，表现为"部分替换"）
            if (containers[j] !== containers[i] && containers[i].contains(containers[j])) return false;
          }
          return true;
        });
      }

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

        const fullText = group[0].unit._fullText || '';
        const okTranslations = group.map(g => g.translation).filter(Boolean);   // 失败的句子为空串
        const failedCount = group.length - okTranslations.length;
        const targetLang = group[0].unit.targetLang;
        sentenceGroups.delete(groupId);

        // 全部句子失败 → 整段拆块重译（成功就渲染完整译文，失败就什么都不渲染，
        // 绝不把 "[LingoFlow translation failed]" 这类占位文案写进页面）
        if (!okTranslations.length) {
          failCount += group.length;
          chunkRetryQueue.push(() => tryChunkTranslate(container, fullText, renderMode, targetLang));
          runChunkRetryQueue();
          return;
        }

        const renderPartial = () => {
          if (!container.isConnected) return;
          this.markProcessed(container);
          const rendered = this.renderSentenceBilingualUnit(container, fullText, okTranslations, renderMode);
          if (rendered) {
            successCount += okTranslations.length;
            console.log('LingoFlow: renderSentenceGroup', okTranslations.length, 'sentences (partial), mode=', renderMode);
          } else {
            container.removeAttribute('data-lingoflow-processed');
            failCount += okTranslations.length;
          }
        };

        // 部分句子失败 → 先整段拆块重译（长段落常因超长被引擎拒绝），
        // 成功则渲染完整译文；仍失败才退回「只渲染成功句子」的部分译文
        if (failedCount > 0 && fullText.length >= 160) {
          chunkRetryQueue.push(async () => {
            const ok = await tryChunkTranslate(container, fullText, renderMode, targetLang);
            if (!ok) renderPartial();
          });
          runChunkRetryQueue();
          return;
        }

        renderPartial();
      };

      // 长段落失败重试：引擎/网关对超长文本常直接失败（长段落整段不翻译就是这个原因），
      // 拆成句子块后逐块重译，成功就渲染，仍然失败才放弃。
      const splitForRetry = (text, maxLen = 400) => {
        const raw = String(text || '');
        let sentences = raw.split(/(?<=[.!?。！？])\s+/).map(s => s.trim()).filter(Boolean);
        // 整段只有一个长句（没有句号分隔）→ 按空格硬切
        if (sentences.length <= 1 && raw.length > maxLen) {
          const words = raw.split(/\s+/);
          const hardSplit = [];
          let line = '';
          words.forEach(word => {
            if (line && line.length + word.length + 1 > maxLen) {
              hardSplit.push(line);
              line = word;
            } else {
              line = line ? line + ' ' + word : word;
            }
          });
          if (line) hardSplit.push(line);
          sentences = hardSplit;
        }
        const pieces = [];
        let current = '';
        sentences.forEach(sentence => {
          if (current && current.length + sentence.length + 1 > maxLen) {
            pieces.push(current);
            current = sentence;
          } else {
            current = current ? current + ' ' + sentence : sentence;
          }
        });
        if (current) pieces.push(current);
        return pieces;
      };

      // 分块翻译：逐块翻译并拼接，块失败自动降级到句子级；任一句子仍失败则返回 null
      const translateInPieces = async (text, targetLang) => {
        const lang = targetLang || mapTargetLang(state.targetLanguage);
        const translateOne = async (piece) => {
          const result = await TranslationEngine.translateMany([piece], lang);
          const translated = Array.isArray(result) ? result[0] : '';
          if (!translated || isFallbackText(translated) || isContextInvalidatedText(translated)) return null;
          return translated;
        };

        const pieces = splitForRetry(text, 300);
        if (pieces.length < 2) return null;

        const parts = [];
        for (const piece of pieces) {
          let translated = await translateOne(piece);
          if (!translated) {
            // 该块仍然失败 → 拆到句子级再试
            const sentences = splitForRetry(piece, 120);
            if (sentences.length < 2) return null;
            for (const sentence of sentences) {
              const one = await translateOne(sentence);
              if (!one) return null;
              parts.push(one);
            }
            continue;
          }
          parts.push(translated);
        }
        const joined = parts.join(' ').trim();
        return joined || null;
      };

      const chunkRetryQueue = [];
      let chunkRetryRunning = false;

      const runChunkRetryQueue = async () => {
        if (chunkRetryRunning) return;
        chunkRetryRunning = true;
        while (chunkRetryQueue.length && !stoppedByInvalidContext) {
          const job = chunkRetryQueue.shift();
          try { await job(); } catch (_) {}
        }
        chunkRetryRunning = false;
      };

      // 整段（拆块）重译：逐块翻译，全部成功才渲染，任一块失败即放弃
      const tryChunkTranslate = async (container, text, mode, targetLang) => {
        if (!container || !container.isConnected) return false;
        if (container.dataset.lingoflowProcessed === 'true') return false;
        const joined = await translateInPieces(text, targetLang);
        if (!joined || !container.isConnected) return false;
        if (container.dataset.lingoflowProcessed === 'true') return false;

        const rendered = mode === 'translation'
          ? this.renderTranslationOnlyUnit(container, joined)
          : this.renderTranslationUnit(container, joined);
        if (rendered) {
          successCount++;
          console.log('LingoFlow: chunk retry rendered paragraph, len=', String(text).length);
        }
        return rendered;
      };

      // 文本节点级单元的分块重译（宿主容器被占用，只能旁挂译文块）
      const tryChunkTranslateInline = async (textNode, text, targetLang) => {
        if (!textNode || !textNode.isConnected) return false;
        const hash = this.hashText(this.normalizeText(textNode.nodeValue));
        if (this.hasInlineTextBlock(hash)) return true;
        const joined = await translateInPieces(text, targetLang);
        if (!joined || !textNode.isConnected) return false;
        const rendered = this.renderInlineTextTranslation(textNode, joined);
        if (rendered) {
          successCount++;
          console.log('LingoFlow: chunk retry rendered inline paragraph, len=', String(text).length);
        }
        return rendered;
      };

      const scheduleChunkRetry = (unit, mode) => {
        if (!unit || unit._isSentence || unit._chunkRetried) return;
        const text = String(unit.text || '');
        if (text.length < 160) return;
        unit._chunkRetried = true;
        if (unit.anchor) {
          chunkRetryQueue.push(async () => {
            if (!unit.anchor || !unit.anchor.isConnected) return;
            const joined = await translateInPieces(text, unit.targetLang);
            if (!joined) return;
            if (this.renderAnchorTranslation(unit.anchor, joined, unit.anchorHash, !!unit.descPanel, unit.insertBefore)) {
              successCount++;
              console.log('LingoFlow: chunk retry rendered anchored paragraph, len=', text.length);
            }
          });
        } else if (unit.textNode) {
          chunkRetryQueue.push(() => tryChunkTranslateInline(unit.textNode, text, unit.targetLang));
        } else {
          chunkRetryQueue.push(() => tryChunkTranslate(unit.container, text, mode, unit.targetLang));
        }
        runChunkRetryQueue();
      };

      const renderUnit = (unit, translation) => {
        const container = unit.container;

        // 文本节点级单元：宿主容器被其它内容/译文占用 → 直接把译文块插到文本所在块之后
        if (unit.textNode) {
          if (!unit.textNode.isConnected) { failCount++; return; }
          if (!translation || isFallbackText(translation) || isContextInvalidatedText(translation)) {
            console.warn('LingoFlow: inline unit translation failed, will retry in pieces');
            scheduleChunkRetry(unit, renderMode);   // 超长文本被引擎拒绝 → 拆块重试
            failCount++;
            return;
          }
          if (this.renderInlineTextTranslation(unit.textNode, translation)) successCount++;
          else {
            scheduleChunkRetry(unit, renderMode);
            failCount++;
          }
          return;
        }

        // 段落锚点级单元：译文块旁挂在锚点之后（描述区域专用，最稳）
        if (unit.anchor) {
          if (!unit.anchor.isConnected) { failCount++; return; }
          if (!translation || isFallbackText(translation) || isContextInvalidatedText(translation)) {
            console.warn('LingoFlow: anchor unit translation failed, will retry in pieces');
            scheduleChunkRetry(unit, renderMode);
            failCount++;
            return;
          }
          if (this.renderAnchorTranslation(unit.anchor, translation, unit.anchorHash, !!unit.descPanel, unit.insertBefore)) successCount++;
          else {
            scheduleChunkRetry(unit, renderMode);
            failCount++;
          }
          return;
        }

        // 句级单元：收集到分组中，等齐后统一渲染
        if (unit._isSentence && unit._groupId) {
          const gid = unit._groupId;
          if (!sentenceGroups.has(gid)) {
            sentenceGroups.set(gid, []);
          }
          // 失败的句子记为 ''（绝不把 "[LingoFlow translation failed]" 当译文渲染）
          const usable = (translation && !isFallbackText(translation) && !isContextInvalidatedText(translation))
            ? translation
            : '';
          sentenceGroups.get(gid).push({ unit, translation: usable });

          // 检查是否该组全部翻译完毕
          const total = unit._sentenceTotal || 1;
          if (sentenceGroups.get(gid).length >= total) {
            flushSentenceGroup(gid);
          }
          return;
        }

        // 普通单元：原有逻辑
        if (!container.isConnected || container.dataset.lingoflowProcessed === 'true') return;

        // 容器内已含译文块（先前批次/动态增量渲染，或同区域子元素已翻译）→ 跳过外层，
        // 避免包裹/隐藏外层时把内层译文块一起吞掉（译文模式空白页的跨批次形态）。
        // 注意：**不能**把容器标记为 processed——那会让"容器里只有别人的译文块、
        // 自己这段还没翻译"的段落被永久判定为已处理（LinkedIn 描述段落漏翻的成因之一）。
        // 另：容器已有 linked 译文（旁挂渲染的簿记）也视为已翻译 → 避免双重翻译。
        if (container.querySelector('.lingoflow-block[data-lingoflow="true"]') ||
            this.hasLinkedTranslation(container)) {
          return;
        }

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
          // 长段落整体失败常见于引擎对超长文本的限制 → 拆块重试一次
          scheduleChunkRetry(unit, renderMode);
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
            if (unit.textNode) return unit.textNode.isConnected;
            if (unit.anchor) return unit.anchor.isConnected;
            return unit.container.isConnected && unit.container.dataset.lingoflowProcessed !== 'true';
          });

          if (!activeChunk.length) continue;

          // 批次使用设置的目标语言（中/英/西），不再固定英译中
          const batchTargetLang = activeChunk[0]?.targetLang || mapTargetLang(state.targetLanguage);
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

    // 兜底清扫：主收集器（结构启发式）偶尔会漏掉混合容器里的残留文本
    // （如 sibling 已翻导致整容器被跳过）。用宽松规则补一刀：
    // 只收集"最深的有合格文本元素"，且不带任何 LingoFlow 标记、不在交互元素里。
    collectResidualUnits(root) {
      const out = [];
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.closest('.lingoflow-ui, [data-lingoflow="true"], [data-lingoflow-hidden]')) continue;
        if (el.closest('script, style, noscript, textarea')) continue;
        if (el.dataset && el.dataset.lingoflowProcessed === 'true') continue;
        // 自身或后代不能已有译文块
        if (el.querySelector('.lingoflow-block[data-lingoflow="true"]')) continue;
        const text = this.normalizeText(el.textContent);
        if (!text || !this.shouldTranslateText(text)) continue;
        // 交互元素内的短标签（"Sign up"/"Aplicar" 等动作词）不扫；
        // 较长的内容文本（公司名、链接标题等，常包在 <a> 里）仍然要翻
        const interactive = el.closest('a, button, input, select, label, [role="button"], summary');
        if (interactive && text.length < 15) continue;
        // 只取"最深"元素：子元素里不再有合格文本（避免整棵树重复包）
        const childHasText = Array.from(el.children).some(c =>
          this.shouldTranslateText(this.normalizeText(c.textContent)));
        if (childHasText) continue;
        out.push({ container: el, text, targetLang: mapTargetLang(state.targetLanguage) });
      }
      return out;
    },

    scheduleResidualSweep(renderMode) {
      if (state._residualSweepTimer) clearTimeout(state._residualSweepTimer);
      state._residualSweepTimer = setTimeout(() => {
        state._residualSweepTimer = null;
        try {
          if (state.activeTranslationMode !== renderMode || state.isTranslating) return;
          const root = state.translationRoot || document.body;
          const units = this.collectResidualUnits(root);
          if (!units.length) return;
          console.log('LingoFlow: residual sweep found ' + units.length + ' leftover units');
          this.translateAndRenderUnits(units.slice(0, 60), renderMode);
        } catch (_) {}
      }, 2500);
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
      // 完全禁用延迟补扫：LinkedIn 等 SPA 上的虚拟化列表/懒加载 + 补扫会形成
      // "站点擦掉/重渲染 → 扩展重新注入" 的拉锯，滚动时一闪一闪，最后彻底不翻译。
      // 用户选择回归稳定策略：只保留初始翻译 + 一次性残留清扫，漏翻用划词翻译。
      // 参数 mode 保留以兼容调用方；函数不再排任何定时器。
      void mode;
      // 顺手清掉可能残留的定时器，防止历史版本留下 pass 继续跑
      (state.repairPassTimers || []).forEach(timer => clearTimeout(timer));
      state.repairPassTimers = [];
    },

    // 兜底补漏：只做有限次数的延迟补扫，不使用持续 MutationObserver。
    // 持续观察在 LinkedIn 等 SPA 上会与站点重渲染形成
    // “站点擦掉译文 → 扩展立刻重新注入” 的无限拉锯，导致页面一直闪烁。
    startDynamicTranslationObserver(mode) {
      this.stopDynamicTranslationObserver();
      state.activeTranslationMode = mode;

      // LinkedIn 不再启动任何动态守卫：wipe guard 在滚动/虚拟化列表场景下
      // 会反复复译，造成闪烁并最终停止翻译。其它网站保留 wipe guard。
      if (/(^|\.)linkedin\.com$/.test(location.hostname || '')) return;

      this.stopWipeGuard();
      this.startWipeGuard(mode);
    },

    stopDynamicTranslationObserver() {
      this.stopWipeGuard();
      (state.repairPassTimers || []).forEach(timer => clearTimeout(timer));
      state.repairPassTimers = [];

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

    // 「擦除守卫」：只监听我们注入的译文节点被站点重渲染擦掉（removedNodes），
    // 完全忽略新增节点，并且有严格上限——被擦后最多修 3 次、间隔 ≥3s，
    // 若站点在短时间内连续擦除 2 次（说明它在跟我们拉锯）立刻永久放弃，
    // 保证「译文被擦能恢复」但绝不会变成持续闪烁。
    startWipeGuard(mode) {
      this.stopWipeGuard();
      if (typeof MutationObserver !== 'function') return;

      const HARD_CAP = 4;          // 整页最多修复次数
      const MIN_INTERVAL = 3000;   // 两次修复最小间隔
      const HOSTILE_WINDOW = 20000;// 该时间窗内连续擦除 ≥3 次 → 判定站点在拉锯
      let repairs = 0;
      let lastRepairAt = 0;
      let firstWipeAt = 0;
      let wipes = 0;

      state._wipeGuard = new MutationObserver((mutations) => {
        let wiped = false;
        for (const mutation of mutations) {
          if (!mutation.removedNodes || !mutation.removedNodes.length) continue;
          for (const node of mutation.removedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if ((node.hasAttribute && node.hasAttribute('data-lingoflow')) ||
                (node.querySelector && node.querySelector('[data-lingoflow="true"]'))) {
              wiped = true;
              break;
            }
          }
          if (wiped) break;
        }
        if (!wiped) return;

        const now = Date.now();
        wipes++;
        if (!firstWipeAt || now - firstWipeAt > HOSTILE_WINDOW) {
          firstWipeAt = now;
          wipes = 1;
        }
        // 站点在短时间窗内反复擦除 → 停止守卫，避免「擦除→重注入」拉锯闪烁
        if (wipes >= 3) {
          console.warn('LingoFlow: site keeps wiping translations, wipe guard disabled');
          this.stopWipeGuard();
          return;
        }
        if (repairs >= HARD_CAP) { this.stopWipeGuard(); return; }
        if (now - lastRepairAt < MIN_INTERVAL) return;

        lastRepairAt = now;
        clearTimeout(state._wipeRepairTimer);
        state._wipeRepairTimer = window.setTimeout(() => {
          if (!state.activeTranslationMode || state.isTranslating) return;
          repairs++;
          console.log('LingoFlow: repairing wiped translations (' + repairs + '/' + HARD_CAP + ')');
          try {
            this.repairTranslationIntegrity();
            this.runIncrementalTranslation(mode, null, false);
          } catch (err) {
            console.warn('LingoFlow: wipe repair failed:', getErrorMessage(err));
          }
          if (repairs >= HARD_CAP) this.stopWipeGuard();
        }, 1500);
      });

      try {
        state._wipeGuard.observe(document.body, { childList: true, subtree: true });
      } catch (_) {
        state._wipeGuard = null;
      }
    },

    stopWipeGuard() {
      if (state._wipeGuard) {
        try { state._wipeGuard.disconnect(); } catch (_) {}
        state._wipeGuard = null;
      }
      clearTimeout(state._wipeRepairTimer);
      state._wipeRepairTimer = null;
    },

    // 诊断：LinkedIn 职位描述段落为什么没被翻译（控制台里 __lingoflowDebug() 调用）
    debugDescribeLinkedIn() {
      const lines = [];
      const descSel = '.jobs-description__content, .jobs-box__html-content, .show-more-less-html__markup, ' +
                      '[data-testid="expandable-text-box"], [data-testid="expanded-text-below"], [data-testid="inline-show-more-text"]';
      const roots = Array.from(document.querySelectorAll(descSel));
      let inlineBlocks = 0;
      try { inlineBlocks = document.querySelectorAll('[data-lingoflow-inline-hash]').length; } catch (_) {}
      const panels = Array.from(document.querySelectorAll('[data-lingoflow-desc-panel="1"]'));
      const firstPanel = panels[0];
      const pRect = firstPanel && firstPanel.getBoundingClientRect ? firstPanel.getBoundingClientRect() : null;
      lines.push('mode=' + state.activeTranslationMode +
                 ' target=' + state.targetLanguage +
                 ' descRoots=' + roots.length +
                 ' inlineBlocks=' + inlineBlocks +
                 ' panels=' + panels.length +
                 ' firstPanel=' + (firstPanel ? (Math.round(pRect ? pRect.width : 0) + 'x' +
                                                   Math.round(pRect ? pRect.height : 0) + ' ' +
                                                   (firstPanel.textContent || '').slice(0, 24)) : 'none'));

      roots.slice(0, 6).forEach((root, i) => {
        lines.push('root' + i + ' <' + root.tagName.toLowerCase() + '>' +
                   ' testid=' + (root.getAttribute('data-testid') || '-') +
                   ' cls=' + String(root.className || '').slice(0, 24) +
                   ' len=' + this.normalizeText(root.textContent || '').length +
                   ' visible=' + this.isVisibleElement(root) +
                   ' processed=' + (root.dataset.lingoflowProcessed === 'true') +
                   ' hasBlock=' + !!root.querySelector('[data-lingoflow="true"]'));
      });

      // 描述区域里"未翻译的长文本"及它会被用的容器、被跳过原因
      const seen = new Set();
      const candidates = [];
      roots.forEach(root => {
        let walker;
        try {
          walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        } catch (_) { return; }
        let node;
        while ((node = walker.nextNode()) && candidates.length < 10) {
          const own = this.normalizeText(node.nodeValue || '');
          if (own.length < 40 || !this.shouldTranslateText(own)) continue;
          let container = null;
          try { container = this.findDescriptionUnitContainer(node); } catch (_) {}
          const key = (container ? (container.tagName + '#' + own.slice(0, 24)) : 'null#' + own.slice(0, 24));
          if (seen.has(key)) continue;
          seen.add(key);

          if (!container) {
            candidates.push(JSON.stringify({ text: own.slice(0, 32), container: null, reason: 'no-container' }));
            continue;
          }
          const block = container.querySelector ? container.querySelector('[data-lingoflow="true"]') : null;
          let blockInfo = null;
          if (block) {
            const rect = block.getBoundingClientRect();
            blockInfo = {
              w: Math.round(rect.width),
              h: Math.round(rect.height),
              txt: (block.textContent || '').slice(0, 20)
            };
          }
          const anchor = this.findDescriptionAnchor(node);
          let siblingInfo = null;
          const sib = anchor && anchor.nextElementSibling;
          if (sib && sib.hasAttribute && sib.hasAttribute('data-lingoflow-inline-hash')) {
            const rect = sib.getBoundingClientRect();
            siblingInfo = {
              w: Math.round(rect.width),
              h: Math.round(rect.height),
              txt: (sib.textContent || '').slice(0, 16),
              visible: this.isVisibleElement(sib)
            };
          }
          candidates.push(JSON.stringify({
            text: own.slice(0, 32),
            container: container.tagName,
            cls: String(container.className || '').slice(0, 22),
            cLen: this.normalizeText(container.textContent || '').length,
            processed: container.dataset.lingoflowProcessed === 'true',
            hasBlock: !!block,
            blockInfo,
            anchor: anchor ? anchor.tagName : null,
            siblingInfo,
            visible: this.isVisibleElement(container),
            skipContainer: this.shouldSkipContainer(container),
            existing: this.hasExistingTranslation(container)
          }));
        }
      });
      lines.push('candidates=' + candidates.length);
      lines.push(...candidates);
      return lines.join('\n');
    },

    // SPA 补翻：LinkedIn 这类站点点击职位卡片后是「客户端路由 + 局部重渲染」，
    // 新渲染出来的正文（职位描述等）不会自动翻译，而延迟补扫（7/13/22s）早已结束。
    // 这里用「路由变化 + 点击」触发一次性增量翻译来替代持续 MutationObserver：
    // 既补上漏翻，又不会与站点重渲染形成「擦除→重注入」拉锯（即闪烁）。
    setupSpaReRenderHooks() {
      if (state._spaHooksInstalled) return;
      state._spaHooksInstalled = true;

      const isLinkedIn = /(^|\.)linkedin\.com$/.test(location.hostname || '');
      const requestRepair = (reason) => {
        if (!state.activeTranslationMode || state.isTranslating) return;
        // LinkedIn 完全不走任何 SPA 动态补翻：点击职位卡片/展开/滚动都已交由初始翻译完成，
        // 继续补翻只会和站点虚拟化列表拉锯，导致闪烁和彻底不翻译。
        if (isLinkedIn) return;
        const now = Date.now();
        if (now - state._lastSpaRepair < 1200) return;   // 点击风暴冷却
        state._lastSpaRepair = now;

        clearTimeout(state._spaRepairTimer);
        state._spaRepairTimer = window.setTimeout(() => {
          if (!state.activeTranslationMode || state.isTranslating) return;
          const mode = state.activeTranslationMode;
          try {
            this.runIncrementalTranslation(mode, null, false);
          } catch (err) {
            console.warn('LingoFlow: SPA repair failed (' + reason + '):', getErrorMessage(err));
          }
        }, 900);
      };

      // 1) History API 路由变化（LinkedIn 职位列表切换用 pushState/replaceState）
      ['pushState', 'replaceState'].forEach(type => {
        const original = history[type];
        if (typeof original !== 'function') return;
        history[type] = function (...args) {
          const result = original.apply(this, args);
          try { window.dispatchEvent(new Event('lingoflow:locationchange')); } catch (_) {}
          return result;
        };
      });
      window.addEventListener('popstate', () => requestRepair('popstate'));
      window.addEventListener('hashchange', () => requestRepair('hashchange'));
      window.addEventListener('lingoflow:locationchange', () => requestRepair('pushState'));

      // 2) 点击/滚动动态补翻：LinkedIn 已完全关闭，避免虚拟化列表滚动时反复重译导致闪烁。
      //    其它站点仍保留 history 路由变化的增量补翻（只加不删）。
      //    注：原先此处有为 LinkedIn 注册的 click 与 scroll 监听器，已移除。
    },

    async translatePage() {
      return this.enableTranslationMode();
    },

    async enableTranslationMode() {
      let stealthEls = null;
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

        // LinkedIn：翻译开始前隐藏主内容区，译文逐批渲染时用户看不到跳闪；译完统一淡入
        stealthEls = this.applyLinkedInStealth();

        const result = await this.translateAndRenderUnits(units, 'translation');
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
          state.isBilingualMode = false;
          this.scheduleSecondScan('translation');
          this.startDynamicTranslationObserver('translation');
          this.scheduleResidualSweep('translation');
        } else {
          state.isBilingualMode = false;
        }
      } catch (err) {
        console.error('LingoFlow: enableTranslationMode error:', err);
        UI.showNotification(statusText('translationFailed'));
      } finally {
        this.revealLinkedInStealth(stealthEls);
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
      let stealthEls = null;
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

        stealthEls = this.applyLinkedInStealth();

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
          this.scheduleResidualSweep('bilingual');
        }
        state.isBilingualMode = successCount > 0;
      } catch (err) {
        console.error('LingoFlow: enableBilingualMode error:', err);
        UI.showNotification(statusText('translationFailed'));
      } finally {
        this.revealLinkedInStealth(stealthEls);
        state.isTranslating = false;
      }
    },

    restoreOriginal() {
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      this.stopDynamicTranslationObserver();
      if (state._residualSweepTimer) {
        clearTimeout(state._residualSweepTimer);
        state._residualSweepTimer = null;
      }
      clearTimeout(state.hoverParagraphTimer);
      state.hoverParagraphTimer = null;
      state.hoverParagraphTarget = null;

      document.querySelectorAll('.lingoflow-block[data-lingoflow="true"]').forEach(block => {
        this.restoreBilingualBlock(block);
      });

      document.querySelectorAll('[data-lingoflow]').forEach(node => {
        node.remove();
      });

      // 还原被解除过限高的容器（避免站点布局被我们的内联样式永久改写）
      try {
        this.restoreUnclampedAncestors();
      } catch (_) {}

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
  // Translation color: inject/update a single <style> tag instead of touching
  // rendered nodes — dynamic blocks pick it up automatically and mode
  // switching logic is never involved.
  let _translationColorStyleEl = null;
  function applyTranslationColorStyle(color) {
    try {
      if (!color || color === 'inherit') {
        if (_translationColorStyleEl) _translationColorStyleEl.remove();
        _translationColorStyleEl = null;
        return;
      }
      if (!_translationColorStyleEl || !_translationColorStyleEl.isConnected) {
        _translationColorStyleEl = document.createElement('style');
        _translationColorStyleEl.id = 'lingoflow-translation-color';
        (document.head || document.documentElement).appendChild(_translationColorStyleEl);
      }
      _translationColorStyleEl.textContent =
        '.lingoflow-translation, .lingoflow-translation-only, ' +
        '.lingoflow-inline-translation, .lingoflow-sentence-trans ' +
        '{ color: ' + color + ' !important; }';
    } catch (_) {}
  }

  // Initialize
  function init() {
    try {
      console.log('LingoFlow: Content script loaded');

      // Load settings (safe wrapper so a reloaded extension doesn't throw
      // "Extension context invalidated" in an already-open old tab).
      storageGet(['lingoflow_settings']).then((result) => {
        if (result && result.lingoflow_settings) {
          state.selectionTranslationEnabled = result.lingoflow_settings.selectionTranslation !== false;
          state.hoverParagraphTranslationEnabled = result.lingoflow_settings.hoverParagraphTranslation === true;
          state.toolbarPosition = result.lingoflow_settings.toolbarPosition || 'above';
          state.uiLanguage = result.lingoflow_settings.uiLanguage || 'auto';
          state.targetLanguage = result.lingoflow_settings.targetLanguage || 'zh';
          state.existingBilingualStrategy = result.lingoflow_settings.existingBilingualStrategy || 'skip';
          TranslationEngine.activeEngine = result.lingoflow_settings.translationEngine || 'google';
          applyTranslationColorStyle(result.lingoflow_settings.translationColor || 'inherit');
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
        // re-show the toolbar normally).
        UI.removeFloatingToolbar();
        // Also dismiss the translation result box on outside click (manual
        // dismissal model — user said it disappeared before they could read it
        // when relying on the previous auto-dismiss timer).
        UI.removeTranslationResult();
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
      // SPA（LinkedIn 等）点击职位卡片 / 路由切换后的一次性补翻钩子
      try {
        PageTranslator.setupSpaReRenderHooks();
      } catch (err) {
        console.warn('LingoFlow: SPA hooks init error:', getErrorMessage(err));
      }
      // 诊断入口：页面上翻译异常时在控制台执行 __lingoflowDebug()
      try {
        window.__lingoflowDebug = () => PageTranslator.debugDescribeLinkedIn();
      } catch (_) {}
      // 目标语言或翻译引擎变化时：清空已注入译文，并用新语言/新引擎自动重译。
      // 否则旧译文块会一直留在页面上（而且 hasExistingTranslation 会因注入节点存在而跳过重译）。
      function onTranslationSettingsChanged() {
        // 页面还没翻译过 → 只更新状态，不打扰用户
        const hasRendered = document.querySelector('.lingoflow-block[data-lingoflow="true"]');
        if (!hasRendered) return;

        // 先记住当前模式：restoreOriginal() 会把 activeTranslationMode 置为 null
        const mode = state.activeTranslationMode;
        if (mode !== 'bilingual' && mode !== 'translation') return;

        PageTranslator.restoreOriginal();

        const lang = state.targetLanguage || 'zh';
        const langNames = {
          zh: _getMessage('chinese', 'Chinese'),
          en: _getMessage('english', 'English'),
          es: _getMessage('spanish', 'Spanish')
        };
        const langName = langNames[lang] || lang;
        UI.showNotification(`${langName} · ${_getMessage('retranslating', 're-translating…')}`, true);

        // 等 restoreOriginal 的 DOM 清理落地后再重新翻译
        setTimeout(() => {
          if (mode === 'bilingual') PageTranslator.enableBilingualMode();
          else PageTranslator.enableTranslationMode();
        }, 120);
      }

      // Listen for settings changes (guarded: a reloaded extension makes this
      // listener inert, but registering it must never throw).
      try {
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
          applyTranslationColorStyle(settings.translationColor || 'inherit');

          // 目标语言 / 翻译引擎变化 → 清空旧译文并用新设置自动重译
          // （用 oldValue/newValue 精确比较，改其它设置不会误触发）
          const oldS = changes.lingoflow_settings.oldValue || {};
          const newS = changes.lingoflow_settings.newValue || {};
          if (((oldS.targetLanguage || 'zh') !== (newS.targetLanguage || 'zh')) ||
              ((oldS.translationEngine || 'google') !== (newS.translationEngine || 'google'))) {
            onTranslationSettingsChanged();
          }

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
      } catch (err) {
        if (isContextInvalidatedError(err)) {
          markCtxInvalidated();
          showContextInvalidatedBanner();
        } else {
          console.warn('LingoFlow: storage.onChanged registration error:', getErrorMessage(err));
        }
      }

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
