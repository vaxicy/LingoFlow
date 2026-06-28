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
    hoverEnabled: true,
    originalContent: new Map(), // Store original content for restoration
    translatedNodes: new Set() // Track translated nodes
  };

  // Helper: Check if translation result is a fallback/error text (not a real translation)
  function isFallbackText(text) {
    return text.startsWith('[翻译') ||
           text.startsWith('[需翻译') ||
           text.startsWith('[翻译超时]');
  }

  // Helper: Check if text is primarily Chinese/CJK (skip translation for already-Chinese content)
  function isChineseText(text) {
    const cleaned = text.replace(/[\s\n\r\t\d.,;:!?'""''()（）【】《》—–…·\-\/]/g, '');
    if (cleaned.length < 5) return false;
    let cjkCount = 0;
    for (const ch of cleaned) {
      if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) cjkCount++;
    }
    return cjkCount / cleaned.length >= 0.45; // ≥45% CJK characters = treat as Chinese
  }

  // Translation Engine - Pluggable architecture
  const TranslationEngine = {
    // Current active engine
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
            resolve(`[翻译超时] ${text}`);
          }, 6000);

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
                  console.warn('LingoFlow: Background translate error', chrome.runtime.lastError);
                  resolve(`[翻译中...] ${text}`);
                  return;
                }

                if (response && response.success && response.translation) {
                  resolve(response.translation);
                } else {
                  console.warn('LingoFlow: Translation failed', response && response.error);
                  resolve(`[翻译中...] ${text}`);
                }
              }
            );
          } catch (err) {
            clearTimeout(timeoutId);
            console.warn('LingoFlow: sendMessage error', err);
            resolve(`[翻译中...] ${text}`);
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
      state.originalContent.set(element, element.innerHTML);
    },

    // Restore original content
    restoreOriginal(element) {
      const original = state.originalContent.get(element);
      if (original) {
        element.innerHTML = original;
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
        this.showNotification('翻译失败，请检查网络连接');
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
        'hello': '你好',
        'world': '世界',
        'computer': '计算机',
        'programming': '编程',
        'language': '语言',
        'learn': '学习',
        'read': '阅读',
        'website': '网站',
        'translation': '翻译'
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
          PageTranslator.translatePage();
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
    // Block-level tags that indicate an element is NOT a leaf paragraph
    nonLeafBlockTags: ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'DIV', 'BLOCKQUOTE', 'UL', 'OL', 'TABLE', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE'],

    // Check if a <div> is a "leaf paragraph" (contains text but no nested block-level children)
    isLeafParagraphDiv(el) {
      if (el.tagName !== 'DIV') return false;
      for (const child of el.children) {
        if (this.nonLeafBlockTags.includes(child.tagName)) return false;
      }
      const text = el.textContent.trim();
      return text.length >= 10;
    },

    // Find all paragraph-level elements in main content (two-phase strategy)
    findParagraphElements(mainContent) {
      // Phase 1: Standard leaf-level paragraph selectors
      const standardSelectors = [
        'p',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'li', 'td', 'th', 'blockquote', 'dt', 'dd'
      ].join(', ');

      let elements = Array.from(mainContent.querySelectorAll(standardSelectors));

      // Filter: skip non-content areas and short text
      // NOTE: intentionally exclude nav/footer/aside but NOT header — many sites put article content inside header
      const skipAreaSelector = 'nav, footer, aside, [role="navigation"], [role="contentinfo"], [role="banner"]';
      elements = elements.filter(el => {
        if (!DOMProcessor.shouldTranslate(el)) return false;
        if (el.closest(skipAreaSelector)) return false;
        // Skip only obvious navigation UI classes, not content areas
        if (el.closest('.sidebar, .menu, .navbar, .nav, .navigation, .menu-bar, .site-nav')) return false;
        if ((el.textContent || '').trim().length < 10) return false;
        return true;
      });

      // Phase 2: ALWAYS also collect leaf <div> paragraphs to supplement Phase 1
      // This ensures Notion-style pages (where paragraphs are divs) are fully covered,
      // and also catches div-wrapped text that standard selectors miss.
      const allDivs = mainContent.querySelectorAll('div');
      const phase1Set = new Set(elements);

      for (const div of allDivs) {
        // Skip elements that should NOT be translated
        if (!DOMProcessor.shouldTranslate(div)) continue;
        if (div.closest(skipAreaSelector)) continue;
        if (div.closest('.sidebar, .menu, .navbar, .nav, .navigation, .menu-bar, .site-nav')) continue;
        if (div.dataset.lfTranslated === '1') continue;
        if (!this.isLeafParagraphDiv(div)) continue;

        // Dedup: skip if this div CONTAINS or IS CONTAINED BY any phase-1 element
        let hasOverlap = false;
        for (const existing of phase1Set) {
          if (div.contains(existing) || existing.contains(div)) {
            hasOverlap = true;
            break;
          }
        }
        if (hasOverlap) continue;

        // Also dedup against other already-added phase-2 divs
        elements.push(div);
        phase1Set.add(div); // reuse set for O(1) dedup
      }

      console.log('LingoFlow: Found ' + elements.length + ' total paragraph elements');

      // Final safety dedup by element reference
      const seen = new Set();
      elements = elements.filter(el => {
        if (seen.has(el)) return false;
        seen.add(el);
        return true;
      });

      // Dedup by text content: if two elements have nearly identical or overlapping
      // textContent, keep only the first (more specific) one — avoids double-translation
      // on pages that wrap <p> inside a leaf <div> or have sibling elements with same text.
      const seenTexts = new Set();
      elements = elements.filter(el => {
        const text = (el.textContent || '').trim();
        if (!text || text.length < 10) return false;
        // Normalise whitespace for comparison
        const norm = text.replace(/\s+/g, ' ');
        // Exact match check first (fast path)
        if (seenTexts.has(norm)) return false;
        // Containment check: if this text is a substring of (or superset of)
        // an already-seen text, it's likely a duplicate wrapper/sibling element.
        // Require significant overlap (>70% of shorter text) to avoid false positives.
        for (const existing of seenTexts) {
          const shorter = norm.length <= existing.length ? norm : existing;
          const longer = norm.length <= existing.length ? existing : norm;
          if (longer.includes(shorter) && shorter.length / longer.length > 0.7) {
            return false;
          }
        }
        seenTexts.add(norm);
        return true;
      });

      return elements;
    },

    // Translate entire page (block-level granularity, one paragraph at a time)
    async translatePage() {
      if (state.isTranslating) return;
      state.isTranslating = true;

      UI.showNotification('正在查找页面段落...');

      const mainContent = this.findMainContent();
      const blocks = this.findParagraphElements(mainContent);

      console.log('LingoFlow: translatePage found ' + blocks.length + ' paragraph elements');

      if (blocks.length === 0) {
        state.isTranslating = false;
        UI.showNotification('未找到可翻译的段落，请刷新页面后重试');
        return;
      }

      UI.showNotification('找到 ' + blocks.length + ' 处段落，开始翻译...');

      let successCount = 0;
      let failCount = 0;

      for (const el of blocks) {
        // Skip if already translated (re-check since findParagraphElements may include new elements)
        if (el.dataset.lfTranslated === '1') continue;

        const text = el.textContent.trim();
        if (!text || text.length < 10) continue;

        // Skip Chinese paragraphs to avoid double-translation
        if (isChineseText(text)) {
          console.log('LingoFlow: Skipping Chinese paragraph:', text.substring(0, 40));
          el.dataset.lfTranslated = '1';
          continue;
        }

        // Mark immediately to prevent double-translation from overlapping elements
        el.dataset.lfTranslated = '1';

        const translation = await TranslationEngine.translate(text);

        if (isFallbackText(translation)) {
          // Remove mark on failure so retry could work
          delete el.dataset.lfTranslated;
          failCount++;
          continue;
        }

        DOMProcessor.saveOriginal(el);
        el.classList.add('lingoflow-translated');

        // Replace text content only (preserve element structure)
        el.textContent = translation;
        state.translatedNodes.add(el);
        successCount++;
      }

      state.isTranslating = false;

      if (successCount === 0 && failCount === 0) {
        UI.showNotification('未找到可翻译的段落');
      } else if (failCount > 0 && successCount === 0) {
        UI.showNotification('翻译失败，请检查网络连接');
      } else if (failCount > 0) {
        UI.showNotification(`已翻译 ${successCount} 处，${failCount} 处失败`);
      } else if (successCount > 0) {
        UI.showNotification(`已翻译 ${successCount} 处段落`);
      }
    },

    // Toggle bilingual mode
    toggleBilingualMode() {
      if (state.isBilingualMode) {
        this.restoreOriginal();
        state.isBilingualMode = false;
      } else {
        this.enableBilingualMode();
        state.isBilingualMode = true;
      }
    },

    // Enable bilingual mode (block-level granularity, one paragraph at a time)
    async enableBilingualMode() {
      if (state.isTranslating) {
        UI.showNotification('正在翻译中，请稍候...');
        return;
      }
      state.isTranslating = true;

      UI.showNotification('正在查找页面段落...');

      const mainContent = this.findMainContent();
      const blocks = this.findParagraphElements(mainContent);

      console.log('LingoFlow: enableBilingualMode found ' + blocks.length + ' paragraph elements');

      if (blocks.length === 0) {
        state.isTranslating = false;
        UI.showNotification('未找到可翻译的段落，请刷新页面后重试');
        return;
      }

      UI.showNotification('找到 ' + blocks.length + ' 处段落，开始翻译...');

      let successCount = 0;
      let failCount = 0;

      for (const el of blocks) {
        // Skip if already has translation sibling
        if (el.nextElementSibling && el.nextElementSibling.classList.contains('lf-bilingual-trans')) continue;
        if (el.dataset.lfTranslated === '1') continue;

        const text = el.textContent.trim();
        if (!text || text.length < 10) continue;

        // Skip Chinese paragraphs to avoid double-translation
        if (isChineseText(text)) {
          console.log('LingoFlow: Skipping Chinese paragraph:', text.substring(0, 40));
          el.dataset.lfTranslated = '1'; // Mark as processed
          continue;
        }

        // Mark immediately to prevent double-translation from overlapping elements
        el.dataset.lfTranslated = '1';

        const translation = await TranslationEngine.translate(text);

        if (isFallbackText(translation)) {
          delete el.dataset.lfTranslated;
          failCount++;
          continue;
        }

        DOMProcessor.saveOriginal(el);
        el.classList.add('lingoflow-translated');

        // Deep-clone the entire element (tag + classes + subtree), then replace text.
        // This lets the browser re-match all CSS rules automatically — no manual
        // property copying needed, and the translation inherits the exact same styles.
        const transEl = el.cloneNode(true);
        // Preserve the id with an lf_ prefix so id-based CSS rules still apply
        if (el.id) transEl.id = 'lf_' + el.id;
        // Remove attributes that shouldn't carry over
        transEl.removeAttribute('data-lf-translated');
        transEl.removeAttribute('data-lf-processed');
        // Remove classes that mark "translated original" — this is the translation, not the original
        transEl.classList.remove('lingoflow-translated');
        // Mark as bilingual translation block
        transEl.classList.add('lf-bilingual-trans');
        // Replace all text content with the translation (preserves element structure)
        transEl.textContent = translation;

        el.insertAdjacentElement('afterend', transEl);
        state.translatedNodes.add(el);
        successCount++;
      }

      if (successCount === 0 && failCount === 0) {
        UI.showNotification('未找到可翻译的段落');
      } else if (failCount > 0 && successCount === 0) {
        UI.showNotification('翻译失败，请检查网络连接');
      } else if (failCount > 0) {
        UI.showNotification(`已翻译 ${successCount} 处，${failCount} 处失败`);
      } else if (successCount > 0) {
        UI.showNotification(`双语对照：已翻译 ${successCount} 处段落`);
      }

      state.isTranslating = false;
    },

    // Restore original content
    restoreOriginal() {
      // Remove all translation sibling blocks
      document.querySelectorAll('.lf-bilingual-trans').forEach(el => el.remove());

      // Restore original innerHTML for saved elements
      for (const [element, originalHTML] of state.originalContent) {
        element.innerHTML = originalHTML;
        element.classList.remove('lingoflow-translated', 'lingoflow-bilingual');
        delete element.dataset.lfTranslated;
      }

      // Also clean up any data-lf-translated attributes on non-saved elements
      document.querySelectorAll('[data-lf-translated]').forEach(el => {
        delete el.dataset.lfTranslated;
        el.classList.remove('lingoflow-translated');
      });

      state.originalContent.clear();
      state.translatedNodes.clear();
      state.isBilingualMode = false;
    },

    // Find main content
    findMainContent() {
      // Try to find main content area
      const selectors = ['article', 'main', '[role="main"]', '.content', '#content', 'body'];
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) return element;
      }
      return document.body;
    },

    // Escape HTML
    escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
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
