---
title: "feat: Signal Tuning v4.4 — Mild Gate, Testimonial Detection, Dampening Fixes"
type: feat
date: 2026-02-26
brainstorm: docs/brainstorms/2026-02-26-signal-tuning-v4.4-brainstorm.md
---

# Signal Tuning v4.4

## Overview

Five targeted signal/scoring fixes based on 17 hours of passive log analysis (v4.3.9, 13,144 entries). Addresses false positives (program muted as ad) and false negatives (ads not muted) observed during CNBC daytime programming.

## Problem Statement

| # | Issue | Sightings | Impact |
|---|-------|-----------|--------|
| A | `captionBottomed(10) + shortPunchyLines(6)` alone crosses threshold | 212 of 244 captionBottomed mutes (87%) | Continuous false muting during non-news hours; brief blips during daytime |
| B | Bare `"quote"` in adContext matches editorial attributions | 5 sightings | 5-6s false positive per occurrence |
| C | Testimonial ads (Coventry Direct) score below threshold | 9 sightings | 1-10s false negative per ad airing |
| D | `textFeatures(25)` fires on financial discussion when dampening expires | 7 instances | 2-5s false positive per occurrence |
| E | `breakCue` fires on conversational "stick around" | 2 sightings | <0.3s blip (sub-second) |

## Proposed Solution

### Fix A: Mild Signal Gate

**File:** `youtubetv-auto-mute.user.js`
**Location:** Inside `evaluate()`, after the caseShift dampening block (around line 1324), before `State.currentConfidence = confidence`

Add a post-processing cap: if the **only** positive-weight signals in the current evaluation are from the mild set, clamp confidence to `S.confidenceThreshold - 1`.

**Mild signal set:** `captionBottomed`, `shortPunchyLines`

**Real signal set (everything else positive):** `hardPhrase`, `brandDetected`, `adContext`, `ctaDetected`, `urlOrPhone`, `breakCue`, `caseShift` (ad direction), `captionLoss`, `imperativeVoice`, `offerDetected`, `textFeatures`, `domAdShowing`, `testimonialAd` (new in this release)

**Note on `textFeatures`:** This signal includes caps/punct sub-components (+6/+4) that are mild in nature, as well as price mentions (+5 each) which are "real". If textFeatures fires with weight ≤ 10 (caps + punct only, no price), treat it as mild. If weight > 10 (includes price), treat as real.

**Edge case decisions:**
- **adLock active:** Lock floor takes precedence. The gate only prevents **new** threshold crossings; it does not override an active lock. This is correct because ad locks represent high-confidence ad detection that shouldn't be broken by a single mild-only evaluation.
- **Pipeline placement:** Apply AFTER the window-vs-latest-line max-deviation selection and AFTER `calculateConfidence()` returns, as a post-processing cap on the `confidence` variable before passing to `decide()`.
- **Passive log observability:** Emit a zero-weight synthetic signal `{ source: 'mildGate', weight: 0, label: 'Mild gate active' }` when the gate fires, so future log analysis can distinguish gate-capped evaluations from organic low scores.

**Implementation sketch (`evaluate()` around line 1324):**

```javascript
// Mild signal gate: prevent mild-only signals from crossing threshold
const MILD_SOURCES = new Set(['captionBottomed', 'shortPunchyLines']);
const positiveSignals = signals.filter(s => s.weight > 0);
const allMild = positiveSignals.length > 0 && positiveSignals.every(s =>
  MILD_SOURCES.has(s.source) || (s.source === 'textFeatures' && s.weight <= 10)
);
if (allMild && confidence >= S.confidenceThreshold) {
  confidence = S.confidenceThreshold - 1;
  signals.push({ source: 'mildGate', weight: 0, label: 'Mild gate active', match: null });
}
```

---

### Fix B: Replace "quote" in adContext

**File:** `youtubetv-auto-mute.user.js`
**Location:** `DEFAULTS.adContext` array, line ~200

**Remove:** `"quote"`
**Add:** `"get a quote"`, `"free quote"`, `"quote today"`, `"quote now"`

**Note:** `"get a quote"` already exists in `offerTerms` (line 210). This means captions containing "get a quote" will now match BOTH `adContext(+10)` and `offerDetected(+8)` for a combined +18. This is **intentional** — "get a quote" is strongly ad-indicative and the combined weight is appropriate.

**Requires:** `SETTINGS_KEY` bump (see Version & Settings section below).

---

### Fix C: New `testimonialAd` Composite Signal

**Weight:** +12 (added to `WEIGHT` constants as `TESTIMONIAL_AD: 12`)

