# YTTV Auto-Mute v4.0 — Refactor + Enhancement Design

**Date:** 2026-02-23
**Status:** Approved
**Current state:** v3.5.0, ~1023 lines, single-file userscript. Works ~90% of the time but was quickly assembled and needs cleanup + detection improvements.

---

## Goals

1. Clean up the codebase for maintainability and extensibility
2. Fix performance bottlenecks (storage writes, DOM churn, double-firing)
3. **Redesign detection as a signal-aggregation confidence system** — no single signal mutes; every signal contributes a weighted score; muting only happens when aggregate confidence crosses the threshold
4. Improve CNBC ad/program detection accuracy with new signal types
5. Add a structured feedback mechanism so users can report false positives/negatives to inform future improvements
6. Add quality-of-life features (volume ramping, sliding caption window)

## Core Design Principle

**No single signal should ever trigger a mute on its own.** Every detection signal (phrase match, caption behavior, text features, contextual patterns) contributes a positive or negative weight to a confidence score (0-100). The mute decision is made solely by comparing aggregate confidence against a user-configurable threshold. This eliminates false positives from editorial discussions of brands, Medicare policy coverage, etc.

## Constraints

- Single-file userscript (no build step, no modules)
- Must work in Tampermonkey, Greasemonkey, and Violentmonkey
- Settings backward-compatible (existing users keep their config)
- No external dependencies

---

## Execution Order

| Step | Scope | Risk | Description |
|------|-------|------|-------------|
| 1 | Quick wins | Low | Debounce storage, fix hotkeys, cache DOM, extract resetState(), add Verdict enum, extract truncate() utility |
| 2 | Architecture | Medium | State object, DetectionPipeline, DecisionEngine, HUD restructure, route detection via History API, compiled phrase regex |
| 3 | Settings panel | Low | Data-driven field declarations, break up buildPanel() |
| 4 | Detection accuracy | Low | Add CNBC shows/anchors/advertisers, fix medicare classification, adjust timing defaults |
| 5 | Feedback system | Low | Enhanced false positive/negative logging with structured data export |
| 6 | New features | Medium | Sliding caption window, volume ramping on unmute |

Each step is a standalone commit. Tests are manual (userscript context).

---

## Step 1: Quick Wins

### 1a. Debounce storage writes
- Replace immediate `kvSet(CAPLOG_KEY, ...)` in `pushCaption()` and `pushEventLog()` with a dirty flag + 5-second flush interval
- Fix double `kvGet` at boot (line 172) — cache the first call
- Debounce slider `saveSettings()` — use `change` event instead of `input`, or debounce 500ms

### 1b. Fix hotkeys
- Change `Ctrl+F` (flag incorrect state) to `Ctrl+Shift+F` to stop hijacking browser Find
- Keep `Ctrl+M` (toggle), `Ctrl+D` (download), `Ctrl+Shift+S` (settings)

### 1c. Cache DOM queries
- Cache `detectNodes()` results with `isConnected` validation and 2-second TTL
- Only query `captionSegment` when `debugVerboseCC` is enabled

### 1d. Extract resetState()
- Group all 12+ module-level `let` variables into a `State` object
- Single `State.reset(full)` method replaces 3 duplicated reset blocks
- `full=true` (route change) also resets lastMuteState, lastCaptionLine, videoRef
- `full=false` (player found) resets detection state only

### 1e. Add Verdict enum
- `Object.freeze({AD_HARD, AD_BREAK, AD_BRAND_WITH_CONTEXT, AD_SIGNAL_SCORE, PROGRAM_ALLOW, PROGRAM_ANCHOR, PROGRAM})`
- Helper predicates: `isAdVerdict(v)`, `isProgramVerdict(v)`
- Replace all ~30 string literal comparisons

### 1f. Extract truncate() utility
- `truncate(text, max=140)` replaces 7 inline truncation expressions
- Consistent ellipsis behavior across all call sites

---

## Step 2: Architecture Refactor

### File structure (within single IIFE)

