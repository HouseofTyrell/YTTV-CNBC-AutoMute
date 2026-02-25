# Passive Tuning System Design

**Date:** 2026-02-25
**Status:** Approved

## Problem

The current tuning loop requires active focus: start a 5-minute session, watch closely, flag false positives/negatives, download a report, analyze, repeat. This is time-intensive and captures only short windows of behavior. We need a way to gather rich structured data passively over 2-4 hour viewing sessions, then analyze it offline.

## Approach

**Smart Logger in the Userscript + Claude Analysis (Approach A)**

The userscript runs a continuous structured log alongside the existing scoring pipeline. A lightweight boundary detector marks probable ad-break start/end events. Data auto-saves periodically via `GM_download`. Claude verifies/corrects auto-detected boundaries and produces signal tuning recommendations. Corrected sessions accumulate into a labeled dataset for regression testing.

The existing active tuning system remains available as-is.

## Components

### 1. Continuous Structured Log

A ring buffer (`State.passiveLog`) captures two types of records:

**Periodic snapshots** — sampled every 5 seconds (configurable via `passiveLogIntervalMs`):

```json
{
  "ts": "09:06:10",
  "t": 1740499570000,
  "conf": 64,
  "muted": true,
  "reason": "CONFIDENCE_HIGH",
  "signals": [{"s": "imperativeVoice", "w": 8, "m": "ratio=0.09"}],
  "caption": "RUSSELL 2000 TO WORK...",
  "adLock": false,
  "quorum": 3,
  "pv": 2
}
```

**Transition events** — captured immediately when mute state changes, regardless of the 5s interval:

```json
{
  "ts": "09:06:26",
  "t": 1740499586000,
  "event": "mute",
  "conf": 64,
  "muted": true,
  "reason": "CONFIDENCE_HIGH",
  "signals": [{"s": "imperativeVoice", "w": 8}, {"s": "shortPunchyLines", "w": 6}],
  "caption": "RUSSELL 2000 TO WORK...",
  "adLock": false,
  "quorum": 0,
  "pv": 0
}
```

**Buffer capacity:** ~2500 records (~3.5 hours at 5s intervals plus transitions). Each record is ~200-300 bytes, total ~500-750KB. Stored under a dedicated GM storage key, separate from the caption log.

**Setting:** `passiveLogging: true` (default on). Toggle in settings panel.

### 2. Session Lifecycle Events

**Session start** — emitted on script boot (page load / refresh):

```json
{
  "ts": "09:00:00",
  "t": 1740499200000,
  "event": "session_start",
  "version": "4.3.6",
  "url": "https://tv.youtube.com/watch/..."
}
```

**Session end** — emitted on `beforeunload`:

```json
{
  "ts": "11:30:00",
  "t": 1740508200000,
  "event": "session_end"
}
```

These markers let Claude understand gaps between viewing periods (refreshes, navigation away, stream off).

### 3. Manual Mute Override Events

When the user engages/disengages manual mute:

```json
{"ts": "10:00:00", "t": ..., "event": "manual_mute_on"}
{"ts": "10:45:00", "t": ..., "event": "manual_mute_off"}
```

Snapshots continue logging during manual mute with `reason: "MANUAL_MUTE"`. This is valuable data — confidence scores reflect what the system *would have done*, providing free labeled program-content data.

### 4. Flag Events

The existing "Flag Incorrect State" button (always visible in row 1) writes to the passive log in addition to tuning flags:

```json
{
  "ts": "09:12:30",
  "t": 1740499950000,
  "event": "flag",
  "type": "false_positive",
  "conf": 64,
  "muted": true,
  "reason": "CONFIDENCE_HIGH",
  "signals": [{"s": "imperativeVoice", "w": 8}],
  "caption": "RUSSELL 2000 TO WORK..."
}
```

Flags are human-labeled ground truth. The subsequent mute/unmute transition is also captured automatically.

### 5. Auto-Boundary Detection

