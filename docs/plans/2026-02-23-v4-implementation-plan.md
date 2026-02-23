# YTTV Auto-Mute v4.0 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor the YTTV Auto-Mute userscript from a verdict-based detection system to a signal-aggregation confidence system where no single signal can trigger a mute.

**Architecture:** Replace the current `detectAdSignals() → evaluate()` pipeline with a `SignalCollector → ConfidenceScorer → DecisionEngine` pipeline. Every detection signal contributes a weighted score to a 0-100 confidence meter. Muting only happens when aggregate confidence crosses the user-configurable threshold. The entire codebase stays in a single IIFE file with clearly labeled sections.

**Tech Stack:** Vanilla JavaScript (ES2017+), Tampermonkey userscript API (GM_getValue, GM_setValue, GM_download)

**Source file:** `youtubetv-auto-mute.user.js`
**Design doc:** `docs/plans/2026-02-23-v4-refactor-design.md`

---

## Task 1: Quick Wins — Storage, Hotkeys, Utilities

**Files:**
- Modify: `youtubetv-auto-mute.user.js`

This task makes targeted fixes to the existing v3.5 code without changing the architecture. Each fix is small and safe.

**Step 1: Fix double kvGet at boot (line 172)**

Replace:
```javascript
window._captions_log = Array.isArray(kvGet(CAPLOG_KEY,[]))?kvGet(CAPLOG_KEY,[]):[];
```
With:
```javascript
const _loadedLog = kvGet(CAPLOG_KEY, []);
window._captions_log = Array.isArray(_loadedLog) ? _loadedLog : [];
```

**Step 2: Add debounced log flush**

After the `kvSet` definition (~line 41), add:
```javascript
let _logDirty = false;
let _logFlushTimer = null;
function scheduleLogFlush() {
  _logDirty = true;
  if (_logFlushTimer) return;
  _logFlushTimer = setTimeout(() => {
    _logFlushTimer = null;
    if (_logDirty) { kvSet(CAPLOG_KEY, window._captions_log); _logDirty = false; }
  }, 5000);
}
```

In `pushCaption()` and `pushEventLog()`, replace `kvSet(CAPLOG_KEY, window._captions_log);` with `scheduleLogFlush();`

**Step 3: Fix Ctrl+F hotkey (line 1016)**

Replace:
```javascript
if(e.ctrlKey && (e.key==='f'||e.key==='F')){flagIncorrectState();e.preventDefault();}
```
With:
```javascript
if(e.ctrlKey && e.shiftKey && (e.key==='f'||e.key==='F')){flagIncorrectState();e.preventDefault();}
```

Update the keyboard shortcuts display in the settings panel to show `Ctrl+Shift+F` instead of `Ctrl+F`.

**Step 4: Add truncate() utility**

After the `kvSet`/storage section, add:
```javascript
const truncate = (text, max = 140) =>
  text ? (text.length > max ? text.slice(0, max - 3) + '\u2026' : text) : '';
```

Replace all inline truncation expressions throughout the file:
- `ccText?ccText.slice(0,140)+(ccText.length>140?'…':''):''` → `truncate(ccText)`
- `ccText.slice(0,140)` → `truncate(ccText)`
- `info.ccSnippet.length>60 ? info.ccSnippet.slice(0,57)+'…' : info.ccSnippet` → `truncate(info.ccSnippet, 60)`
- `cc.slice(0,200)+(cc.length>200?'…':'')` → `truncate(cc, 200)`
- `info.match.length>30?info.match.slice(0,27)+'…':info.match` → `truncate(info.match, 30)`

**Step 5: Add Verdict enum and helpers**

After the `DEFAULTS` section, add:
```javascript
const Verdict = Object.freeze({
  AD_HARD: 'AD_HARD',
  AD_BREAK: 'AD_BREAK',
  AD_BRAND_WITH_CONTEXT: 'AD_BRAND_WITH_CONTEXT',
  AD_SIGNAL_SCORE: 'AD_SIGNAL_SCORE',
  PROGRAM_ALLOW: 'PROGRAM_ALLOW',
  PROGRAM_ANCHOR: 'PROGRAM_ANCHOR',
  PROGRAM: 'PROGRAM',
});
const isAdVerdict = (v) => v === Verdict.AD_HARD || v === Verdict.AD_BREAK ||
  v === Verdict.AD_BRAND_WITH_CONTEXT || v === Verdict.AD_SIGNAL_SCORE;
const isProgramVerdict = (v) => v === Verdict.PROGRAM || v === Verdict.PROGRAM_ANCHOR;
```

Replace ALL string literal verdict comparisons throughout the file with `Verdict.X` references and use the helpers where compound conditions appear (lines 522, 532, 547, 566).

**Step 6: Extract State object and resetState()**

Replace the loose `let` variables at lines 174-181 with:
```javascript
const State = {
  enabled: true,
  videoRef: null,
  lastMuteState: null,
  lastCaptionLine: '',
  lastCcSeenMs: 0,
  lastProgramGoodMs: 0,
  lastAutoDlMs: Date.now(),
  rafScheduled: false,
  adLockUntil: 0,
  programVotes: 0,
  manualOverrideUntil: 0,
  noCcConsec: 0,
  bottomConsec: 0,
  programQuorumCount: 0,
  lastCaptionVisibility: null,
  currentConfidence: 0,
  manualMuteActive: false,
  // Sliding caption window (populated in Task 6)
  captionWindow: [],

  reset(full = false) {
    if (full) {
      this.lastMuteState = null;
      this.lastCaptionLine = '';
      this.videoRef = null;
    }
    this.lastCcSeenMs = Date.now();
    this.lastProgramGoodMs = 0;
    this.adLockUntil = 0;
    this.programVotes = 0;
    this.manualOverrideUntil = 0;
    this.noCcConsec = 0;
    this.bottomConsec = 0;
    this.programQuorumCount = 0;
    this.lastCaptionVisibility = null;
    this.currentConfidence = 0;
    this.captionWindow = [];
  }
};
```

