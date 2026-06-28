// LingoFlow Popup Script

document.addEventListener('DOMContentLoaded', () => {
  console.log('LingoFlow: Popup loaded');

  // Initialize buttons
  initButtons();

  // Update status
  updateStatus();
});

// Initialize button event listeners
function initButtons() {
  const buttons = document.querySelectorAll('[data-action]');

  buttons.forEach(button => {
    button.addEventListener('click', (e) => {
      const action = button.getAttribute('data-action');
      handleAction(action);
    });
  });
}

// Handle button actions
async function handleAction(action) {
  switch (action) {
    case 'translate-page':
      sendMessageToContent({ action: 'translate_page' });
      break;

    case 'bilingual-mode':
      sendMessageToContent({ action: 'bilingual_mode' });
      break;

    case 'restore-original':
      sendMessageToContent({ action: 'restore_original' });
      break;

    case 'vocabulary':
      openVocabularyPage();
      break;

    case 'history':
      openHistoryPage();
      break;

    case 'settings':
      openSettingsPage();
      break;
  }
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
function sendMessageToContent(message, retries = 2) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0] || !tabs[0].id) {
      showStatus(getMessage('error_cannot_access'), 'error');
      return;
    }

    const url = tabs[0].url;
    if (!isSupportedUrl(url)) {
      showStatus(getMessage('error_cannot_access'), 'error');
      return;
    }

    const tabId = tabs[0].id;

    console.log('LingoFlow Popup: Sending message to tab', tabId, ', action:', message.action, ', retries left:', retries);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        if (retries > 0) {
          // If we still have normal retries left, first try a quick retry
          setTimeout(() => sendMessageToContent(message, retries - 1), 600);
          return;
        }
        // All normal retries exhausted — try injecting content script explicitly as last resort
        console.log('LingoFlow Popup: Attempting explicit content script injection for tab', tabId);
        injectContentScriptAndSend(tabId, message);
        return;
      }
      console.log('LingoFlow Popup: Message sent successfully, response:', response);
    });
  });
}

// Fallback: inject content script then send message (with multi-attempt retry)
function injectContentScriptAndSend(tabId, message) {
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
          showStatus(getMessage('error_cannot_access'), 'error');
          return;
        }
        console.log('LingoFlow Popup: Inline handler injected successfully');
        showStatus(getMessage('ready'), 'success');
      });
      return;
    }

    console.log('LingoFlow Popup: Content script injected successfully');

    // Try sending message with progressive delays (content script needs init time)
    attemptSendAfterInjection(tabId, message, 3);
  });
}

// Retry sending message after injection with backoff
function attemptSendAfterInjection(tabId, message, attemptsLeft) {
  const delay = [300, 600, 1000][3 - attemptsLeft] || 1000;
  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('LingoFlow Popup: Post-injection send failed, attempts left:', attemptsLeft - 1,
          '—', chrome.runtime.lastError.message);
        if (attemptsLeft > 1) {
          attemptSendAfterInjection(tabId, message, attemptsLeft - 1);
          return;
        }
        console.error('LingoFlow Popup: All post-injection attempts exhausted');
        showStatus(getMessage('error_cannot_access'), 'error');
        return;
      }
      console.log('LingoFlow Popup: Message sent after injection, response:', response);
      showStatus(getMessage('ready'), 'success');
    });
  }, delay);
}

