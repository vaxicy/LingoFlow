// LingoFlow i18n Utility
// Shared internationalization functions
// Supports manual language override via setLanguage(lang)

// Manually loaded locale messages (override chrome.i18n when set)
let _manualMessages = null;

/**
 * Set manual UI language.
 * @param {string} lang - 'auto' | 'zh' | 'en'
 *   'auto': use chrome.i18n (browser locale)
 *   'zh' / 'en': manually load and apply the corresponding locale file
 */
function setLanguage(lang) {
  if (lang === 'auto') {
    _manualMessages = null;
    // Re-localize the current page with browser locale
    if (typeof localizeHtml === 'function') localizeHtml();
    if (typeof localizePlaceholders === 'function') localizePlaceholders();
    return Promise.resolve();
  }

  // Map lang code to directory name
  const dir = (lang === 'zh' || lang.startsWith('zh')) ? 'zh_CN' : lang;

  return fetch(chrome.runtime.getURL('_locales/' + dir + '/messages.json'))
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(messages => {
      _manualMessages = messages;
      // Re-localize the current page
      if (typeof localizeHtml === 'function') localizeHtml();
      if (typeof localizePlaceholders === 'function') localizePlaceholders();
      if (typeof localizeContainer === 'function') {
        const container = document.querySelector('.options-container') || document.body;
        localizeContainer(container);
      }
    })
    .catch(err => console.warn('LingoFlow i18n: Failed to load locale', dir, err));
}

/**
 * Get localized message.
 * If manual language is set, use _manualMessages; otherwise fall back to chrome.i18n.
 * @param {string} key - i18n key
 * @param {Array} substitutions - Optional substitutions
 * @returns {string} Localized message or key if not found
 */
function getMessage(key, substitutions = []) {
  if (_manualMessages && _manualMessages[key]) {
    let msg = _manualMessages[key].message;
    // Simple substitution support: $1, $2, ...
    if (substitutions && substitutions.length) {
      substitutions.forEach((sub, i) => {
        msg = msg.replace('$' + (i + 1), sub);
      });
    }
    return msg;
  }
  const message = chrome.i18n.getMessage(key, substitutions);
  return message || key;
}

/**
 * Localize all elements with data-i18n attribute
 * Call this function on DOMContentLoaded
 */
function localizeHtml() {
  const elements = document.querySelectorAll('[data-i18n]');
  elements.forEach(el => {
    const key = el.getAttribute('data-i18n');
    const message = getMessage(key);
    if (message && message !== key) {
      el.textContent = message;
    }
  });
}

/**
 * Localize placeholder attributes
 */
function localizePlaceholders() {
  const elements = document.querySelectorAll('[data-i18n-placeholder]');
  elements.forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const message = getMessage(key);
    if (message && message !== key) {
      el.placeholder = message;
    }
  });
}

/**
 * Localize element with a specific key
 * @param {HTMLElement} element - Target element
 * @param {string} key - i18n key
 */
function localizeElement(element, key) {
  const message = getMessage(key);
  if (message && message !== key) {
    element.textContent = message;
  }
}

/**
 * Localize all data-i18n elements within a container
 * @param {HTMLElement} container - Container element
 */
function localizeContainer(container) {
  const elements = container.querySelectorAll('[data-i18n]');
  elements.forEach(el => {
    const key = el.getAttribute('data-i18n');
    const message = getMessage(key);
    if (message && message !== key) {
      el.textContent = message;
    }
  });
}

// Auto-localize on DOMContentLoaded (for pages that load i18n.js normally)
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    localizeHtml();
    localizePlaceholders();
  });
}