Update ALL references from bare variable names (`enabled`, `videoRef`, `lastMuteState`, etc.) to `State.X` throughout the entire file. Replace the 3 duplicated reset blocks (lines ~595, ~660, ~719) with `State.reset(true)` or `State.reset(false)`.

**Step 7: Cache DOM queries**

Replace `detectNodes()` with:
```javascript
let _cachedVideo = null, _cachedCaptionWindow = null, _cacheValidUntil = 0;
function detectNodes() {
  const now = Date.now();
  if (now < _cacheValidUntil && _cachedVideo?.isConnected && _cachedCaptionWindow?.isConnected) {
    return { video: _cachedVideo, captionWindow: _cachedCaptionWindow };
  }
  const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
  const captionWindow = document.querySelector('div.caption-window') ||
    document.querySelector('.ytp-caption-window-container') || document.querySelector('.ytp-caption-window');
  _cachedVideo = video;
  _cachedCaptionWindow = captionWindow;
  _cacheValidUntil = now + 2000;
  return { video, captionWindow };
}
```

Move the `captionSegment` query inside the `debugVerboseCC` conditional in `tick()`.

**Step 8: Verify and commit**

Verify: Open the script in Tampermonkey editor, confirm no syntax errors. Load tv.youtube.com and verify the script initializes (check console for `[YTTV-Mute] Booted`).

```bash
git add youtubetv-auto-mute.user.js
git commit -m "refactor: quick wins — debounce storage, fix hotkeys, add State object, cache DOM

- Debounce caption log writes to 5-second intervals (was every caption)
- Fix Ctrl+F hijacking browser Find → Ctrl+Shift+F
- Extract truncate() utility (replaces 7 inline truncations)
- Add Verdict enum with isAdVerdict/isProgramVerdict helpers
- Consolidate 12+ let vars into State object with reset()
- Cache detectNodes() with 2s TTL and isConnected validation
- Fix double kvGet at boot"
```

---

## Task 2: Architecture — SignalCollector, ConfidenceScorer, DecisionEngine

**Files:**
- Modify: `youtubetv-auto-mute.user.js`

This is the core architectural change. We replace the verdict-based pipeline with signal aggregation.

**Step 1: Add WEIGHT constants**

After the Verdict enum, add:
```javascript
const WEIGHT = Object.freeze({
  BASE: 50,
  HARD_PHRASE: 40,
  BREAK_CUE: 38,
  BRAND_DETECTED: 15,
  AD_CONTEXT: 10,
  CTA_DETECTED: 8,
  OFFER_DETECTED: 8,
  URL_PRESENT: 10,
  PHONE_PRESENT: 10,
  IMPERATIVE_VOICE: 8,
  SHORT_PUNCHY: 6,
  CAPS_HEAVY: 6,
  PUNCT_HEAVY: 4,
  PRICE_MENTION: 5,
  CAPTION_LOSS_MAX: 18,
  CAPTION_BOTTOMED: 4,
  PROGRAM_ALLOW: -45,
  RETURN_FROM_BREAK: -42,
  ANCHOR_NAME: -28,
  PROGRAM_ANCHOR: -25,
  GUEST_INTRO: -22,
  SEGMENT_NAME: -18,
  CONVERSATIONAL: -12,
  THIRD_PERSON: -8,
  LOCK_FLOOR: 65,
  QUORUM_REDUCTION_PER: 4,
});
```

**Step 2: Add PhraseIndex**

Replace the loose `HARD_AD_PHRASES`, `BRAND_TERMS`, `AD_CONTEXT`, `ALLOW_PHRASES`, `BREAK_PHRASES`, `CTA_TERMS`, `OFFER_TERMS` variables with:

```javascript
const PhraseIndex = {
  _compiled: {},

  rebuild(settings) {
    const norm = (val) => {
      const raw = Array.isArray(val) ? val.join('\n') : (val || '');
      return raw.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
    };
    const compile = (phrases) => {
      if (!phrases.length) return null;
      const escaped = phrases.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      return new RegExp('(' + escaped.join('|') + ')', 'i');
    };

    this.lists = {
      hard: norm(settings.hardPhrases),
      brand: norm(settings.brandTerms),
      adContext: norm(settings.adContext),
      cta: norm(settings.ctaTerms),
      offer: norm(settings.offerTerms),
      allow: norm(settings.allowPhrases),
      break_: norm(settings.breakPhrases),
      anchor: norm(settings.anchorNames || []),
      segment: norm(settings.segmentNames || []),
      returnBreak: norm(settings.returnFromBreakPhrases || []),
    };

    for (const [key, list] of Object.entries(this.lists)) {
      this._compiled[key] = compile(list);
    }
  },

  match(category, text) {
    const re = this._compiled[category];
    if (!re) return null;
    const m = text.match(re);
    return m ? m[1] : null;
  },

  matchAll(category, text) {
    const re = this._compiled[category];
    if (!re) return [];
    const globalRe = new RegExp(re.source, 'gi');
    const matches = [];
    let m;
    while ((m = globalRe.exec(text)) !== null) matches.push(m[1]);
    return matches;
  }
};
```

Call `PhraseIndex.rebuild(S)` at boot and in the settings save handler.

**Step 3: Add TextAnalyzer (charCode-based)**