```
/* ========== VERDICT ENUM ========== */
/* ========== STORAGE ========== */
/* ========== SETTINGS ========== */
/* ========== STATE ========== */
/* ========== PHRASE INDEX ========== */
/* ========== TEXT ANALYZER ========== */
/* ========== DETECTION PIPELINE ========== */
/* ========== CONFIDENCE SCORER ========== */
/* ========== DECISION ENGINE ========== */
/* ========== MUTE CONTROLLER ========== */
/* ========== LOGGER ========== */
/* ========== HUD ========== */
/* ========== SETTINGS PANEL ========== */
/* ========== CONTROL BUTTONS ========== */
/* ========== ORCHESTRATOR ========== */
/* ========== OBSERVERS ========== */
/* ========== HOTKEYS ========== */
/* ========== BOOT ========== */
```

### 2a. State object
```javascript
const State = {
  enabled: true,
  videoRef: null,
  lastMuteState: null,
  lastCaptionLine: '',
  // detection
  lastCcSeenMs: 0,
  noCcConsec: 0,
  bottomConsec: 0,
  // program gating
  programVotes: 0,
  programQuorumCount: 0,
  lastProgramGoodMs: 0,
  // locks
  adLockUntil: 0,
  manualOverrideUntil: 0,
  // ui
  currentConfidence: 0,
  manualMuteActive: false,
  lastCaptionVisibility: null,
  // timing
  lastAutoDlMs: Date.now(),
  rafScheduled: false,

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
  }
};
```

### 2b. PhraseIndex — compiled regex
- On init and on settings save, compile each phrase list to a single regex via `new RegExp(phrases.map(escape).join('|'), 'i')`
- `PhraseIndex.match(category, text)` returns the matched phrase or null
- `PhraseIndex.matchAll(category, text)` returns array of all matches (for multi-signal scoring)
- Eliminates linear `containsAny()` scans (~130 phrases per tick)

### 2c. SignalCollector — replaces the old DetectionPipeline

**The old model:** First matching strategy wins, returns a single verdict.
**The new model:** ALL signals run on every tick. Each returns a weighted contribution. The aggregate determines confidence.

```javascript
const SignalCollector = {
  signals: [],

  register(name, signalFn) {
    // signalFn(ccText, window, env) => { weight: number, label: string, matches: [] } | null
    this.signals.push({ name, fn: signalFn });
  },

  collectAll(ccText, captionWindow, env) {
    const results = [];
    for (const s of this.signals) {
      const r = s.fn(ccText, captionWindow, env);
      if (r) results.push({ source: s.name, ...r });
    }
    return results; // Array of all triggered signals with their weights
  }
};
```

**Registered signal analyzers (all run every tick):**

| Signal | Weight Range | What It Detects |
|--------|-------------|-----------------|
| `hardPhrase` | +30 to +45 | Rx disclaimers, pharma safety language, paid programming |
| `brandDetected` | +10 to +20 | Brand name present in caption |
| `adContext` | +5 to +15 | Ad-associated context phrases (.com, call now, etc.) |
| `ctaDetected` | +5 to +10 | Call-to-action language (apply, enroll, sign up) |
| `offerDetected` | +5 to +10 | Pricing/offer language ($0, per month, guarantee) |
| `breakCue` | +35 to +40 | Explicit break announcement ("we'll be right back") |
| `captionLoss` | +5 to +20 | No captions for N ms (scales with duration) |
| `captionBottomed` | +3 to +5 | Captions positioned at bottom (ad-typical) |
| `textFeatures` | +3 to +10 | High caps ratio, exclamation marks, price mentions |
| `shortPunchyLines` | +3 to +8 | Caption line < 50 chars, high turnover rate |
| `imperativeVoice` | +5 to +10 | Second-person imperative: "you/your/get/call/visit" |
| `urlOrPhone` | +8 to +12 | URL or phone number pattern in caption |
| `programAllow` | -40 to -50 | Strong program phrase ("joining me now", show names) |
| `programAnchor` | -25 to -35 | Program anchor regex match (earnings, breaking news) |
| `anchorName` | -20 to -30 | Known CNBC anchor name detected |
| `guestIntro` | -15 to -25 | Pattern: "[name] from [brand]", "[brand]'s CEO/CFO" |
| `conversational` | -5 to -15 | Long lines (>80 chars), third-person analytical language |
| `segmentName` | -10 to -20 | Known segment (lightning round, final trades) |
| `returnFromBreak` | -35 to -45 | "Welcome back", "and we are back" |

