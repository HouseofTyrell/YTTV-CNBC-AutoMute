// ==UserScript==
// @name         YTTV Auto-Mute (v2.8: CNBC smart mute + Auto HUD toast w/ fade/slide + stability delay)
// @namespace    http://tampermonkey.net/
// @description  Auto-mute suspected commercials on YouTube TV with caption/event logging, allow-list, break-cues, ad-lock, safer brand+URL/phone rule, stronger program gating, and HUD toast that auto-appears on mute with fade/slide.
// @version      2.8
// @match        https://tv.youtube.com/watch/*
// @match        https://tv.youtube.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_download
// @run-at       document-start
// @license      MIT
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ---------- SINGLE NAMESPACE & CLEANUP ---------- */
  const NSKEY = '__yttpMute__';
  const NS = (window[NSKEY] = window[NSKEY] || {});
  try {
    if (NS.intervalId) clearInterval(NS.intervalId);
    if (NS.ccAttachTimer) clearInterval(NS.ccAttachTimer);
    if (NS.ccObserver?.disconnect) NS.ccObserver.disconnect();
    if (NS.routeObserver?.disconnect) NS.routeObserver.disconnect();
    if (NS.hudTimer) clearTimeout(NS.hudTimer);
    if (NS.hudAnimTimer) clearTimeout(NS.hudAnimTimer);
  } catch {}
  Object.assign(NS, {
    intervalId: null,
    ccAttachTimer: null,
    ccObserver: null,
    routeObserver: null,
    hudEl: null,
    panelEl: null,
    hudText: '',
    hudTimer: null,
    hudAnimTimer: null,
    _lastUrl: location.href,
  });

  /* ---------- SAFE GM SHIMS ---------- */
  const hasGM_getValue = typeof GM_getValue === 'function';
  const hasGM_setValue = typeof GM_setValue === 'function';
  const hasGM_download = typeof GM_download === 'function';

  const kvGet = (k, defVal) => {
    try {
      if (hasGM_getValue) return GM_getValue(k, defVal);
      const raw = localStorage.getItem('yttp__' + k);
      return raw ? JSON.parse(raw) : defVal;
    } catch { return defVal; }
  };
  const kvSet = (k, v) => {
    try {
      if (hasGM_setValue) return GM_setValue(k, v);
      localStorage.setItem('yttp__' + k, JSON.stringify(v));
    } catch {}
  };
  const downloadText = (filename, text) => {
    try {
      if (hasGM_download) {
        const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
        GM_download({ url, name: filename, saveAs: false });
        return;
      }
    } catch {}
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.documentElement.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 300);
  };

  /* ---------- DEFAULTS & SETTINGS ---------- */
  const DEFAULTS = {
    useTrueMute: true,
    intervalMs: 150,
    debug: true,
    debugVerboseCC: false,

    // HUD options
    showHUD: true,               // always show HUD
    hudAutoOnMute: false,        // auto show HUD only when MUTED, hide on UNMUTED
    hudAutoDelayMs: 10000,       // stability delay before changing visibility (10s)
    hudFadeMs: 250,              // toast fade duration
    hudSlidePx: 8,               // toast slide distance (px)

    // Timing
    muteOnNoCCDelayMs: 140,
    unmuteDebounceMs: 500,

    // Ad-lock window (stay muted after ad signal; cleared by strong allow cues)
    minAdLockMs: 20000,

    // PROGRAM gate (need consecutive “program votes” to unmute unless PROGRAM_ALLOW)
    programVotesNeeded: 2,
    fastRecheckRAF: true,

    captionLogLimit: 6000,
    autoDownloadEveryMin: 0,

    // Hard ad phrases (added from logs)
    hardPhrases: [
      "ask your doctor","side effects include","do not take if you are allergic",
      "eligible patients","risk of serious","use as directed","available by prescription",
      "talk to your doctor","call your doctor","call 1-800",
      "terms apply","limited time offer","0% apr","zero percent apr",
      "get started today","apply today","see store for details",
      "not available in all states","learn more at","learn more on","visit",
      "get your money right","policy for only","guaranteed buyback option","own your place in the future"
    ].join('\n'),

    // Brand terms (need context + CTA/OFFER)
    brandTerms: [
      "charles schwab","schwab","fidelity","td ameritrade","ameritrade","etrade","e-trade",
      "robinhood","vanguard","capital one","goldman sachs","morgan stanley",
      "t-mobile","tmobile","verizon","at&t","att","comcast","xfinity",
      "liberty mutual","progressive","geico","state farm","allstate",
      "ozempic","mounjaro","trulicity","jardiance","humira","rinvoq","skyrizi",
      "iphone","whopper","medicare","aarp"
    ].join('\n'),

    // Ad-context phrases
    adContext: [
      "sponsored by","brought to you by","presented by",
      "offer ends","apply now","apply today",
      "learn more","visit","sign up","join now",
      ".com","dot com","get started","start today","enroll",
      "see your doctor","ask your doctor","talk to your doctor",
      "terms apply","see details","member fdic","not fdic insured"
    ].join('\n'),

    // CTA/OFFER evidence (used with brand+context)
    ctaTerms: [
      "apply","sign up","join now","call","visit","learn more","enroll","get started","download","claim","see details","see your doctor"
    ],
    offerTerms: [
      "policy for only","only $","per month","per mo","per year","limited time","guarantee","guaranteed","get a quote","get your money right","buyback option"
    ],

    // Strong program cues (clear ad-lock)
    allowPhrases: [
      "joining me now","from washington","live in","live at",
      "earnings","guidance","conference call","analyst",
      "tariff","tariffs","supreme court","breaking news",
      "economic data","cpi","ppi","jobs report","nonfarm payrolls",
      "market breadth","all time high","record highs",
      "thanks for that","back to you","latest on",
      "chief investment officer","portfolio manager","senior analyst",
      "coming up on the show"
    ],

    // Break cues (enter ad-lock)
    breakPhrases: [
      "back after this","we'll be right back","we will be right back",
      "stay with us","the exchange is back after this",
      "more after the break","right after this break"
    ],
  };

  const SETTINGS_KEY = 'yttp_settings_v2_8';
  const loadSettings = () => ({ ...DEFAULTS, ...(kvGet(SETTINGS_KEY, {})) });
  const saveSettings = (s) => kvSet(SETTINGS_KEY, s);
  let S = loadSettings();

  const toLines = (t) => (t||'').split('\n').map(s=>s.trim()).filter(Boolean);
  let HARD_AD_PHRASES = toLines(S.hardPhrases);
  let BRAND_TERMS     = toLines(S.brandTerms);
  let AD_CONTEXT      = toLines(S.adContext);
  let ALLOW_PHRASES   = toLines(Array.isArray(S.allowPhrases)?S.allowPhrases.join('\n'):S.allowPhrases);
  let BREAK_PHRASES   = toLines(Array.isArray(S.breakPhrases)?S.breakPhrases.join('\n'):S.breakPhrases);
  let CTA_TERMS       = Array.isArray(S.ctaTerms) ? S.ctaTerms.map(s=>s.toLowerCase()) : toLines(S.ctaTerms?.join?.('\n') || '');
  let OFFER_TERMS     = Array.isArray(S.offerTerms) ? S.offerTerms.map(s=>s.toLowerCase()) : toLines(S.offerTerms?.join?.('\n') || '');

  /* ---------- STATE ---------- */
  const LOG_EVENTS_IN_CAPTION_LOG = true;
  const log = (...a)=>{ if (S.debug) console.log('[YTTV-Mute]', ...a); };
  const nowStr = ()=> new Date().toLocaleTimeString();

  const CAPLOG_KEY = 'captions_log';
  const storedLog = kvGet(CAPLOG_KEY, []);
  window._captions_log = Array.isArray(storedLog) ? storedLog : [];

  let enabled = true;
  let videoRef = null;
  let lastMuteState = null;
  let lastCaptionLine = '';
  let lastCcSeenMs = 0;
  let lastProgramGoodMs = 0;
  let lastAutoDlMs = Date.now();
  let rafScheduled = false;

  let adLockUntil = 0;
  let programVotes = 0;

  const URL_RE   = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i;
  const PHONE_RE = /\b(?:\d{3}[-\s.]?\d{3}[-\s.]?\d{4})\b/;
  const DOLLAR_RE= /\$\s?\d/;
  const PER_RE   = /\b\d+\s?(?:per|\/)\s?(?:month|mo|yr|year)\b/i;

  /* ---------- HUD (TOAST) ---------- */
  function ensureHUD(){
    if (NS.hudEl) return;
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed','right:12px','bottom:12px','z-index:2147483647',
      'font:12px/1.3 system-ui,sans-serif',
      'background:rgba(0,0,0,0.72)','color:#fff',
      'padding:8px 10px','border-radius:8px','max-width:360px',
      'pointer-events:none','white-space:pre-wrap',
      // toast animation baseline
      `opacity:0`,`transform:translateY(${S.hudSlidePx|0}px)`,
      `transition: opacity ${S.hudFadeMs|0}ms ease, transform ${S.hudFadeMs|0}ms ease`
    ].join(';');
    el.textContent = NS.hudText || '';
    document.documentElement.appendChild(el);
    NS.hudEl = el;
  }
  function hudFadeTo(visible){
    ensureHUD();
    if (!NS.hudEl) return;
    // cancel any pending removal
    if (NS.hudAnimTimer) { clearTimeout(NS.hudAnimTimer); NS.hudAnimTimer = null; }
    // trigger style
    NS.hudEl.style.opacity   = visible ? '1' : '0';
    NS.hudEl.style.transform = visible ? 'translateY(0px)' : `translateY(${S.hudSlidePx|0}px)`;
    // if hiding and not "always show", we can optionally remove after fade to keep DOM clean
    if (!visible && !S.showHUD && S.hudAutoOnMute) {
      NS.hudAnimTimer = setTimeout(() => {
        // keep element (cheap), but safe to remove if you prefer:
        // if (NS.hudEl?.parentNode) NS.hudEl.parentNode.removeChild(NS.hudEl), NS.hudEl=null;
      }, (S.hudFadeMs|0) + 10);
    }
  }
  // Only updates text (does not change visibility)
  function updateHUDText(txt){
    NS.hudText = txt;
    if (NS.hudEl) NS.hudEl.textContent = txt;
  }
  // schedule visibility change with stability delay
  function scheduleHudVisibility(desiredVisible){
    if (NS.hudTimer) clearTimeout(NS.hudTimer);
    const token = Symbol('hud');
    NS._hudDesiredToken = token;
    NS.hudTimer = setTimeout(() => {
      if (NS._hudDesiredToken !== token) return;
      // final decision: always-show overrides auto behavior
      const finalVisible = S.showHUD || (S.hudAutoOnMute && desiredVisible);
      hudFadeTo(finalVisible);
    }, Math.max(0, S.hudAutoDelayMs|0));
  }

  /* ---------- CAPTION & EVENT LOG ---------- */
  function pushCaption(text){
    const entry = `[${nowStr()}] ${text}`;
    window._captions_log.push(entry);
    if (window._captions_log.length > S.captionLogLimit) {
      window._captions_log.splice(0, window._captions_log.length - S.captionLogLimit);
    }
    kvSet(CAPLOG_KEY, window._captions_log);
  }
  function pushEventLog(kind, payload = {}) {
    const t = new Date();
    const pad = n => String(n).padStart(2,'0');
    const ts = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    const line = [
      `[${ts}] >>> ${kind}`,
      payload.reason ? `reason=${payload.reason}` : null,
      payload.match  ? `match="${payload.match}"` : null,
      payload.noCcMs !== undefined ? `noCcMs=${payload.noCcMs}` : null,
      payload.ccSnippet ? `cc="${payload.ccSnippet}"` : null,
      payload.url ? `url=${payload.url}` : null,
      payload.lock ? `adLockMsLeft=${payload.lock}` : null,
      payload.pv !== undefined ? `programVotes=${payload.pv}` : null
    ].filter(Boolean).join(' | ');
    window._captions_log.push(line);
    if (window._captions_log.length > S.captionLogLimit) {
      window._captions_log.splice(0, window._captions_log.length - S.captionLogLimit);
    }
    kvSet(CAPLOG_KEY, window._captions_log);
  }
  function downloadCaptionsNow(){
    const pad = n=>String(n).padStart(2,'0');
    const d=new Date();
    const name=`youtubetv_captions_${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
    downloadText(name, window._captions_log.join('\n') || '(no captions logged yet)');
  }

  /* ---------- DETECTION ---------- */
  function containsAny(text, arr) {
    for (const t of arr) { if (t && text.includes(t)) return t; }
    return null;
  }
  function detectAdSignals(ccText, { captionsExist, captionsBottomed, noCcMs, muteOnNoCCDelayMs }){
    const text = (ccText || '').toLowerCase();

    // Strong program cues — clear ad-lock
    const allowHit = containsAny(text, ALLOW_PHRASES);
    if (allowHit) return { verdict: 'PROGRAM_ALLOW', matched: allowHit };

    // Break-start cues — enter ad
    const breakHit = containsAny(text, BREAK_PHRASES);
    if (breakHit) return { verdict: 'AD_BREAK', matched: breakHit };

    // Hard ad phrases
    for (const p of HARD_AD_PHRASES) { if (text.includes(p)) return { verdict:'AD_HARD', matched:p }; }

    // Brand + context + CTA/OFFER evidence
    const brandHit = containsAny(text, BRAND_TERMS);
    if (brandHit) {
      const ctxHit = containsAny(text, AD_CONTEXT) || (URL_RE.test(text) ? 'url' : null) || (PHONE_RE.test(text) ? 'phone' : null);
      if (ctxHit) {
        const ctaHit = containsAny(text, CTA_TERMS) || containsAny(text, OFFER_TERMS) || (DOLLAR_RE.test(text) ? '$' : null) || (PER_RE.test(text) ? 'per' : null);
        if (ctaHit) return { verdict: 'AD_BRAND_WITH_CONTEXT', matched: `${brandHit} + ${ctxHit}+${ctaHit}` };
      }
    }

    // Non-textual signals
    let score = 0;
    if (!captionsExist && noCcMs > muteOnNoCCDelayMs) score += 2;
    if (captionsBottomed) score += 1;
    if (score >= 2) return { verdict:'AD_SIGNAL_SCORE', matched:`score=${score}` };

    // Default program
    return { verdict:'PROGRAM', matched:null };
  }

  /* ---------- MUTE CONTROL ---------- */
  function setMuted(video, shouldMute, reasonObj){
    if (!video) return;
    if (!enabled) shouldMute = false;

    const stateChanged = (lastMuteState !== shouldMute);

    // True mute or soft volume
    if (S.useTrueMute) {
      if (video.muted !== shouldMute) video.muted = shouldMute;
    } else {
      if (shouldMute) video.volume = 0.01;
      else video.volume = Math.max(video.volume || 1.0, 0.01);
    }

    // Event log + HUD toast control
    if (stateChanged) {
      const lockMsLeft = Math.max(0, adLockUntil - Date.now());
      pushEventLog(shouldMute ? "MUTED" : "UNMUTED", {
        reason: reasonObj.reason,
        match: reasonObj.match,
        ccSnippet: reasonObj.ccSnippet,
        url: location.href,
        noCcMs: reasonObj.noCcMs,
        lock: lockMsLeft,
        pv: programVotes
      });

      // auto HUD toast: show when MUTED, hide when UNMUTED, with stability delay + fade/slide
      if (S.hudAutoOnMute) {
        scheduleHudVisibility(shouldMute /* desired visible if muted */);
      } else if (S.showHUD) {
        // ensure visible if always-on
        hudFadeTo(true);
      }
    }

    lastMuteState = shouldMute;

    updateHUDText(
      (enabled ? '' : '[PAUSED] ') +
      `${shouldMute?'MUTED':'UNMUTED'}\n` +
      `Reason: ${reasonObj.reason}\n` +
      (reasonObj.match ? `Match: "${reasonObj.match}"\n` : '') +
      (reasonObj.ccSnippet ? `CC: "${reasonObj.ccSnippet}"` : '')
    );
  }

  /* ---------- DOM HELPERS ---------- */
  function detectNodes(){
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    const captionSegment =
      document.querySelector('span.ytp-caption-segment') ||
      document.querySelector('.ytp-caption-segment');
    const captionWindow =
      document.querySelector('div.caption-window') ||
      document.querySelector('.ytp-caption-window-container') ||
      document.querySelector('.ytp-caption-window');
    return { video, captionSegment, captionWindow };
  }
  function scheduleImmediateCheck(){
    if (!S.fastRecheckRAF) return tick();
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => { rafScheduled = false; tick(); });
  }

  /* ---------- MAIN LOOP ---------- */
  function evaluate(video, ccText, captionsExist, captionsBottomed){
    const t = Date.now();
    if (captionsExist) lastCcSeenMs = t;

    const noCcMs = t - lastCcSeenMs;
    const res = detectAdSignals(ccText, { captionsExist, captionsBottomed, noCcMs, muteOnNoCCDelayMs: S.muteOnNoCCDelayMs });

    let shouldMute = false;
    let reason = 'PROGRAM_DETECTED';
    let match = res.matched;

    // Enter/extend ad-lock on ad-like verdicts
    if (res.verdict === 'AD_BREAK' || res.verdict === 'AD_HARD' || res.verdict === 'AD_BRAND_WITH_CONTEXT' || res.verdict === 'AD_SIGNAL_SCORE') {
      adLockUntil = Math.max(adLockUntil, t + S.minAdLockMs);
      programVotes = 0;
    }

    const lockActive = t < adLockUntil;

    // Strong program cue clears lock and boosts votes
    if (res.verdict === 'PROGRAM_ALLOW') {
      adLockUntil = 0;
      programVotes = Math.max(programVotes, S.programVotesNeeded);
    }

    // Program voting outside ad verdicts
    if (res.verdict === 'PROGRAM' || res.verdict === 'PROGRAM_ALLOW') {
      if (captionsExist && !captionsBottomed) {
        programVotes = Math.min(S.programVotesNeeded, programVotes + 1);
      }
    } else {
      programVotes = 0;
    }

    if (lockActive) {
      shouldMute = true;
      reason = 'AD_LOCK';
    } else {
      if (res.verdict === 'AD_BREAK' || res.verdict === 'AD_HARD' || res.verdict === 'AD_BRAND_WITH_CONTEXT' || res.verdict === 'AD_SIGNAL_SCORE') {
        shouldMute = true;
        reason = res.verdict;
        lastProgramGoodMs = 0;
      } else if (captionsExist && !captionsBottomed) {
        if (lastProgramGoodMs === 0) lastProgramGoodMs = t;
        const votesOK = programVotes >= S.programVotesNeeded;
        const timeOK  = (t - lastProgramGoodMs) >= S.unmuteDebounceMs;
        if (votesOK && timeOK) {
          shouldMute = false;
          reason = (res.verdict === 'PROGRAM_ALLOW') ? 'PROGRAM_ALLOW' : 'PROGRAM_CONFIRMED';
        } else {
          shouldMute = (lastMuteState === true);
          reason = votesOK ? 'PROGRAM_DEBOUNCE' : 'PROGRAM_VOTING';
        }
      } else {
        // Hold previous mute briefly when CC vanishes
        shouldMute = (lastMuteState === true) && (noCcMs < S.muteOnNoCCDelayMs);
        if (shouldMute) reason = 'HOLD_PREV_STATE';
      }
    }

    setMuted(video, shouldMute, {
      reason,
      match,
      ccSnippet: ccText ? ccText.slice(0,140) + (ccText.length>140?'…':'') : '',
      noCcMs
    });
  }

  function tick(){
    const { video, captionSegment, captionWindow } = detectNodes();
    if (!video){
      if (videoRef) log('Video disappeared; waiting…');
      videoRef = null;
      // leave toast visibility to settings; just update text
      updateHUDText('Waiting for player…');
      return;
    }
    if (!videoRef){
      videoRef = video;
      log('Player found. Ready.');
      lastCcSeenMs = Date.now();
      lastProgramGoodMs = 0;
      programVotes = 0;
    }

    let ccText = '', captionsExist = false, captionsBottomed = false;
    if (captionWindow){
      ccText = (captionWindow.textContent || '').trim();
      captionsExist = ccText.length > 0;
      const bottomStyle = captionWindow.style && captionWindow.style.bottom;
      captionsBottomed = !!(bottomStyle && bottomStyle !== 'auto' && bottomStyle !== '');
    }

    if (S.debugVerboseCC && captionSegment?.textContent) {
      const seg = captionSegment.textContent;
      if (seg && seg !== lastCaptionLine) { lastCaptionLine = seg; log('CC:', seg); }
    }
    if (ccText && ccText !== lastCaptionLine) { lastCaptionLine = ccText; pushCaption(ccText); }

    if (S.autoDownloadEveryMin > 0) {
      const since = (Date.now() - lastAutoDlMs) / 60000;
      if (since >= S.autoDownloadEveryMin) { lastAutoDlMs = Date.now(); downloadCaptionsNow(); }
    }

    evaluate(video, ccText, captionsExist, captionsBottomed);
  }

  function startLoop(){
    if (NS.intervalId) clearInterval(NS.intervalId);
    NS.intervalId = setInterval(tick, S.intervalMs);
    log('Loop started. INTERVAL_MS:', S.intervalMs, 'URL:', location.href);

    // initial HUD state
    ensureHUD();
    if (S.showHUD) {
      // always on, fade in quickly
      hudFadeTo(true);
      updateHUDText('Initializing…');
    } else if (S.hudAutoOnMute) {
      // auto mode will handle visibility on next state change; start hidden
      hudFadeTo(false);
    } else {
      // neither: keep hidden
      hudFadeTo(false);
    }
  }

  /* ---------- OBSERVERS ---------- */
  function attachCcObserver(){
    const { captionWindow } = detectNodes();
    if (!captionWindow) return;
    if (!NS.ccObserver) NS.ccObserver = new MutationObserver(() => scheduleImmediateCheck());
    else { try { NS.ccObserver.disconnect(); } catch {} }
    try {
      NS.ccObserver.observe(captionWindow, { subtree:true, childList:true, characterData:true });
      log('CC observer attached.');
    } catch {}
  }
  if (NS.ccAttachTimer) clearInterval(NS.ccAttachTimer);
  NS.ccAttachTimer = setInterval(attachCcObserver, 1000);

  function attachRouteObserver(){
    if (NS.routeObserver) { try { NS.routeObserver.disconnect(); } catch {} }
    NS.routeObserver = new MutationObserver(() => {
      if (NS._lastUrl !== location.href) {
        NS._lastUrl = location.href;
        log('Route change detected →', NS._lastUrl);
        lastMuteState = null; lastCaptionLine = ''; videoRef = null;
        lastCcSeenMs = Date.now(); lastProgramGoodMs = 0;
        adLockUntil = 0; programVotes = 0;
        if (NS.hudTimer) { clearTimeout(NS.hudTimer); NS.hudTimer = null; }
        if (NS.hudAnimTimer) { clearTimeout(NS.hudAnimTimer); NS.hudAnimTimer = null; }
        startLoop();
      }
    });
    NS.routeObserver.observe(document, { subtree:true, childList:true });
  }
  attachRouteObserver();

  /* ---------- SETTINGS PANEL ---------- */
  function clampInt(v,min,max,fb){ const n=Math.round(parseInt(v,10)); return Number.isNaN(n)?fb:Math.min(max,Math.max(min,n)); }

  function buildPanel(){
    if (NS.panelEl) return NS.panelEl;
    const panel = document.createElement('div');
    NS.panelEl = panel;
    panel.style.cssText = [
      'position:fixed','right:16px','top:16px','z-index:2147483647',
      'width:560px','max-width:95vw','max-height:85vh','overflow:auto',
      'background:#111','color:#fff','border:1px solid #333','border-radius:10px',
      'box-shadow:0 10px 30px rgba(0,0,0,0.5)','font:13px/1.4 system-ui,sans-serif'
    ].join(';');

    const btn='background:#1f6feb;border:none;color:#fff;padding:6px 10px;border-radius:7px;cursor:pointer';
    const input='width:100%;box-sizing:border-box;background:#000;color:#fff;border:1px solid #333;border-radius:7px;padding:6px';

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #333;position:sticky;top:0;background:#111;">
        <div style="font-weight:600;font-size:14px;">YTTV Auto-Mute — Settings</div>
        <div style="margin-left:auto;display:flex;gap:8px;">
          <button id="yttp-save" style="${btn}">Save & Apply</button>
          <button id="yttp-close" style="${btn};background:#444">Close (Ctrl+Shift+S)</button>
        </div>
      </div>
      <div style="padding:12px;display:grid;gap:12px;">

        <div style="display:grid;gap:8px;">
          <label><input type="checkbox" id="useTrueMute"> True mute (vs soft low-volume)</label>
          <label><input type="checkbox" id="debug"> Console debug</label>
          <label><input type="checkbox" id="debugVerboseCC"> Verbose CC debug</label>
        </div>

        <div style="display:grid;gap:8px;">
          <label><input type="checkbox" id="showHUD"> Show HUD always</label>
          <label><input type="checkbox" id="hudAutoOnMute"> Auto HUD on mute (hide on unmute)</label>
          <label>HUD auto show/hide delay (ms) <input id="hudAutoDelayMs" type="number" min="0" max="60000" step="100" style="${input}"></label>
          <label>HUD fade (ms) <input id="hudFadeMs" type="number" min="0" max="2000" step="10" style="${input}"></label>
          <label>HUD slide (px) <input id="hudSlidePx" type="number" min="0" max="50" step="1" style="${input}"></label>
        </div>

        <div style="display:grid;gap:6px;">
          <label>Poll interval (ms) <input id="intervalMs" type="number" min="50" max="1000" step="10" style="${input}"></label>
          <label>Fast mute when CC missing (ms) <input id="muteOnNoCCDelayMs" type="number" min="0" max="5000" step="20" style="${input}"></label>
          <label>Unmute debounce (ms) <input id="unmuteDebounceMs" type="number" min="0" max="5000" step="20" style="${input}"></label>
          <label>Ad-lock duration (ms) <input id="minAdLockMs" type="number" min="0" max="60000" step="100" style="${input}"></label>
          <label>Program votes needed (1–4) <input id="programVotesNeeded" type="number" min="1" max="4" step="1" style="${input}"></label>
          <label>Auto-download captions every N minutes (0=off) <input id="autoDownloadEveryMin" type="number" min="0" max="360" step="1" style="${input}"></label>
          <label>Caption log limit (lines) <input id="captionLogLimit" type="number" min="200" max="50000" step="100" style="${input}"></label>
        </div>

        <div><div style="margin:6px 0 4px;font-weight:600;">Hard Ad Phrases (one per line)</div>
          <textarea id="hardPhrases" rows="7" style="${input};font-family:ui-monospace, Menlo, Consolas, monospace;"></textarea>
        </div>
        <div><div style="margin:6px 0 4px;font-weight:600;">Brand Terms (one per line)</div>
          <textarea id="brandTerms" rows="7" style="${input};font-family:ui-monospace, Menlo, Consolas, monospace;"></textarea>
        </div>
        <div><div style="margin:6px 0 4px;font-weight:600;">Ad Context Phrases (one per line)</div>
          <textarea id="adContext" rows="7" style="${input};font-family:ui-monospace, Menlo, Consolas, monospace;"></textarea>
        </div>
        <div><div style="margin:6px 0 4px;font-weight:600;">CTA Terms (one per line)</div>
          <textarea id="ctaTerms" rows="5" style="${input};font-family:ui-monospace, Menlo, Consolas, monospace;"></textarea>
        </div>
        <div><div style="margin:6px 0 4px;font-weight:600;">Offer Terms (one per line)</div>
          <textarea id="offerTerms" rows="5" style="${input};font-family:ui-monospace, Menlo, Consolas, monospace;"></textarea>
        </div>
        <div><div style="margin:6px 0 4px;font-weight:600;">Allow Phrases (program cues, one per line)</div>
          <textarea id="allowPhrases" rows="7" style="${input};font-family:ui-monospace, Menlo, Consolas, monospace;"></textarea>
        </div>
        <div><div style="margin:6px 0 4px;font-weight:600;">Break Phrases (break start cues, one per line)</div>
          <textarea id="breakPhrases" rows="7" style="${input};font-family:ui-monospace, Menlo, Consolas, monospace;"></textarea>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="dl" style="${btn}">Download Captions (Ctrl+D)</button>
          <button id="clearlog" style="${btn};background:#8b0000">Clear Caption Log</button>
          <button id="export" style="${btn}">Export Settings</button>
          <label style="${btn};display:inline-block;position:relative;overflow:hidden;">
            Import Settings<input id="import" type="file" accept="application/json" style="opacity:0;position:absolute;left:0;top:0;width:100%;height:100%;cursor:pointer;">
          </label>
          <button id="reset" style="${btn};background:#444">Reset Defaults</button>
        </div>

        <div style="font-size:12px;color:#bbb;">Hotkeys: Ctrl+M (toggle), Ctrl+D (download captions), Ctrl+Shift+S (settings)</div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    // Populate
    panel.querySelector('#useTrueMute').checked = S.useTrueMute;
    panel.querySelector('#debug').checked = S.debug;
    panel.querySelector('#debugVerboseCC').checked = S.debugVerboseCC;

    panel.querySelector('#showHUD').checked = S.showHUD;
    panel.querySelector('#hudAutoOnMute').checked = S.hudAutoOnMute;
    panel.querySelector('#hudAutoDelayMs').value = S.hudAutoDelayMs;
    panel.querySelector('#hudFadeMs').value = S.hudFadeMs;
    panel.querySelector('#hudSlidePx').value = S.hudSlidePx;

    panel.querySelector('#intervalMs').value = S.intervalMs;
    panel.querySelector('#muteOnNoCCDelayMs').value = S.muteOnNoCCDelayMs;
    panel.querySelector('#unmuteDebounceMs').value = S.unmuteDebounceMs;
    panel.querySelector('#minAdLockMs').value = S.minAdLockMs;
    panel.querySelector('#programVotesNeeded').value = S.programVotesNeeded;
    panel.querySelector('#autoDownloadEveryMin').value = S.autoDownloadEveryMin;
    panel.querySelector('#captionLogLimit').value = S.captionLogLimit;

    panel.querySelector('#hardPhrases').value = S.hardPhrases;
    panel.querySelector('#brandTerms').value = S.brandTerms;
    panel.querySelector('#adContext').value = S.adContext;
    panel.querySelector('#ctaTerms').value = (Array.isArray(S.ctaTerms)?S.ctaTerms.join('\n'):S.ctaTerms||'');
    panel.querySelector('#offerTerms').value = (Array.isArray(S.offerTerms)?S.offerTerms.join('\n'):S.offerTerms||'');
    panel.querySelector('#allowPhrases').value = Array.isArray(S.allowPhrases) ? S.allowPhrases.join('\n') : S.allowPhrases;
    panel.querySelector('#breakPhrases').value = Array.isArray(S.breakPhrases) ? S.breakPhrases.join('\n') : S.breakPhrases;

    // Actions
    panel.querySelector('#yttp-close').onclick = togglePanel;
    panel.querySelector('#dl').onclick = downloadCaptionsNow;
    panel.querySelector('#clearlog').onclick = () => {
      window._captions_log = []; kvSet(CAPLOG_KEY, window._captions_log); alert('Caption log cleared.');
    };
    panel.querySelector('#export').onclick = () => {
      const data = JSON.stringify(S, null, 2);
      const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(data);
      const a = document.createElement('a'); a.href = url; a.download = 'yttp_settings.json'; a.click();
    };
    panel.querySelector('#import').onchange = (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const parsed = JSON.parse(r.result);
          S = { ...DEFAULTS, ...parsed };
          saveSettings(S);
          applySettings(true);
          alert('Settings imported and applied.');
          NS.panelEl.remove(); NS.panelEl = null; buildPanel();
        } catch { alert('Invalid settings file.'); }
      };
      r.readAsText(f);
    };
    panel.querySelector('#reset').onclick = () => {
      if (!confirm('Reset settings to defaults?')) return;
      S = { ...DEFAULTS }; saveSettings(S); applySettings(true);
      NS.panelEl.remove(); NS.panelEl = null; buildPanel();
    };
    panel.querySelector('#yttp-save').onclick = () => {
      S.useTrueMute = panel.querySelector('#useTrueMute').checked;
      S.debug = panel.querySelector('#debug').checked;
      S.debugVerboseCC = panel.querySelector('#debugVerboseCC').checked;

      S.showHUD = panel.querySelector('#showHUD').checked;
      S.hudAutoOnMute = panel.querySelector('#hudAutoOnMute').checked;
      S.hudAutoDelayMs = clampInt(panel.querySelector('#hudAutoDelayMs').value, 0, 60000, DEFAULTS.hudAutoDelayMs);
      S.hudFadeMs = clampInt(panel.querySelector('#hudFadeMs').value, 0, 2000, DEFAULTS.hudFadeMs);
      S.hudSlidePx = clampInt(panel.querySelector('#hudSlidePx').value, 0, 50, DEFAULTS.hudSlidePx);

      S.intervalMs = clampInt(panel.querySelector('#intervalMs').value, 50, 2000, DEFAULTS.intervalMs);
      S.muteOnNoCCDelayMs = clampInt(panel.querySelector('#muteOnNoCCDelayMs').value, 0, 5000, DEFAULTS.muteOnNoCCDelayMs);
      S.unmuteDebounceMs = clampInt(panel.querySelector('#unmuteDebounceMs').value, 0, 5000, DEFAULTS.unmuteDebounceMs);
      S.minAdLockMs = clampInt(panel.querySelector('#minAdLockMs').value, 0, 60000, DEFAULTS.minAdLockMs);
      S.programVotesNeeded = clampInt(panel.querySelector('#programVotesNeeded').value, 1, 4, DEFAULTS.programVotesNeeded);
      S.autoDownloadEveryMin = clampInt(panel.querySelector('#autoDownloadEveryMin').value, 0, 360, DEFAULTS.autoDownloadEveryMin);
      S.captionLogLimit = clampInt(panel.querySelector('#captionLogLimit').value, 200, 50000, DEFAULTS.captionLogLimit);

      S.hardPhrases = panel.querySelector('#hardPhrases').value;
      S.brandTerms = panel.querySelector('#brandTerms').value;
      S.adContext = panel.querySelector('#adContext').value;
      S.ctaTerms = panel.querySelector('#ctaTerms').value.split('\n').map(s=>s.trim()).filter(Boolean);
      S.offerTerms = panel.querySelector('#offerTerms').value.split('\n').map(s=>s.trim()).filter(Boolean);
      S.allowPhrases = panel.querySelector('#allowPhrases').value.split('\n').map(s=>s.trim()).filter(Boolean);
      S.breakPhrases = panel.querySelector('#breakPhrases').value.split('\n').map(s=>s.trim()).filter(Boolean);

      // refresh term arrays
      HARD_AD_PHRASES = toLines(S.hardPhrases);
      BRAND_TERMS = toLines(S.brandTerms);
      AD_CONTEXT = toLines(S.adContext);
      CTA_TERMS = Array.isArray(S.ctaTerms)?S.ctaTerms.map(s=>s.toLowerCase()):toLines(S.ctaTerms?.join?.('\n')||'');
      OFFER_TERMS = Array.isArray(S.offerTerms)?S.offerTerms.map(s=>s.toLowerCase()):toLines(S.offerTerms?.join?.('\n')||'');
      ALLOW_PHRASES = toLines(Array.isArray(S.allowPhrases)?S.allowPhrases.join('\n'):S.allowPhrases);
      BREAK_PHRASES = toLines(Array.isArray(S.breakPhrases)?S.breakPhrases.join('\n'):S.breakPhrases);

      saveSettings(S);
      applySettings(true);
      alert('Settings saved and applied.');
    };

    return panel;
  }
  function togglePanel(){ if (!NS.panelEl) buildPanel(); NS.panelEl.style.display = (NS.panelEl.style.display === 'none' ? 'block' : 'none'); }

  function applySettings(restart=false){
    // refresh HUD transition settings if already created
    if (NS.hudEl) {
      NS.hudEl.style.transition = `opacity ${S.hudFadeMs|0}ms ease, transform ${S.hudFadeMs|0}ms ease`;
    }
    if (restart) startLoop();
  }

  /* ---------- HOTKEYS ---------- */
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && (e.key==='m' || e.key==='M')) { enabled = !enabled; log(`Toggled → ${enabled?'ENABLED':'PAUSED'}`); e.preventDefault(); }
    if (e.ctrlKey && (e.key==='d' || e.key==='D')) { downloadCaptionsNow(); e.preventDefault(); }
    if (e.ctrlKey && e.shiftKey && (e.key==='s' || e.key==='S')) { togglePanel(); e.preventDefault(); }
  }, true);

  /* ---------- BOOT ---------- */
  applySettings(false);
  startLoop();

  // Attach observers once
  (function attachRouteObserver(){
    if (NS.routeObserver) { try { NS.routeObserver.disconnect(); } catch {} }
    NS.routeObserver = new MutationObserver(() => {
      if (NS._lastUrl !== location.href) {
        NS._lastUrl = location.href;
        log('Route change detected →', NS._lastUrl);
        lastMuteState = null; lastCaptionLine = ''; videoRef = null;
        lastCcSeenMs = Date.now(); lastProgramGoodMs = 0;
        adLockUntil = 0; programVotes = 0;
        if (NS.hudTimer) { clearTimeout(NS.hudTimer); NS.hudTimer = null; }
        if (NS.hudAnimTimer) { clearTimeout(NS.hudAnimTimer); NS.hudAnimTimer = null; }
        startLoop();
      }
    });
    NS.routeObserver.observe(document, { subtree:true, childList:true });
  })();

  (function attachCcObserver(){
    const attach = () => {
      const { captionWindow } = detectNodes();
      if (!captionWindow) return;
      if (!NS.ccObserver) NS.ccObserver = new MutationObserver(() => scheduleImmediateCheck());
      else { try { NS.ccObserver.disconnect(); } catch {} }
      try {
        NS.ccObserver.observe(captionWindow, { subtree:true, childList:true, characterData:true });
        log('CC observer attached.');
      } catch {}
    };
    if (NS.ccAttachTimer) clearInterval(NS.ccAttachTimer);
    NS.ccAttachTimer = setInterval(attach, 1000);
  })();

  log('Booted v2.8', {
    hardCount:HARD_AD_PHRASES.length,
    brandCount:BRAND_TERMS.length,
    ctxCount:AD_CONTEXT.length,
    allowCount:ALLOW_PHRASES.length,
    breakCount:BREAK_PHRASES.length,
    ctaCount:CTA_TERMS.length,
    offerCount:OFFER_TERMS.length
  });
})();