Replace `analyzeTextFeatures()` with:
```javascript
const TextAnalyzer = {
  analyze(text) {
    if (!text) return { capsRatio: 0, punctDensity: 0, shortText: false, priceCount: 0, wordCount: 0 };
    let upper = 0, letter = 0, punct = 0, wordCount = 0, inWord = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 65 && c <= 90) { upper++; letter++; }
      else if (c >= 97 && c <= 122) { letter++; }
      else if (c === 33 || c === 63) { punct++; }
      const isAlpha = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
      if (isAlpha && !inWord) { wordCount++; inWord = true; }
      else if (!isAlpha) { inWord = false; }
    }
    const priceCount = (text.match(/\$\d+|\d+\s?(?:dollars?|cents?)/gi) || []).length;
    return {
      capsRatio: letter > 0 ? upper / letter : 0,
      punctDensity: text.length > 0 ? punct / text.length : 0,
      shortText: text.length > 0 && text.length < 50,
      priceCount,
      wordCount,
    };
  },

  imperativeScore(text) {
    const words = text.toLowerCase().split(/\s+/);
    if (words.length < 3) return 0;
    const pronouns = new Set(['you', 'your', "you're", 'yourself']);
    const imperatives = new Set(['get', 'call', 'visit', 'try', 'ask', 'switch', 'start', 'save', 'protect', 'discover', 'order', 'apply', 'enroll', 'join', 'claim']);
    let count = 0;
    for (const w of words) {
      if (pronouns.has(w) || imperatives.has(w)) count++;
    }
    return count / words.length;
  },

  conversationalScore(text) {
    const words = text.toLowerCase().split(/\s+/);
    if (words.length < 5) return 0;
    const thirdPerson = new Set(['they', 'their', 'them', 'the company', 'analysts', 'investors', 'the market', 'the stock']);
    const analytical = new Set(['reported', 'expects', 'estimates', 'revenue', 'growth', 'decline', 'forecast', 'quarter', 'year-over-year', 'consensus', 'guidance']);
    let count = 0;
    for (const w of words) {
      if (thirdPerson.has(w) || analytical.has(w)) count++;
    }
    return count / words.length;
  }
};
```

**Step 4: Add SignalCollector**

```javascript
const SignalCollector = {
  signals: [],

  register(name, fn) {
    this.signals.push({ name, fn });
  },

  collectAll(ccText, env) {
    const results = [];
    for (const s of this.signals) {
      const r = s.fn(ccText, env);
      if (r) results.push({ source: s.name, ...r });
    }
    return results;
  }
};
```

**Step 5: Register all signal analyzers**

```javascript
// --- Ad-leaning signals ---

SignalCollector.register('hardPhrase', (text, env) => {
  const match = PhraseIndex.match('hard', text);
  return match ? { weight: WEIGHT.HARD_PHRASE, label: 'Hard ad phrase', match } : null;
});

SignalCollector.register('breakCue', (text, env) => {
  const match = PhraseIndex.match('break_', text);
  return match ? { weight: WEIGHT.BREAK_CUE, label: 'Break cue', match } : null;
});

SignalCollector.register('brandDetected', (text, env) => {
  const match = PhraseIndex.match('brand', text);
  if (!match) return null;
  // Suppress brand weight if guest intro detected in same text
  if (env.guestIntroDetected) return null;
  // Brand alone cannot start ad lock — reduce weight if no lock active
  const w = (State.adLockUntil > Date.now()) ? WEIGHT.BRAND_DETECTED : Math.round(WEIGHT.BRAND_DETECTED * 0.5);
  return { weight: w, label: 'Brand detected', match };
});

SignalCollector.register('adContext', (text, env) => {
  const match = PhraseIndex.match('adContext', text);
  if (!match && !URL_RE.test(text) && !PHONE_RE.test(text)) return null;
  return { weight: WEIGHT.AD_CONTEXT, label: 'Ad context', match: match || 'url/phone' };
});

SignalCollector.register('ctaDetected', (text, env) => {
  const match = PhraseIndex.match('cta', text);
  return match ? { weight: WEIGHT.CTA_DETECTED, label: 'CTA', match } : null;
});

SignalCollector.register('offerDetected', (text, env) => {
  const match = PhraseIndex.match('offer', text);
  return match ? { weight: WEIGHT.OFFER_DETECTED, label: 'Offer', match } : null;
});

SignalCollector.register('urlOrPhone', (text, env) => {
  const hasUrl = URL_RE.test(text);
  const hasPhone = PHONE_RE.test(text);
  if (!hasUrl && !hasPhone) return null;
  const w = (hasUrl ? WEIGHT.URL_PRESENT : 0) + (hasPhone ? WEIGHT.PHONE_PRESENT : 0);
  return { weight: w, label: hasUrl && hasPhone ? 'URL+Phone' : hasUrl ? 'URL' : 'Phone', match: null };
});

SignalCollector.register('textFeatures', (text, env) => {
  const f = env.textFeatures;
  let w = 0, parts = [];
  if (f.capsRatio > 0.3) { w += WEIGHT.CAPS_HEAVY; parts.push('caps'); }
  if (f.punctDensity > 0.05) { w += WEIGHT.PUNCT_HEAVY; parts.push('punct'); }
  if (f.priceCount > 0) { w += f.priceCount * WEIGHT.PRICE_MENTION; parts.push('price'); }
  return w > 0 ? { weight: w, label: 'Text features: ' + parts.join('+'), match: null } : null;
});

SignalCollector.register('imperativeVoice', (text, env) => {
  const score = env.imperativeScore;
  if (score <= 0.08) return null;
  const w = Math.min(WEIGHT.IMPERATIVE_VOICE, Math.round(score * 100));
  return { weight: w, label: 'Imperative voice', match: `ratio=${score.toFixed(2)}` };
});

SignalCollector.register('shortPunchyLines', (text, env) => {
  const window = State.captionWindow;
  if (window.length < 3) return null;
  const avgLen = window.reduce((s, l) => s + l.length, 0) / window.length;
  if (avgLen >= 50) return null;
  return { weight: WEIGHT.SHORT_PUNCHY, label: 'Short punchy lines', match: `avgLen=${Math.round(avgLen)}` };
});

SignalCollector.register('captionLoss', (text, env) => {
  if (env.captionsExist) { State.noCcConsec = 0; return null; }
  State.noCcConsec++;
  if (env.noCcMs < S.muteOnNoCCDelayMs || State.noCcConsec < S.noCcHitsToMute) return null;
  const w = Math.min(WEIGHT.CAPTION_LOSS_MAX, Math.round(env.noCcMs / 400));
  return { weight: w, label: 'Caption loss', match: `noCcMs=${env.noCcMs}` };
});

SignalCollector.register('captionBottomed', (text, env) => {
  if (!env.captionsBottomed) { State.bottomConsec = 0; return null; }
  State.bottomConsec++;
  return State.bottomConsec >= 2 ? { weight: WEIGHT.CAPTION_BOTTOMED, label: 'Bottom captions', match: null } : null;
});

// --- Program-leaning signals ---

SignalCollector.register('programAllow', (text, env) => {
  const match = PhraseIndex.match('allow', text);
  return match ? { weight: WEIGHT.PROGRAM_ALLOW, label: 'Program allow', match } : null;
});

SignalCollector.register('returnFromBreak', (text, env) => {
  const match = PhraseIndex.match('returnBreak', text);
  return match ? { weight: WEIGHT.RETURN_FROM_BREAK, label: 'Return from break', match } : null;
});

SignalCollector.register('anchorName', (text, env) => {
  const match = PhraseIndex.match('anchor', text);
  return match ? { weight: WEIGHT.ANCHOR_NAME, label: 'Anchor name', match } : null;
});

SignalCollector.register('programAnchor', (text, env) => {
  const m = PROGRAM_ANCHOR_RE.exec(text);
  return m ? { weight: WEIGHT.PROGRAM_ANCHOR, label: 'Program anchor', match: m[1] } : null;
});

SignalCollector.register('guestIntro', (text, env) => {
  if (!env.guestIntroDetected) return null;
  return { weight: WEIGHT.GUEST_INTRO, label: 'Guest intro', match: env.guestIntroMatch };
});

SignalCollector.register('segmentName', (text, env) => {
  const match = PhraseIndex.match('segment', text);
  return match ? { weight: WEIGHT.SEGMENT_NAME, label: 'Segment name', match } : null;
});

SignalCollector.register('conversational', (text, env) => {
  const score = env.conversationalScore;
  const longLine = text.length > 80;
  if (score <= 0.05 && !longLine) return null;
  let w = 0;
  if (score > 0.05) w += Math.min(Math.abs(WEIGHT.CONVERSATIONAL), Math.round(score * 120));
  if (longLine) w += Math.abs(WEIGHT.THIRD_PERSON);
  return { weight: -w, label: 'Conversational', match: `score=${score.toFixed(2)},len=${text.length}` };
});
```

