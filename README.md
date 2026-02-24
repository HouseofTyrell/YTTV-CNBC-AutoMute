# YTTV Auto-Mute

A Tampermonkey/Greasemonkey userscript that automatically mutes advertisements on YouTube TV using signal-aggregation confidence scoring.

## Overview

This userscript intelligently detects when ads are playing on YouTube TV (primarily targeting CNBC and financial news channels) and automatically mutes them. It uses a **signal-aggregation confidence system** where 18 weighted signals (ad-leaning and program-leaning) feed a 0-100 confidence meter — no single signal can trigger a mute on its own.

## Features

- **Signal-Aggregation Confidence Scoring**: 18 independent signals contribute weighted scores to a 0-100 confidence meter. Muting only occurs when the aggregate confidence exceeds a configurable threshold (default: 65).
- **Smart Caption Analysis**: Detects ads by analyzing closed caption text for pharma disclaimers, brand mentions, CTAs, offer language, and imperative voice patterns.
- **Guest Intro Detection**: Suppresses brand-name signals when editorial discussion context is detected (e.g., "joining us from Fidelity" won't trigger a mute).
- **Sliding Caption Window**: Analyzes both the latest caption line and a sliding window of recent lines for broader context.
- **Program Detection**: 33 CNBC anchor names, 14 named segments, 11 return-from-break phrases, and ~50 allow phrases for strong program identification.
- **Tuning Session**: Timed 5-minute diagnostic workflow with signal snapshots, active flagging, post-session questionnaire, and downloadable JSON report for weight tuning.
- **Ad Lock Mechanism**: Maintains mute for 45 seconds (configurable) during commercial breaks to prevent rapid toggling.
- **Program Quorum System**: Requires consecutive program-leaning captions before unmuting to avoid false positives.
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
Caption Text → SignalCollector (18 signals) → ConfidenceScorer (0-100) → DecisionEngine → Mute/Unmute
```

Each signal contributes a positive (ad-leaning) or negative (program-leaning) weight to a base score of 50. The final confidence score determines whether to mute.

### Ad-Leaning Signals (positive weight)

| Signal | Weight | Description |
|--------|--------|-------------|
| Hard Phrase | +40 | Pharma disclaimers, paid programming, strong ad markers |
| Break Cue | +38 | "we'll be right back", "stay with us" |
| Brand Detected | +15 | Known advertiser brands (suppressed during guest intros) |
| Ad Context | +10 | "sponsored by", ".com", "call now" |
| URL/Phone | +10 | URLs or phone numbers in caption text |
| CTA Detected | +8 | "apply now", "enroll", "sign up" |
| Offer Detected | +8 | "$0 premium", "limited time", pricing language |
| Imperative Voice | +8 | High ratio of "you/your" + command verbs |
| Caption Loss | +18 max | Captions disappear (common during ads) |
| Text Features | varies | ALL CAPS, excessive punctuation, price mentions |

### Program-Leaning Signals (negative weight)

| Signal | Weight | Description |
|--------|--------|-------------|
| Program Allow | -45 | "earnings", "breaking news", show names |
| Return from Break | -42 | "welcome back to squawk", "we are back" |
| Anchor Name | -28 | 33 CNBC anchors (Sara Eisen, Jim Cramer, etc.) |
| Program Anchor | -25 | Regex-based: "joins us now", "conference call", etc. |
| Guest Intro | -22 | Editorial brand discussion context |
| Segment Name | -18 | "lightning round", "final trades", etc. |
| Conversational | -12 | Third-person analytical language patterns |

### State Management

- **Ad Lock**: When confidence exceeds 75, locks mute for 75s (configurable) with a floor of 65
- **Program Quorum**: Requires multiple consecutive program signals before unmuting
- **Manual Override**: After flagging a false positive, prevents re-muting for 8s

## Usage

### Hotkeys

- **Ctrl+M**: Toggle script on/off
- **Ctrl+D**: Download caption log
- **Ctrl+Shift+S**: Open settings panel
- **Ctrl+Shift+F**: Flag incorrect state (captures full signal breakdown)
- **Ctrl+Shift+T**: Start/stop tuning session

### Settings Panel

Press **Ctrl+Shift+S** to open the tabbed settings panel:

- **General**: True mute toggle, debug logging, caption visibility
- **HUD**: Confidence meter style, threshold slider, animation settings
- **Timing**: Poll interval, CC loss delay, ad lock duration, quorum settings, caption window size, volume ramp
- **Phrases**: All phrase lists (one per line, editable)
- **Actions**: Download/clear logs, export/import settings, download feedback log

### HUD (Heads-Up Display)

The HUD shows:
- Current mute state (MUTED/UNMUTED)
- Reason for the current state
- Confidence meter (bar, numeric, or both)
- Adjustable threshold slider
- Top 3 contributing signals with weights

### Feedback System

Click the red "Flag Incorrect State" button (or press Ctrl+Shift+F) when the script makes a mistake. Each feedback entry captures:
- Whether it was a false positive or false negative
- Full signal array with weights and matches
- Last 5 caption lines for context
- Confidence score and ad lock state
- URL and timestamp

Download feedback as JSON from the settings panel for analysis and weight tuning.

### Tuning Session

The tuning session is a structured 5-minute workflow for collecting high-quality diagnostic data:

1. **Start**: Click "Start Tuning" button (bottom-left) or press **Ctrl+Shift+T**
2. **Watch**: Pay close attention and flag every incorrect mute/unmute with the "Flag Incorrect State" button
3. **Timer**: HUD shows countdown (e.g., `[TUNING 3:45]`) so you know when the session ends
4. **Post-session dialog**: After the timer expires, a dialog asks:
   - Were there commercial breaks during this session?
   - Where were most incorrect states? (false positives / false negatives / both / none)
   - Optional notes
5. **Download report**: Comprehensive JSON file with signal snapshots (every 5s), all flags, caption log, settings, and your feedback

Share the downloaded tuning report in a new session for analysis and weight tuning to improve accuracy.

## Configuration

### Key Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `intervalMs` | 150 | How often to check captions (ms) |
| `confidenceThreshold` | 72 | Mute when confidence >= this (0-100) |
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

1. Lower `confidenceThreshold` (default 65, try 70-75)
2. Add common show phrases to "Allow Phrases" list
3. Decrease `minAdLockMs` (shorter ad lock duration)
4. Check feedback log to see which signals are triggering

### Not Muting Ads

1. Raise `confidenceThreshold` (try 55-60)
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

**Version**: 4.0.4
**Last Updated**: 2026