// Inline fallback handler — a minimal self-contained content script
// This runs inside the page context and handles translate/bilingual actions directly
function createInlineHandler(initialMessage) {
  // Inject our bilingual styles FIRST so they're available when translation runs
  var styleEl = document.createElement('style');
  styleEl.id = 'lingoflow-inline-styles';
  styleEl.textContent = [
    '.lf-bilingual-trans {',
    '  overflow-wrap: break-word;',
    '  word-break: break-word;',
    '  overflow-x: hidden;',
    '  max-width: 100%;',
    '  margin-top: 1px !important;',
    '  margin-bottom: 0 !important;',
    '}'
  ].join('\n');
  (document.head || document.documentElement).appendChild(styleEl);

  // Register listener immediately
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try { sendResponse({ received: true }); } catch (_) {}
  });

  // Handle the initial message that triggered this injection
  handleActionInline(initialMessage);

  function handleActionInline(msg) {
    if (!document || !document.body) return;

    var isTranslating = false;
    var translatedEls = new Set();

    // Minimal paragraph finder
    function findParagraphs() {
      var main = document.querySelector('article, main, [role="main"], .content, #content') || document.body;
      var selectors = 'p, h1, h2, h3, h4, h5, h6, li';
      var els = Array.from(main.querySelectorAll(selectors));

      // Also collect leaf divs (for Notion-style pages)
      var divs = main.querySelectorAll('div');
      var skipSel = 'nav, footer, aside, .sidebar, .menu, .navbar, .nav';
      var elSet = new Set(els);

      for (var i = 0; i < divs.length; i++) {
        var d = divs[i];
        if (d.closest(skipSel)) continue;
        if (d.dataset.lfTranslated) continue;

        // Check leaf: no block children, enough text
        var hasBlockChild = false;
        var blockTags = ['P','H1','H2','H3','H4','H5','H6','LI','DIV','BLOCKQUOTE','UL','OL','TABLE','SECTION','ARTICLE'];
        for (var c = 0; c < d.children.length; c++) {
          if (blockTags.indexOf(d.children[c].tagName) >= 0) { hasBlockChild = true; break; }
        }
        if (hasBlockChild) continue;
        if ((d.textContent || '').trim().length < 10) continue;

        // Check overlap
        var overlap = false;
        elSet.forEach(function(e) { if (d.contains(e) || e.contains(d)) overlap = true; });
        if (overlap) continue;

        els.push(d);
        elSet.add(d);
      }

      return els.filter(function(el) {
        return !el.closest(skipSel) && (el.textContent || '').trim().length >= 10 && !translatedEls.has(el);
      }).filter(function(el, idx, arr) {
        // Dedup by text content: use containment to catch wrapper/sibling duplicates
        var text = (el.textContent || '').trim().replace(/\s+/g, ' ');
        for (var j = 0; j < idx; j++) {
          var prev = (arr[j].textContent || '').trim().replace(/\s+/g, ' ');
          var shorter = text.length <= prev.length ? text : prev;
          var longer = text.length <= prev.length ? prev : text;
          if (longer.includes(shorter) && shorter.length / longer.length > 0.7) return false;
        }
        return true;
      });
    }

    // Simple translate via background
    function translate(text, cb) {
      chrome.runtime.sendMessage({
        action: 'translate',
        text: text.substring(0, 2000),
        targetLang: 'zh-CN'
      }, function(resp) {
        if (resp && resp.success && resp.translation) cb(resp.translation);
        else cb('[翻译中...] ' + text);
      });
    }

    function isFallback(t) {
      return t.indexOf('[翻译') === 0;
    }

    // Detect if text is primarily Chinese (skip translation)
    function isChinese(t) {
      var cleaned = t.replace(/[\s\n\r\t\d.,;:!?'""''()（）【】《》—–…·\-\/]/g, '');
      if (cleaned.length < 5) return false;
      var cjk = 0;
      for (var ci = 0; ci < cleaned.length; ci++) {
        if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(cleaned[ci])) cjk++;
      }
      return cjk / cleaned.length >= 0.45;
    }

    async function doTranslate(actionType) {
      if (isTranslating) return;
      isTranslating = true;

      var blocks = findParagraphs();
      if (blocks.length === 0) { isTranslating = false; return; }

      var ok = 0, fail = 0;
      for (var idx = 0; idx < blocks.length; idx++) {
        var el = blocks[idx];
        if (el.dataset.lfTranslated === '1') continue;
        var txt = (el.textContent || '').trim();
        if (txt.length < 10) continue;

        // Skip Chinese paragraphs
        if (isChinese(txt)) { el.dataset.lfTranslated = '1'; continue; }

        el.dataset.lfTranslated = '1';

        await new Promise(function(resolve) {
          translate(txt, function(trans) {
            if (isFallback(trans)) { delete el.dataset.lfTranslated; fail++; resolve(); return; }
            translatedEls.add(el);

            if (actionType === 'bilingual_mode') {
              // Deep-clone the entire element (tag + classes + subtree), then replace text.
              // This lets the browser re-match all CSS rules automatically.
              var clone = el.cloneNode(true);
              // Preserve id with lf_ prefix so id-based CSS rules still apply
              if (el.id) clone.id = 'lf_' + el.id;
              // Remove attributes that shouldn't carry over
              delete clone.dataset.lfTranslated;
              delete clone.dataset.lfProcessed;
              // Remove classes that mark "translated original"
              clone.classList.remove('lingoflow-translated');
              // Mark as bilingual translation block
              clone.classList.add('lf-bilingual-trans');
              // Replace all text content with the translation
              clone.textContent = trans;
              el.insertAdjacentElement('afterend', clone);
            } else {
              el.textContent = trans;
            }
            ok++;
            resolve();
          });
        });

        // Small delay to avoid rate limiting
        if (idx < blocks.length - 1) await new Promise(function(r) { setTimeout(r, 200); });
      }

      isTranslating = false;
    }

    if (msg.action === 'translate_page' || msg.action === 'bilingual_mode') {
      doTranslate(msg.action).then(function() {});
    } else if (msg.action === 'restore_original') {
      document.querySelectorAll('.lf-bilingual-trans').forEach(function(el) { el.remove(); });
      document.querySelectorAll('[data-lf-translated]').forEach(function(el) {
        delete el.dataset.lfTranslated;
        el.classList.remove('lingoflow-translated');
      });
      translatedEls.clear();
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
      statusIndicator.style.background = '#10b981';
      break;
    case 'warning':
      statusIndicator.style.background = '#f59e0b';
      break;
    case 'error':
      statusIndicator.style.background = '#ef4444';
      break;
  }
}
