// Sync theme with the extension
(function () {
  try {
    var saved = localStorage.getItem('lingoflow_theme') || 'dark';
    if (saved === 'light') document.body.setAttribute('data-theme', 'light');
  } catch (e) {}
})();

// Language switcher for setup guide page
(function () {
  var STORAGE_KEY = 'lingoflow_ui_lang';
  var buttons = document.querySelectorAll('.lang-switch button');

  function localeDir(lang) {
    var l = (lang || '').toLowerCase();
    if (l === 'zh' || l.indexOf('zh') === 0) return 'zh_CN';
    if (l.indexOf('es') === 0) return 'es';
    return 'en';
  }

  function applyLang(lang) {
    var dir = localeDir(lang);
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
          if (msg) {
            // Use innerHTML so locale messages can carry inline <code> spans
            // (e.g. step text containing sk-… / URL code highlights).
            el.innerHTML = msg;
          }
        });
        buttons.forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-lang') === lang);
        });
        try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
        var l = (lang || '').toLowerCase();
        document.documentElement.lang = (l.indexOf('zh') === 0) ? 'zh-CN' : (l.indexOf('es') === 0 ? 'es' : 'en');
      })
      .catch(function (err) { console.warn('LingoFlow setup guide: failed to load locale', dir, err); });
  }

  function detectLang() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'zh' || saved === 'en' || saved === 'es') return saved;
    } catch (e) {}
    var nav = (navigator.language || navigator.userLanguage || 'zh').toLowerCase();
    if (nav.indexOf('zh') === 0) return 'zh';
    if (nav.indexOf('es') === 0) return 'es';
    return 'en';
  }

  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      applyLang(b.getAttribute('data-lang'));
    });
  });

  // Initial localization (match the extension's UI language preference)
  applyLang(detectLang());
})();