**Step 6: Add ConfidenceScorer**

```javascript
function calculateConfidence(signalResults) {
  let score = WEIGHT.BASE;
  for (const signal of signalResults) {
    score += signal.weight;
  }
  if (State.adLockUntil > Date.now() && score < WEIGHT.LOCK_FLOOR) {
    score = WEIGHT.LOCK_FLOOR;
  }
  score -= State.programQuorumCount * WEIGHT.QUORUM_REDUCTION_PER;
  return Math.max(0, Math.min(100, Math.round(score)));
}
```

**Step 7: Add DecisionEngine**

```javascript
function decide(confidence, signalResults) {
  const t = Date.now();

  if (State.manualMuteActive) return { shouldMute: true, reason: 'MANUAL_MUTE' };
  if (!State.enabled) return { shouldMute: false, reason: 'DISABLED' };
  if (t < State.manualOverrideUntil) return { shouldMute: false, reason: 'MANUAL_OVERRIDE' };

  const meetsThreshold = confidence >= S.confidenceThreshold;
  const hasStrongProgram = signalResults.some(s =>
    s.source === 'programAllow' || s.source === 'returnFromBreak');

  // Strong program clears ad lock
  if (hasStrongProgram) {
    State.adLockUntil = 0;
    State.programVotes = S.programVotesNeeded;
    State.programQuorumCount = S.programQuorumLines;
    return { shouldMute: false, reason: 'PROGRAM_CONFIRMED' };
  }

  // Extend ad lock on high confidence
  if (meetsThreshold && confidence >= 75) {
    State.adLockUntil = Math.max(State.adLockUntil, t + S.minAdLockMs);
    State.programVotes = 0;
    State.programQuorumCount = 0;
    State.lastProgramGoodMs = 0;
  }

  const lockActive = t < State.adLockUntil;

  // Program quorum tracking
  const programSignal = signalResults.some(s => s.weight < -10);
  if (programSignal && !lockActive) {
    State.programVotes = Math.min(S.programVotesNeeded, State.programVotes + 1);
    State.programQuorumCount = Math.min(S.programQuorumLines, State.programQuorumCount + 1);
    if (!State.lastProgramGoodMs) State.lastProgramGoodMs = t;
  } else if (meetsThreshold) {
    State.programQuorumCount = 0;
    State.programVotes = 0;
    State.lastProgramGoodMs = 0;
  }

  // Ad lock holds mute
  if (lockActive && meetsThreshold) return { shouldMute: true, reason: 'AD_LOCK' };
  if (lockActive) return { shouldMute: State.lastMuteState === true, reason: 'AD_LOCK_FADING' };

  // Above threshold = mute
  if (meetsThreshold) return { shouldMute: true, reason: 'CONFIDENCE_HIGH' };

  // Below threshold — require quorum to unmute
  const votesOK = State.programVotes >= S.programVotesNeeded;
  const quorumOK = State.programQuorumCount >= S.programQuorumLines;
  const timeOK = State.lastProgramGoodMs && (t - State.lastProgramGoodMs >= S.unmuteDebounceMs);
  if (votesOK && quorumOK && timeOK) return { shouldMute: false, reason: 'PROGRAM_QUORUM_MET' };

  return { shouldMute: State.lastMuteState === true, reason: 'BUILDING_QUORUM' };
}
```

**Step 8: Rewrite the orchestrator (tick/evaluate)**

