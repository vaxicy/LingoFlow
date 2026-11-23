// LingoFlow · YouTube 字幕翻译（合并式双语字幕）
//
// 设计要点（为什么这样写）：
// 1) **合并式**：YouTube 原生字幕保持可见、原样显示，作为「原文行」；
//    我们只在它正下方（或正上方）渲染一行译文，并镜像原生样式（字体/字号/描边/背景），
//    视觉上是一个整体的双语字幕块 —— 不再隐藏原生、也不自己复刻原文。
// 2) 绝不修改 .ytp-caption-segment：YouTube 会重写这些节点，只读文本。
// 3) 译文未到时**保持上一句**，不显示原文、不闪、不空（仅译文模式同理）。
// 4) token 校验：译文回来时若已换句则丢弃，避免串句。
// 5) 位置每句重新测量（原生字幕换行会变高），下方空间不足时自动翻到上方。
// 6) SPA 适配：yt-navigate-finish 后整体重建。
//
// 「仅译文」模式内部复用同一套渲染，只是隐藏原生字幕、允许自定义样式与字号。

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
  const GAP = 4;                // 译文与原生字幕块的间距

  const MODES = ['merged', 'translation', 'off'];

  const state = {
    settings: null,
    enabled: false,
    mode: 'merged',            // merged（合并双语）| translation（仅译文）| off
    pos: 'below',              // below（原生下方）| above（原生上方）
    style: 'native',           // native | classic | box | minimal（仅 translation 模式生效）
    fontSize: 22,
    sourceLang: 'auto',
    targetLang: 'zh',
    uiLang: 'zh',

    noBaseNotified: false,
    baseFailCount: 0,
    lastBaseCheckAt: 0,

    running: false,
    observer: null,
    observedRoot: null,
    pollTimer: null,
    debounceTimer: null,
    clearTimer: null,
    token: 0,
    lastText: '',
    lastDst: '',
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

  // 历史设置迁移：layout / displayMode / renderMode / ytSubsDual → mode
  function migrateMode(s) {
    const saved = s && s.ytSubsMode;
    if (MODES.indexOf(saved) >= 0) return saved;

    const layout = s && s.ytSubsLayout;
    if (layout === 'takeover-translation') return 'translation';
    if (layout === 'takeover-source') return 'off';
    if (layout === 'takeover-dual' || layout === 'avoid') return 'merged';

    const disp = (s && s.ytSubsDisplayMode)
      || ((s && s.ytSubsDual === false) ? 'translation' : 'dual');
    if (disp === 'translation') return 'translation';
    if (disp === 'source') return 'off';
    return 'merged';
  }

  function applyRuntimeConfig(s) {
    state.settings = s || {};

    state.mode = migrateMode(state.settings);
    state.enabled = state.settings.ytSubsEnabled === true && state.mode !== 'off';
    state.pos = state.settings.ytSubsTranslationPos === 'above' ? 'above' : 'below';

    const style = state.settings.ytSubsStyle;
    // 合并模式下必须镜像原生样式，否则两行字体/字号对不上
    state.style = (state.mode === 'merged')
      ? 'native'
      : ((style === 'classic' || style === 'box' || style === 'minimal') ? style : 'native');

    state.fontSize = Number(state.settings.ytSubsFontSize) || 22;
    state.sourceLang = state.settings.ytSubsSourceLang || 'auto';
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
    warmUpServiceWorker();
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

  // MV3 service worker 会休眠，首条消息多 100–300ms；提前 ping 一下
  function warmUpServiceWorker() {
    try {
      chrome.runtime.sendMessage({ action: 'lf_ping' }, () => { void chrome.runtime.lastError; });
    } catch (_) {}
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

  // 用户可能把 YouTube 字幕切成了「中文（翻译）」轨 → 我们拿到的原文已是中文。
  // 请求 background 在主世界用 player API 切回原语言轨（失败不影响主流程）。
  function askEnsureBaseTrack() {
    if (state.baseFailCount >= 3) return;
    try {
      chrome.runtime.sendMessage(
        { action: 'lf_yt_ensure_base', targetLang: state.targetLang, sourceLang: state.sourceLang },
        (res) => {
          if (chrome.runtime.lastError || !res) return;

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

    // 原生字幕块的高度/位置会随换行变化 → 跟随重定位
    if (state.overlay && !state.overlay.hidden) positionOverlay();
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
    if (!isRootVisible(root)) return '';

    const parts = [];
    root.querySelectorAll('.ytp-caption-segment').forEach((el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
    });
    return parts.join(' ').slice(0, MAX_TEXT);
  }

  function shouldTranslate(text) {
    if (!text) return false;
    // 目标中文而原文基本就是中文 → 不需要翻译
    if (String(state.targetLang).toLowerCase().indexOf('zh') === 0) {
      const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      const latin = (text.match(/[A-Za-z]/g) || []).length;
      if (cjk > 0 && latin < cjk / 4) return false;
    }
    return true;
  }

  function processCurrentLine() {
    if (!state.running) return;

    const text = readLine();
    if (!text) { scheduleClear(); return; }
    if (text === state.lastText) return;

    state.lastText = text;
    if (state.clearTimer) { clearTimeout(state.clearTimer); state.clearTimer = null; }

    if (!shouldTranslate(text)) {
      // 原文已是目标语言：合并模式保留原生字幕即可，我们这层不需要
      state.token += 1;
      hideOverlay();
      return;
    }

    const key = state.targetLang + '\u0001' + text;
    const token = ++state.token;

    if (state.lru.has(key)) {
      showTranslation(state.lru.get(key));
      return;
    }

    // 译文未到：**保持上一句**（不清空、不显示原文）。
    // 第一句时 overlay 还是隐藏的，等译文到达再出现。
    try {
      chrome.runtime.sendMessage(
        { action: 'translate', text: text, targetLang: state.targetLang },
        (res) => {
          if (chrome.runtime.lastError) return;
          if (token !== state.token) return; // 已换句，丢弃
          const dst = res && res.success && res.translation ? String(res.translation).trim() : '';
          if (!dst) return;
          remember(key, dst);
          showTranslation(dst);
        }
      );
    } catch (_) {}
  }

  function remember(key, value) {
    state.lru.set(key, value);
    while (state.lru.size > LRU_LIMIT) {
      state.lru.delete(state.lru.keys().next().value);
    }
  }

  function scheduleClear() {
    if (state.clearTimer) return;
    state.clearTimer = setTimeout(() => {
      state.clearTimer = null;
      if (state.lastText === '') return;
      state.lastText = '';
      state.token += 1; // 作废在途请求
      hideOverlay();
    }, CLEAR_DELAY);
  }

  // ---------- 渲染 ----------

  function ensureOverlay() {
    if (state.overlay && document.body.contains(state.overlay)) return state.overlay;

    const player = document.getElementById('movie_player');
    if (!player) return null;

    // 我们的层是 absolute 定位，依赖播放器作为定位祖先。
    // YouTube 正常都是 relative，个别皮肤可能是 static → 兜底补上，避免飘到页面别处。
    try {
      if (window.getComputedStyle(player).position === 'static') {
        player.style.position = 'relative';
      }
    } catch (_) {}

    const ov = document.createElement('div');
    ov.id = 'lf-yt-subs';
    ov.className = 'lf-yt-subs';
    ov.setAttribute('data-lingoflow', 'true');
    ov.hidden = true;
    player.appendChild(ov);

    state.overlay = ov;
    return ov;
  }

  function showTranslation(dst) {
    if (!dst) return;
    state.lastDst = dst;

    const ov = ensureOverlay();
    if (!ov) return;

    ov.textContent = dst;
    ov.hidden = false;
    applyStyle();
    positionOverlay();
  }

  function hideOverlay() {
    if (state.overlay) state.overlay.hidden = true;
  }

  function applyStyle() {
    const ov = state.overlay;
    if (!ov) return;

    ov.setAttribute('data-lf-style', state.style);
    // 清掉上一轮 native 镜像写入的变量，避免切模式后残留
    ['--lf-yt-native-font', '--lf-yt-native-size', '--lf-yt-native-weight',
      '--lf-yt-native-color', '--lf-yt-native-shadow', '--lf-yt-native-bg',
      '--lf-yt-native-pad', '--lf-yt-native-radius'
    ].forEach(v => ov.style.removeProperty(v));

    if (state.style === 'native') {
      mirrorNativeStyle();
    } else {
      ov.style.setProperty('--lf-yt-font-size', state.fontSize + 'px');
    }
  }

  // 把原生字幕的计算样式搬过来 → 两行看起来是同一套排版
  function mirrorNativeStyle() {
    const ov = state.overlay;
    const seg = document.querySelector('.ytp-caption-segment');
    if (!ov || !seg) return;

    const cs = window.getComputedStyle(seg);
    ov.style.setProperty('--lf-yt-native-font', cs.fontFamily);
    ov.style.setProperty('--lf-yt-native-size', cs.fontSize);
    ov.style.setProperty('--lf-yt-native-weight', cs.fontWeight);
    ov.style.setProperty('--lf-yt-native-color', cs.color);
    if (cs.textShadow && cs.textShadow !== 'none') {
      ov.style.setProperty('--lf-yt-native-shadow', cs.textShadow);
    }

    const win = document.querySelector('.caption-window') || seg.parentElement;
    if (win) {
      const cw = window.getComputedStyle(win);
      const bg = cw.backgroundColor || '';
      const transparent = !bg || bg === 'transparent' || /rgba\(0,\s*0,\s*0,\s*0\)/.test(bg);
      if (!transparent) {
        ov.style.setProperty('--lf-yt-native-bg', bg);
        ov.style.setProperty('--lf-yt-native-pad', cw.padding);
        ov.style.setProperty('--lf-yt-native-radius', cw.borderRadius);
      }
    }
  }

  // 位置：合并模式下贴住原生字幕块；仅译文模式固定在底部
  function positionOverlay() {
    const ov = state.overlay;
    const player = document.getElementById('movie_player');
    if (!ov || !player) return;

    ov.style.top = '';
    ov.style.bottom = '';
    ov.style.maxWidth = '';

    if (state.mode !== 'merged') {
      ov.style.bottom = '8%';
      return;
    }

    const win = document.querySelector('.caption-window');
    if (!win) {
      ov.style.bottom = '8%';
      return;
    }

    const pr = player.getBoundingClientRect();
    const wr = win.getBoundingClientRect();
    if (!wr.height) { ov.style.bottom = '8%'; return; }

    // 与原生块同宽，换行方式才一致，视觉上才像一块
    const width = Math.round(wr.width);
    if (width > 120) ov.style.maxWidth = width + 'px';

    const aboveBottom = Math.round(pr.bottom - wr.top + GAP);

    if (state.pos === 'above') {
      ov.style.bottom = aboveBottom + 'px';
      return;
    }

    ov.style.top = Math.round(wr.bottom - pr.top + GAP) + 'px';

    // 下方空间不足（贴近控制条/画面底部）→ 自动翻到上方，避免被裁掉
    const oh = ov.getBoundingClientRect().height || 0;
    if (wr.bottom + GAP + oh > pr.bottom - 6) {
      ov.style.top = '';
      ov.style.bottom = aboveBottom + 'px';
    }
  }

  function applyModeClass() {
    // 只有「仅译文」才隐藏原生字幕；合并模式原生必须可见
    if (state.mode === 'translation') {
      document.documentElement.classList.add('lf-yt-subs-on');
    } else {
      document.documentElement.classList.remove('lf-yt-subs-on');
    }
    document.documentElement.setAttribute('data-lf-yt-mode', state.mode);
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

      const prev = {
        enabled: state.enabled,
        mode: state.mode,
        pos: state.pos,
        style: state.style,
        fontSize: state.fontSize,
        sourceLang: state.sourceLang
      };

      loadSettings((s) => {
        applyRuntimeConfig(s);

        if (state.enabled && !prev.enabled) { start(); return; }
        if (!state.enabled && prev.enabled) { teardown(); return; }
        if (!state.enabled) return;

        if (state.mode !== prev.mode) {
          applyModeClass();
          // 切到仅译文时要立刻把原生字幕藏起来；切回合并要恢复
        }
        if (state.pos !== prev.pos || state.mode !== prev.mode) {
          if (state.lastDst) positionOverlay();
        }
        if (state.style !== prev.style || state.fontSize !== prev.fontSize) {
          if (state.lastDst) { applyStyle(); positionOverlay(); }
        }
        if (state.sourceLang !== prev.sourceLang) {
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
