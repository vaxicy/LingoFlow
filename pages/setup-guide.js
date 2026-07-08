// Sync theme with the extension
(function () {
  try {
    var saved = localStorage.getItem('lingoflow_theme') || 'dark';
    if (saved === 'light') document.body.setAttribute('data-theme', 'light');
  } catch (e) {}
})();