Replace `evaluate()` with:
```javascript
function evaluate(video, ccText, captionsExist, captionsBottomed) {
  const t = Date.now();
  if (captionsExist) State.lastCcSeenMs = t;
  const noCcMs = t - State.lastCcSeenMs;

  // Pre-compute features for signals
  const textFeatures = TextAnalyzer.analyze(ccText);
  const imperativeScore = ccText ? TextAnalyzer.imperativeScore(ccText) : 0;
  const conversationalScore = ccText ? TextAnalyzer.conversationalScore(ccText) : 0;

  // Guest intro detection (pre-pass so brandDetected can check)
  let guestIntroDetected = false, guestIntroMatch = null;
  if (ccText && PhraseIndex.match('brand', ccText)) {
    const introRe = /(?:joining us|joins us|let's bring in|with us from|our guest from|from)\s+/i;
    const titleRe = /(?:ceo|cfo|coo|president|chairman|chief|analyst|strategist|manager|economist|director)\b/i;
    if (introRe.test(ccText) || titleRe.test(ccText)) {
      guestIntroDetected = true;
      guestIntroMatch = ccText;
    }
  }

  const env = { captionsExist, captionsBottomed, noCcMs, textFeatures, imperativeScore, conversationalScore, guestIntroDetected, guestIntroMatch };

  // Collect all signals
  const signals = SignalCollector.collectAll(ccText || '', env);

  // Calculate confidence
  const confidence = calculateConfidence(signals);
  State.currentConfidence = confidence;

  // Decide mute state
  const decision = decide(confidence, signals);

  // Store last signals for feedback system
  State.lastSignals = signals;

  // Apply mute
  setMuted(video, decision.shouldMute, {
    reason: decision.reason,
    match: signals.find(s => s.match)?.match || null,
    ccSnippet: truncate(ccText),
    noCcMs,
    confidence,
    signals,
  });
}
```

Update `setMuted()` to accept the new info shape (signals array for HUD display).

**Step 9: Remove old detection functions**

Delete `detectAdSignals()`, `nonTextAdSignal()`, `isProgramAnchor()`, `containsAny()`, and the old `calculateConfidence()`. Also delete the loose phrase array variables (`HARD_AD_PHRASES`, `BRAND_TERMS`, etc.) since they are now in `PhraseIndex`.

**Step 10: Restructure HUD to build once**

Replace `updateHUDText()` with a version that:
1. On first call, builds the HUD innerHTML with stable element IDs
2. Caches references to the status span, meter span, slider, and slider value
3. On subsequent calls, updates only `.textContent` and `.style.color` on cached elements
4. Attaches the slider `input` listener only once (with `change` for settings save)

**Step 11: Replace route MutationObserver with History API**

Replace `attachRouteObserver()` with:
```javascript
function watchRouteChanges() {
  function onRouteChange() {
    if (NS._lastUrl === location.href) return;
    NS._lastUrl = location.href;
    log('Route change →', NS._lastUrl);
    State.reset(true);
    if (NS.hudTimer) { clearTimeout(NS.hudTimer); NS.hudTimer = null; }
    if (NS.hudAnimTimer) { clearTimeout(NS.hudAnimTimer); NS.hudAnimTimer = null; }
    startLoop();
  }
  const origPush = history.pushState;
  history.pushState = function() { origPush.apply(this, arguments); onRouteChange(); };
  const origReplace = history.replaceState;
  history.replaceState = function() { origReplace.apply(this, arguments); onRouteChange(); };
  window.addEventListener('popstate', onRouteChange);
}
```

Remove the old `NS.routeObserver` and its cleanup.

**Step 12: Clean up CC observer attach timer**

In `attachCcObserver()`, after successful attach, clear the timer:
```javascript
clearInterval(NS.ccAttachTimer);
NS.ccAttachTimer = null;
```
In `tick()`, if captionWindow is gone and timer is null, restart it.

**Step 13: Update version header to v4.0.0**

Update the `@version` line and the boot log.

**Step 14: Verify and commit**

```bash
git add youtubetv-auto-mute.user.js
git commit -m "feat: signal-aggregation confidence system (v4.0.0)

Replace verdict-based detection with SignalCollector + ConfidenceScorer +
DecisionEngine. No single signal can trigger a mute — all signals
contribute weighted scores to a 0-100 confidence meter.

- Add PhraseIndex with compiled regex (3-10x faster matching)
- Add TextAnalyzer with charCode loop (no regex array allocations)
- Add 18 registered signal analyzers (ad + program leaning)
- Add WEIGHT constants for all signal weights
- Restructure HUD to build once and update text nodes only
- Replace document MutationObserver with History API interception
- Rewrite evaluate() as thin orchestrator"
```

---

## Task 3: Settings Panel — Data-Driven Refactor

**Files:**
- Modify: `youtubetv-auto-mute.user.js`

**Step 1: Add SETTING_FIELDS declaration**

Before `buildPanel()`, add a data-driven field declaration array. Each entry describes one setting with its UI metadata:

