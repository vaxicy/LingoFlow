// LingoFlow · YouTube 字幕翻译（接管式双语字幕）
//
// 设计要点（为什么这样写）：
// 1) 接管式渲染：把 YouTube 原生字幕层设为 opacity:0（它仍在 DOM 里继续更新，作为我们的
//    数据源），屏幕上只保留我们这一层 → 物理上不可能出现「两行字幕打架」。
// 2) 绝不修改 .ytp-caption-segment：只读文本。YouTube 会重写这些节点，插内容必被覆盖。
// 3) 先渲染原文、再异步补译文：字幕永远"在"，不会出现空白等待。
// 4) token 校验：译文回来时若已换句则丢弃，避免上一句译文串到下一句。
// 5) SPA 适配：yt-navigate-finish 后整体重建。
//
// 该脚本独立于 js/content.js，只负责字幕，不参与整页翻译。

(function () {
  'use strict';

  if (window.top !== window) return;
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;

  const SETTINGS_KEY = 'lingoflow_settings';
  const LRU_LIMIT = 600;
  const CLEAR_DELAY = 250;      // 句子间 DOM 会短暂清空，延迟清理防闪烁
  const TYPE_DEBOUNCE = 110;    // 字幕逐字出现，防抖后再取整句
  const POLL_MS = 500;
  const MAX_TEXT = 1200;

  const state = {
    settings: null,
    enabled: false,
    displayMode: 'dual',        // dual | translation | source
    sourceLang: 'auto',         // 原文字幕语言偏好
    renderMode: 'takeover',     // takeover | avoid
    fontSize: 22,
    targetLang: 'zh',
    uiLang: 'zh',
    noBaseNotified: false,
    baseFailCount: 0,
    lastDst: '',
    running: false,
    observer: null,
    observedRoot: null,
    pollTimer: null,
    debounceTimer: null,
    clearTimer: null,
    token: 0,
    lastText: '',
    overlay: null,
    lru: new Map(),
    ccClicks: 0,
    lastCcClickAt: 0,
    startAttempts: 0,
    navTimer: null
  };

  // ---------- 设置 ----------

  function loadSettings(cb) {
    try {
      chrome.storage.local.get([SETTINGS_KEY], (res) => {
        if (chrome.runtime.lastError) { cb(state.settings || {}); return; }
        cb((res && res[SETTINGS_KEY]) || {});
      });
    } catch (_) {
      cb(state.settings || {});
    }
  }

  function applyRuntimeConfig(s) {
    state.settings = s || {};
    state.enabled = state.settings.ytSubsEnabled === true;

    // 显示方式：优先新键；旧版只有 ytSubsDual 布尔值，做一次兼容迁移
    const mode = state.settings.ytSubsDisplayMode;
    if (mode === 'dual' || mode === 'translation' || mode === 'source') {
      state.displayMode = mode;
    } else {
      state.displayMode = state.settings.ytSubsDual === false ? 'translation' : 'dual';
    }

    state.sourceLang = state.settings.ytSubsSourceLang || 'auto';
    state.renderMode = state.settings.ytSubsRenderMode === 'avoid' ? 'avoid' : 'takeover';
    state.fontSize = Number(state.settings.ytSubsFontSize) || 22;
    state.targetLang = state.settings.targetLanguage || 'zh';
    state.uiLang = String(state.settings.uiLanguage || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  }

  function T() {
    const zh = state.uiLang === 'zh';
    return {
      switched: zh ? '已把 YouTube 字幕切回原语言' : 'Switched YouTube subtitles back to the original language',
      noBase: zh
        ? '该视频只有翻译字幕，无法显示原文'
        : 'This video only has translated captions; the original line is unavailable'
    };
  }

  // ---------- 页面判定 ----------

  function isWatchPage() {
    return location.pathname === '/watch';
  }

  // ---------- 启动 / 停止 ----------

  function start() {
    if (state.running) return;
    if (!isWatchPage()) return;

    const player = document.getElementById('movie_player');
    if (!player) {
      // 播放器还没注入，最多重试 20 次（约 12s）
      if (state.startAttempts >= 20) { state.startAttempts = 0; return; }
      state.startAttempts += 1;
      setTimeout(start, 600);
      return;
    }

    state.startAttempts = 0;
    state.running = true;
    state.token = 0;
    state.lastText = '';
    state.lastDst = '';
    state.ccClicks = 0;
    state.noBaseNotified = false;
    state.baseFailCount = 0;
    state.lastBaseCheckAt = Date.now();

    ensureOverlay();
    applyModeClass();
    ensureCaptionsOn();
    askEnsureBaseTrack();
    startPolling();
  }

  function teardown() {
    state.running = false;
    stopPolling();

    if (state.observer) {
      try { state.observer.disconnect(); } catch (_) {}
    }
    state.observer = null;
    state.observedRoot = null;

    if (state.debounceTimer) { clearTimeout(state.debounceTimer); state.debounceTimer = null; }
    if (state.clearTimer) { clearTimeout(state.clearTimer); state.clearTimer = null; }

    if (state.overlay) {
      try { state.overlay.remove(); } catch (_) {}
      state.overlay = null;
    }

    removeModeClass();
    state.lastText = '';
    state.lastDst = '';
    state.token += 1;
  }

  // ---------- 原生字幕层控制 ----------

  function ensureCaptionsOn() {
    if (!state.running) return;
    if (document.querySelector('.ytp-caption-segment')) return;

    const btn = document.querySelector('.ytp-subtitles-button');
    if (!btn) return;
    if (btn.getAttribute('aria-pressed') === 'true') return;
    if (btn.disabled) return;

    const now = Date.now();
    if (state.ccClicks >= 3 || now - state.lastCcClickAt < 1200) return;
    state.ccClicks += 1;
    state.lastCcClickAt = now;
    try { btn.click(); } catch (_) {}
  }

  // 用户可能把 YouTube 字幕切成了「中文（翻译）」轨 → 我们拿到的原文已是中文，
  // 双语就出不来。这里请求 background 在主世界用 player API 切回原语言轨。
  // 失败不影响主流程（退化为单语），连续失败 3 次后停止重试并提示一次。
  function askEnsureBaseTrack() {
    if (state.baseFailCount >= 3) return;
    try {
      chrome.runtime.sendMessage(
        {
          action: 'lf_yt_ensure_base',
          targetLang: state.targetLang,
          sourceLang: state.sourceLang
        },
        (res) => {
          if (chrome.runtime.lastError) return;
          if (!res) return;

          if (res.tracks) {
            console.log('[LingoFlow] yt tracks:', res.tracks,
              '| picked:', res.picked || null,
              '| switched:', !!res.switched,
              '| ok:', !!res.ok,
              res.reason ? ('| reason: ' + res.reason) : '');
          }

          if (res.reason === 'no base track') {
            state.baseFailCount = 3;
            if (!state.noBaseNotified) {
              state.noBaseNotified = true;
              toast(T().noBase);
            }
            return;
          }

          if (res.ok) {
            state.baseFailCount = 0;
            if (res.switched) toast(T().switched);
          } else {
            state.baseFailCount += 1;
          }
        }
      );
    } catch (_) {}
  }

  // ---------- 字幕采集 ----------

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(tick, POLL_MS);
    tick();
  }

  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  function tick() {
    if (!state.running) return;

    // 播放器被销毁（离开视频页 / SPA 重建）→ 收工
    if (!document.getElementById('movie_player')) { teardown(); return; }

    ensureOverlay();
    ensureCaptionsOn();

    // 定期复查字幕轨：用户可能中途手动把 YouTube 字幕切成中文翻译轨
    const now = Date.now();
    if (now - (state.lastBaseCheckAt || 0) > 15000) {
      state.lastBaseCheckAt = now;
      askEnsureBaseTrack();
    }

    const root = document.querySelector('.ytp-caption-window-container');
    if (root && root !== state.observedRoot) bindObserver(root);
    if (state.observedRoot) processCurrentLine();
  }

  function bindObserver(root) {
    if (state.observer) {
      try { state.observer.disconnect(); } catch (_) {}
    }
    state.observedRoot = root;
    state.observer = new MutationObserver(() => {
      if (state.debounceTimer) return;
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        processCurrentLine();
      }, TYPE_DEBOUNCE);
    });
    try {
      state.observer.observe(root, { childList: true, subtree: true, characterData: true });
    } catch (_) {}
  }

  function isRootVisible(root) {
    if (!root) return false;
    try {
      const st = window.getComputedStyle(root);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      if (root.getBoundingClientRect().height === 0) return false;
    } catch (_) {
      return false;
    }
    return true;
  }

  function readLine() {
    const root = state.observedRoot || document.querySelector('.ytp-caption-window-container');
    if (!root) return '';
    // 句子之间的空档：容器还在但被 YouTube 隐藏/高度归零 → 视为没有字幕
    if (!isRootVisible(root)) return '';
    const parts = [];
    root.querySelectorAll('.ytp-caption-segment').forEach((el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
    });
    return parts.join(' ').slice(0, MAX_TEXT);
  }

  function processCurrentLine() {
    if (!state.running) return;

    const text = readLine();
    if (!text) { scheduleClear(); return; }
    if (text === state.lastText) return;

    state.lastText = text;
    if (state.clearTimer) { clearTimeout(state.clearTimer); state.clearTimer = null; }

    const token = ++state.token;

    // ① 原文立刻上屏（0 延迟）
    renderLine(text, '');

    if (shouldSkipTranslation(text)) return;

    const key = state.targetLang + '\u0001' + text;
    if (state.lru.has(key)) {
      renderLine(text, state.lru.get(key));
      return;
    }

    try {
      chrome.runtime.sendMessage(
        { action: 'translate', text: text, targetLang: state.targetLang },
        (res) => {
          if (chrome.runtime.lastError) return;
          if (token !== state.token) return; // 已换句，丢弃
          const dst = res && res.success && res.translation ? String(res.translation).trim() : '';
          if (!dst) return;
          remember(key, dst);
          renderLine(text, dst);
        }
      );
    } catch (_) {}
  }

  function shouldSkipTranslation(text) {
    if (!text) return true;
    // 目标中文而原文基本就是中文 → 不需要翻译
    if (String(state.targetLang).toLowerCase().indexOf('zh') === 0) {
      const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      const latin = (text.match(/[A-Za-z]/g) || []).length;
      if (cjk > 0 && latin < cjk / 4) return true;
    }
    return false;
  }

  function remember(key, value) {
    state.lru.set(key, value);
    while (state.lru.size > LRU_LIMIT) {
      const first = state.lru.keys().next().value;
      state.lru.delete(first);
    }
  }

  function scheduleClear() {
    if (state.clearTimer) return;
    state.clearTimer = setTimeout(() => {
      state.clearTimer = null;
      if (state.lastText === '') return;
      state.lastText = '';
      state.token += 1; // 作废在途请求
      if (state.overlay) state.overlay.hidden = true;
    }, CLEAR_DELAY);
  }

  // ---------- 渲染 ----------

  function ensureOverlay() {
    if (state.overlay && document.body.contains(state.overlay)) return state.overlay;

    const player = document.getElementById('movie_player');
    if (!player) return null;

    const ov = document.createElement('div');
    ov.id = 'lf-yt-subs';
    ov.className = 'lf-yt-subs';
    ov.setAttribute('data-lingoflow', 'true');
    ov.hidden = true;
    ov.innerHTML = '<div class="lf-yt-src"></div><div class="lf-yt-dst"></div>';
    ov.style.setProperty('--lf-yt-font-size', state.fontSize + 'px');
    player.appendChild(ov);

    state.overlay = ov;
    return ov;
  }

  function sameText(a, b) {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return !!a && !!b && norm(a) === norm(b);
  }

  function renderLine(src, dst) {
    const ov = ensureOverlay();
    if (!ov) return;

    const srcEl = ov.querySelector('.lf-yt-src');
    const dstEl = ov.querySelector('.lf-yt-dst');
    if (!srcEl || !dstEl) return;

    state.lastDst = dst || '';
    ov.hidden = false;

    let showSrc = false;
    let showDst = false;

    if (state.displayMode === 'source') {
      // 只看原文（不翻译也照样显示）
      showSrc = !!src;
    } else if (state.displayMode === 'translation') {
      // 只看译文；译文还没回来时先拿原文顶上，避免空白
      if (dst) showDst = true;
      else showSrc = !!src;
    } else {
      // 双语：原文在上、译文在下；两者内容相同时不重复显示
      showSrc = !!src;
      showDst = !!dst && !sameText(src, dst);
    }

    srcEl.textContent = src || '';
    srcEl.hidden = !showSrc;
    dstEl.textContent = dst || '';
    dstEl.hidden = !showDst;

    adjustAvoidOffset();
  }

  function adjustAvoidOffset() {
    const ov = state.overlay;
    if (!ov) return;
    if (state.renderMode !== 'avoid') { ov.style.bottom = ''; return; }

    // 避让模式：原生字幕保持可见，我们只显示译文并坐到它上方
    const root = state.observedRoot;
    const h = root ? Math.round(root.getBoundingClientRect().height) : 0;
    ov.style.bottom = 'calc(11% + ' + (h + 8) + 'px)';
  }

  function applyModeClass() {
    document.documentElement.classList.add('lf-yt-subs-on');
    document.documentElement.setAttribute('data-lf-yt-mode', state.renderMode);
  }

  function removeModeClass() {
    document.documentElement.classList.remove('lf-yt-subs-on');
    document.documentElement.removeAttribute('data-lf-yt-mode');
  }

  function toast(msg) {
    if (!msg) return;
    const player = document.getElementById('movie_player');
    if (!player) return;

    let el = document.getElementById('lf-yt-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lf-yt-toast';
      el.className = 'lf-yt-toast';
      el.setAttribute('data-lingoflow', 'true');
      player.appendChild(el);
    }
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el._lfTimer);
    el._lfTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  // ---------- 事件 ----------

  // SPA 切换视频
  window.addEventListener('yt-navigate-finish', () => {
    if (state.navTimer) clearTimeout(state.navTimer);
    teardown();
    state.navTimer = setTimeout(() => {
      state.navTimer = null;
      loadSettings((s) => {
        applyRuntimeConfig(s);
        if (state.enabled) start();
      });
    }, 400);
  });

  // 设置变更（设置页保存后实时生效，无需刷新页面）
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;

      const prevEnabled = state.enabled;
      const prevMode = state.renderMode;
      const prevFont = state.fontSize;
      const prevDisplay = state.displayMode;
      const prevSource = state.sourceLang;

      loadSettings((s) => {
        applyRuntimeConfig(s);

        if (state.overlay && state.fontSize !== prevFont) {
          state.overlay.style.setProperty('--lf-yt-font-size', state.fontSize + 'px');
        }

        if (state.enabled && !prevEnabled) {
          start();
          return;
        }
        if (!state.enabled && prevEnabled) {
          teardown();
          return;
        }
        if (!state.enabled) return;

        if (state.renderMode !== prevMode) {
          document.documentElement.setAttribute('data-lf-yt-mode', state.renderMode);
        }
        // 显示方式变了：用已缓存的译文重画当前句，无需重新请求
        if (state.displayMode !== prevDisplay && state.lastText) {
          renderLine(state.lastText, state.lastDst);
        }
        // 原文语言偏好变了：重新选轨
        if (state.sourceLang !== prevSource) {
          state.baseFailCount = 0;
          state.noBaseNotified = false;
          state.lastBaseCheckAt = 0;
          askEnsureBaseTrack();
        }
      });
    });
  } catch (_) {}

  // ---------- 启动 ----------

  loadSettings((s) => {
    applyRuntimeConfig(s);
    if (state.enabled && isWatchPage()) start();
  });
})();
