# Signal Tuning v4.4 — Brainstorm

**Date:** 2026-02-26
**Data source:** 17-hour passive log (v4.3.9, Feb 25 15:49 – Feb 26 08:48, 13,144 entries)
**Focus:** Daytime CNBC, plus overnight patterns that apply to daytime

---

## What We're Building

Five targeted signal/scoring fixes based on 17 hours of passive log analysis. These address false positives (program muted as ad) and false negatives (ads not muted) observed during CNBC daytime programming.

## Key Findings from Data

| # | Issue | Sightings | Severity | Duration |
|---|-------|-----------|----------|----------|
| A | captionBottomed+shortPunchyLines alone trigger mute | 212 of 244 captionBottomed mutes (87%) | HIGH | Continuous during non-news; brief blips during daytime |
| B | "quote" in adContext matches editorial attributions (#9) | 5 (3 new) | MEDIUM | 5-6s FP |
| C | Coventry Direct / testimonial ads score low (#8) | 9 (6 new) | MEDIUM | 1-10s FN per airing |
| D | textFeatures(25) fires on financial discussion | 7 instances | MEDIUM | 2-5s FP |
| E | breakCue "stick around" on program content | 2 new | LOW | <0.3s blips |

## Decisions

### Fix A: Mild Signal Gate

**Decision:** Require at least one "real" ad signal before mild-only signals can cross threshold.

**Mild signals:** `captionBottomed`, `shortPunchyLines`, `capsHeavy`, `punctHeavy`

**Real ad signals:** Everything else positive — `hardPhrase`, `brandDetected`, `adContext`, `ctaDetected`, `urlOrPhone`, `breakCue`, `caseShift(ad)`, `captionLoss`, `imperativeVoice`, `offerDetected`, `textFeatures`, `domAdShowing`

**Behavior:** If the only positive signals in the current evaluation are from the mild group, cap the confidence at `threshold - 1` (64). Real signals can be from the current evaluation OR recent (within captionWindow).

**Rationale:** Base(50) + captionBottomed(10) + shortPunchyLines(6) = 66 is the #1 false-mute combo. This gate prevents mild signals alone from ever triggering a mute while preserving their contribution when combined with real ad evidence.

### Fix B: Replace "quote" in adContext

**Decision:** Remove bare `"quote"` from the adContext phrase list. Replace with specific ad phrases:
- `"get a quote"`
- `"free quote"`
- `"quote today"`
- `"quote now"`

**Rationale:** 5 sightings of editorial "A, QUOTE, [statement]" triggering adContext. The replacement phrases are ad-specific and won't match editorial usage.

**Note:** Requires `SETTINGS_KEY` bump since default phrase lists change.

### Fix C: Testimonial Composite Signal

**Decision:** New signal `testimonialAd` at weight +12 that detects the testimonial ad pattern.

**Conditions (all must be true):**
- Mixed case captions (not ALL CAPS)
- `captionBottomed` is active (captions at bottom)
- No CNBC markers in recent window: no `>>` speaker markers, no anchor names
- Within 60s of a `captionLoss` event (ads typically follow caption loss)

**Weight:** +12 (moderate, comparable to brandDetected)

**Rationale:** Testimonial ads (Coventry Direct, Blackstone, financial advisory) use first-person conversational copy with no strong ad phrases. The composite signal detects the structural pattern: bottom-positioned, mixed-case captions appearing after a caption loss gap with no CNBC production markers.

### Fix D: Extended textFeatures Dampening

**Decision:** Two changes to the recentProgram dampening mechanism:

1. **Extend window from 45s to 90s** — Covers longer gaps between program signals during financial discussion
2. **Use quorum as alternative trigger** — If `programQuorumCount > 0`, also dampen textFeatures (cap at +12). Quorum is more persistent than the timer and better represents ongoing program confidence.

**Rationale:** 7 instances of textFeatures(25) firing on dollar amounts ($4M, $100-200M, $100M, $100K) during program content. The 45s window expires during natural pauses in program signals, allowing full +25 to fire on the next financial mention.

### Fix E: "stick around" Exclusion in breakCue

**Decision:** Remove `"stick around"` from the breakPhrases list. Replace with more specific:
- `"stick around for"`
- `"we'll stick around"`

**Rationale:** 2 sightings of "I want to stick around" (conversational) triggering breakCue(38). Sub-second blips corrected by speakerMarker, but the more specific phrases avoid the match entirely while still catching actual break cues.

## Open Questions

1. **Mild signal gate — should captionLoss be gated too?** It's +25 max and fires on legitimate ad breaks, but also during brief caption hiccups. Currently categorized as "real" signal.
2. **testimonialAd — should the 60s-after-captionLoss window be configurable?** Or is 60s a safe hardcoded value?
3. **SETTINGS_KEY bump** — Fix B changes default phrase lists, so we need a new settings key. Should we bump on all fixes or just B?

## What's Explicitly Out of Scope

- Non-CNBC programming (Shark Tank, etc.) — user watches daytime CNBC only
- Issue #6 (ALL CAPS ads + caseShift) — no new fix proposed; existing halving works, and the testimonial composite signal (Fix C) addresses the Coventry overlap
- Issue #10 (imperativeVoice on "kicking off") — only 1 sighting, sub-second

## Version Plan

- Version bump to **v4.4.0** (minor bump for signal architecture change — the mild gate is a scoring behavior change)
- `SETTINGS_KEY` bump required for Fix B (phrase list change)