```javascript
const SETTING_FIELDS = [
  // General tab
  { id: 'useTrueMute', tab: 'general', type: 'checkbox', label: 'True mute (vs low volume)' },
  { id: 'debug', tab: 'general', type: 'checkbox', label: 'Console debug logging' },
  { id: 'debugVerboseCC', tab: 'general', type: 'checkbox', label: 'Verbose CC debug' },
  { id: 'llmReviewEnabled', tab: 'general', type: 'checkbox', label: 'Enable LLM Review', section: 'Review Features' },
  { id: 'showFrequentWords', tab: 'general', type: 'checkbox', label: 'Show Frequent Words' },
  { id: 'hideCaptions', tab: 'general', type: 'checkbox', label: 'Hide captions from view', section: 'Caption Display' },
  // HUD tab
  { id: 'showHUD', tab: 'hud', type: 'checkbox', label: 'Show HUD always' },
  { id: 'hudAutoOnMute', tab: 'hud', type: 'checkbox', label: 'Auto HUD on mute' },
  { id: 'showConfidenceMeter', tab: 'hud', type: 'checkbox', label: 'Show confidence meter', section: 'Confidence Meter' },
  { id: 'showHudSlider', tab: 'hud', type: 'checkbox', label: 'Show threshold slider on HUD' },
  { id: 'confidenceMeterStyle', tab: 'hud', type: 'select', label: 'Meter style', options: [['bar','Bar'],['numeric','Numeric'],['both','Both']] },
  { id: 'confidenceThreshold', tab: 'hud', type: 'range', min: 0, max: 100, label: 'Mute confidence threshold' },
  { id: 'hudAutoDelayMs', tab: 'hud', type: 'number', min: 0, max: 60000, label: 'Auto delay (ms)', section: 'Animation' },
  { id: 'hudFadeMs', tab: 'hud', type: 'number', min: 0, max: 2000, label: 'Fade (ms)' },
  { id: 'hudSlidePx', tab: 'hud', type: 'number', min: 0, max: 50, label: 'Slide (px)' },
  // Timing tab
  { id: 'intervalMs', tab: 'timing', type: 'number', min: 50, max: 2000, label: 'Poll interval (ms)' },
  { id: 'muteOnNoCCDelayMs', tab: 'timing', type: 'number', min: 0, max: 5000, label: 'Mute on CC loss (ms)' },
  { id: 'noCcHitsToMute', tab: 'timing', type: 'number', min: 1, max: 6, label: 'No-CC hits to mute' },
  { id: 'unmuteDebounceMs', tab: 'timing', type: 'number', min: 0, max: 5000, label: 'Unmute debounce (ms)' },
  { id: 'minAdLockMs', tab: 'timing', type: 'number', min: 0, max: 120000, label: 'Ad lock (ms)', section: 'Ad Lock' },
  { id: 'programVotesNeeded', tab: 'timing', type: 'number', min: 1, max: 6, label: 'Program votes needed' },
  { id: 'programQuorumLines', tab: 'timing', type: 'number', min: 1, max: 10, label: 'Quorum lines' },
  { id: 'manualOverrideMs', tab: 'timing', type: 'number', min: 0, max: 60000, label: 'Manual override (ms)' },
  // Phrases tab
  { id: 'hardPhrases', tab: 'phrases', type: 'textarea', rows: 7, label: 'Hard Ad Phrases' },
  { id: 'brandTerms', tab: 'phrases', type: 'textarea', rows: 6, label: 'Brand Terms' },
  { id: 'adContext', tab: 'phrases', type: 'textarea', rows: 6, label: 'Ad Context' },
  { id: 'ctaTerms', tab: 'phrases', type: 'textarea', rows: 5, label: 'CTA Terms' },
  { id: 'offerTerms', tab: 'phrases', type: 'textarea', rows: 5, label: 'Offer Terms' },
  { id: 'allowPhrases', tab: 'phrases', type: 'textarea', rows: 6, label: 'Allow Phrases (program cues)' },
  { id: 'breakPhrases', tab: 'phrases', type: 'textarea', rows: 5, label: 'Break Phrases' },
  { id: 'anchorNames', tab: 'phrases', type: 'textarea', rows: 5, label: 'CNBC Anchor Names' },
  { id: 'segmentNames', tab: 'phrases', type: 'textarea', rows: 5, label: 'Segment Names' },
  { id: 'returnFromBreakPhrases', tab: 'phrases', type: 'textarea', rows: 5, label: 'Return-from-Break Phrases' },
];
```

**Step 2: Write `populatePanel()` and `readPanel()` helpers**

```javascript
function populatePanel(panel, settings) {
  for (const f of SETTING_FIELDS) {
    const el = panel.querySelector('#' + f.id);
    if (!el) continue;
    const val = settings[f.id];
    if (f.type === 'checkbox') el.checked = !!val;
    else if (f.type === 'textarea') el.value = Array.isArray(val) ? val.join('\n') : (val || '');
    else el.value = val;
  }
}

function readPanel(panel) {
  const out = {};
  for (const f of SETTING_FIELDS) {
    const el = panel.querySelector('#' + f.id);
    if (!el) continue;
    if (f.type === 'checkbox') out[f.id] = el.checked;
    else if (f.type === 'number' || f.type === 'range') out[f.id] = clampInt(el.value, f.min, f.max, DEFAULTS[f.id]);
    else if (f.type === 'textarea') {
      const lines = el.value.split('\n').map(s => s.trim()).filter(Boolean);
      out[f.id] = Array.isArray(DEFAULTS[f.id]) ? lines : el.value;
    }
    else out[f.id] = el.value;
  }
  return out;
}
```

**Step 3: Rewrite `buildPanel()` using SETTING_FIELDS**

Generate the tab contents programmatically from `SETTING_FIELDS`. The panel header and tab bar stay as HTML strings. Each tab content is generated by iterating fields for that tab. The save handler becomes:
```javascript
Object.assign(S, readPanel(panel));
PhraseIndex.rebuild(S);
saveSettings(S);
applySettings(true);
```

**Step 4: Verify and commit**

```bash
git add youtubetv-auto-mute.user.js
git commit -m "refactor: data-driven settings panel

Replace 275-line buildPanel() with data-driven SETTING_FIELDS
declaration + populatePanel/readPanel helpers. Adding a new
setting now requires one entry in SETTING_FIELDS + DEFAULTS."
```

---

## Task 4: Detection Accuracy — Phrase Lists & Timing

**Files:**
- Modify: `youtubetv-auto-mute.user.js`

**Step 1: Add new phrase lists to DEFAULTS**

Add these new keys to the DEFAULTS object:

```javascript
// CNBC anchor names
anchorNames: [
  "sara eisen","scott wapner","jim cramer","carl quintanilla","david faber",
  "melissa lee","kelly evans","joe kernen","becky quick","andrew ross sorkin",
  "brian sullivan","tyler mathisen","rick santelli","steve liesman","mike santoli",
  "diana olick","robert frank","meg tirrell","dominic chu","leslie picker",
  "kate rooney","courtney reagan","deirdre bosa","julia boorstin","frank holland",
  "contessa brewer","seema mody","kristina partsinevelos","bertha coombs",
  "guy adami","karen finerman","tim seymour","dan nathan"
],

// Named segments
segmentNames: [
  "final trades","lightning round","stop trading","call of the day","stock draft",
  "investment committee","options action","cramer's game plan","cramer's lightning round",
  "off the charts","the bottom line","market zone","halftime overtime","unusual activity"
],

// Return-from-break phrases
returnFromBreakPhrases: [
  "and we are back","all right we are back","okay we are back",
  "welcome back everybody","welcome back to squawk","welcome back to closing bell",
  "welcome back to the halftime report","welcome back to power lunch",
  "welcome back to fast money","before the break we were","as we were discussing"
],
```

