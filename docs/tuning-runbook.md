# YTTV Auto-Mute Tuning Runbook

Guide for Claude sessions analyzing passive log data and tuning signal weights.

## Passive Log Format

Files are named `yttp_passive_YYYY-MM-DD_HHmm.json`.

### Top-Level Structure

```json
{
  "version": "4.3.7",
  "format": "passive_log",
  "sessionStart": "ISO timestamp",
  "savedAt": "ISO timestamp",
  "settings": { "confidenceThreshold": 63, ... },
  "entries": [ ... ],
  "boundaries": [ ... ]
}
```

### Entry Types

**Periodic snapshot** (every 5s):
```json
{
  "t": 1740499570000, "ts": "09:06:10",
  "conf": 64, "muted": true, "reason": "CONFIDENCE_HIGH",
  "signals": [{"s": "imperativeVoice", "w": 8, "m": "ratio=0.09"}],
  "caption": "RUSSELL 2000 TO WORK...",
  "adLock": false, "quorum": 3, "pv": 2
}
```

**Mute/unmute transition** (immediate on state change):
```json
{ "event": "mute", "t": ..., "ts": ..., "conf": 68, "muted": true, "reason": "CONFIDENCE_HIGH", "signals": [...], "caption": "...", "adLock": false, "quorum": 0, "pv": 0 }
{ "event": "unmute", ... }
```

**Boundary marker** (auto-detected ad/program transition):
```json
{ "event": "boundary", "type": "ad_start", "trigger": "confidence_crossed", "t": ..., "ts": ..., "conf": 72 }
{ "event": "boundary", "type": "ad_end", "trigger": "program_quorum_met", "t": ..., "ts": ... }
```
Triggers: `confidence_crossed`, `ad_lock_engaged`, `dom_ad_showing`, `caption_loss`, `program_confirmed`, `program_quorum_met`, `case_shift_program`

**Flag** (user pressed Flag Incorrect State):
```json
{ "event": "flag", "type": "false_positive", "t": ..., "ts": ..., "conf": 64, "muted": true, "signals": [...], "caption": "...", "adLock": false, "quorum": 3 }
```
Flags are **ground truth** — the user explicitly said "this is wrong." Soft flags have `"softFlag": true` (no state correction applied).

**Session lifecycle**:
```json
{ "event": "session_start", "t": ..., "ts": ..., "version": "4.3.7", "url": "https://tv.youtube.com/watch/..." }
{ "event": "session_end", "t": ..., "ts": ... }
{ "event": "manual_mute_on", "t": ..., "ts": ... }
{ "event": "manual_mute_off", "t": ..., "ts": ... }
```

## Analysis Procedure

### Step 1: Parse and Summarize

```python
entries = data['entries']
snapshots = [e for e in entries if 'event' not in e]
transitions = [e for e in entries if e.get('event') in ('mute', 'unmute')]
boundaries = data['boundaries']
flags = [e for e in entries if e.get('event') == 'flag']
sessions = [e for e in entries if e.get('event') in ('session_start', 'session_end')]
manual_mutes = [e for e in entries if e.get('event') in ('manual_mute_on', 'manual_mute_off')]
```

Report: total duration, snapshot count, muted %, transition count, boundary count, flag count.

### Step 2: Verify Boundaries

For each auto-detected boundary, examine surrounding 30s of snapshots:
- Check if caption content changes character (ALL CAPS interview → mixed case ads, or vice versa)
- Check for caption loss gaps (common at ad break start)
- Check if strong signals appear (hardPhrase, brandDetected, programAllow, returnFromBreak)
- Use flags as anchor points — a flag near a boundary confirms or contradicts it

Mark each boundary as **confirmed**, **adjusted** (move timestamp), or **removed** (false boundary).

### Step 3: Classify Segments

