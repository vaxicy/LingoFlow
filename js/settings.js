// LingoFlow 设置整页（pages/settings.html）的页面外壳脚本。
// 注意：设置面板本身的读/写逻辑仍然只在 js/popup.js 里（popup 与设置页共用同一套实现，
// 避免两份代码漂移）。这里只负责左侧锚点导航高亮和页面标题。

document.addEventListener('DOMContentLoaded', () => {
  const navItems = Array.from(document.querySelectorAll('.settings-nav-item'));
  if (!navItems.length) return;

  // 品牌文字（data-i18n="settings"）被 i18n 重新本地化时，同步更新标签页标题
  const brandLabel = document.querySelector('.settings-page-brand-text span');
  if (brandLabel) {
    const syncTitle = () => {
      const label = (brandLabel.textContent || '').trim() || 'Settings';
      document.title = 'LingoFlow · ' + label;
    };
    new MutationObserver(syncTitle).observe(brandLabel, {
      characterData: true,
      childList: true,
      subtree: true
    });
    syncTitle();
  }

  const sections = navItems
    .map(item => {
      const id = (item.getAttribute('href') || '').replace('#', '');
      const el = id ? document.getElementById(id) : null;
      return el ? { item, el } : null;
    })
    .filter(Boolean);

  const setActive = (target) => {
    navItems.forEach(item => {
      const on = item === target;
      item.classList.toggle('active', on);
      if (on) {
        item.setAttribute('aria-current', 'true');
      } else {
        item.removeAttribute('aria-current');
      }
    });
  };

  // 点击立即高亮（滚动高亮会随后接管）
  navItems.forEach(item => {
    item.addEventListener('click', () => setActive(item));
  });

  if (!('IntersectionObserver' in window) || !sections.length) return;

  const observer = new IntersectionObserver((entries) => {
    const topMost = entries
      .filter(entry => entry.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!topMost) return;
    const found = sections.find(section => section.el === topMost.target);
    if (found) setActive(found.item);
  }, { rootMargin: '-90px 0px -65% 0px', threshold: 0 });

  sections.forEach(section => observer.observe(section.el));
});
