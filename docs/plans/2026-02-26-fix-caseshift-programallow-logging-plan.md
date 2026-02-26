---
title: "fix: caseShift Suppression, programAllow Expansion, Logging Fix"
type: fix
date: 2026-02-26
brainstorm: docs/brainstorms/2026-02-26-remaining-fixes-v4.4.1-brainstorm.md
---

# Signal Tuning v4.4.1

## Overview

Three targeted fixes based on v4.4.0 live data (1.5h, 1,069 snapshots) and 3 historical sightings. Addresses caseShift(program) false negatives on ALL CAPS ads, programAllow false unmutes on ads containing market terms, and textFeatures logging observability.

## Problem Statement

| # | Issue | Sightings | Impact |
|---|-------|-----------|--------|
| 1 | caseShift(program) fires -28 on ALL CAPS ads after captionLoss | 3 historical (8-11s FN), 1 in v4.4.0 (Coventry Direct 12:15) | 8-20s false negative per ad break |
| 2 | programAllow(-45) fires on ad content mentioning market terms | 1 sighting (Invesco "Nasdaq-100 innovators" 11:25:17) | 13s false unmute, self-corrected |
| 3 | textFeatures `match` field = `null` → "undefined" in passive logs | All 39 textFeatures entries in v4.4.0 data | Hinders log analysis |

## Proposed Solution

### Fix 1: Unified caseShift(program) Dampening

**File:** `youtubetv-auto-mute.user.js`
**Location:** Replace the existing caseShift dampening block (lines ~1334-1341) with a single unified block that handles all caseShift(program) dampening rules in one pass.

**Outcome tiers (applied in order, first match wins):**

| Condition | Result | Rationale |
|-----------|--------|-----------|
| Within 15s of `lastCaptionLossEndMs` AND no speakerMarker/anchorName in signals | weight = 0 | ALL CAPS text right after captionLoss is almost certainly an ad |
| Within 15s of `lastCaptionLossEndMs` AND speakerMarker/anchorName present | weight = full (-28) | Corroborated by structural CNBC signal |
| Outside 15s, adContext OR ctaDetected present, no corroboration | weight = -7 (quarter of -28) | Both dampening rules stack: no-corroboration cap to -14, then adContext halving to -7 |
| Outside 15s, adContext OR ctaDetected present, with corroboration | weight = -14 (half of -28) | Only adContext halving applies |
| Outside 15s, no adContext/ctaDetected, no corroboration | weight = -14 (half of -28) | No-corroboration cap only |
| Outside 15s, no adContext/ctaDetected, with corroboration | weight = full (-28) | No dampening needed |

**Corroboration signals:** `speakerMarker`, `anchorName` only. NOT programAllow (can appear in ads with market terms) or segmentName (could theoretically match ad content).

**Implementation approach:** Single unified block replaces existing lines 1334-1341. Computes final weight in one pass, then calls `calculateConfidence(signals)` once. No stacking ambiguity.

```javascript
// Unified caseShift(program) dampening
const csIdx = signals.findIndex(s => s.source === 'caseShift' && s.weight < 0);
if (csIdx !== -1) {
  const hasAdSignal = signals.some(s => s.source === 'adContext' || s.source === 'ctaDetected');
  const hasCorroboration = signals.some(s => s.source === 'speakerMarker' || s.source === 'anchorName');
  const postCaptionLoss = State.lastCaptionLossEndMs > 0 && (t - State.lastCaptionLossEndMs < 15000);

  let newWeight = signals[csIdx].weight; // starts at -28
  let reason = '';

  if (postCaptionLoss && !hasCorroboration) {
    newWeight = 0;
    reason = 'suppressed (post-captionLoss)';
  } else if (!postCaptionLoss && !hasCorroboration && hasAdSignal) {
    newWeight = Math.round(WEIGHT.CASE_SHIFT_PROGRAM / 4); // -7
    reason = 'dampened (no corroboration + ad signal)';
  } else if (!postCaptionLoss && hasAdSignal) {
    newWeight = Math.round(WEIGHT.CASE_SHIFT_PROGRAM / 2); // -14
    reason = 'dampened (ad signal)';
  } else if (!postCaptionLoss && !hasCorroboration) {
    newWeight = Math.round(WEIGHT.CASE_SHIFT_PROGRAM / 2); // -14
    reason = 'dampened (no corroboration)';
  }
  // else: full weight, no dampening

  if (newWeight !== signals[csIdx].weight) {
    signals[csIdx] = { ...signals[csIdx], weight: newWeight, label: signals[csIdx].label + ' (' + reason + ')' };
    confidence = calculateConfidence(signals);
  }
}
```

