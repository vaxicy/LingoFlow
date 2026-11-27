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

    // ===== 预翻译（整片预取）=====
    // preload: 'on' 表示允许预翻译；pipeline: 'prefetch' 表示已切到"时间轴驱动"渲染。
    // 任何一步失败都保持 pipeline='live'（逐词读 DOM），功能不会因此而不可用。
    preload: 'on',
    pipeline: 'live',
    segments: [],        // [{ start, end, en, zh, pending, tries }]
    zhByText: new Map(), // 规范化文本 → 译文：同一句话出现多次只翻一次
    segTimer: null,
    segToken: 0,
    lastSegIndex: -1,
    videoKey: '',
    cacheTimer: null,

    noBaseNotified: false,
    baseFailCount: 0,
    lastBaseCheckAt: 0,
    revealTimer: null,

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
    // 预翻译（整片预取）：默认开；关掉则退回实时逐词
    state.preload = state.settings.ytSubsPreload === 'off' ? 'off' : 'on';

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
    startPrefetch(); // 预翻译：成功则切到"时间轴驱动"，失败就继续用逐词模式

    // 看门狗：3s 内我们还一句都画不出来，就把原生字幕还回去。
    // 否则一旦读不到文字（切轨/皮肤差异/接口变化），屏幕上就是"一个字都没有"。
    setTimeout(() => {
      if (!state.running) return;
      if (!state.overlay || state.overlay.hidden) {
        document.documentElement.classList.remove('lf-yt-subs-on');
        console.log('[LingoFlow] no subtitle rendered in 3s, native captions restored');
      }
    }, 3000);
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

          // 切轨成功也不弹提示（用户明确不想要）：切轨是内部行为，屏幕上有没有字幕
          // 本身就是最好的反馈。
          if (res.ok) {
            state.baseFailCount = 0;
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

    // 只在本页启动时选一次轨。
    // 之前每 15s 复查并纠正会反复切轨：切轨瞬间 YouTube 会清空字幕容器，
    // 表现为"字幕突然全没了"，而且每次切换都会弹提示 —— 得不偿失。

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
    if (state.pipeline === 'prefetch') return; // 已切到时间轴驱动，不再逐词读 DOM

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
          patchUntranslated(text, key); // 有英文残留就局部补翻
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

  // ---------- 漏词补翻 ----------
  // 模型偶尔会把短语原样保留（例如 "You have until early summer" →
  // "您有直到 early summer 的时间"）。这里把残留的英文片段单独翻一次再替换回去，
  // 只处理"原文里确实存在、且不是人名/缩写/术语"的片段，避免误伤 WiFi / API / Mr 等。
  const LATIN_RUN_RE = /[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*)*/g;

  function findUntranslatedRuns(dst, src) {
    if (!/^zh/i.test(state.targetLang)) return [];
    if (!/[A-Za-z]{2,}/.test(dst)) return [];

    const srcText = String(src || '');
    const srcLower = srcText.toLowerCase();
    const picked = [];

    (String(dst).match(LATIN_RUN_RE) || []).forEach((raw) => {
      const run = raw.trim();
      if (!run) return;
      if (/[A-Z]/.test(run.slice(1))) return;            // WiFi / iPhone：保留
      if (/^[A-Z]{2,}$/.test(run)) return;               // API / HD：保留
      const words = run.split(/\s+/);
      if (words.length < 2 && run.length < 4) return;    // 单个短词多半是术语
      if (srcLower.indexOf(run.toLowerCase()) < 0) return; // 原文没出现 → 不是漏词

      const re = new RegExp('\\b' + run.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      const hit = srcText.match(re);
      // 单个词且源文里首字母大写 → 人名/专名，保留；多词片段（哪怕句首大写）照常补翻
      if (hit && words.length === 1 && /^[A-Z]/.test(hit[0])) return;

      if (picked.indexOf(run) < 0) picked.push(run);
    });

    return picked;
  }

  function patchUntranslated(srcText, key) {
    const runs = findUntranslatedRuns(state.lastDst, srcText);
    if (!runs.length) return;

    runs.forEach((run) => {
      try {
        chrome.runtime.sendMessage(
          { action: 'translate', text: run, targetLang: state.targetLang },
          (res) => {
            if (chrome.runtime.lastError) return;
            const piece = res && res.success && res.translation ? String(res.translation).trim() : '';
            if (!piece || /^[A-Za-z\s]+$/.test(piece)) return;   // 还是英文就不替换
            if (!state.lastDst || state.lastDst.indexOf(run) < 0) return;

            state.lastDst = state.lastDst.split(run).join(piece);
            if (state.lru.has(key)) state.lru.set(key, state.lastDst);
            renderLines();
          }
        );
      } catch (_) {}
    });
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

  // ---------- 预翻译（整片预取 + 时间轴驱动） ----------
  // 目标：开播前把后面几十句翻好，播放时按 currentTime 查表 →
  // 倍速、拖动、暂停都不会出现"中文后到/消失"。

  function sendMsg(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) { cb(null); return; }
        cb(res || null);
      });
    } catch (_) { cb(null); }
  }

  function getVideoId() {
    try { return new URLSearchParams(location.search).get('v') || ''; } catch (_) { return ''; }
  }

  function currentVideo() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  // 与 ensure-base 同样的优先级：指定语言（人工→自动）→ 任意非目标语言
  function pickTrack(tracks) {
    const base = (c) => String(c || '').toLowerCase().split('-')[0];
    const want = (state.sourceLang && state.sourceLang !== 'auto') ? base(state.sourceLang) : 'en';
    const target = base(state.targetLang);
    const isWant = (t) => base(t.lang) === want;
    const notTarget = (t) => base(t.lang) !== target;
    return tracks.find((t) => isWant(t) && t.kind !== 'asr')
      || tracks.find(isWant)
      || tracks.find((t) => notTarget(t) && t.kind !== 'asr')
      || tracks.find(notTarget)
      || null;
  }

  const SEG_GAP = 0.45;   // 相邻 cue 间隔小于它才合并
  // 「一句一段」的三个封口条件（满足任一就断段）：
  //   ① 出现句末标点 ② 字符数达到上限 ③ 这段已经持续太久
  // 之所以不能只靠标点：ASR 经常整段没有标点，会一路粘到 90 字符，
  // 一次切换显示两三句，看起来就像"跳"。
  const SEG_MAX = 60;
  const SEG_MAX_SEC = 5;

  // 把碎片的 cue 合并成"一句一段"，并去掉滚动式字幕的重复
  function buildSegments(cues) {
    const segs = [];
    cues.forEach((c) => {
      const text = String(c.text || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      const start = Number(c.start) || 0;
      const dur = Number(c.dur) || 0;

      const prev = segs[segs.length - 1];
      if (prev) {
        if (text === prev.en || prev.en.endsWith(' ' + text)) return;
        if (text.startsWith(prev.en)) {
          prev.en = text;
          prev.end = Math.max(prev.end, start + dur);
          return;
        }

        const gap = start - prev.end;
        const prevDone = /[.!?。！？]["')\]]?$/.test(prev.en);
        const tooLong = prev.en.length + text.length > SEG_MAX;
        const tooSlow = (start + dur - prev.start) > SEG_MAX_SEC;

        if (gap <= SEG_GAP && !prevDone && !tooLong && !tooSlow) {
          prev.en = (prev.en + ' ' + text).trim();
          prev.end = Math.max(prev.end, start + dur);
          return;
        }
      }
      segs.push({ start: start, end: Math.max(start + 0.4, start + dur), en: text, zh: '', pending: false, tries: 0 });
    });

    // 时长缺失时用"到下一段开始"补齐，避免整段只闪一下
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].end - segs[i].start < 0.6) {
        const next = segs[i + 1];
        segs[i].end = next ? Math.max(segs[i].start + 0.6, next.start) : segs[i].start + 2.5;
      }
    }
    return segs;
  }

  function normSegText(s) {
    return String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
  }

  function rememberSegZh(text, zh) {
    if (!zh) return;
    const key = normSegText(text);
    if (key.length >= 2) state.zhByText.set(key, zh);
  }

  // 同一句话（重复出现的 cue / 重播）直接复用已有译文，避免重复请求
  function applyKnownZh(segs) {
    segs.forEach((s) => {
      if (s.zh) return;
      const hit = state.zhByText.get(normSegText(s.en));
      if (hit) s.zh = hit;
    });
  }

  function findSegIndex(t) {
    const segs = state.segments;
    if (!segs.length) return -1;
    let lo = 0;
    let hi = segs.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (ans < 0) return -1;
    if (t > segs[ans].end + 0.25) return -1; // 段与段之间的空档
    return ans;
  }

  // ---- 会话缓存：同一视频重看不必再翻 ----
  const CACHE_KEY = 'lf_yt_segs_v1';
  const CACHE_LIMIT = 4;

  function loadCache(key, cb) {
    try {
      if (!chrome.storage || !chrome.storage.session) { cb(null); return; }
      chrome.storage.session.get([CACHE_KEY], (res) => {
        const all = (res && res[CACHE_KEY]) || {};
        const hit = all[key];
        if (hit && Array.isArray(hit.segs) && hit.segs.length) { cb(hit.segs); return; }
        cb(null);
      });
    } catch (_) { cb(null); }
  }

  function saveCache() {
    if (!state.videoKey || !state.segments.length) return;
    if (state.cacheTimer) return;
    state.cacheTimer = setTimeout(() => {
      state.cacheTimer = null;
      try {
        if (!chrome.storage || !chrome.storage.session) return;
        chrome.storage.session.get([CACHE_KEY], (res) => {
          const all = (res && res[CACHE_KEY]) || {};
          all[state.videoKey] = { at: Date.now(), segs: state.segments.map((s) => ({ s: s.start, e: s.end, en: s.en, zh: s.zh || '' })) };
          const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
          keys.slice(CACHE_LIMIT).forEach((k) => { delete all[k]; });
          try { chrome.storage.session.set({ [CACHE_KEY]: all }); } catch (_) {}
        });
      } catch (_) {}
    }, 1500);
  }

  function segTick() {
    if (state.pipeline !== 'prefetch') return;
    const v = currentVideo();
    if (!v) return;

    const idx = findSegIndex(v.currentTime);
    if (idx < 0) {
      state.lastSegIndex = -1;
      state.lastText = '';
      state.lastDst = '';
      renderLines();
      return;
    }

    const seg = state.segments[idx];
    const changed = idx !== state.lastSegIndex;
    state.lastSegIndex = idx;

    if (changed || state.lastText !== seg.en || state.lastDst !== (seg.zh || '')) {
      state.lastText = seg.en;
      state.lastDst = seg.zh || '';
      renderLines();
    }

    if (!seg.zh) ensureSeg(seg);
  }

  // 当前段还没译文 → 立刻单条翻（一问一答，不会错位）
  function ensureSeg(seg) {
    if (!seg || seg.zh || seg.pending) return;
    if ((seg.tries || 0) >= 3) return;
    seg.pending = true;
    seg.tries = (seg.tries || 0) + 1;
    sendMsg({ action: 'translate', text: seg.en, targetLang: state.targetLang }, (res) => {
      seg.pending = false;
      const dst = res && res.success && res.translation ? String(res.translation).trim() : '';
      if (!dst) return;
      seg.zh = dst;
      rememberSegZh(seg.en, dst);
      saveCache();
      segTick();
    });
  }

  // 预取队列：以当前播放位置为中心，先往后翻，再回补前面
  function prefetchQueue() {
    const token = ++state.segToken;
    const CHUNK = 20;
    let rounds = 0;

    const next = () => {
      if (state.pipeline !== 'prefetch' || token !== state.segToken) return;
      if (++rounds > 400) return;

      const v = currentVideo();
      const from = v ? Math.max(0, findSegIndex(v.currentTime)) : 0;
      const targets = [];
      const collect = (a, b) => {
        for (let i = a; i < b && targets.length < CHUNK; i++) {
          const s = state.segments[i];
          if (s.zh || s.pending || (s.tries || 0) >= 2) continue;
          // 这句话之前翻过（重复 cue / 重播）→ 直接复用，不重复请求
          const known = state.zhByText.get(normSegText(s.en));
          if (known) { s.zh = known; continue; }
          targets.push(s);
        }
      };
      collect(from, state.segments.length);
      if (!targets.length) collect(0, from);
      if (!targets.length) return;

      targets.forEach((s) => { s.pending = true; });

      sendMsg({ action: 'translate_batch', texts: targets.map((s) => s.en), targetLang: state.targetLang }, (res) => {
        if (state.pipeline !== 'prefetch' || token !== state.segToken) return;
        const list = res && res.success && Array.isArray(res.translations) ? res.translations : null;

        // 条数对不上就整批放弃，绝不按下标硬套（否则译文会串到别的句子上）
        if (!list || list.length !== targets.length) {
          targets.forEach((s) => { s.pending = false; s.tries = (s.tries || 0) + 1; });
          console.warn('LingoFlow: prefetch batch size mismatch, using per-segment translation');
          return;
        }

        let filled = 0;
        targets.forEach((s, i) => {
          s.pending = false;
          const t = list[i] ? String(list[i]).trim() : '';
          if (t) { s.zh = t; rememberSegZh(s.en, t); filled += 1; } else { s.tries = (s.tries || 0) + 1; }
        });

        if (filled) { saveCache(); segTick(); }
        if (!filled) return;
        setTimeout(next, 60);
      });
    };

    next();
  }

  function startSegTicker() {
    stopSegTicker();
    state.segTimer = setInterval(segTick, 200);
    const v = currentVideo();
    if (v) {
      try { v.addEventListener('seeked', onSegSeek); } catch (_) {}
    }
    segTick();
  }

  function stopSegTicker() {
    if (state.segTimer) { clearInterval(state.segTimer); state.segTimer = null; }
    const v = currentVideo();
    if (v) { try { v.removeEventListener('seeked', onSegSeek); } catch (_) {} }
  }

  function onSegSeek() {
    if (state.pipeline !== 'prefetch') return;
    segTick();
    // 拖到没预翻的位置：以新位置为起点重排预取
    if (state.segToken) { state.segToken += 1; prefetchQueue(); }
  }

  function activatePrefetch(segs) {
    state.segments = segs;
    applyKnownZh(segs);
    state.pipeline = 'prefetch';
    state.lastSegIndex = -1;
    state.lastText = '';
    state.lastDst = '';
    stopPolling();       // 不再逐词读 DOM
    startSegTicker();
    prefetchQueue();
    console.log('[LingoFlow] preload ready:', segs.length, 'segments');
  }

  function stopPrefetch() {
    stopSegTicker();
    state.segToken += 1;
    state.pipeline = 'live';
    state.segments = [];
    state.lastSegIndex = -1;
  }

  function startPrefetch() {
    if (state.preload === 'off') return;

    const key = (getVideoId() || 'unknown') + '|' + state.sourceLang + '|' + state.targetLang;
    state.videoKey = key;

    loadCache(key, (cached) => {
      if (!state.running) return;
      if (cached && cached.length) {
        const segs = cached.map((s) => ({
          start: s.s, end: s.e, en: s.en, zh: s.zh || '', pending: false, tries: 0
        }));
        segs.forEach((s) => rememberSegZh(s.en, s.zh));
        activatePrefetch(segs);
        return;
      }

      sendMsg({ action: 'lf_yt_tracklist' }, (res) => {
        if (!state.running) return;
        if (!res || !res.ok || !res.tracks || !res.tracks.length) {
          console.log('[LingoFlow] preload: no tracklist, keep live mode');
          return;
        }

        const track = pickTrack(res.tracks);
        if (!track || !track.url) {
          console.log('[LingoFlow] preload: no usable base track, keep live mode');
          return;
        }

        sendMsg({ action: 'lf_yt_timedtext', url: track.url }, (r) => {
          if (!state.running) return;
          if (!r || !r.ok || !r.cues || !r.cues.length) {
            console.log('[LingoFlow] preload: timedtext unavailable, keep live mode');
            return;
          }
          const segs = buildSegments(r.cues);
          if (segs.length < 5) {
            console.log('[LingoFlow] preload: too few segments, keep live mode');
            return;
          }
          activatePrefetch(segs);
        });
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

    if (!ov.hidden) {
      applyStyle();
      if (state.revealTimer) { clearTimeout(state.revealTimer); state.revealTimer = null; }
      document.documentElement.classList.add('lf-yt-subs-on');
    } else if (state.content !== 'off') {
      // 我们长时间没内容可显示时，把原生字幕还回去 —— 宁可原生字幕回来，
      // 也不能让屏幕上"一个字都没有"。900ms 是为了不干扰句与句之间的正常空档。
      if (!state.revealTimer) {
        state.revealTimer = setTimeout(() => {
          state.revealTimer = null;
          if (!state.overlay || state.overlay.hidden) {
            document.documentElement.classList.remove('lf-yt-subs-on');
          }
        }, 900);
      }
    }
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
        sourceLang: state.sourceLang,
        preload: state.preload
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

        // 预翻译开关或原文语言变了 → 重建整片字幕（显示模式不受影响）
        const needRebuild = (state.preload !== prev.preload)
          || (state.sourceLang !== prev.sourceLang && state.preload === 'on');
        if (needRebuild) {
          stopPrefetch();
          startPolling();
          startPrefetch();
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
