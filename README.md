# YTTV Auto-Mute

A Tampermonkey/Greasemonkey userscript that automatically mutes advertisements on YouTube TV using signal-aggregation confidence scoring.

## Overview

This userscript intelligently detects when ads are playing on YouTube TV (primarily targeting CNBC and financial news channels) and automatically mutes them. It uses a **signal-aggregation confidence system** where 21+ weighted signals (ad-leaning and program-leaning) feed a 0-100 confidence meter — no single signal can trigger a mute on its own.

## Features

- **Signal-Aggregation Confidence Scoring**: 21+ independent signals contribute weighted scores to a 0-100 confidence meter. Muting only occurs when the aggregate confidence exceeds a configurable threshold (default: 65).
- **Smart Caption Analysis**: Detects ads by analyzing closed caption text for pharma disclaimers, brand mentions, CTAs, offer language, imperative voice patterns, and case shift transitions.
- **Guest Intro Detection**: Suppresses brand-name signals when editorial discussion context is detected (e.g., "joining us from Fidelity" won't trigger a mute).
- **Sliding Caption Window**: Analyzes both the latest caption line and a sliding window of recent lines for broader context.
- **Program Detection**: 33 CNBC anchor names, 14 named segments, 11 return-from-break phrases, and ~50 allow phrases for strong program identification.
- **Case Shift Detection**: Tracks capitalization history — CNBC live captions are ALL CAPS while ads are mixed case. Transitions between styles provide strong directional signals.
- **Passive Logging**: Continuous structured logging over multi-hour sessions with auto-detected ad boundaries, periodic auto-save, and flag capture for offline analysis and tuning.
- **Active Tuning Session**: Timed 5-minute diagnostic workflow with signal snapshots, active flagging, post-session questionnaire, and downloadable JSON report.
- **Ad Lock Mechanism**: Maintains mute for 45 seconds (configurable) during commercial breaks with a decaying floor to prevent rapid toggling.
- **Program Quorum System**: Requires consecutive program-leaning captions before unmuting to avoid false positives.
- **Manual Mute Override**: Toggle persistent mute independently of the auto-mute system (e.g., during meetings).
- **Structured Feedback System**: Flag false positives/negatives with full signal breakdown capture for analysis and weight tuning.
- **Volume Ramping**: Smooth ease-in volume ramp on unmute (1.5s default, configurable) instead of jarring instant unmute.
- **Visual HUD**: On-screen display with confidence meter, threshold slider, signal breakdown, and mute status.
- **Data-Driven Settings Panel**: Tabbed settings panel with all detection parameters, phrase lists, and timing controls.
- **Hotkey Support**: Quick keyboard shortcuts for common actions.

## Installation

### Prerequisites

- A userscript manager extension:
  - [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari)
  - [Greasemonkey](https://www.greasespot.net/) (Firefox)
  - [Violentmonkey](https://violentmonkey.github.io/) (Chrome, Firefox, Edge)

### Install Steps

1. Install a userscript manager in your browser
2. Click on `youtubetv-auto-mute.user.js` in this repository
3. Click the "Raw" button to view the raw script
4. Your userscript manager should prompt you to install it
5. Confirm the installation
6. Navigate to [tv.youtube.com](https://tv.youtube.com) and the script will activate automatically

Alternatively, you can copy the entire script content and create a new userscript in your manager.

## How It Works

### Signal-Aggregation Pipeline

```
Caption Text → SignalCollector (21+ signals) → ConfidenceScorer (0-100) → DecisionEngine → Mute/Unmute
```

Each signal contributes a positive (ad-leaning) or negative (program-leaning) weight to a base score of 50. The final confidence score determines whether to mute.

### Ad-Leaning Signals (positive weight)

| Signal | Weight | Description |
|--------|--------|-------------|
| DOM Ad Showing | +45 | `.ad-showing` class on video player |
| Hard Phrase | +40 | Pharma disclaimers, paid programming, strong ad markers |
| Break Cue | +38 | "we'll be right back", "stay with us" |
| Case Shift → Ad | +28 | ALL CAPS captions transition to mixed case |
| Brand Detected | +12 | Known advertiser brands (suppressed during guest intros) |
| Ad Context | +10 | "sponsored by", ".com", "call now" |
| URL/Phone | +10 | URLs or phone numbers in caption text |
| Caption Bottomed | +10 | Captions positioned at bottom of screen |
| CTA Detected | +8 | "apply now", "enroll", "sign up" |
| Offer Detected | +8 | "$0 premium", "limited time", pricing language |
| Imperative Voice | +8 | Imperative verbs + "you/your" pronouns (requires verb) |
| Short Punchy Lines | +6 | Average caption line length < 50 chars |
| Caps Heavy | +6 | High caps ratio in mixed-case context |
| Price Mention | +5 | Dollar amounts, percentages (dampened during program) |
| Caption Loss | +25 max | Captions disappear (common at ad break boundaries) |
| Text Features | varies | Caps, punctuation density, price patterns (capped at +12 during program) |
| Punct Heavy | +4 | Exclamation marks, ellipses |

### Program-Leaning Signals (negative weight)

| Signal | Weight | Description |
|--------|--------|-------------|
| Program Allow | -45 | "earnings", "breaking news", CNBC show names (suppressed when brand also detected) |
| Return from Break | -42 | "welcome back to squawk", "we are back" |
| Case Shift → Program | -28 | Mixed case captions transition to ALL CAPS (halved when ad signals present) |
| Anchor Name | -28 | 33 CNBC anchors (Sara Eisen, Jim Cramer, etc.) |
| Guest Intro | -22 | Editorial brand discussion context |
| Segment Name | -18 | "lightning round", "final trades", etc. |
| Speaker Marker | -15 | `>>` in captions (CNBC speaker change, never in ads) |
| Conversational | -12 | Third-person pronouns + analytical/financial terms |

### State Management

- **Ad Lock**: When confidence exceeds 82, locks mute for 45s (configurable) with a decaying floor
- **Program Quorum**: Requires multiple consecutive program signals before unmuting
- **Manual Override**: After flagging a false positive, prevents re-muting for 8s
- **Recent Program**: Tracks when strong program signals last fired; dampens price/textFeatures signals within 45s

## Usage

### Hotkeys

- **Ctrl+M**: Toggle script on/off
- **Ctrl+D**: Download caption log
- **Ctrl+Shift+S**: Open settings panel
- **Ctrl+Shift+F**: Flag incorrect state (captures full signal breakdown)
- **Ctrl+Shift+T**: Start/stop tuning session

### Settings Panel

Press **Ctrl+Shift+S** to open the tabbed settings panel:

- **General**: True mute toggle, debug logging, caption visibility, passive logging toggle
- **HUD**: Confidence meter style, threshold slider, animation settings
- **Timing**: Poll interval, CC loss delay, ad lock duration, quorum settings, caption window size, volume ramp
- **Phrases**: All phrase lists (one per line, editable)
- **Actions**: Download/clear logs, export/import settings, download/clear passive log

### HUD (Heads-Up Display)

The HUD shows:
- Current mute state (MUTED/UNMUTED)
- Reason for the current state
- Confidence meter (bar, numeric, or both)
- Adjustable threshold slider
- Top 3 contributing signals with weights

### Passive Logging

Passive logging runs continuously in the background, capturing structured data for offline analysis:

- **Periodic snapshots** every 5 seconds with confidence, signals, caption text, and mute state
- **Transition events** captured immediately on every mute/unmute change
- **Auto-detected boundaries** marking probable ad-break start/end events
- **Flag events** when you press Flag Incorrect State (ground truth labels)
- **Session lifecycle** events (start, end, manual mute on/off)
- **Auto-save** every 15 minutes via download (filename includes start and end time)
- **Ring buffer** holds ~2500 records (~3.5 hours) with persistence across page refreshes

Download passive logs from the settings panel and provide them for analysis to tune signal weights.

### Active Tuning Session

The tuning session is a structured 5-minute workflow for collecting high-quality diagnostic data:

1. **Start**: Click "Start Tuning" button (bottom-left) or press **Ctrl+Shift+T**
2. **Watch**: Pay close attention and flag every incorrect mute/unmute with the "Flag Incorrect State" button
3. **Timer**: HUD shows countdown (e.g., `[TUNING 3:45]`) so you know when the session ends
4. **Post-session dialog**: After the timer expires, a dialog asks:
   - Were there commercial breaks during this session?
   - Where were most incorrect states? (false positives / false negatives / both / none)
   - Optional notes
5. **Download report**: Comprehensive JSON file with signal snapshots (every 5s), all flags, caption log, settings, and your feedback

### Feedback System

Click the red "Flag Incorrect State" button (or press Ctrl+Shift+F) when the script makes a mistake. Each feedback entry captures:
- Whether it was a false positive or false negative
- Full signal array with weights and matches
- Last 5 caption lines for context
- Confidence score and ad lock state
- URL and timestamp

Download feedback as JSON from the settings panel for analysis and weight tuning.

## Configuration

### Key Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `intervalMs` | 150 | How often to check captions (ms) |
| `confidenceThreshold` | 65 | Mute when confidence >= this (0-100) |
| `muteOnNoCCDelayMs` | 2500 | How quickly to mute when captions disappear (ms) |
| `noCcHitsToMute` | 2 | Consecutive no-caption checks before muting |
| `minAdLockMs` | 45000 | Minimum ad lock duration (45 seconds) |
| `programVotesNeeded` | 2 | Program signals needed before unmute consideration |
| `programQuorumLines` | 3 | Consecutive program captions needed to unmute |
| `unmuteDebounceMs` | 350 | Delay before unmuting after program detected (ms) |
| `manualOverrideMs` | 8000 | Override duration after flagging false positive (ms) |
| `captionWindowSize` | 5 | Number of recent caption lines for window analysis |
| `volumeRampMs` | 1500 | Volume ramp duration on unmute (0 = instant) |
| `tuningDurationMs` | 300000 | Tuning session length (5 minutes) |
| `passiveLogging` | true | Enable continuous passive logging |
| `passiveLogIntervalMs` | 5000 | Passive snapshot interval |
| `passiveSaveIntervalMs` | 900000 | Passive auto-save interval (15 minutes) |
| `passiveLogCapacity` | 2500 | Max records in passive log ring buffer |

### Phrase Lists

The script includes extensive customizable phrase lists:

- **Hard Phrases**: Rx disclaimers, pharma safety info, paid programming, strong ad markers
- **Brand Terms**: ~100 advertisers across financial, telecom, pharma, insurance, auto, tech, gold, and legal categories
- **Ad Context**: Sponsorship language, promo codes, guarantees, order/shop CTAs
- **CTA Terms**: "apply now", "call today", "learn more"
- **Offer Terms**: Pricing, guarantees, benefits
- **Allow Phrases**: ~50 CNBC show names, welcome variants, market terms, conversational anchors
- **Break Phrases**: Commercial break announcements
- **Anchor Names**: 33 CNBC on-air personalities
- **Segment Names**: 14 named CNBC segments
- **Return-from-Break**: 11 phrases indicating program resumption

All lists are editable in the settings panel (Phrases tab).

## Logging and Debugging

### Caption Logs

All captions are logged with timestamps. Access them via:
- **Ctrl+D**: Download current log as text file
- Settings panel: Configure auto-download intervals, clear logs

### Feedback Logs

Structured JSON logs of every false positive/negative flag. Download from Settings > Actions.

### Console Debugging

Enable in settings:
- `debug`: General logging (mute/unmute events, route changes, boot info)
- `debugVerboseCC`: Log every caption change in real-time

## Troubleshooting

### Script Not Working

1. Ensure closed captions are enabled on YouTube TV
2. Check browser console for errors (F12)
3. Verify userscript manager is active and script is enabled
4. Try reloading the page

### Too Many False Positives (Muting During Shows)

1. Raise `confidenceThreshold` (try 70-75)
2. Add common show phrases to "Allow Phrases" list
3. Decrease `minAdLockMs` (shorter ad lock duration)
4. Check feedback log to see which signals are triggering

### Not Muting Ads

1. Lower `confidenceThreshold` (try 55-60)
2. Add common ad phrases to "Hard Phrases" or "Brand Terms"
3. Decrease `muteOnNoCCDelayMs` (faster mute on caption loss)
4. Check caption logs to see what text appears during ads

### HUD Issues

- Not visible: Enable "Show HUD always" in settings
- Wrong position: HUD is fixed to bottom-center; check for page zoom issues
- Not updating: Verify script is enabled (Ctrl+M to toggle)

## Technical Details

- **Architecture**: SignalCollector → ConfidenceScorer → DecisionEngine pipeline
- **Namespace**: Uses `window.__yttpMute__` to prevent conflicts
- **Storage**: Settings and logs persist via GM_getValue/localStorage with debounced writes
- **PhraseIndex**: Compiled regex from phrase lists (3-10x faster than array iteration)
- **TextAnalyzer**: CharCode-based text analysis (no regex array allocations)
- **Route Detection**: History API interception (pushState/replaceState + popstate)
- **HUD**: Build DOM once, update only textContent on subsequent calls
- **DOM Caching**: Video and caption window queries cached with 2s TTL
- **Passive Log**: Ring buffer with GM persistence, auto-boundary detection, periodic auto-save via GM_download

## License

MIT License - See script header for details

## Contributing

Found an issue or want to improve detection? This is an open userscript - feel free to:
- Fork and modify
- Share improved phrase lists
- Submit feedback logs to help tune signal weights
- Report detection patterns that need adjustment

## Credits

Developed for CNBC and financial news viewers on YouTube TV. Optimized for financial news ad patterns including Medicare/benefits, pharma, and financial services advertisements.

---

**Version**: 4.3.8
**Last Updated**: 2026-02-25