---

### Fix 2: Expanded programAllow Suppression

**File:** `youtubetv-auto-mute.user.js`
**Location:** `decide()` function, the `hasProgramAllow` block (lines ~695-706)

**Current logic:** Suppress PROGRAM_CONFIRMED when `brandDetected` fires.

**New logic:** Suppress PROGRAM_CONFIRMED when ANY of:
- `brandDetected` fires (existing)
- `captionBottomed` fires (new)
- `testimonialAd` fires (new)
- Within 30s of `State.lastCaptionLossEndMs` AND no speakerMarker/anchorName present (new)

**Decision on weight vs. early-exit suppression (resolving spec-flow Q2):**

Only the PROGRAM_CONFIRMED early exit is suppressed, NOT the -45 weight. Reasoning:
- When adLock is active, the lock floor keeps confidence above threshold regardless of -45 — correct behavior, system stays muted
- When adLock has expired, programAllow's -45 pushes confidence below threshold, but quorum may accumulate over multiple ticks — this is acceptable because quorum accumulation takes 3+ ticks (15+ seconds) and represents sustained program evidence
- Zeroing the weight would be a scoring-layer change that risks suppressing legitimate programAllow during transitions

**Emit synthetic signal for observability:** When suppression fires, push `{ source: 'programAllowSuppressed', weight: 0, label: 'programAllow suppressed: <reason>', match: null }` into the signals array.

**Quorum accumulation concern (spec-flow Gap 8):** programAllow at -45 qualifies as a `strongProgramSignal` (weight <= -12), which increments `lastStrongProgramMs` in decide(). When suppressed, we should ALSO skip the `strongProgramSignal` update for programAllow. This prevents the slow quorum-based false unmute.

**Implementation:** Expand the existing `hasBrand` check:

```javascript
if (hasProgramAllow) {
  const hasBrand = signalResults.some(s => s.source === 'brandDetected');
  const hasBottomOrTestimonial = signalResults.some(s => s.source === 'captionBottomed' || s.source === 'testimonialAd');
  const hasCorroboration = signalResults.some(s => s.source === 'speakerMarker' || s.source === 'anchorName');
  const postCaptionLoss = State.lastCaptionLossEndMs > 0 && (t - State.lastCaptionLossEndMs < 30000);
  const suppress = hasBrand || hasBottomOrTestimonial || (postCaptionLoss && !hasCorroboration);

  if (!suppress) {
    // existing PROGRAM_CONFIRMED logic unchanged
    State.adLockUntil = 0;
    State.programVotes = S.programVotesNeeded;
    State.programQuorumCount = S.programQuorumLines;
    if (State.manualMuteActive) return { shouldMute: true, reason: 'MANUAL_MUTE', virtualReason: 'PROGRAM_CONFIRMED' };
    return { shouldMute: false, reason: 'PROGRAM_CONFIRMED' };
  }
  // When suppressed: don't count as strong program signal for quorum purposes
  // (handled below by excluding programAllow from strongProgramSignal check)
}
```

**strongProgramSignal exclusion:** When programAllow is suppressed, exclude it from the strong program signal check that sets `State.lastStrongProgramMs`. Change:
```javascript
const strongProgramSignal = signalResults.some(s => s.weight <= -12);
```
To:
```javascript
const suppressedProgramAllow = hasProgramAllow && suppress;
const strongProgramSignal = signalResults.some(s => s.weight <= -12 && !(suppressedProgramAllow && s.source === 'programAllow'));
```

Note: The `suppress` and `hasProgramAllow` variables need to be scoped so they're accessible at the `strongProgramSignal` line. Hoist the suppression check variables outside the `if (hasProgramAllow)` block, or restructure to set a flag.

---

### Fix 3: textFeatures Match Field

**File:** `youtubetv-auto-mute.user.js`
**Location:** `textFeatures` signal registration (line ~571)

**Change:**
```javascript
// Before:
return w > 0 ? { weight: w, label: 'Text features: ' + parts.join('+'), match: null } : null;

// After:
return w > 0 ? { weight: w, label: 'Text features: ' + parts.join('+'), match: parts.join('+') } : null;
```

The `parts` array includes 'dampened' when the cap fires, so the match field will show `caps+dampened` or `price+dampened`. This is intentional — it mirrors the label and makes the dampening visible in passive logs without parsing the label string.

---

### Fix 4: lastCaptionLossEndMs Gate Tightening

