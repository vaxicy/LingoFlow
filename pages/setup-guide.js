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

  function applyLang(lang) {
    var dir = lang === 'zh' || (lang || '').startsWith('zh') ? 'zh_CN' : 'en';
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
        document.documentElement.lang = lang === 'zh' ? 'zh' : 'en';
      })
      .catch(function (err) { console.warn('LingoFlow setup guide: failed to load locale', dir, err); });
  }

  function detectLang() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'zh' || saved === 'en') return saved;
    } catch (e) {}
    var nav = (navigator.language || navigator.userLanguage || 'zh').toLowerCase();
    return nav.startsWith('zh') ? 'zh' : 'en';
  }

  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      applyLang(b.getAttribute('data-lang'));
    });
  });

  // Initial localization (match the extension's UI language preference)
  applyLang(detectLang());
})();