### 2d. ConfidenceScorer — aggregates signals into 0-100

```javascript
function calculateConfidence(signalResults, env) {
  let score = CONFIDENCE.BASE; // Start at 50 (neutral)

  for (const signal of signalResults) {
    score += signal.weight;
  }

  // Ad lock momentum: if in ad lock, floor at LOCK_FLOOR
  if (State.adLockUntil > Date.now() && score < CONFIDENCE.LOCK_FLOOR) {
    score = CONFIDENCE.LOCK_FLOOR;
  }

  // Program quorum momentum: reduce score as quorum builds
  score -= State.programQuorumCount * CONFIDENCE.QUORUM_REDUCTION_PER;

  return Math.max(0, Math.min(100, Math.round(score)));
}
```

**Key difference from v3.5:** In v3.5, `calculateConfidence()` was a post-hoc display layer that mapped a verdict to a fixed confidence value. In v4, confidence IS the detection — there are no verdicts, only aggregate signal weights. The confidence score directly drives the mute decision.

### 2e. DecisionEngine — uses confidence, not verdicts

```javascript
function decide(confidence, signalResults, env) {
  // Returns { shouldMute: boolean, reason: string, signals: [] }

  // Manual override check
  if (State.manualMuteActive) return { shouldMute: true, reason: 'MANUAL_MUTE' };
  if (Date.now() < State.manualOverrideUntil) return { shouldMute: false, reason: 'MANUAL_OVERRIDE' };

  const meetsThreshold = confidence >= S.confidenceThreshold;

  // Update ad lock (extend if confident, clear if strong program)
  if (meetsThreshold && confidence >= 75) {
    State.adLockUntil = Math.max(State.adLockUntil, Date.now() + S.minAdLockMs);
    State.programVotes = 0;
    State.programQuorumCount = 0;
  }

  // Strong program signals can clear ad lock
  const hasStrongProgram = signalResults.some(s =>
    s.source === 'programAllow' || s.source === 'returnFromBreak');
  if (hasStrongProgram) {
    State.adLockUntil = 0;
    return { shouldMute: false, reason: 'PROGRAM_CONFIRMED' };
  }

  // Ad lock active
  if (Date.now() < State.adLockUntil && meetsThreshold) {
    return { shouldMute: true, reason: 'AD_LOCK' };
  }

  // Normal threshold-based decision with quorum gating for unmute
  if (meetsThreshold) return { shouldMute: true, reason: 'CONFIDENCE_ABOVE_THRESHOLD' };

  // Below threshold — require quorum before unmuting
  // (prevents flickering between ad segments)
  if (State.programQuorumCount >= S.programQuorumLines) {
    return { shouldMute: false, reason: 'PROGRAM_QUORUM_MET' };
  }

  // Hold previous state while building quorum
  return { shouldMute: State.lastMuteState === true, reason: 'BUILDING_QUORUM' };
}
```

### 2e. HUD restructure
- `ensureHud()` builds the DOM once with cached element references
- `updateHud(status, reason, confidence)` updates `.textContent` and `.style` only
- Slider listener attached once during `ensureHud()`
- Check `isConnected` before updating; rebuild if detached by YouTube TV SPA

### 2f. Route detection via History API
- Intercept `history.pushState` and `history.replaceState`
- Listen for `popstate` event
- Remove the document-wide MutationObserver (eliminates hundreds of callbacks/sec)

### 2g. TextAnalyzer — charCode loop
- Replace 3 regex-based `match()` calls with a single character loop
- Only run price regex when other ad signals are present