**File:** `youtubetv-auto-mute.user.js`
**Location:** `evaluate()` (line ~1311)

Per spec-flow Gap 3, the current `noCcConsec > 0` threshold means even a single missed 150ms tick sets the timestamp, creating spurious 15s/30s windows during program content.

**Change:**
```javascript
// Before:
if (captionsExist && State.noCcConsec > 0) State.lastCaptionLossEndMs = Date.now();

// After:
if (captionsExist && State.noCcConsec >= S.noCcHitsToMute) State.lastCaptionLossEndMs = Date.now();
```

This aligns the timestamp gate with the captionLoss signal's own threshold (`noCcHitsToMute` defaults to 2), meaning only "real" caption loss periods (300ms+) trigger the suppression windows.

---

### Fix 5: Add lastCaptionLossEndMs to Passive Log

**File:** `youtubetv-auto-mute.user.js`
**Location:** `passiveSnapshot()` function (line ~1019)

Add a `clEnd` field to the passive log snapshot so the 15s/30s windows can be reconstructed during analysis:

```javascript
const rec = {
  conf: confidence,
  muted: decision.shouldMute,
  reason: decision.reason,
  signals: signals.map(s => ({ s: s.source, w: s.weight, m: s.match || undefined })),
  caption: truncate(ccText, 200),
  adLock: Date.now() < State.adLockUntil,
  quorum: State.programQuorumCount,
  pv: State.programVotes,
  clEnd: State.lastCaptionLossEndMs || undefined,  // NEW: for 15s/30s window analysis
};
```

---

## Version & Settings

- **Version:** Bump from `4.4.0` → `4.4.1`
- **@name suffix:** Update from `Mild Gate + Testimonial Signal` to `caseShift Guard + programAllow Guard`
- **SETTINGS_KEY:** No change (stays `yttp_settings_v4_4_0` — no phrase list changes)

## Implementation Order

1. **Fix 3** (textFeatures match) — one-line change, zero risk
2. **Fix 4** (lastCaptionLossEndMs gate) — one-line change, prerequisite for Fix 1 & 2
3. **Fix 5** (passive log field) — one-line addition, observability
4. **Fix 1** (unified caseShift dampening) — replaces existing block, moderate complexity
5. **Fix 2** (programAllow suppression) — decision engine change, highest complexity
6. **Version bump** — all 9 locations

## Acceptance Criteria

- [x] Fix 1: ALL CAPS ad text within 15s of captionLoss has caseShift(program) = 0 (not -28)
- [x] Fix 1: CNBC program with `>>` marker within 15s of captionLoss gets full caseShift(program) = -28
- [x] Fix 1: ALL CAPS ad text with adContext, outside 15s, no corroboration → caseShift(program) = -7
- [x] Fix 1: ALL CAPS ad text with adContext, outside 15s, with anchorName → caseShift(program) = -14
- [x] Fix 2: Ad containing "Nasdaq" with captionBottomed does NOT trigger PROGRAM_CONFIRMED
- [x] Fix 2: Ad containing "Nasdaq" within 30s of captionLoss does NOT trigger PROGRAM_CONFIRMED
- [x] Fix 2: CNBC anchor saying "Nasdaq" with speakerMarker present DOES trigger PROGRAM_CONFIRMED
- [x] Fix 2: returnFromBreak is NOT affected by any suppression
- [x] Fix 2: Suppressed programAllow does NOT increment lastStrongProgramMs
- [x] Fix 2: `programAllowSuppressed` synthetic signal appears in passive log
- [x] Fix 3: textFeatures passive log shows `m: "caps+punct"` (not `m: undefined`)
- [x] Fix 4: Brief CC flicker (< 300ms) does NOT set lastCaptionLossEndMs
- [x] Fix 5: `clEnd` field appears in passive log snapshots
- [x] Regression: Zero FP/FN regressions on labeled dataset
- [x] All 9 version strings updated to `4.4.1`

## References

- Brainstorm: `docs/brainstorms/2026-02-26-remaining-fixes-v4.4.1-brainstorm.md`
- v4.4.0 live data: 1.5h (Feb 26 11:20–12:50, 1,069 v4.4.0 snapshots)
- Historical sightings: tuning-runbook.md issues #6, #7, #8
- Key code locations:
  - caseShift dampening: line ~1334 (to be replaced by unified block)
  - `decide()` programAllow block: line ~695
  - `strongProgramSignal` check: line ~718
  - textFeatures signal: line ~571
  - `lastCaptionLossEndMs` set: line ~1311
  - `passiveSnapshot()`: line ~1019
  - State object: line ~325