**Step 2: Expand allowPhrases**

Add CNBC show names, conversational phrases, and welcome variants to `allowPhrases`:
```javascript
// Add to existing allowPhrases array:
"squawk box","squawk on the street","power lunch","fast money","mad money",
"halftime report","money movers","last call","worldwide exchange","the exchange",
"cnbc special report",
"welcome to squawk","welcome to power lunch","welcome to fast money",
"welcome to the halftime report","welcome to mad money",
"let's get to","let's bring in","let's go to","i want to bring in",
"thanks for being with us","thank you for joining us","good to have you",
"appreciate your time","let's get a check on","the ten-year","treasury yield",
"federal reserve","rate cut","rate hike","basis points",
"take a look at this","straight ahead","still to come","coming up","up next on"
```

**Step 3: Medicare reclassification**

Move from `hardPhrases` to `brandTerms`: "medicare", "medicare advantage", "part c", "dual-eligible", "special needs plan", "enrollment ends", "annual election period", "aep", "open enrollment", "enroll by", "humana", "unitedhealthcare", "anthem", "aetna"

Keep in `hardPhrases`: "licensed agent", "call the number", "tty", "$0 premium", "$0 copay", "speak to a licensed agent", "talk to a licensed agent"

Add to `hardPhrases`: "tell your doctor about all the medicines you take", "important safety information", "results may vary", "individual results", "injection site reactions", "risk of thyroid tumors", "paid programming", "paid advertisement", "the following is a paid", "the preceding was a paid"

**Step 4: Expand brandTerms**

Add all missing advertisers from the design doc (financial, tech, pharma, gold, legal, other categories).

**Step 5: Expand adContext, breakPhrases**

Add the additional ad context phrases and break phrases from the design doc.

**Step 6: Update PROGRAM_ANCHOR_RE**

Add show names and segment names to the regex:
```javascript
const PROGRAM_ANCHOR_RE = new RegExp(
  String.raw`\b(joins us now|joining me now|welcome to|welcome back|we'?re back|back with|back to you|from washington|live (?:in|at)|earnings|beat estimates|raised guidance|analyst|conference call|tariffs?|supreme court|breaking news|economic data|cpi|ppi|jobs report|nonfarm payrolls|market (?:breadth|reaction)|s&p|nasdaq|dow|chief investment officer|portfolio manager|senior analyst|ceo|cfo|chair|closing bell|overtime|squawk box|squawk on the street|power lunch|fast money|mad money|halftime report|money movers|last call|worldwide exchange|the exchange|lightning round|final trades|stop trading)\b`,
  'i'
);
```

**Step 7: Update timing defaults**

```javascript
minAdLockMs: 75000,       // was 20000
muteOnNoCCDelayMs: 2500,  // was 180
confidenceThreshold: 65,  // was 70
```

**Step 8: Verify and commit**

```bash
git add youtubetv-auto-mute.user.js
git commit -m "feat: expand CNBC detection — shows, anchors, advertisers, timing

- Add 33 CNBC anchor names as program signals
- Add 14 named segments (lightning round, final trades, etc.)
- Add 11 return-from-break phrases
- Add ~30 CNBC show names and welcome variants to allowPhrases
- Expand brandTerms with ~80 new advertisers across 6 categories
- Reclassify medicare terms from hard phrases to brand terms
- Add pharma disclaimer phrases to hard phrases
- Increase minAdLockMs 20s→75s, muteOnNoCCDelayMs 180ms→2500ms"
```

---

## Task 5: Feedback System

**Files:**
- Modify: `youtubetv-auto-mute.user.js`

**Step 1: Add feedback log storage**

```javascript
const FEEDBACK_KEY = 'yttp_feedback_log';
let _feedbackLog = kvGet(FEEDBACK_KEY, []);
if (!Array.isArray(_feedbackLog)) _feedbackLog = [];
```

**Step 2: Rewrite flagIncorrectState()**

```javascript
function flagIncorrectState() {
  const { captionWindow, video } = detectNodes();
  const cc = (captionWindow?.textContent || '').trim();
  const wasMuted = State.lastMuteState === true;

  const entry = {
    timestamp: new Date().toISOString(),
    action: wasMuted ? 'FALSE_POSITIVE' : 'FALSE_NEGATIVE',
    wasMuted,
    captionText: truncate(cc, 200),
    lastNLines: [...State.captionWindow],
    confidence: State.currentConfidence,
    signals: (State.lastSignals || []).map(s => ({
      source: s.source, weight: s.weight, match: s.match
    })),
    adLockActive: Date.now() < State.adLockUntil,
    url: location.href,
    programQuorum: State.programQuorumCount,
  };

  _feedbackLog.push(entry);
  kvSet(FEEDBACK_KEY, _feedbackLog);

  // Also log to caption log for backward compat
  pushEventLog('FLAG_INCORRECT_STATE', {
    reason: entry.action, ccSnippet: entry.captionText, url: entry.url,
    noCcMs: Date.now() - State.lastCcSeenMs,
    lock: Math.max(0, State.adLockUntil - Date.now()),
    pv: State.programVotes, quorum: State.programQuorumCount
  });

  // Toggle mute state
  if (video) {
    if (wasMuted) {
      State.adLockUntil = 0;
      State.programQuorumCount = S.programQuorumLines;
      State.manualOverrideUntil = Date.now() + S.manualOverrideMs;
      setMuted(video, false, { reason: 'FLAG_UNMUTE', match: null, ccSnippet: truncate(cc), noCcMs: Date.now() - State.lastCcSeenMs, confidence: State.currentConfidence, signals: [] });
    } else {
      setMuted(video, true, { reason: 'FLAG_MUTE', match: null, ccSnippet: truncate(cc), noCcMs: Date.now() - State.lastCcSeenMs, confidence: State.currentConfidence, signals: [] });
    }
  }

  log('Feedback logged:', entry.action, 'confidence:', entry.confidence, 'signals:', entry.signals.length);
}
```

**Step 3: Add feedback export to settings panel**

In the Actions tab, add a "Download Feedback Log" button:
```javascript
{ id: 'dlFeedback', tab: 'actions', type: 'button', label: 'Download Feedback Log (JSON)',
  action: () => downloadText('yttp_feedback.json', JSON.stringify(_feedbackLog, null, 2)) }
