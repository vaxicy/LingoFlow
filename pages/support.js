// pages/support.js — Support page logic (external script so it passes MV3 CSP)
(function () {
  // ---- 1) Sync theme with the extension ----
  try {
    chrome.storage.local.get(['lingoflow_settings'], function (result) {
      var settings = result && result.lingoflow_settings;
      var theme = settings && settings.theme === 'dark' ? 'dark' : 'light';
      document.body.setAttribute('data-theme', theme);
    });
  } catch (_) {
    document.body.setAttribute('data-theme', 'light');
  }

  // ---- 2) Language switcher ----
  var STORAGE_KEY = 'lingoflow_ui_lang';
  var buttons = document.querySelectorAll('.lang-switch button');

  function dirFor(lang) {
    var l = (lang || '').toLowerCase();
    if (l === 'zh' || l.indexOf('zh') === 0) return 'zh_CN';
    if (l.indexOf('es') === 0) return 'es';
    return 'en';
  }

  function applyI18n(lang) {
    var dir = dirFor(lang);
    return fetch(chrome.runtime.getURL('_locales/' + dir + '/messages.json'))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (messages) {
        var els = document.querySelectorAll('[data-i18n]');
        els.forEach(function (el) {
          var key = el.getAttribute('data-i18n');
          var msg = messages[key] && messages[key].message;
          if (msg) el.innerHTML = msg;
        });
        buttons.forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-lang') === lang);
        });
        try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
        var l = (lang || '').toLowerCase();
        document.documentElement.lang = (l.indexOf('zh') === 0) ? 'zh-CN' : (l.indexOf('es') === 0 ? 'es' : 'en');
      })
      .catch(function (err) { console.warn('LingoFlow support: failed to load locale', dir, err); });
  }

  // Priority: popup's real source (chrome.storage) > localStorage mirror > browser language
  function detectLang(cb) {
    try {
      chrome.storage.local.get(['lingoflow_settings'], function (result) {
        var ui = result && result.lingoflow_settings && result.lingoflow_settings.uiLanguage;
        if (ui === 'zh' || ui === 'en' || ui === 'es') return cb(ui);
        var saved;
        try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) {}
        if (saved === 'zh' || saved === 'en' || saved === 'es') return cb(saved);
        var nav = (navigator.language || navigator.userLanguage || 'zh').toLowerCase();
        if (nav.indexOf('zh') === 0) return cb('zh');
        if (nav.indexOf('es') === 0) return cb('es');
        cb('en');
      });
    } catch (_) {
      cb('en');
    }
  }

  function setLang(lang) {
    applyI18n(lang);
    // Write back to chrome.storage so popup/settings stay in sync.
    // background merges with getDefaultSettings, keeping all other keys intact.
    try {
      chrome.runtime.sendMessage({
        action: 'update_settings',
        settings: { uiLanguage: lang }
      });
    } catch (e) {}
  }

  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      setLang(b.getAttribute('data-lang'));
    });
  });

  detectLang(function (lang) {
    applyI18n(lang);
    buttons.forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-lang') === lang);
    });
  });
})();
