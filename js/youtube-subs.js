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
    // 单飞（single-flight）：同一时刻只允许一个翻译请求在途，期间到来的新文本只记下最新一条，
    // 等回来再发。这样一句话最多 1–2 次请求，不会因为"逐词增长"把请求队列堵死。
    inflight: false,
    pendingText: '',
    doneKey: '',      // 已经拿到译文的文本 key
    firedLen: 0,      // 上次发请求时原文长度（用于抑制"只多几个字母"的重复请求）

    // ===== 混合模式：DOM 负责显示（保证完整句），预取负责提前备好译文（保证不延迟）=====
    lines: [],            // 预取到的整片字幕 [{ start, dur, en, zh, pending, tries }]
    trCache: new Map(),   // 规范化文本 → 译文，命中即 0 延迟
    prefetchReady: false,
    seekHookBound: false,
    cueToken: 0,
    videoId: '',
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
    state.inflight = false;
    state.pendingText = '';
    state.doneKey = '';
    state.firedLen = 0;
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
    startPrefetch(); // 预取整片译文当缓存；失败则纯逐词（显示不受影响）
  }

  function teardown() {
    state.running = false;
    stopPrefetch();
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
    state.inflight = false;
    state.pendingText = '';
    state.doneKey = '';
    state.firedLen = 0;
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

    // YouTube 自动字幕是**逐词增长**的：先出现前半句，再不断追加。
    // 判断这一句是不是上一句的"延长"：不是延长就是新句，重置增长基准。
    const prevText = state.lastText;
    if (!prevText || !text.startsWith(prevText)) {
      state.firedLen = 0;
      state.doneKey = '';
      // 新的一句：先把上一句的中文摘掉，避免"新英文 + 旧中文"张冠李戴
      state.lastDst = '';
    }

    state.lastText = text;
    state.everGotText = true;
    if (state.clearTimer) { clearTimeout(state.clearTimer); state.clearTimer = null; }

    // 原文已是目标语言：双语模式下只保留原文行
    if (!shouldTranslate(text)) {
      state.token += 1;
      state.lastDst = '';
      state.inflight = false;
      state.pendingText = '';
      state.doneKey = '';
      renderLines();
      return;
    }

    // 双语模式：原文随字幕实时增长（0 延迟）；仅译文模式不画原文
    if (state.content === 'dual') renderLines();

    // ① 预取缓存命中 → 中文与英文同一帧出现（这是"实时感"的来源）
    const prefetched = cacheGet(text);
    if (prefetched) {
      state.lastDst = prefetched;
      state.doneKey = state.targetLang + '\u0001' + text;
      renderLines();
      return;
    }

    const key = state.targetLang + '\u0001' + text;
    if (key === state.doneKey) return; // 这段文本已经翻过

    if (state.lru.has(key)) {
      state.doneKey = key;
      state.lastDst = state.lru.get(key);
      renderLines();
      return;
    }

    // 只多了几个字母就先不发，等它长够 / 说完再发，避免无意义的重复请求
    if (!state.inflight && state.firedLen > 0 && text.length - state.firedLen < 6) return;

    // 单飞：已有请求在途 → 只记下最新文本，回来后再发这一条
    if (state.inflight) {
      state.pendingText = text;
      return;
    }

    fireTranslation(text, key);
  }

  // 发一次翻译；回来时若期间文本又长了，用**最新**那条再补发一次（不排队）
  function fireTranslation(text, key) {
    const token = ++state.token;
    state.inflight = true;
    state.firedLen = text.length;

    // 看门狗：万一某次请求迟迟不返回，别把后面整段视频的字幕都卡住
    const watch = setTimeout(() => {
      if (!state.inflight || token !== state.token) return;
      state.inflight = false;
      const next = state.pendingText;
      state.pendingText = '';
      if (next && next !== text) {
        const nextKey = state.targetLang + '\u0001' + next;
        if (nextKey !== state.doneKey) fireTranslation(next, nextKey);
      }
    }, 6000);

    try {
      chrome.runtime.sendMessage(
        { action: 'translate', text: text, targetLang: state.targetLang },
        (res) => {
          clearTimeout(watch);
          state.inflight = false;

          if (!chrome.runtime.lastError && token === state.token) {
            const dst = res && res.success && res.translation ? String(res.translation).trim() : '';
            if (dst) {
              remember(key, dst);
              state.doneKey = key;
              state.lastDst = dst;
              renderLines();
            }
          }

          // 期间文本又增长了 → 补发一次最新文本
          const next = state.pendingText;
          state.pendingText = '';
          if (!next || next === text) return;

          const nextKey = state.targetLang + '\u0001' + next;
          if (state.lru.has(nextKey)) {
            state.doneKey = nextKey;
            state.lastDst = state.lru.get(nextKey);
            renderLines();
            return;
          }
          if (nextKey !== state.doneKey) fireTranslation(next, nextKey);
        }
      );
    } catch (_) {
      state.inflight = false;
    }
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
      state.inflight = false;
      state.pendingText = '';
      state.doneKey = '';
      state.firedLen = 0;
      state.token += 1; // 作废在途请求
      renderLines();
    }, CLEAR_DELAY);
  }

  // ---------- 方案 B：预取整片字幕 ----------

  function sendMsg(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) { cb(null); return; }
        cb(res || null);
      });
    } catch (_) {
      cb(null);
    }
  }

  function getVideoId() {
    try {
      return new URLSearchParams(location.search).get('v') || '';
    } catch (_) {
      return '';
    }
  }

  // 和 ensure-base 用同一套优先级：指定语言（人工→自动）→ 任意非目标语言
  function pickTrack(tracks) {
    const norm = (c) => String(c || '').toLowerCase().split('-')[0];
    const want = state.sourceLang && state.sourceLang !== 'auto' ? norm(state.sourceLang) : 'en';
    const target = norm(state.targetLang);
    const isWant = (t) => norm(t.lang) === want;
    const notTarget = (t) => norm(t.lang) !== target;

    return tracks.find((t) => isWant(t) && t.kind !== 'asr')
      || tracks.find(isWant)
      || tracks.find((t) => notTarget(t) && t.kind !== 'asr')
      || tracks.find(notTarget)
      || null;
  }

  // 把碎片 cue 合并成"一句一行"，避免译文被切碎（时间轴仍然准确）
  function buildLines(cues) {
    const MAX_LEN = 90;
    const MAX_GAP = 0.45;
    const lines = [];

    cues.forEach((c) => {
      const text = String(c.text || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      const start = Number(c.start) || 0;
      const dur = Number(c.dur) || 0;

      const prev = lines[lines.length - 1];
      if (prev) {
        // 自动生成字幕常见"滚动式"输出：同一句会被重复吐出，或逐次变得更长。
        // 先去掉这类重复，否则译文会重复翻译同一段。
        if (text === prev.en || prev.en.endsWith(' ' + text)) return;
        if (text.startsWith(prev.en)) {
          prev.en = text;
          prev.dur = Math.max(prev.dur, start + dur - prev.start);
          return;
        }

        const gap = start - (prev.start + prev.dur);
        const prevDone = /[.!?。！？]["')\]]?$/.test(prev.en);
        if (gap <= MAX_GAP && !prevDone && prev.en.length + text.length <= MAX_LEN) {
          prev.en = (prev.en + ' ' + text).trim();
          prev.dur = Math.max(prev.dur, start + dur - prev.start);
          return;
        }
      }

      lines.push({ start: start, dur: Math.max(0.4, dur), en: text, zh: '', pending: false, tries: 0 });
    });

    // 有些格式不给时长：用"到下一句开始"补齐，避免整句只闪一下
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].dur < 0.6) {
        const next = lines[i + 1];
        lines[i].dur = next ? Math.max(0.6, next.start - lines[i].start) : 2.5;
      }
    }
    return lines;
  }

  function findLineIndex(t) {
    const lines = state.lines;
    if (!lines.length) return -1;
    let lo = 0;
    let hi = lines.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].start <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (ans < 0) return -1;
    const line = lines[ans];
    if (t > line.start + line.dur + 0.25) return -1; // 句与句之间的空档
    return ans;
  }

  function currentVideo() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  // ---- 预取缓存 ----
  // 混合模式的核心：**显示仍然由 DOM 驱动**（保证是 YouTube 自己拼好的完整句），
  // 预取只是提前把译文备好，按"规范化文本"索引，命中就 0 延迟出中文。

  function normalizeText(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[\s\u00a0]+/g, ' ')
      .replace(/[^\p{L}\p{N} ]/gu, '')
      .trim();
  }

  function cacheSet(src, dst) {
    if (!src || !dst) return;
    const key = normalizeText(src);
    if (key.length < 2) return;
    state.trCache.set(key, dst);
    while (state.trCache.size > 4000) {
      state.trCache.delete(state.trCache.keys().next().value);
    }
  }

  function similarText(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const aw = a.split(' ').filter(Boolean);
    const bw = b.split(' ').filter(Boolean);
    if (!aw.length || !bw.length) return false;
    if (aw[0] === bw[0] && aw[aw.length - 1] === bw[bw.length - 1]) return true;
    const setB = new Set(bw);
    const overlap = aw.filter((w) => setB.has(w)).length / Math.max(aw.length, bw.length);
    return overlap >= 0.8;
  }

  // 查缓存：先按文本精确命中（规范化后），再用时间轴上的 cue 做近似匹配，
  // 解决"DOM 文本与 cue 文本标点/断行不完全一致"导致的漏命中。
  function cacheGet(src) {
    const key = normalizeText(src);
    if (!key) return '';

    const hit = state.trCache.get(key);
    if (hit) return hit;

    const v = currentVideo();
    if (!v || !state.lines.length) return '';
    const idx = findLineIndex(v.currentTime);
    if (idx < 0) return '';
    const line = state.lines[idx];
    if (!line.zh) return '';
    return similarText(key, normalizeText(line.en)) ? line.zh : '';
  }

  // 当前播放位置的 cue 若还没翻译 → 立刻单句补一条（跳转时用；一问一答不会错位）
  function prefetchLineAtTime(t) {
    const idx = findLineIndex(t);
    if (idx < 0) return;
    const line = state.lines[idx];
    if (!line || line.zh || line.pending) return;
    if ((line.tries || 0) >= 3) return;
    line.pending = true;
    line.tries = (line.tries || 0) + 1;

    sendMsg({ action: 'translate', text: line.en, targetLang: state.targetLang }, (res) => {
      line.pending = false;
      const dst = res && res.success && res.translation ? String(res.translation).trim() : '';
      if (!dst) return;
      line.zh = dst;
      cacheSet(line.en, dst);
      // 如果屏幕上正好是这句，立刻补上中文
      if (state.lastText && !state.lastDst
        && similarText(normalizeText(state.lastText), normalizeText(line.en))) {
        state.lastDst = dst;
        renderLines();
      }
    });
  }

  function onSeeked() {
    if (!state.prefetchReady) return;
    const v = currentVideo();
    if (!v) return;
    prefetchLineAtTime(v.currentTime);
    // 跳转后 DOM 未必立刻变化，主动催一次取句
    setTimeout(() => { if (state.running) processCurrentLine(); }, 60);
  }

  function attachSeekHook() {
    if (state.seekHookBound) return;
    const v = currentVideo();
    if (!v) return;
    state.seekHookBound = true;
    try { v.addEventListener('seeked', onSeeked); } catch (_) {}
  }

  function detachSeekHook() {
    const v = currentVideo();
    if (v) { try { v.removeEventListener('seeked', onSeeked); } catch (_) {} }
    state.seekHookBound = false;
  }

  // 边播边批量翻，只用来填缓存（不驱动显示）；优先当前进度往后
  function translateLines() {
    const token = ++state.cueToken;
    const CHUNK = 20;
    let rounds = 0;

    const nextBatch = () => {
      if (!state.prefetchReady || token !== state.cueToken) return;
      if (++rounds > 300) return;

      const v = currentVideo();
      const from = v ? Math.max(0, findLineIndex(v.currentTime)) : 0;

      const targets = [];
      const collect = (startIdx, endIdx) => {
        for (let i = startIdx; i < endIdx && targets.length < CHUNK; i++) {
          const l = state.lines[i];
          if (!l.zh && !l.pending && (l.tries || 0) < 2) targets.push(l);
        }
      };
      collect(from, state.lines.length);
      if (!targets.length) collect(0, from);
      if (!targets.length) return;

      targets.forEach((l) => { l.pending = true; });

      sendMsg(
        { action: 'translate_batch', texts: targets.map((l) => l.en), targetLang: state.targetLang },
        (res) => {
          if (!state.prefetchReady || token !== state.cueToken) return;
          const list = res && res.success && Array.isArray(res.translations) ? res.translations : null;

          if (!list || list.length !== targets.length) {
            // 条数对不上 → 绝不能按下标硬套（会把别句译文贴过来），整批放弃
            targets.forEach((l) => { l.pending = false; l.tries = (l.tries || 0) + 1; });
            console.warn('LingoFlow: batch size mismatch (' + (list ? list.length : 'null') + '/' + targets.length + '), prefetch skipped');
            return;
          }

          let filled = 0;
          targets.forEach((l, i) => {
            l.pending = false;
            const t = list[i] ? String(list[i]).trim() : '';
            if (t) { l.zh = t; cacheSet(l.en, t); filled += 1; } else { l.tries = (l.tries || 0) + 1; }
          });

          // 当前屏幕这句刚好被补上 → 立刻显示
          if (filled && state.lastText && !state.lastDst) {
            const cached = cacheGet(state.lastText);
            if (cached) { state.lastDst = cached; renderLines(); }
          }
          if (!filled) return;
          setTimeout(nextBatch, 80);
        }
      );
    };

    nextBatch();
  }

  function stopPrefetch() {
    state.cueToken += 1;
    state.prefetchReady = false;
    state.lines = [];
    state.trCache.clear();
    detachSeekHook();
  }

  // 启动预取；任何一步失败都静默退回"纯逐词"模式（显示不受影响）
  function startPrefetch() {
    sendMsg({ action: 'lf_yt_tracklist' }, (res) => {
      if (!state.running) return;
      if (!res || !res.ok || !res.tracks || !res.tracks.length) {
        console.log('[LingoFlow] prefetch: no tracklist, using live translation');
        return;
      }

      const track = pickTrack(res.tracks);
      if (!track || !track.url) {
        console.log('[LingoFlow] prefetch: no usable base track');
        return;
      }

      state.videoId = res.videoId || getVideoId();

      sendMsg({ action: 'lf_yt_timedtext', url: track.url }, (r) => {
        if (!state.running) return;
        if (!r || !r.ok || !r.cues || !r.cues.length) {
          console.log('[LingoFlow] prefetch: timedtext unavailable, using live translation');
          return;
        }

        const lines = buildLines(r.cues);
        if (lines.length < 5) {
          console.log('[LingoFlow] prefetch: too few cues, using live translation');
          return;
        }

        state.lines = lines;
        state.prefetchReady = true;
        attachSeekHook();
        translateLines();
        console.log('[LingoFlow] prefetch ready:', lines.length, 'lines, track:', track.lang, track.kind || 'manual');
      });
    });
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
          // 换了原文语言 → 预取缓存要重建（显示仍是 DOM，不受影响）
          if (state.prefetchReady) {
            stopPrefetch();
            startPrefetch();
          }
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