```

Add a "Clear Feedback Log" button:
```javascript
{ id: 'clearFeedback', tab: 'actions', type: 'button', label: 'Clear Feedback Log',
  action: () => { _feedbackLog = []; kvSet(FEEDBACK_KEY, _feedbackLog); } }
```

**Step 4: Add signal breakdown to HUD (optional, for always-show mode)**

When `S.showHUD` is true, append the top 3 contributing signals to the HUD text:
```javascript
if (S.showHUD && signals.length > 0) {
  const topSignals = [...signals].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 3);
  const sigText = topSignals.map(s => `${s.weight > 0 ? '+' : ''}${s.weight} ${s.source}`).join(', ');
  // Update the HUD signal span textContent
}
```

**Step 5: Verify and commit**

```bash
git add youtubetv-auto-mute.user.js
git commit -m "feat: structured feedback system with signal breakdown

- Separate feedback log from caption log (JSON format)
- Each feedback entry captures full signal array with weights
- Download feedback as JSON for analysis and weight tuning
- Show top 3 signals on HUD in always-show mode
- Ctrl+Shift+F captures last 5 caption lines for context"
```

---

## Task 6: New Features — Sliding Window & Volume Ramp

**Files:**
- Modify: `youtubetv-auto-mute.user.js`

**Step 1: Add settings for new features**

```javascript
// In DEFAULTS:
captionWindowSize: 5,     // Number of recent caption lines to keep
volumeRampMs: 1500,       // Volume ramp duration on unmute (0 = instant)
```

Add corresponding entries to SETTING_FIELDS.

**Step 2: Implement sliding caption window**

In `tick()`, after reading `ccText`, update the window:
```javascript
if (ccText && ccText !== State.lastCaptionLine) {
  State.captionWindow.push(ccText);
  if (State.captionWindow.length > S.captionWindowSize) {
    State.captionWindow.shift();
  }
}
```

In `evaluate()`, run detection on both the latest line AND the concatenated window:
```javascript
const windowText = State.captionWindow.join(' ');
const signalsLatest = SignalCollector.collectAll(ccText || '', env);
const envWindow = { ...env, textFeatures: TextAnalyzer.analyze(windowText), imperativeScore: TextAnalyzer.imperativeScore(windowText), conversationalScore: TextAnalyzer.conversationalScore(windowText) };
const signalsWindow = SignalCollector.collectAll(windowText, envWindow);

const confLatest = calculateConfidence(signalsLatest);
const confWindow = calculateConfidence(signalsWindow);

// Use whichever has higher absolute deviation from neutral (50)
const signals = Math.abs(confLatest - 50) >= Math.abs(confWindow - 50) ? signalsLatest : signalsWindow;
const confidence = Math.abs(confLatest - 50) >= Math.abs(confWindow - 50) ? confLatest : confWindow;
```

**Step 3: Implement volume ramping**

```javascript
let _rampTimer = null;
let _rampTargetVolume = 1.0;

function applyMute(video, shouldMute) {
  if (!video) return;

  // Cancel any active ramp
  if (_rampTimer) { cancelAnimationFrame(_rampTimer); _rampTimer = null; }

  if (shouldMute) {
    if (S.useTrueMute) { video.muted = true; }
    else { video.volume = 0.01; }
    return;
  }

  // Unmute with optional ramp
  if (S.volumeRampMs <= 0 || !S.useTrueMute) {
    // Instant unmute or low-volume mode
    if (S.useTrueMute) video.muted = false;
    else video.volume = Math.max(_rampTargetVolume, 0.5);
    return;
  }

  // Ramp: unmute at low volume, then ramp up
  video.muted = false;
  video.volume = 0.05;
  const startTime = performance.now();
  const startVol = 0.05;
  const endVol = _rampTargetVolume || 1.0;
  const duration = S.volumeRampMs;

  function step(now) {
    const elapsed = now - startTime;
    if (elapsed >= duration) {
      video.volume = endVol;
      _rampTimer = null;
      return;
    }
    const progress = elapsed / duration;
    // Ease-in curve for more natural ramp
    video.volume = startVol + (endVol - startVol) * (progress * progress);
    _rampTimer = requestAnimationFrame(step);
  }
  _rampTimer = requestAnimationFrame(step);
}
```

Replace the inline mute logic in `setMuted()` with `applyMute(video, shouldMute)`.

Before muting, save the current volume: `if (!shouldMute || !State.lastMuteState) _rampTargetVolume = video.volume || 1.0;`

**Step 4: Verify and commit**

```bash
git add youtubetv-auto-mute.user.js
git commit -m "feat: sliding caption window + volume ramping

- Keep last 5 caption lines in ring buffer
- Run detection on both latest line and full window, use strongest signal
- Volume ramp on unmute (ease-in over 1.5s, configurable)
- Cancel ramp immediately on re-mute"
```

---

## Post-Implementation Checklist

After all 6 tasks are complete:

1. Read through the entire final file to verify consistency
2. Verify the `@version` is `4.0.0`
3. Verify `@updateURL` and `@downloadURL` point to the correct raw GitHub URL
4. Verify the boot log includes the new signal count and feature flags
5. Update `README.md` to reflect v4.0 changes (new signals, new hotkeys, new settings, feedback system)
6. Commit the README update
