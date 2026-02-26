# Remaining Fixes v4.4.1 — Brainstorm

**Date:** 2026-02-26
**Data source:** 1.5h v4.4.0 live data (Feb 26 11:20–12:50, 1,069 v4.4.0 snapshots) + historical sightings
**Focus:** Four remaining issues after v4.4.0 deployment

---

## What We're Building

Four fixes addressing remaining issues observed in v4.4.0 live data and historical sightings.

## Key Findings from Data

| # | Issue | Sightings | Severity |
|---|-------|-----------|----------|
| 1 | caseShift(program) on ALL CAPS ads after captionLoss | 3 historical (8-11s FN each), 1 in v4.4.0 data (Coventry Direct 12:15, during manual mute) | MEDIUM |
| 2 | programAllow(-45) on ads mentioning market terms | 1 sighting (Invesco "Nasdaq-100 innovators" 11:25:17, self-corrected in 13s) | LOW |
| 3 | textFeatures match field "undefined" in passive logs | All 39 textFeatures entries in v4.4.0 data | LOW (cosmetic, hinders analysis) |
| 4 | Coventry Direct ALL CAPS ad gets caseShift(-28) + conversational(-12) = deeply negative score | Overlap of #1 + existing testimonial pattern; 12:15 showed conf=14 | MEDIUM (would be 20s+ FN if not manually muted) |

## Decisions

### Fix 1: caseShift(program) Suppression (Issue #6)

**Decision:** Combined approach — suppress after captionLoss AND require corroboration.

**After captionLoss suppression:**
- When captions return after a captionLoss period (reuse `State.lastCaptionLossEndMs` from v4.4.0), suppress caseShift(program) for ~15s unless `speakerMarker` or `anchorName` also present in the same evaluation.
- Rationale: captionLoss almost always precedes ad breaks. ALL CAPS text arriving right after is likely ads, not program return.

**Corroboration requirement (outside captionLoss window):**
- caseShift(program) only fires at full weight (-28) when at least one other program signal (`speakerMarker`, `anchorName`, `programAllow`) is present in the same evaluation.
- Without corroboration, cap at half weight (-14).
- This is additive to the existing adContext/ctaDetected dampening.

**Combined behavior:**
- Within 15s of captionLoss return: caseShift(program) = 0 unless speakerMarker/anchorName present
- Outside 15s, with corroboration: full -28
- Outside 15s, without corroboration: -14 (half)
- With adContext/ctaDetected: existing halving still applies (stacks to -7 if both apply)

### Fix 2: Expanded programAllow Suppression

**Decision:** Suppress programAllow when captionBottomed/testimonialAd fires AND within 30s of captionLoss return.

**Condition 1 (ad structural signals):**
- If `captionBottomed` or `testimonialAd` fires alongside `programAllow`, suppress the PROGRAM_CONFIRMED action (same as brandDetected suppression).
- Rationale: bottom-positioned captions are an ad indicator; market terms in ads shouldn't trigger program confirmation.

**Condition 2 (post-captionLoss window):**
- Within 30s of `State.lastCaptionLossEndMs`, suppress programAllow's PROGRAM_CONFIRMED action unless `speakerMarker` or `anchorName` also present.
- Rationale: programAllow matching right after captionLoss is likely an ad containing market terms, not real program content.

**Both conditions use the same suppression mechanism** already in place for brandDetected — the signal still contributes to confidence scoring, but it doesn't trigger the PROGRAM_CONFIRMED early exit that clears adLock and sets quorum.

### Fix 3: textFeatures Match Field

**Decision:** Populate match with `parts.join('+')` instead of `null`.

Change from:
```javascript
return w > 0 ? { weight: w, label: '...', match: null } : null;
```
To:
```javascript
return w > 0 ? { weight: w, label: '...', match: parts.join('+') } : null;
```

Passive log will now show `m: "caps+punct"` or `m: "price+dampened"` instead of `m: undefined`.

### Fix 4: No Additional Fix Needed

Issue #4 (Coventry Direct deeply negative score) is the intersection of issues #1 and #8. With Fix 1 (caseShift suppression after captionLoss) and the existing testimonialAd signal from v4.4.0, Coventry Direct ads should score significantly higher:
- caseShift(program) suppressed (was -28, now 0 within 15s of captionLoss)
- testimonialAd(+12) already firing
- Net improvement of +28–40 on these ads

## Open Questions

1. **15s captionLoss window for caseShift** — is this long enough? Typical ad break is 2-5 minutes, but caseShift should be useful again once the ad→program transition actually happens. 15s catches the initial ALL CAPS ad captions.
2. **Stacking of caseShift dampening rules** — with three dampening paths (captionLoss suppression, corroboration requirement, adContext halving), the logic is getting layered. Should we simplify to a single unified approach?

## What's Explicitly Out of Scope

- Issue #10 (imperativeVoice "kicking off") — 1 sighting, no recurrence
- Any changes to the testimonialAd signal conditions (working correctly)
- Any changes to the mild signal gate (working correctly)

## Version Plan

- Version bump to **v4.4.1** (patch bump for signal tuning adjustments)
- SETTINGS_KEY stays at `yttp_settings_v4_4_0` (no phrase list changes)
