// LingoFlow Content Script
// Handles all in-page interactions

(function () {
  'use strict';

  // =========================================================================
  // CRITICAL: Message listener MUST be registered FIRST, before any other code.
  // This ensures popup can always communicate with us even if later code throws.
  // =========================================================================
  let _dispatchMessage = null; // Set after EventHandlers is defined below

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
    hoverEnabled: true,
    uiLanguage: 'auto',
    existingBilingualStrategy: 'skip',
    originalContent: new Map(), // Store original content for restoration
    translatedNodes: new Set() // Track translated nodes
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
    }
  };

  function isChineseUi() {
    if (state.uiLanguage && state.uiLanguage !== 'auto') {
      return state.uiLanguage.toLowerCase().startsWith('zh');
    }
    try {
      return chrome.i18n.getUILanguage().toLowerCase().startsWith('zh');
    } catch (_) {
      return false;
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
                  if (isContextInvalidatedError(chrome.runtime.lastError)) {
                    resolve(`[LingoFlow context invalidated] ${text}`);
                    return;
                  }
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

    // Translate text
    async translate(text, targetLang = 'zh') {
      switch (this.activeEngine) {
        case 'google':
        default:
          return await this.googleTranslator.translate(text, targetLang);
      }
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
    // Create floating toolbar
    createFloatingToolbar(x, y, selectedText) {
      this.removeFloatingToolbar();

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
            <span data-i18n="translate">Translate</span>
          </button>
          <button class="lingoflow-btn lingoflow-copy-btn" data-action="copy" data-text="${this.escapeHtml(selectedText)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            <span data-i18n="copy">Copy</span>
          </button>
          <button class="lingoflow-btn lingoflow-save-btn" data-action="save" data-text="${this.escapeHtml(selectedText)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
              <polyline points="17 21 17 13 7 13 7 21"/>
              <polyline points="7 3 7 8 15 8"/>
            </svg>
            <span data-i18n="save">Save</span>
          </button>
        </div>
      `;

      // Position toolbar
      toolbar.style.left = `${x}px`;
      toolbar.style.top = `${y}px`;

      // Add event listeners
      toolbar.querySelector('.lingoflow-translate-btn').addEventListener('click', (e) => {
        this.handleTranslate(selectedText);
        this.removeFloatingToolbar();
      });

      toolbar.querySelector('.lingoflow-copy-btn').addEventListener('click', (e) => {
        this.handleCopy(selectedText);
        this.removeFloatingToolbar();
      });

      toolbar.querySelector('.lingoflow-save-btn').addEventListener('click', (e) => {
        this.handleSave(selectedText);
        this.removeFloatingToolbar();
      });

      document.body.appendChild(toolbar);

      // Adjust position if out of viewport
      this.adjustToolbarPosition(toolbar);
    },

    // Remove floating toolbar
    removeFloatingToolbar() {
      const toolbar = document.getElementById('lingoflow-toolbar');
      if (toolbar) toolbar.remove();
    },

    // Adjust toolbar position to stay in viewport
    adjustToolbarPosition(toolbar) {
      const rect = toolbar.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      if (rect.right > viewportWidth) {
        toolbar.style.left = `${viewportWidth - rect.width - 10}px`;
      }

      if (rect.bottom > viewportHeight) {
        toolbar.style.top = `${parseInt(toolbar.style.top) - rect.height - 10}px`;
      }
    },

    // Show translation result
    showTranslationResult(x, y, originalText, translation) {
      this.removeTranslationResult();

      const result = document.createElement('div');
      result.id = 'lingoflow-translation-result';
      result.className = 'lingoflow-ui';

      result.innerHTML = `
        <div class="lingoflow-result-content">
          <div class="lingoflow-result-original">${this.escapeHtml(originalText)}</div>
          <div class="lingoflow-result-translation">${this.escapeHtml(translation)}</div>
        </div>
      `;

      result.style.left = `${x}px`;
      result.style.top = `${y + 40}px`;

      document.body.appendChild(result);

      // Auto remove after 5 seconds
      setTimeout(() => this.removeTranslationResult(), 5000);
    },

    // Remove translation result
    removeTranslationResult() {
      const result = document.getElementById('lingoflow-translation-result');
      if (result) result.remove();
    },

    // Show hover definition card
    showHoverCard(x, y, word, definition) {
      this.removeHoverCard();

      const card = document.createElement('div');
      card.id = 'lingoflow-hover-card';
      card.className = 'lingoflow-ui';

      card.innerHTML = `
        <div class="lingoflow-hover-content">
          <div class="lingoflow-hover-word">${this.escapeHtml(word)}</div>
          <div class="lingoflow-hover-definition">${this.escapeHtml(definition)}</div>
        </div>
      `;

      card.style.left = `${x}px`;
      card.style.top = `${y + 20}px`;

      document.body.appendChild(card);

      // Adjust position if out of viewport
      setTimeout(() => {
        const rect = card.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
          card.style.left = `${window.innerWidth - rect.width - 10}px`;
        }
        if (rect.bottom > window.innerHeight) {
          card.style.top = `${y - rect.height - 10}px`;
        }
      }, 0);
    },

    // Remove hover card
    removeHoverCard() {
      const card = document.getElementById('lingoflow-hover-card');
      if (card) card.remove();
    },

    // Handle translate action
    async handleTranslate(text) {
      const translation = await TranslationEngine.translate(text);

      // If translation failed (fallback text), show notification instead of result
      if (isFallbackText(translation)) {
        this.showNotification(statusText('translationFailed'));
        return;
      }

      // Save to history
      chrome.runtime.sendMessage({
        action: 'add_to_history',
        data: {
          text: text,
          translation: translation,
          sourceUrl: window.location.href
        }
      });

      // Show result
      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        this.showTranslationResult(
          rect.left + window.scrollX,
          rect.bottom + window.scrollY,
          text,
          translation
        );
      }
    },

    // Handle copy action
    handleCopy(text) {
      navigator.clipboard.writeText(text).then(() => {
        this.showNotification(getMessage('copied'));
      });
    },

    // Handle save action
    handleSave(text) {
      chrome.runtime.sendMessage({
        action: 'save_to_vocabulary',
        data: {
          text: text,
          type: text.split(' ').length > 1 ? 'sentence' : 'word',
          sourceUrl: window.location.href
        }
      }, (response) => {
        this.showNotification(getMessage('saved'));
      });
    },

    // Show notification (replaces previous notification to avoid stacking)
    showNotification(message) {
      // Remove any existing notification first
      const existing = document.querySelector('.lingoflow-notification');
      if (existing) existing.remove();

      const notification = document.createElement('div');
      notification.className = 'lingoflow-notification';
      notification.textContent = message;

      document.body.appendChild(notification);

      setTimeout(() => {
        notification.classList.add('lingoflow-notification-show');
      }, 10);

      setTimeout(() => {
        notification.classList.remove('lingoflow-notification-show');
        setTimeout(() => notification.remove(), 300);
      }, 2500);
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
    // Handle text selection
    handleTextSelection(e) {
      const selection = window.getSelection();
      const selectedText = selection.toString().trim();

      if (selectedText.length > 0) {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        UI.createFloatingToolbar(
          rect.left + window.scrollX,
          rect.bottom + window.scrollY,
          selectedText
        );
      } else {
        UI.removeFloatingToolbar();
      }
    },

    // Handle mouse hover for word definition
    handleMouseHover(e) {
      if (!state.hoverEnabled) return;

      const target = e.target;
      if (target.classList.contains('lingoflow-translated')) return;

      // Get word under cursor
      const range = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (!range) return;

      const textNode = range.startContainer;
      if (textNode.nodeType !== Node.TEXT_NODE) return;

      const text = textNode.textContent;
      const offset = range.startOffset;
      const word = this.getWordAt(text, offset);

      if (word && word.length > 2) {
        // Simple dictionary lookup (mock)
        const definition = this.lookupWord(word);
        if (definition) {
          UI.showHoverCard(e.clientX, e.clientY, word, definition);
        }
      }
    },

    // Get word at offset
    getWordAt(text, offset) {
      const left = text.lastIndexOf(' ', offset - 1) + 1;
      const right = text.indexOf(' ', offset);
      const word = text.substring(left, right === -1 ? text.length : right).trim();
      return word.replace(/[.,!?;:()"']/g, '');
    },

    // Simple dictionary lookup
    lookupWord(word) {
      // Mock dictionary - in real version, this would use a proper dictionary
      const dict = {
        'hello': 'hello',
        'world': 'world',
        'computer': 'computer',
        'programming': 'programming',
        'language': 'language',
        'learn': 'learn',
        'read': 'read',
        'website': 'website',
        'translation': 'translation'
      };

      return dict[word.toLowerCase()] || null;
    },

    // Handle messages from background script (exposed globally for top-level listener)
    handleMessage(request, sender, sendResponse) {
      switch (request.action) {
        case 'translate_selection':
          UI.handleTranslate(request.text);
          sendResponse({ received: true });
          break;

        case 'save_selection':
          UI.handleSave(request.text);
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
          PageTranslator.restoreOriginal();
          sendResponse({ received: true });
          break;

        default:
          sendResponse({ received: false });
      }
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
      '#lingoflow-toolbar',
      '#lingoflow-translation-result',
      '#lingoflow-hover-card'
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

    shouldTranslateText(text) {
      const normalized = this.normalizeText(text);
      if (normalized.length < 3) return false;
      if (normalized.length > 2000) return false;
      if (/^\d+([.,:/-]\d+)*$/.test(normalized)) return false;
      if (!/[A-Za-z]{2,}/.test(normalized)) return false;
      if (!/[A-Za-z0-9]/.test(normalized.replace(/[^\p{L}\p{N}]/gu, ''))) return false;
      if (hasMixedLatinAndChinese(normalized)) return false;
      if (isChineseText(normalized)) return false;
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
      if (scopeText.length > 700 || scope.children.length > 12) return false;

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

    hasBilingualDescendants(scope) {
      if (!scope || scope === document.body || scope === document.documentElement) return false;

      const scopeText = this.getElementText(scope);
      if (scopeText.length < 6 || scopeText.length > 700) return false;
      if (!this.hasLatinText(scopeText) || !this.hasChineseText(scopeText)) return false;

      const candidates = Array.from(scope.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div, span, strong, b'));
      let hasEnglish = false;
      let hasChinese = false;

      for (const candidate of candidates.slice(0, 30)) {
        if (candidate.matches && candidate.matches('[data-lingoflow], .lingoflow-ui')) continue;
        const text = this.getElementText(candidate);
        if (this.hasLatinText(text)) hasEnglish = true;
        if (this.hasChineseText(text)) hasChinese = true;
        if (hasEnglish && hasChinese) return true;
      }

      return false;
    },

    hasBilingualAncestor(container) {
      let scope = container.parentElement;
      for (let depth = 0; scope && depth < 5; depth++, scope = scope.parentElement) {
        if (this.hasBilingualChildren(scope) || this.hasBilingualDescendants(scope)) {
          return true;
        }
      }
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

    hasExistingTranslation(container) {
      if (state.existingBilingualStrategy === 'translate_english') return false;

      const text = this.getElementText(container);
      if (this.hasLatinText(text) && this.hasChineseText(text)) return true;
      if (this.hasChineseSibling(container)) return true;
      if (this.isHeadingContainer(container)) return false;
      return this.hasCatalogCardTranslation(container);
    },

    shouldSkipTextNode(node) {
      if (!node || node.nodeType !== Node.TEXT_NODE || !node.parentElement) return true;

      let element = node.parentElement;
      while (element) {
        if (this.skipTags.has(element.tagName)) return true;
        if (element.matches && element.matches(this.skipSelectors)) return true;
        if (element.isContentEditable) return true;
        // Skip elements hidden by a previous translation (not yet fully restored)
        if (element.hasAttribute && element.hasAttribute('data-lingoflow-hidden')) return true;
        element = element.parentElement;
      }

      return !this.shouldTranslateText(node.textContent);
    },

    isLeafDiv(element) {
      if (!element || element.tagName !== 'DIV') return false;
      if (element.children.length === 0) return this.shouldTranslateText(element.textContent);
      return !Array.from(element.children).some(child => this.nestedBlockTags.has(child.tagName));
    },

    isTranslationContainer(element) {
      if (!element || element === document.body || element === document.documentElement) return false;
      if (element.getAttribute('role') === 'heading') return true;
      if (this.blockTags.has(element.tagName)) return true;
      return this.isLeafDiv(element);
    },

    findTextContainer(textNode) {
      let element = textNode.parentElement;
      while (element && element !== document.body && element !== document.documentElement) {
        if (this.skipTags.has(element.tagName)) return null;
        if (element.matches && element.matches(this.skipSelectors)) return null;
        if (element.isContentEditable) return null;
        if (this.isTranslationContainer(element)) return element;
        element = element.parentElement;
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

      return Array.from(units.values())
        .map(unit => ({
          container: unit.container,
          text: this.normalizeText(unit.textParts.join(' '))
        }))
        .filter(unit => this.shouldTranslateText(unit.text));
    },

    markProcessed(container) {
      if (container) {
        container.setAttribute('data-lingoflow-processed', 'true');
      }
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

    copyLayoutMargins(source, block) {
      const style = window.getComputedStyle(source);
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
    },

    shouldRenderInside(container) {
      return ['LI', 'DIV', 'TD', 'TH', 'BLOCKQUOTE', 'DD', 'DT', 'FIGCAPTION'].includes(container.tagName);
    },

    renderExternal(container, translation) {
      if (!container || !container.parentNode) return false;

      const range = document.createRange();
      range.selectNode(container);
      const marker = document.createComment('lingoflow-bilingual-anchor');
      range.insertNode(marker);

      const block = this.createBilingualBlock(translation, 'external');
      const original = block.querySelector(':scope > .lingoflow-original');
      this.copyLayoutMargins(container, block);
      original.appendChild(container);
      marker.replaceWith(block);
      range.detach();

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
      return true;
    },

    renderTranslationUnit(container, translation) {
      return this.shouldRenderInside(container)
        ? this.renderInternal(container, translation)
        : this.renderExternal(container, translation);
    },

    hideOriginalContainer(container) {
      container.setAttribute('data-lingoflow-hidden', 'true');
      container.hidden = true;
    },

    renderTranslationOnlyUnit(container, translation) {
      if (!container || !container.parentNode) return false;

      const range = document.createRange();
      range.selectNode(container);
      const marker = document.createComment('lingoflow-translation-anchor');
      range.insertNode(marker);

      const block = this.createTranslationOnlyBlock(translation);
      this.copyLayoutMargins(container, block);
      marker.replaceWith(block);
      range.detach();

      this.hideOriginalContainer(container);
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

    async translatePage() {
      return this.enableTranslationMode();
    },

    async enableTranslationMode() {
      if (state.isTranslating) {
        UI.showNotification(statusText('translationInProgress'));
        return;
      }

      // If page already has translation, restore first to avoid double-translating
      if (state.isTranslated) {
        this.restoreOriginal();
      }

      state.isTranslating = true;

      UI.showNotification(statusText('scanning'));

      const units = this.collectTranslationUnits(document.body);
      console.log('LingoFlow: enableTranslationMode found ' + units.length + ' translation units');

      if (units.length === 0) {
        state.isTranslating = false;
        UI.showNotification(statusText('noText'));
        return;
      }

      UI.showNotification(statusText('found', units.length));

      let successCount = 0;
      let failCount = 0;
      let stoppedByInvalidContext = false;

      for (const unit of units) {
        const container = unit.container;
        if (!container.isConnected || container.dataset.lingoflowProcessed === 'true') continue;

        this.markProcessed(container);
        const translation = await TranslationEngine.translate(unit.text);

        if (isContextInvalidatedText(translation)) {
          container.removeAttribute('data-lingoflow-processed');
          stoppedByInvalidContext = true;
          break;
        }

        if (isFallbackText(translation)) {
          container.removeAttribute('data-lingoflow-processed');
          failCount++;
          continue;
        }

        if (this.renderTranslationOnlyUnit(container, translation)) {
          successCount++;
        } else {
          container.removeAttribute('data-lingoflow-processed');
        }
      }

      if (stoppedByInvalidContext) {
        UI.showNotification(statusText('reloaded'));
      } else if (successCount === 0 && failCount === 0) {
        UI.showNotification(statusText('noText'));
      } else if (failCount > 0 && successCount === 0) {
        UI.showNotification(statusText('translationFailed'));
      } else if (failCount > 0) {
        UI.showNotification(statusText('partial', successCount, failCount));
      } else {
        UI.showNotification(statusText('translationOnlyDone', successCount));
      }

      if (successCount > 0) {
        state.isTranslated = true;
      }
      state.isBilingualMode = false;
      state.isTranslating = false;
    },

    toggleBilingualMode() {
      if (state.isBilingualMode || document.querySelector('.lingoflow-block[data-lingoflow="true"]')) {
        this.restoreOriginal();
      } else {
        this.enableBilingualMode();
      }
    },

    async enableBilingualMode() {
      if (state.isTranslating) {
        UI.showNotification(statusText('translationInProgress'));
        return;
      }

      // If page already has translation, restore first
      if (state.isTranslated) {
        this.restoreOriginal();
      }

      state.isTranslating = true;

      UI.showNotification(statusText('scanning'));

      const units = this.collectTranslationUnits(document.body);
      console.log('LingoFlow: enableBilingualMode found ' + units.length + ' translation units');

      if (units.length === 0) {
        state.isTranslating = false;
        UI.showNotification(statusText('noText'));
        return;
      }

      UI.showNotification(statusText('found', units.length));

      let successCount = 0;
      let failCount = 0;
      let stoppedByInvalidContext = false;

      for (const unit of units) {
        const container = unit.container;
        if (!container.isConnected || container.dataset.lingoflowProcessed === 'true') continue;

        this.markProcessed(container);
        const translation = await TranslationEngine.translate(unit.text);

        if (isContextInvalidatedText(translation)) {
          container.removeAttribute('data-lingoflow-processed');
          stoppedByInvalidContext = true;
          break;
        }

        if (isFallbackText(translation)) {
          container.removeAttribute('data-lingoflow-processed');
          failCount++;
          continue;
        }

        if (this.renderTranslationUnit(container, translation)) {
          successCount++;
        } else {
          container.removeAttribute('data-lingoflow-processed');
        }
      }

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
      }
      state.isBilingualMode = successCount > 0;
      state.isTranslating = false;
    },

    restoreOriginal() {
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;

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
        el.classList.remove('lingoflow-translated', 'lingoflow-bilingual');
        delete el.dataset.lfTranslated;
      });

      state.originalContent.clear();
      state.translatedNodes.clear();
      state.isBilingualMode = false;
      state.isTranslated = false;
      window.scrollTo(scrollX, scrollY);
    }
  };
  // Initialize
  function init() {
    try {
      console.log('LingoFlow: Content script loaded');

      // Load settings
      chrome.storage.local.get(['lingoflow_settings'], (result) => {
        if (result.lingoflow_settings) {
          state.hoverEnabled = result.lingoflow_settings.hoverTranslation !== false;
          state.uiLanguage = result.lingoflow_settings.uiLanguage || 'auto';
          state.existingBilingualStrategy = result.lingoflow_settings.existingBilingualStrategy || 'skip';
          TranslationEngine.activeEngine = result.lingoflow_settings.translationEngine || 'google';
        }
      });

      // Event listeners
      document.addEventListener('mouseup', (e) => EventHandlers.handleTextSelection(e));
      document.addEventListener('mouseover', (e) => EventHandlers.handleMouseHover(e));
      document.addEventListener('mouseout', () => UI.removeHoverCard());

      // Listen for settings changes
      chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes.lingoflow_settings) {
          const settings = changes.lingoflow_settings.newValue;
          state.hoverEnabled = settings.hoverTranslation !== false;
          state.uiLanguage = settings.uiLanguage || 'auto';
          state.existingBilingualStrategy = settings.existingBilingualStrategy || 'skip';
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
