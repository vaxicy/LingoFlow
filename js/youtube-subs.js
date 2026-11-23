// LingoFlow · YouTube 字幕翻译（接管式双语字幕）
//
// 设计要点（为什么这样写）：
// 1) **接管式 + 固定锚点**：把 YouTube 原生字幕层设为 opacity:0（它仍继续更新，作为数据源），
//    我们自己在固定的 bottom 上画「原文 + 译文」两行。
//    —— 不测量任何原生元素的位置，所以字幕不会随原生块换行/重排而上下乱窜。
// 2) 绝不修改 .ytp-caption-segment：只读文本，YouTube 会重写这些节点。
// 3) 双语模式原文立即上屏（读 DOM，0 延迟），译文到达后补第二行；
//    仅译文模式**绝不画英文**（译文未到则保持上一句）。
// 4) token 校验：译文回来时若已换句则丢弃，避免串句。
// 5) 兜底：若播放中连续 10s 读不到字幕（隐藏后不再更新），自动恢复原生字幕并提示一次。
// 6) SPA 适配：yt-navigate-finish 后整体重建。

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
  const NO_TEXT_WARN_MS = 30000; // 纯诊断用：播放 30s 仍没读到任何字幕 → 只打日志

  const CONTENTS = ['dual', 'translation', 'off'];
  const OFFSETS = ['low', 'mid', 'high'];

  const state = {
    settings: null,
    enabled: false,
    content: 'dual',           // dual（双语）| translation（仅译文）| off
    offset: 'mid',             // low | mid | high
    style: 'classic',          // classic | box（「跟随 YouTube」「极简」因看不清已移除）
    fontSize: 22,
    sourceLang: 'auto',
    targetLang: 'zh',
    uiLang: 'zh',

    noBaseNotified: false,
    baseFailCount: 0,
    lastBaseCheckAt: 0,

    // 注意：**不要**因为"一段时间读不到字幕"就判定接管失效并恢复原生字幕。
    // 教学视频经常几十秒只有画面没有旁白，那是正常情况，误判会让整个视频失去翻译。
    everGotText: false,
    noTextWarned: false,
    startAt: 0,

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

  // 历史设置迁移：mode / displayMode / renderMode / ytSubsDual → content
  function migrateContent(s) {
    const saved = s && s.ytSubsContent;
    if (CONTENTS.indexOf(saved) >= 0) return saved;

    const mode = s && s.ytSubsMode;
    if (mode === 'translation') return 'translation';
    if (mode === 'off') return 'off';
    if (mode === 'merged') return 'dual';

    const disp = (s && s.ytSubsDisplayMode)
      || ((s && s.ytSubsDual === false) ? 'translation' : 'dual');
    if (disp === 'translation') return 'translation';
    if (disp === 'source') return 'off';
    return 'dual';
  }

  function migrateOffset(s) {
    const saved = s && s.ytSubsOffset;
    if (OFFSETS.indexOf(saved) >= 0) return saved;
    // 旧「译文位置 上/下」→ 高/中
    if (s && s.ytSubsTranslationPos === 'above') return 'high';
    return 'mid';
  }

  function applyRuntimeConfig(s) {
    state.settings = s || {};

    state.content = migrateContent(state.settings);
    state.enabled = state.settings.ytSubsEnabled === true && state.content !== 'off';
    state.offset = migrateOffset(state.settings);

    // 已移除「跟随 YouTube」（镜像来的 text-shadow 常为 none）与「极简」（无描边 → 白字压浅色
    // 画面等于隐形）。旧值 native / minimal / 未知值一律回落到 classic（白字 + 黑描边，任何画面都清晰）。
    const style = state.settings.ytSubsStyle;
    state.style = style === 'box' ? 'box' : 'classic';

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
    state.everGotText = false;
    state.noTextWarned = false;
    state.startAt = Date.now();

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

  // 用户可能把 YouTube 字幕切成了「中文（翻译）」轨 → 原文已是中文。
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

          // 完全没有字幕轨：**不提示**。
          // tracklist 为空不等于没有字幕（播放器 API 未就绪、字幕走别的链路都可能返回空），
          // 而这时屏幕上往往已经在正常显示双语字幕了 —— 弹"没有可用字幕"会自相矛盾。
          // 真正没有字幕的视频用户自己看得出来，不需要打扰。
          if (res.reason === 'no tracks') return;

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

    // 纯诊断：播放 30s 仍没读到任何字幕时打一条日志。
    // **不做**任何自动降级 —— 教学视频常有几十秒只有画面没有旁白，
    // 用"多久没新字幕"当失败信号会误判（曾导致整个视频失去翻译）。
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    const playing = video && !video.paused && !video.ended;
    if (!state.everGotText && playing && !state.noTextWarned
      && now - (state.startAt || now) > NO_TEXT_WARN_MS) {
      state.noTextWarned = true;
      console.log('[LingoFlow] no caption text after ' + (NO_TEXT_WARN_MS / 1000) +
        's — the video may have no captions, or is silent for a long stretch');
    }
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

    // 新的一句（上一行已以句末标点结束）→ 先清掉上一句的中文。
    // 否则屏幕上是「新英文 + 旧中文」，读起来就是"这句没翻/错配"。
    // 只对双语模式做：仅译文模式本来就不画英文，清空会变成整块空白。
    const prevLine = state.lastText;
    const isContinuation = !!prevLine && !/[.!?。！？]["')\]]?\s*$/.test(prevLine);
    if (!isContinuation && state.content === 'dual') state.lastDst = '';

    state.lastText = text;
    state.everGotText = true;
    if (state.clearTimer) { clearTimeout(state.clearTimer); state.clearTimer = null; }

    // 原文已是目标语言：双语模式下只保留原文行
    if (!shouldTranslate(text)) {
      state.token += 1;
      state.lastDst = '';
      renderLines();
      return;
    }

    const key = state.targetLang + '\u0001' + text;
    const token = ++state.token;

    // 双语模式：原文立即可见（0 延迟）；仅译文模式不画原文（保持上一句译文）
    if (state.content === 'dual') renderLines();

    if (state.lru.has(key)) {
      state.lastDst = state.lru.get(key);
      renderLines();
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
          state.lastDst = dst;
          renderLines();
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
      if (state.lastText === '' && state.lastDst === '') return;
      state.lastText = '';
      state.lastDst = '';
      state.token += 1; // 作废在途请求
      renderLines();
    }, CLEAR_DELAY);
  }

  // ---------- 渲染 ----------

  function ensureOverlay() {
    if (state.overlay && document.body.contains(state.overlay)) return state.overlay;

    const player = document.getElementById('movie_player');
    if (!player) return null;

    // 绝对定位依赖播放器作为定位祖先；个别皮肤是 static → 兜底补上
    try {
      if (window.getComputedStyle(player).position === 'static') {
        player.style.position = 'relative';
      }
    } catch (_) {}

    const ov = document.createElement('div');
    ov.id = 'lf-yt-subs';
    ov.className = 'lf-yt-subs';
    ov.setAttribute('data-lingoflow', 'true');
    ov.setAttribute('data-lf-offset', state.offset);
    ov.hidden = true;
    ov.innerHTML = '<div class="lf-yt-src"></div><div class="lf-yt-dst"></div>';
    player.appendChild(ov);

    state.overlay = ov;
    return ov;
  }

  function renderLines() {
    const ov = ensureOverlay();
    if (!ov) return;

    const srcEl = ov.querySelector('.lf-yt-src');
    const dstEl = ov.querySelector('.lf-yt-dst');
    if (!srcEl || !dstEl) return;

    ov.setAttribute('data-lf-offset', state.offset);

    // 双语显示原文；仅译文绝不画原文
    const showSrc = state.content === 'dual' && !!state.lastText;
    const showDst = !!state.lastDst;

    srcEl.textContent = showSrc ? state.lastText : '';
    srcEl.hidden = !showSrc;
    dstEl.textContent = showDst ? state.lastDst : '';
    dstEl.hidden = !showDst;

    ov.hidden = !(showSrc || showDst);
    if (!ov.hidden) applyStyle();
  }

  function hideOverlay() {
    if (state.overlay) state.overlay.hidden = true;
  }

  function applyStyle() {
    const ov = state.overlay;
    if (!ov) return;

    ov.setAttribute('data-lf-style', state.style);
    ov.style.setProperty('--lf-yt-font-size', state.fontSize + 'px');
  }

  function applyModeClass() {
    // 接管式：隐藏原生字幕（它仍在 DOM 里更新，作为我们的数据源）
    if (state.content !== 'off') {
      document.documentElement.classList.add('lf-yt-subs-on');
    } else {
      document.documentElement.classList.remove('lf-yt-subs-on');
    }
  }

  function removeModeClass() {
    document.documentElement.classList.remove('lf-yt-subs-on');
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
        content: state.content,
        offset: state.offset,
        style: state.style,
        fontSize: state.fontSize,
        sourceLang: state.sourceLang
      };

      loadSettings((s) => {
        applyRuntimeConfig(s);

        if (state.enabled && !prev.enabled) {
          start();
          return;
        }
        if (!state.enabled && prev.enabled) { teardown(); return; }
        if (!state.enabled) return;

        if (state.content !== prev.content) {
          applyModeClass();
          renderLines();
        }
        if (state.offset !== prev.offset || state.style !== prev.style || state.fontSize !== prev.fontSize) {
          applyStyle();
          renderLines();
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