**New state field:** `State.lastCaptionLossEndMs` — timestamp of when captions return after a captionLoss period (the edge from absent → present). Set inside `evaluate()` when `captionsExist` transitions from false to true after a captionLoss signal had fired. Initialize to `0` in `State` object and `State.reset()`.

**Conditions (all must be true):**

| Condition | Implementation | Threshold |
|-----------|----------------|-----------|
| Mixed case captions | `env.textFeatures.capsRatio < 0.85` | Consistent with caseShift ALL CAPS detection |
| Caption at bottom | `env.captionsBottomed === true` (implies `State.bottomConsec >= 2`) | Existing signal logic |
| No CNBC markers in caption window | `State.captionWindow.join(' ')` does not contain `>>` AND `PhraseIndex.match('anchor', windowJoined)` returns null | Uses 5-line rolling window |
| Recently after caption loss | `State.lastCaptionLossEndMs > 0 && (Date.now() - State.lastCaptionLossEndMs < 60000)` | 60s from when captions resumed, not from when they disappeared |

**Registration order:** MUST be registered AFTER `captionBottomed` and `captionLoss` signals (append after the last existing signal registration, before the `CONFIDENCE SCORER` comment).

**Implementation sketch:**

```javascript
// State additions:
// In State object: lastCaptionLossEndMs: 0,
// In State.reset(): this.lastCaptionLossEndMs = 0;

// In evaluate(), when captions return after loss:
// if (captionsExist && State.noCcConsec > 0) State.lastCaptionLossEndMs = Date.now();
// (careful: noCcConsec is reset by the captionLoss signal, so check BEFORE collectAll)

SignalCollector.register('testimonialAd', (text, env) => {
  if (!env.captionsBottomed) return null;
  if (env.textFeatures.capsRatio >= 0.85) return null;  // must be mixed case
  if (!State.lastCaptionLossEndMs || Date.now() - State.lastCaptionLossEndMs > 60000) return null;
  const windowText = State.captionWindow.join(' ');
  if (windowText.includes('>>')) return null;
  if (PhraseIndex.match('anchor', windowText)) return null;
  return { weight: WEIGHT.TESTIMONIAL_AD, label: 'Testimonial ad pattern', match: null };
});
```

**Edge case:** `lastCaptionLossEndMs` timing — the timestamp must be set **before** `collectAll()` runs so the new signal can read it on the same tick that captions resume. This means the transition detection goes in `evaluate()` before `SignalCollector.collectAll()`.

---

### Fix D: Extended textFeatures Dampening

**File:** `youtubetv-auto-mute.user.js`
**Location:** `textFeatures` signal registration, lines ~561 and ~566

**Change 1:** Extend `recentProgram` window from 45s to 90s

```javascript
// Line 561: change 45000 → 90000
const recentProgram = State.lastStrongProgramMs && (Date.now() - State.lastStrongProgramMs < 90000);
```

**Change 2:** Add quorum as alternative dampening trigger

```javascript
// Line 566: add || condition
if ((recentProgram || State.programQuorumCount > 0) && w > 12) { w = 12; parts.push('dampened'); }
```

**Timing note:** `collectAll()` runs before `decide()`, so `programQuorumCount` reflects the previous cycle's value. On the first tick after a program→ad transition (where `decide()` clears quorum), textFeatures will still be dampened. This one-tick lag is acceptable — better to err on dampening during the transition.

---

### Fix E: Narrow breakCue "stick around"

**File:** `youtubetv-auto-mute.user.js`
**Location:** `DEFAULTS.breakPhrases` array, line ~244

**Remove:** `"stick around"`
**Add:** `"stick around for"`, `"we'll stick around"`

**Requires:** `SETTINGS_KEY` bump (shared with Fix B).

---

## Version & Settings

- **Version:** Bump from `4.3.10` → `4.4.0` (minor version for signal architecture change)
- **@name suffix:** Update from `Signal Aggregation` to `Mild Gate + Testimonial Signal`
- **Version strings:** All 9 locations updated via `replace_all` on `4.3.10`
- **SETTINGS_KEY:** Bump from `yttp_settings_v4_3_8` → `yttp_settings_v4_4_0` (Fixes B and E change default phrase lists)
- **WEIGHT constant:** Add `TESTIMONIAL_AD: 12` to the `WEIGHT` frozen object

## Implementation Phases

### Phase 1: Build Regression Simulation Script

Before touching the main script, write a Node.js simulation that replays passive log entries through the scoring pipeline.

**Input:** Merged passive log file (`/tmp/yttp_merged_new.json`, 13,144 entries)
**Also test against:** Labeled data (`docs/labeled/2026-02-25_1051_labeled.json`, 946 entries)