### 2h. Confidence weights as named constants
```javascript
const WEIGHT = Object.freeze({
  // Base
  BASE: 50,                     // Neutral starting point

  // Ad-leaning signals (positive = toward muting)
  HARD_PHRASE: 40,              // Rx disclaimers, paid programming
  BREAK_CUE: 38,               // "we'll be right back"
  BRAND_DETECTED: 15,          // Brand name present
  AD_CONTEXT: 10,              // ".com", "call now", etc.
  CTA_DETECTED: 8,             // "apply now", "enroll", etc.
  OFFER_DETECTED: 8,           // "$0", "per month", "guarantee"
  URL_PRESENT: 10,             // URL pattern in caption
  PHONE_PRESENT: 10,           // Phone number pattern
  IMPERATIVE_VOICE: 8,         // "you/your" + imperative verbs
  SHORT_PUNCHY: 6,             // Short rapid-fire caption lines
  CAPS_HEAVY: 6,               // High caps ratio
  PUNCT_HEAVY: 4,              // Exclamation/question marks
  PRICE_MENTION: 5,            // Per price mentioned
  CAPTION_LOSS_MAX: 18,        // Scales with no-CC duration
  CAPTION_BOTTOMED: 4,         // Bottom-positioned captions

  // Program-leaning signals (negative = toward unmuting)
  PROGRAM_ALLOW: -45,          // Show names, strong program phrases
  RETURN_FROM_BREAK: -42,      // "welcome back", "we are back"
  ANCHOR_NAME: -28,            // Known CNBC anchor detected
  PROGRAM_ANCHOR: -25,         // Regex anchor match (earnings, etc.)
  GUEST_INTRO: -22,            // "[name] from [brand]", "[brand]'s CEO"
  SEGMENT_NAME: -18,           // "lightning round", "final trades"
  CONVERSATIONAL: -12,         // Long lines, analytical language
  THIRD_PERSON: -8,            // "the company", "they reported"

  // State modifiers
  LOCK_FLOOR: 65,              // Minimum confidence during ad lock
  QUORUM_REDUCTION_PER: 4,     // Subtracted per quorum count
});
```

**The key insight:** A brand mention like "Schwab" adds only +15 to a base of 50 = 65, which is BELOW the default 65 threshold. It takes multiple ad signals stacking (brand + context + CTA + imperative voice + short lines) to cross the threshold. Meanwhile, a guest intro or anchor name detection immediately subtracts 22-28 points, making it virtually impossible for editorial brand discussion to trigger a mute.

---

## Step 3: Settings Panel Refactor

### Data-driven field declarations
```javascript
const SETTING_FIELDS = [
  { id: 'useTrueMute', tab: 'general', type: 'checkbox', label: 'True mute (vs low volume)' },
  { id: 'intervalMs', tab: 'timing', type: 'number', min: 50, max: 2000, label: 'Poll interval (ms)' },
  { id: 'hardPhrases', tab: 'phrases', type: 'textarea', rows: 7, label: 'Hard Ad Phrases' },
  // ... all fields declared here
];
```

- `populatePanel(panel, settings)` iterates SETTING_FIELDS to set form values
- `readPanel(panel)` iterates SETTING_FIELDS to read form values back
- Adding a new setting = one entry in SETTING_FIELDS + one entry in DEFAULTS
- Reduces `buildPanel()` from 275 lines to ~100

---

## Step 4: Detection Accuracy — Phrase Lists & New Signals

All phrase lists now feed into the signal-aggregation system. No phrase list directly triggers a mute — each contributes a weighted signal.

### 4a. New signal: Guest Intro Detection (`guestIntro`, weight -15 to -25)
Regex patterns that identify editorial brand mentions:
```
/(?:joining us|joins us|let's bring in|with us from|our guest from)\s+.*?\b(BRAND)\b/i
/\b(BRAND)(?:'s)?\s+(?:ceo|cfo|coo|cto|president|chairman|chief|head of|director|analyst|strategist|manager|economist)/i
/(?:analyst|strategist|manager|economist)\s+(?:at|from|with)\s+.*?\b(BRAND)\b/i
```
Where `(BRAND)` is dynamically built from the brandTerms list. When these match, the brand signal is suppressed and a strong negative (program) weight is applied instead.

### 4b. New signal: Imperative Voice Detection (`imperativeVoice`, weight +5 to +10)
Count second-person pronouns and imperative verbs:
- Pronouns: "you", "your", "you're", "yourself"
- Imperatives: "get", "call", "visit", "try", "ask", "switch", "start", "save", "protect", "discover"
- Score: (pronoun_count + imperative_count) / word_count
- If ratio > 0.08: ad-leaning signal

### 4c. New signal: Conversational/Analytical Language (`conversational`, weight -5 to -15)
Count third-person and analytical patterns:
- Third-person: "they", "the company", "the stock", "analysts", "investors", "the market"
- Analytical: "reported", "expects", "estimates", "revenue", "growth", "decline", "forecast"
- Long caption lines (>80 chars) contribute negative weight (ads are short and punchy)