Label each contiguous block between confirmed boundaries as `ad` or `program`. Everything before the first boundary inherits from the initial mute state. Manual mute periods are labeled `program` (user was watching, just didn't want audio).

### Step 4: Find False Positives/Negatives

For each snapshot:
- **False positive**: `muted=true` but segment label is `program`
- **False negative**: `muted=false` but segment label is `ad`

Group consecutive FP/FN runs and report the signal breakdown for each.

### Step 5: Signal Analysis

For each FP/FN cluster, identify:
- Which signals pushed the score in the wrong direction
- Which signals should have fired but didn't
- Whether the issue is a weight problem, threshold problem, or missing signal

### Step 6: Regression Check

Before proposing changes, simulate them against the full session:

```python
def simulate(entries, old_weights, new_weights):
    # For each snapshot, recompute confidence with new weights
    # Compare old vs new mute decisions against labeled ground truth
    # Report: FP/FN eliminated, FP/FN introduced, net change
```

Also run against all files in `docs/labeled/` and historical tuning files.

### Step 7: Append to Labeled Dataset

Save the corrected, labeled session to `docs/labeled/` with the naming convention:
`docs/labeled/YYYY-MM-DD_HHmm_labeled.json`

Format: same as passive log but with added `"label"` field on each entry (`"ad"` or `"program"`), and `"boundaries_verified": true` at the top level.

## Signal Reference

| Signal | Weight | Type | What It Detects | Known Failure Modes |
|--------|--------|------|-----------------|---------------------|
| hardPhrase | +40 | ad | Medicare/Rx disclaimers, direct ad language | Very reliable, few false positives |
| breakCue | +38 | ad | "We'll be right back" type phrases | Reliable |
| brandDetected | +12 | ad | Company/product names in ad context | Can fire on guest intros (suppressed by guestIntro) |
| adContext | +10 | ad | Insurance, financial product terms | Can fire on CNBC financial discussion (dampened by `recentProgram`) |
| ctaDetected | +8 | ad | "Call now", "visit" type phrases | Rare false positives |
| offerDetected | +8 | ad | "Free trial", "limited time" etc | Reliable |
| urlOrPhone | +10 | ad | URLs or phone numbers in captions | Reliable |
| imperativeVoice | +8 | ad | Imperative verbs + "you/your" pronouns | **Fixed v4.3.6**: Was firing on conversational "you" without verbs. Now requires at least one imperative verb. |
| shortPunchyLines | +6 | ad | Avg caption line length < 50 chars | Fires on short CNBC live caption segments. Mild signal, not problematic alone. |
| capsHeavy | +6 | ad | High caps ratio in mixed-case context | Suppressed when avg recent caps is high (CNBC live is ALL CAPS) |
| punctHeavy | +4 | ad | Exclamation marks, ellipses | Mild signal |
| priceMention | +5 | ad | Dollar amounts, percentages | Dampened when recent program signals present. **v4.3.8**: textFeatures total capped at +12 when recentProgram (45s window). |
| captionLoss | +25 max | ad | No captions for extended period | Strong signal at ad break boundaries |
| captionBottomed | +10 | ad | Captions positioned at bottom | |
| caseShift (ad) | +28 | ad | ALL CAPS → mixed case transition | Reliable |
| domAdShowing | +45 | ad | `.ad-showing` class on player | May not work on tv.youtube.com |
| programAllow | -45 | prog | CNBC show titles, tickers, financial terms | Very strong, overrides most ad signals |
| returnFromBreak | -42 | prog | "Welcome back" type phrases | Very strong |
| anchorName | -28 | prog | CNBC anchor names (Cramer, Faber, etc) | |
| guestIntro | -22 | prog | Guest title + intro phrase pattern | |
| segmentName | -18 | prog | "Squawk Box", "Power Lunch" etc | |
| speakerMarker | -15 | prog | `>>` in captions (CNBC speaker change) | Never appears in ads |
| conversational | -12 | prog | Third-person pronouns + analytical words | **v4.3.6**: Added financial terms (earnings, economy, inflation, equities, market, stocks, rates, yields, fiscal, tariffs, monetary, cyclical, sector) |
| caseShift (prog) | -28 | prog | Mixed case → ALL CAPS transition | **v4.3.8**: Halved when adContext/ctaDetected also present (ALL CAPS ads) |

## Known Failure Patterns

### 1. Pronoun-Only Imperative Voice (Fixed v4.3.6)
**Pattern**: Financial discussion with "you/your" but no imperative verbs. `imperativeVoice` fired at ratio 0.08-0.09.
**Fix**: Require at least one imperative verb (get, call, visit, etc).
**Example**: "WHAT DO YOU MEAN SORT OF EXTRA" → ratio=0.09, fired. Now returns 0.

### 2. Quorum Erosion from Mild Signals (Fixed v4.3.6)
**Pattern**: `imperativeVoice(8) + shortPunchyLines(6) = 14 >= 10` eroded program quorum every cycle.
**Fix**: Raised quorum erosion threshold from 10 to 15.

### 3. Chattering on Financial Interviews (Fixed v4.3.6)
**Pattern**: Score oscillates 50→64→36→64 causing rapid mute/unmute. Combination of patterns 1 and 2.
**Fix**: Patterns 1 and 2 fixes plus expanded `_ANALYTICAL` terms.

### 4. Sticky PROGRAM_QUORUM_MET (Fixed earlier)
**Pattern**: Quorum persisted across ad breaks, preventing muting.
**Fix**: 15s freshness requirement + caption loss resets quorum.

### 5. Price on Financial Content (Improved v4.3.8)
**Pattern**: Price mentions (+5) and textFeatures (+25 for price patterns like "$10") fire on CNBC market discussion.
**Fix**: `priceMention` suppressed when `recentProgram` is set. `textFeatures` capped at +12 when `recentProgram` is set (45s window). Still worth monitoring for edge cases near the window boundary.

### 6. ALL CAPS Ads Triggering caseShift→program (Mitigated v4.3.8)
**Pattern**: Some ads (e.g., Coventry Direct) use ALL CAPS text identical to CNBC live captions. After captionLoss, caseShift detects ALL CAPS continuity and awards -28 (program signal).
**Mitigation**: caseShift(program) weight halved when `adContext` or `ctaDetected` are also present. Known limitation: if no ad signals fire alongside caseShift, the false program signal persists. User flag → ad_lock provides recovery.

### 7. Parent Company Ads Triggering programAllow (Fixed v4.3.8)
**Pattern**: "Comcast Business" ads trigger `programAllow(-45)` because "Comcast" (CNBC parent) is in the allow phrase list via caption window residual.
**Fix**: `programAllow` override suppressed in decision engine when `brandDetected` also fires on the same evaluation. "Comcast Business" added to brand terms.

### 8. Testimonial-Style Ads Score Low (Monitoring)
**Pattern**: First-person testimonial ads ("I didn't like the person looking back at me", "You and your team worked within my budget") trigger `conversational(-8)` because they use first-person pronouns and analytical-adjacent language. Net score stays at 36-42, well below threshold.
**Status**: Not yet addressed. Only observed during manual mute period (no user impact). Future signal for "testimonial pattern" could help.

## Regression Test Procedure

Run proposed scoring changes against ALL historical data:

1. Tuning session files in `docs/` (named `yttp_tuning_*.json`)
2. Labeled passive logs in `docs/labeled/`
3. Tuning files on NAS at `/Volumes/NAS/1.  Dump/yttp_tuning_*.json`

For each file, simulate old vs new scoring and report:
- Snapshots that cross threshold in either direction
- Whether each changed snapshot is actual ad or program content
- Net false positive / false negative change

**Zero regressions** is the bar. Any new false mutes or missed ads must be investigated.