**Simulation approach:**
- For each snapshot entry, extract the stored `signals` array and `conf` value
- Apply proposed changes:
  - **Fix A:** Check if all positive signals are mild; if so, cap at threshold-1
  - **Fix B:** Check if `adContext` fired and caption contains bare "quote" but NOT "get a quote"/"free quote"/"quote today"/"quote now" — if so, remove adContext contribution
  - **Fix C:** Check testimonialAd conditions from stored data (captionBottomed presence, capsRatio from caption text, `>>` in caption, proximity to captionLoss events)
  - **Fix D:** Check if textFeatures weight >12 and programQuorumCount >0 or within 90s window — if so, cap at 12
  - **Fix E:** Check if breakCue fired and caption contains bare "stick around" but NOT "stick around for"/"we'll stick around" — if so, remove breakCue contribution
- Recompute confidence with adjusted signals
- Compare old vs new mute decision (against threshold)
- Report every changed decision

**Output:** Per-fix breakdown of:
- Snapshots where mute decision changes
- For labeled data: FP/FN change count
- For unlabeled data: score shift direction and magnitude

**File:** `scripts/simulate-v44.js` (new)

**Bar:** Zero regressions on labeled data. On unlabeled data, all changes must be explainable and directionally correct.

### Phase 2: Implement Fixes (in order)

1. **Fix D** (textFeatures dampening) — smallest, most isolated change
2. **Fix B** (quote replacement) — phrase list change only
3. **Fix E** (stick around narrowing) — phrase list change only
4. **Fix C** (testimonialAd signal) — new signal + state field
5. **Fix A** (mild signal gate) — scoring architecture change, depends on Fix C being registered first
6. **Version & settings bump** — version strings + SETTINGS_KEY

### Phase 3: Re-run Simulation

Run the simulation script against the actual modified code (not the approximation from Phase 1) by extracting the scoring functions and running them against the log data. Verify results match Phase 1 expectations.

### Phase 4: Update Documentation

- Update `docs/tuning-runbook.md` signal reference table with:
  - `testimonialAd` (+12) entry
  - `mildGate` (0, synthetic) entry
  - Updated textFeatures dampening description (90s + quorum)
  - Updated adContext note (quote → specific phrases)
  - Updated breakPhrases note (stick around → specific phrases)
- Close or update open issues #8, #9, #10 in the runbook
- Update MEMORY.md with new version and fix summary

## Acceptance Criteria

- [x] Fix A: `captionBottomed(10) + shortPunchyLines(6)` alone produces conf=64 (not 66)
- [x] Fix A: `captionBottomed(10) + adContext(10)` still produces conf=70 and mutes
- [x] Fix A: `mildGate` synthetic signal appears in passive log when gate fires
- [x] Fix A: Active adLock is NOT broken by mild-only evaluations
- [x] Fix B: Caption "A, QUOTE, MAJOR PACKAGE" does NOT trigger adContext
- [x] Fix B: Caption "get a quote today" DOES trigger adContext
- [x] Fix C: Coventry Direct testimonial opener (mixed case, bottom, post-captionLoss, no >>) triggers `testimonialAd(+12)`
- [x] Fix C: CNBC program content with `>>` markers does NOT trigger testimonialAd
- [x] Fix C: ALL CAPS content does NOT trigger testimonialAd
- [x] Fix D: Dollar amounts in program content during active quorum produce textFeatures ≤ 12
- [x] Fix D: Dollar amounts with no recent program signals produce full textFeatures weight
- [x] Fix E: "I want to stick around" does NOT trigger breakCue
- [x] Fix E: "stick around for more" DOES trigger breakCue
- [x] Regression: Zero FP/FN regressions on labeled dataset
- [x] SETTINGS_KEY bumped to `yttp_settings_v4_4_0`
- [x] All 9 version strings updated to `4.4.0`

## References

- Brainstorm: `docs/brainstorms/2026-02-26-signal-tuning-v4.4-brainstorm.md`
- Passive log analysis: 17h merged dataset (Feb 25 15:49 – Feb 26 08:48)
- Labeled data: `docs/labeled/2026-02-25_1051_labeled.json` (946 entries, v4.3.7)
- Tuning runbook: `docs/tuning-runbook.md`
- Key code locations:
  - `calculateConfidence()`: line ~663
  - `evaluate()` post-processing: line ~1316
  - `textFeatures` dampening: line ~561
  - `DEFAULTS.adContext`: line ~195
  - `DEFAULTS.breakPhrases`: line ~240
  - `SETTINGS_KEY`: line ~276
  - `WEIGHT` constants: line ~283
  - Signal registrations: lines ~492-660
  - State object: line ~325