### 4d. New signal: Caption Cadence (`shortPunchyLines`, weight +3 to +8)
Track caption line lengths over a sliding window:
- Average line length < 50 chars over last 5 lines: ad-leaning
- Lines changing rapidly (new line every 2-4 seconds with short text): ad-leaning
- Average line length > 80 chars with slower turnover: program-leaning

### 4e. New signal: Ad-Lock Gating for Brands
Brand detection can only EXTEND an existing ad lock (add momentum), not START one. If no ad lock is active and a brand is detected in editorial context (no CTA, no imperative voice, guest intro present), the brand signal weight is reduced to near zero.

### 4f. CNBC show names → programAllow signal (weight -40 to -50)
```
squawk box, squawk on the street, power lunch, fast money, mad money,
halftime report, money movers, last call, worldwide exchange, the exchange,
cnbc special report
```
Plus "welcome to X" variants for each show.

### 4g. Anchor names → anchorName signal (weight -20 to -30)
~30 anchors:
```
sara eisen, scott wapner, jim cramer, carl quintanilla, david faber,
melissa lee, kelly evans, joe kernen, becky quick, andrew ross sorkin,
brian sullivan, tyler mathisen, rick santelli, steve liesman, mike santoli,
diana olick, robert frank, meg tirrell, dominic chu, leslie picker,
kate rooney, courtney reagan, deirdre bosa, julia boorstin, frank holland,
contessa brewer, seema mody, kristina partsinevelos, bertha coombs, guy adami,
karen finerman, tim seymour, dan nathan
```

### 4h. Conversational program phrases → programAllow / programAnchor signals
```
let's get to, let's bring in, let's go to, i want to bring in,
thanks for being with us, thank you for joining us, good to have you,
appreciate your time, let's get a check on, the ten-year, treasury yield,
federal reserve, rate cut, rate hike, basis points, the bell is going to ring,
take a look at this, straight ahead, still to come, coming up, up next on
```

### 4i. Segment names → segmentName signal (weight -10 to -20)
```
final trades, lightning round, stop trading, call of the day, stock draft,
investment committee, options action, cramer's game plan, cramer's lightning round,
off the charts, the bottom line, market zone, halftime overtime, unusual activity
```

### 4j. Missing advertisers → brandTerms (contribute brandDetected signal, weight +10 to +20)
- **Financial:** schwab, charles schwab, fidelity, e-trade, morgan stanley, goldman sachs, jp morgan, wells fargo, td ameritrade, interactive brokers, robinhood, sofi, merrill lynch, raymond james, edward jones, northwestern mutual, prudential, tiaa, new york life, massmutual, invesco, blackrock, vanguard
- **Tech:** salesforce, servicenow, ibm, dell, oracle, accenture, cisco, crowdstrike, palantir, palo alto networks, workday, snowflake
- **Pharma:** dupixent, keytruda, opdivo, entresto, eliquis, xarelto, cosentyx, tremfya, otezla, enbrel, stelara, repatha, wegovy, zepbound, rybelsus, farxiga, breztri, symbicort, trelegy, nucala, eylea, caplyta, vraylar
- **Gold/Metals:** rosland capital, goldco, birch gold, augusta precious metals, american hartford gold, goldline, lear capital, noble gold, gold ira, precious metals ira
- **Legal:** class action, mesothelioma, camp lejeune, you may be entitled to compensation
- **Other:** grayscale, coinbase, ancestry, indeed, ziprecruiter, rocket mortgage, carvana

### 4k. Medicare reclassification
- Move standalone "medicare", "part c", "enrollment ends", "dual-eligible", "special needs plan", "annual election period", "aep", "open enrollment" from hardPhrases to brandTerms (contribute +10-20, not +30-45)
- KEEP as hard phrases: "licensed agent", "tty", "$0 premium", "$0 copay", "speak to a licensed agent", "talk to a licensed agent" (these never appear in editorial)
- Add new hard phrases: "tell your doctor about all the medicines you take", "important safety information", "results may vary", "individual results", "injection site reactions", "risk of thyroid tumors", "paid programming", "paid advertisement", "the following is a paid"

