# YTTV Auto-Mute

A Tampermonkey/Greasemonkey userscript that automatically mutes advertisements on YouTube TV by analyzing closed captions and video behavior patterns.

## Overview

This userscript intelligently detects when ads are playing on YouTube TV (primarily targeting CNBC and financial news channels) and automatically mutes them. It uses a sophisticated detection system based on closed caption analysis, program/ad phrase matching, and visual cues to determine when to mute and unmute content.

## Features

- **Smart Caption Analysis**: Detects ads by analyzing closed caption text for common advertising phrases, Medicare/benefits terminology, brand mentions, and call-to-action language
- **Program Detection**: Recognizes when actual programming resumes using anchor phrases like "joining me now", "back to you", earnings discussions, and breaking news cues
- **Ad Lock Mechanism**: Maintains mute during commercial breaks to prevent rapid toggling
- **Program Quorum System**: Requires consecutive program-leaning captions before unmuting to avoid false positives
- **Manual Override**: Flag false positives with Ctrl+F to teach the script when it makes mistakes
- **Visual HUD**: Optional on-screen display showing mute status, reason, and caption snippets
- **Caption Logging**: Records all captions with timestamps for debugging and analysis
- **Customizable Detection**: Fully configurable phrase lists, timing parameters, and detection thresholds
- **Hotkey Support**: Quick keyboard shortcuts for common actions

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

The script uses multiple detection strategies:

### 1. Caption-Based Detection

- **Hard Ad Phrases**: Medical disclaimers ("ask your doctor", "side effects include"), Medicare/benefits terms, financial offers
- **Brand + Context Detection**: Recognizes brand names combined with advertising context (URLs, phone numbers, CTAs)
- **Break Cues**: Detects explicit commercial break announcements ("back after this", "we'll be right back")
- **Program Anchors**: Identifies strong program signals ("joining me now", "breaking news", earnings discussions)

### 2. Visual Cues

- **Caption Loss**: Rapid muting when captions disappear (common during ads)
- **Bottom-Positioned Captions**: Detects when captions are bottom-aligned (typical ad behavior)

### 3. Intelligent State Management

- **Ad Lock**: Once an ad is detected, maintains mute for a minimum duration to cover full commercial breaks
- **Program Quorum**: Requires multiple consecutive program-leaning caption lines before unmuting
- **Voting System**: Accumulates evidence before changing mute state
- **Manual Override Window**: After flagging a false positive, prevents re-muting for several seconds unless strong ad signals detected

## Usage

### Hotkeys

- **Ctrl+M**: Toggle script on/off
- **Ctrl+D**: Download caption log
- **Ctrl+Shift+S**: Open settings panel
- **Ctrl+F**: Flag false positive (logs current state and toggles mute)

### Settings Panel

Press **Ctrl+Shift+S** to open the comprehensive settings panel where you can:

- Toggle true mute vs. volume reduction
- Adjust timing parameters (poll interval, debounce delays, ad lock duration)
- Configure HUD display options
- Edit detection phrase lists
- Import/export settings
- Clear caption logs
- Reset to defaults

### HUD (Heads-Up Display)

The optional HUD shows:
- Current mute state (MUTED/UNMUTED)
- Reason for the current state
- Matched phrase (if applicable)
- Caption snippet

Configure HUD behavior in settings:
- Always visible
- Auto-show only when muted
- Customizable fade animations and positioning

### Flag False Positive Button

A red "Flag False Positive" button appears in the bottom-left corner. Click it (or press Ctrl+F) when the script:
- Mutes during actual programming
- Fails to mute during ads

This logs the event and temporarily overrides the current state, helping you identify patterns to adjust settings.

## Configuration

### Key Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `intervalMs` | 150 | How often to check captions (milliseconds) |
| `muteOnNoCCDelayMs` | 180 | How quickly to mute when captions disappear |
| `noCcHitsToMute` | 2 | Consecutive no-caption checks before muting |
| `minAdLockMs` | 20000 | Minimum ad lock duration (20 seconds) |
| `programVotesNeeded` | 2 | Program signals needed before unmute consideration |
| `programQuorumLines` | 4 | Consecutive program captions needed to unmute |
| `unmuteDebounceMs` | 500 | Delay before unmuting after program detected |
| `manualOverrideMs` | 8000 | Override duration after flagging false positive |

### Phrase Lists

The script includes extensive customizable phrase lists:

- **Hard Phrases**: Rx disclaimers, Medicare terms, financial offers
- **Brand Terms**: Major advertisers (financial, telecom, pharma, etc.)
- **Ad Context**: Sponsorship, CTAs, offers
- **CTA Terms**: "apply now", "call today", "learn more"
- **Offer Terms**: Pricing, guarantees, benefits
- **Allow Phrases**: Strong program indicators (analyst names, market terminology)
- **Break Phrases**: Explicit commercial break announcements

All lists are editable in the settings panel.

## Logging and Debugging

### Caption Logs

All captions are logged with timestamps. Access them via:
- **Ctrl+D**: Download current log as text file
- Settings panel: View, clear, or configure auto-download intervals

### Event Logs

The script logs all mute/unmute events with:
- Timestamp
- Action (MUTED/UNMUTED/FLAG_FALSE_POSITIVE)
- Reason/verdict
- Matched phrase
- Caption snippet
- State variables (ad lock, program votes, quorum count)

### Console Debugging

Enable in settings:
- `debug`: General logging
- `debugVerboseCC`: Log every caption change in real-time

## Troubleshooting

### Script Not Working

1. Ensure closed captions are enabled on YouTube TV
2. Check browser console for errors (F12)
3. Verify userscript manager is active and script is enabled
4. Try reloading the page

### Too Many False Positives (Muting During Shows)

1. Reduce `programQuorumLines` (requires fewer program captions to unmute)
2. Reduce `programVotesNeeded`
3. Add common show phrases to "Allow Phrases" list
4. Decrease `minAdLockMs` (shorter ad lock duration)

### Not Muting Ads

1. Increase `programQuorumLines` (requires more evidence before unmuting)
2. Add common ad phrases to "Hard Phrases" or "Brand Terms"
3. Decrease `muteOnNoCCDelayMs` (faster mute on caption loss)
4. Check caption logs to see what text appears during ads

### HUD Issues

- Not visible: Enable "Show HUD always" in settings
- Wrong position: HUD is fixed to bottom-right; check for page zoom issues
- Not updating: Verify script is enabled (Ctrl+M to toggle)

## Technical Details

- **Namespace**: Uses `window.__yttpMute__` to prevent conflicts
- **Storage**: Settings and logs persist via GM_getValue/localStorage
- **Observers**: MutationObserver watches captions and route changes
- **Performance**: Configurable polling with RAF-based fast recheck option

## License

MIT License - See script header for details

## Contributing

Found an issue or want to improve detection? This is an open userscript - feel free to:
- Fork and modify
- Share improved phrase lists
- Report detection patterns that need adjustment

## Credits

Developed for CNBC and financial news viewers on YouTube TV. Heavily weighted detection for Medicare/benefits advertisements which are common during financial news programming.

---

**Version**: 3.0
**Last Updated**: 2024