The boundary detector watches for patterns and emits boundary markers:

**Ad break start triggers** (any of):
- Caption loss exceeding `muteOnNoCCDelayMs` followed by confidence spike
- Confidence crossing threshold upward (actual mute moment)
- `domAdShowing` turning true
- `adLock` engaging (confidence >= 82)

**Ad break end triggers** (any of):
- `returnFromBreak` or `programAllow` phrase detected
- `PROGRAM_QUORUM_MET` or `PROGRAM_CONFIRMED` after a muted period
- caseShift → program detected

Boundary records:

```json
{
  "ts": "09:12:45",
  "t": 1740499965000,
  "event": "boundary",
  "type": "ad_start",
  "trigger": "confidence_crossed",
  "conf": 72
}
```

These are preliminary labels — Claude verifies and corrects them during analysis.

### 6. Auto-Save

- **Method:** `GM_download` with `saveAs: false` (no dialog, straight to download folder)
- **Interval:** Every 15 minutes (configurable via `passiveSaveIntervalMs`)
- **Strategy:** Accumulate into a single session file. Each save overwrites with the full buffer. Filename uses session start time: `yttp_passive_2026-02-25_0900.json`
- **On `beforeunload`:** Final save attempt to capture tail end
- **Buffer clear:** After successful save, only clear records older than the save point (keep recent context for boundary detection)

### 7. Output File Format

```json
{
  "version": "4.3.6",
  "format": "passive_log",
  "sessionStart": "2026-02-25T16:00:00.000Z",
  "settings": {
    "confidenceThreshold": 63,
    "minAdLockMs": 45000,
    "muteOnNoCCDelayMs": 2500,
    "programVotesNeeded": 2,
    "programQuorumLines": 3,
    "captionWindowSize": 5
  },
  "entries": [
    {"event": "session_start", "t": ..., "ts": "09:00:00", "version": "4.3.6", "url": "..."},
    {"t": ..., "ts": "09:00:05", "conf": 42, "muted": false, "reason": "LOW_CONFIDENCE", ...},
    {"t": ..., "ts": "09:00:12", "event": "mute", "conf": 68, ...},
    {"t": ..., "ts": "09:00:13", "event": "boundary", "type": "ad_start", "trigger": "confidence_crossed"},
    {"event": "flag", "type": "false_positive", ...},
    {"event": "session_end", "t": ...}
  ],
  "boundaries": [
    {"type": "ad_start", "t": ..., "trigger": "confidence_crossed"},
    {"type": "ad_end", "t": ..., "trigger": "program_quorum_met"}
  ]
}
```

The `boundaries` array is a convenience summary extracted from inline boundary events for quick overview.

## Settings Additions

| Setting | Default | Description |
|---------|---------|-------------|
| `passiveLogging` | `true` | Enable/disable passive logging |
| `passiveLogIntervalMs` | `5000` | Snapshot interval |
| `passiveSaveIntervalMs` | `900000` | Auto-save interval (15 min) |
| `passiveLogCapacity` | `2500` | Max records in ring buffer |

## Analysis Workflow (Claude)

Documented in `docs/tuning-runbook.md`. Steps:

1. Parse and summarize — session duration, snapshot count, mute %, boundary count
2. Verify boundaries — examine surrounding signals/captions, confirm or correct ad/program labels
3. Classify segments — label each contiguous block as `ad` or `program`
4. Analyze false positives/negatives — find snapshots where `muted` disagrees with classified label
5. Signal analysis — identify which signals drove incorrect decisions, recommend weight/threshold changes
6. Regression check — simulate proposed changes against the full session
7. Append to labeled dataset — save corrected session to `docs/labeled/` for future regression testing

## What Doesn't Change

- The existing active tuning system (Start Tuning button, 5-min sessions, tuning dialog, tuning report download) remains fully intact
- The caption log continues operating independently
- All existing HUD, settings, and scoring behavior is unchanged