### 4l. Additional ad context phrases → adContext signal
```
for more information, available now, now available, while supplies last,
act now, don't wait, risk-free, money-back guarantee, satisfaction guaranteed,
no obligation, official sponsor, proud sponsor, proud partner, as seen on
```

### 4m. Break phrase additions → breakCue signal (weight +35 to +40)
```
we'll be back in two minutes, we'll be back in just a moment,
don't go anywhere, stick around, quick break, take a quick break,
much more ahead, more squawk box after this, more halftime after this
```

### 4n. Return-from-break additions → returnFromBreak signal (weight -35 to -45)
```
and we are back, all right we are back, welcome back everybody,
welcome back to squawk, welcome back to closing bell,
welcome back to the halftime report, welcome back to power lunch,
welcome back to fast money, before the break we were, as we were discussing
```

### 4o. Timing default adjustments
- `minAdLockMs`: 20000 → 75000 (75s — covers most commercial pods)
- `muteOnNoCCDelayMs`: 180 → 2500 (avoids false mute on CNBC bumper graphics)
- `programQuorumLines`: 3 → 3 (keep — already reasonable)
- `confidenceThreshold`: 70 → 65 (slightly lower since signals are more granular now)

---

## Step 5: Enhanced Feedback System

### Problem
The current "Flag Incorrect State" button logs an event but the data is mixed into the raw caption log. Users can't easily export or analyze their false positive/negative patterns.

### Design
- **Structured feedback log** — separate from caption log. Each entry captures the FULL signal breakdown:
  ```json
  {
    "timestamp": "2026-02-23T14:32:15.000Z",
    "action": "FALSE_POSITIVE",
    "wasMuted": true,
    "captionText": "joining us now from schwab to discuss...",
    "lastNLines": ["...", "...", "...", "...", "..."],
    "confidence": 72,
    "signals": [
      { "source": "brandDetected", "weight": 15, "match": "schwab" },
      { "source": "adContext", "weight": 10, "match": ".com" },
      { "source": "guestIntro", "weight": -22, "match": "joining us now from schwab" }
    ],
    "aggregateBreakdown": "+15 brand, +10 context, -22 guestIntro = net 53 (base 50)",
    "adLockActive": false,
    "url": "https://tv.youtube.com/watch/...",
    "programQuorum": 1
  }
  ```
- **Signal breakdown on HUD** — when HUD is in "always show" mode, display the top 3 contributing signals (e.g., "+40 hardPhrase, -28 anchorName, +15 brand")
- **Feedback export** — new "Download Feedback Log" button in Actions tab, exports as JSON. This is the primary data source for tuning weights in future versions.
- **Feedback counter on HUD** — small badge showing FP/FN count this session
- **Enhanced Flag button** — when clicked, captures the last 5 caption lines (sliding window from Step 6), the full signal array, and the confidence breakdown
- **Ctrl+Shift+F** triggers flag (was Ctrl+F, fixed in Step 1)

This structured signal data is what enables iterative weight tuning. When a user reports a false positive, we can see exactly which signals fired and why the confidence was wrong — then adjust weights accordingly.

---

## Step 6: New Features

### 6a. Sliding caption window
- Ring buffer of last 5 caption lines (configurable via `captionWindowSize`)
- On each tick, concatenate window and run detection on the full window
- Also run detection on just the latest line (for immediate signals like "ask your doctor")
- Take the higher-confidence result
- Catches ads earlier (context builds over multiple lines)
- Confirms programs faster (anchor name + topic accumulate)

### 6b. Volume ramping on unmute
- New setting `volumeRampMs` (default 1500, 0 = instant)
- On unmute: save current volume target, set to 0, ramp via requestAnimationFrame
- On mute during ramp: cancel ramp immediately, mute
- Only applies when `useTrueMute` is false (true mute is binary by nature)
- When `useTrueMute` is true, briefly set `video.muted = false` then ramp volume from low to saved level

---

## Non-Goals (for now)

- Multi-channel support (ESPN, Bloomberg) — future version
- LLM review integration — needs async architecture, defer to v5
- Statistics dashboard — defer to v5
- Time-of-day awareness — defer to v5 (needs schedule data source)
- OCR/chyron reading — not feasible in userscript context
