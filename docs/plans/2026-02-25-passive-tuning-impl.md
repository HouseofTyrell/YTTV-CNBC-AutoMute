# Passive Tuning System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add continuous structured logging with auto-boundary detection, flag capture, and periodic auto-save so tuning data can be gathered passively over 2-4 hour viewing sessions.

**Architecture:** A ring buffer (`State.passiveLog`) collects snapshot records every 5s, mute transition records immediately on state change, boundary markers from a lightweight detector, flag events from the existing Flag button, and session lifecycle events. A timer auto-saves via `GM_download` every 15 minutes. The existing active tuning system remains untouched.

**Tech Stack:** Tampermonkey userscript (vanilla JS), GM_download API, GM_getValue/GM_setValue for persistence.

**Single file:** `youtubetv-auto-mute.user.js`

---

### Task 1: Add Passive Log State and Settings

**Files:**
- Modify: `youtubetv-auto-mute.user.js:80-125` (DEFAULTS)
- Modify: `youtubetv-auto-mute.user.js:265` (SETTINGS_KEY bump)
- Modify: `youtubetv-auto-mute.user.js:314-364` (State object)

**Step 1: Add defaults for passive logging**

In the `DEFAULTS` object (after line 124 `captionLogLimit:8000,`), add:

```js
    // Passive logging
    passiveLogging:true,
    passiveLogIntervalMs:5000,
    passiveSaveIntervalMs:900000, // 15 min
    passiveLogCapacity:2500,
```

**Step 2: Bump SETTINGS_KEY**

Change line 265 from:
```js
const SETTINGS_KEY='yttp_settings_v4_3_5';
```
to:
```js
const SETTINGS_KEY='yttp_settings_v4_3_7';
```

**Step 3: Add passive log state**

In the `State` object (after line 341 `tuningLogStartIdx: 0,`), add:

```js
    // Passive logging
    passiveLog: [],
    passiveSessionStart: 0,
    passiveLastSnapshotMs: 0,
    passiveSaveTimer: null,
    passiveBoundaryState: 'program', // 'program' or 'ad'
    passiveBoundaryLastChangeMs: 0,
```

**Step 4: Add passive log settings to USER_PREFS**

In the `USER_PREFS` array (~line 1746), add `'passiveLogging'` so it's preserved across settings resets.

**Step 5: Commit**

```
v4.3.7: Add passive log state, settings defaults, bump SETTINGS_KEY
```

---

### Task 2: Passive Log Core — Record Helpers and Ring Buffer

**Files:**
- Modify: `youtubetv-auto-mute.user.js` — new section after the `downloadCaptionsNow` function (~line 938)

**Step 1: Add the PassiveLog module**

Insert a new section after the caption log functions:

```js
  /* ---------- PASSIVE LOG ---------- */
  const PASSIVE_LOG_KEY = 'yttp_passive_log';
  const PASSIVE_META_KEY = 'yttp_passive_meta';

  function passiveLogPush(record) {
    if (!S.passiveLogging) return;
    record.t = Date.now();
    record.ts = nowStr();
    State.passiveLog.push(record);
    // Ring buffer trim
    if (State.passiveLog.length > S.passiveLogCapacity * 1.25) {
      State.passiveLog = State.passiveLog.slice(-S.passiveLogCapacity);
    }
  }

  function passiveSnapshot(confidence, decision, signals, ccText) {
    passiveLogPush({
      conf: confidence,
      muted: decision.shouldMute,
      reason: decision.reason,
      signals: signals.map(s => ({ s: s.source, w: s.weight, m: s.match || undefined })),
      caption: truncate(ccText, 200),
      adLock: Date.now() < State.adLockUntil,
      quorum: State.programQuorumCount,
      pv: State.programVotes,
    });
  }

  function passiveTransition(type, confidence, decision, signals, ccText) {
    // type is 'mute' or 'unmute'
    passiveLogPush({
      event: type,
      conf: confidence,
      muted: decision.shouldMute,
      reason: decision.reason,
      signals: signals.map(s => ({ s: s.source, w: s.weight, m: s.match || undefined })),
      caption: truncate(ccText, 200),
      adLock: Date.now() < State.adLockUntil,
      quorum: State.programQuorumCount,
      pv: State.programVotes,
    });
  }

  function passiveEvent(eventName, extra) {
    passiveLogPush({ event: eventName, ...extra });
  }
```

**Step 2: Add persistence flush**

Below the module, add the debounced flush (same pattern as caption log):

```js
  let _passiveDirty = false;
  let _passiveFlushTimer = null;
  function schedulePassiveFlush() {
    _passiveDirty = true;
    if (_passiveFlushTimer) return;
    _passiveFlushTimer = setTimeout(() => {
      _passiveFlushTimer = null;
      if (_passiveDirty) {
        kvSet(PASSIVE_LOG_KEY, State.passiveLog);
        kvSet(PASSIVE_META_KEY, { sessionStart: State.passiveSessionStart, version: '4.3.7' });
        _passiveDirty = false;
      }
    }, 10000);
  }
```

**Step 3: Load persisted log on boot**

Right after the State definition (after `State.reset` method), add loading logic:

```js
  // Load persisted passive log
  const _loadedPassive = kvGet(PASSIVE_LOG_KEY, []);
  if (Array.isArray(_loadedPassive)) State.passiveLog = _loadedPassive;
  const _passiveMeta = kvGet(PASSIVE_META_KEY, {});
  State.passiveSessionStart = _passiveMeta.sessionStart || Date.now();
```

**Step 4: Commit**

```
v4.3.7: Add PassiveLog module with ring buffer, persistence, record helpers
```

---

### Task 3: Integrate Snapshots and Transitions into Scoring Loop

**Files:**
- Modify: `youtubetv-auto-mute.user.js:1059-1146` (evaluate function)
- Modify: `youtubetv-auto-mute.user.js:990-1016` (setMuted function)

**Step 1: Add periodic passive snapshots in `evaluate()`**

In the `evaluate` function, after the existing tuning snapshot block (~line 1131-1145), add:

```js
    // Passive log snapshot collection
    if (S.passiveLogging && (t - State.passiveLastSnapshotMs >= S.passiveLogIntervalMs)) {
      State.passiveLastSnapshotMs = t;
      passiveSnapshot(confidence, decision, signals, ccText);
      schedulePassiveFlush();
    }
```

**Step 2: Add transition events in `setMuted()`**

In the `setMuted` function, inside the `if(changed)` block (~line 1007), after the `pushEventLog` call (line 1009-1012), add:

```js
      // Passive log transition
      if (S.passiveLogging) {
        passiveTransition(
          shouldMute ? 'mute' : 'unmute',
          State.currentConfidence,
          { shouldMute, reason: info.reason },
          info.signals || State.lastSignals || [],
          info.ccSnippet || ''
        );
        schedulePassiveFlush();
      }
```

**Step 3: Commit**

```
v4.3.7: Integrate passive snapshots and mute transitions into scoring loop
```

---

### Task 4: Session Lifecycle Events

**Files:**
- Modify: `youtubetv-auto-mute.user.js:1785-1792` (BOOT section)
- Modify: `youtubetv-auto-mute.user.js:893-908` (manual mute toggle)

**Step 1: Emit session_start on boot**

In the BOOT section (~line 1785), after `applySettings(false)` and `startLoop()` but before the `beforeunload` listener, add:

```js
  // Passive logging session start
  if (S.passiveLogging) {
    // Only start a new session if no existing session or >30 min gap
    const lastEntry = State.passiveLog[State.passiveLog.length - 1];
    const gap = lastEntry ? Date.now() - (lastEntry.t || 0) : Infinity;
    if (gap > 1800000) {
      State.passiveSessionStart = Date.now();
      State.passiveLog = [];  // Fresh session
    }
    passiveEvent('session_start', { version: '4.3.7', url: location.href });
    schedulePassiveFlush();
  }
```

**Step 2: Emit session_end on beforeunload**

Modify the existing `beforeunload` handler (~line 1788) to also handle passive log:

```js
  window.addEventListener('beforeunload', () => {
    if (_logDirty) { kvSet(CAPLOG_KEY, window._captions_log); _logDirty = false; }
    if (S.passiveLogging) {
      passiveEvent('session_end');
      kvSet(PASSIVE_LOG_KEY, State.passiveLog);
      kvSet(PASSIVE_META_KEY, { sessionStart: State.passiveSessionStart, version: '4.3.7' });
      passiveAutoSave();  // Final save
    }
  });
```

**Step 3: Emit manual mute events**

In the manual mute toggle handler (~line 900), after `State.manualMuteActive = !State.manualMuteActive;`, add:

```js
      if (S.passiveLogging) {
        passiveEvent(State.manualMuteActive ? 'manual_mute_on' : 'manual_mute_off');
        schedulePassiveFlush();
      }
```

**Step 4: Commit**

```
v4.3.7: Add session lifecycle and manual mute events to passive log
```

---

### Task 5: Flag Events in Passive Log

**Files:**
- Modify: `youtubetv-auto-mute.user.js:1315-1364` (flagIncorrectState)
- Modify: `youtubetv-auto-mute.user.js:1366-1399` (flagTuningOnly)

**Step 1: Add passive log write to `flagIncorrectState()`**

After line 1336 (`if (State.tuningActive) State.tuningFlags.push(entry);`), add:

```js
    // Always write flags to passive log (high-value ground truth)
    if (S.passiveLogging) {
      passiveEvent('flag', {
        type: entry.action === 'FALSE_POSITIVE' ? 'false_positive' : 'false_negative',
        conf: entry.confidence,
        muted: wasMuted,
        reason: State.lastSignals ? undefined : undefined,
        signals: entry.signals.map(s => ({ s: s.source, w: s.weight, m: s.match || undefined })),
        caption: entry.captionText,
        adLock: entry.adLockActive,
        quorum: entry.programQuorum,
      });
      schedulePassiveFlush();
    }
```

**Step 2: Add passive log write to `flagTuningOnly()`**

After line 1388 (`if (State.tuningActive) State.tuningFlags.push(entry);`), add the same block but with `softFlag: true`:

```js
    if (S.passiveLogging) {
      passiveEvent('flag', {
        type: entry.action === 'FALSE_POSITIVE' ? 'false_positive' : 'false_negative',
        softFlag: true,
        conf: entry.confidence,
        muted: wasMuted,
        signals: entry.signals.map(s => ({ s: s.source, w: s.weight, m: s.match || undefined })),
        caption: entry.captionText,
        adLock: entry.adLockActive,
        quorum: entry.programQuorum,
      });
      schedulePassiveFlush();
    }
```

**Step 3: Commit**

```
v4.3.7: Write flag events to passive log as ground truth data points
```

---

### Task 6: Auto-Boundary Detection

**Files:**
- Modify: `youtubetv-auto-mute.user.js` — add boundary detector in the PassiveLog section (after the flush helpers)

**Step 1: Add the boundary detector**

```js
  function passiveBoundaryCheck(confidence, decision, signals) {
    if (!S.passiveLogging) return;
    const t = Date.now();
    const prev = State.passiveBoundaryState;
    let next = prev;
    let trigger = null;

    if (prev === 'program') {
      // Detect ad start
      if (decision.reason === 'CONFIDENCE_HIGH' && confidence >= S.confidenceThreshold) {
        next = 'ad'; trigger = 'confidence_crossed';
      } else if (decision.reason === 'AD_LOCK') {
        next = 'ad'; trigger = 'ad_lock_engaged';
      } else if (signals.some(s => s.source === 'domAdShowing')) {
        next = 'ad'; trigger = 'dom_ad_showing';
      } else if (signals.some(s => s.source === 'captionLoss' && s.weight >= 15)) {
        next = 'ad'; trigger = 'caption_loss';
      }
    } else {
      // Detect ad end
      if (decision.reason === 'PROGRAM_CONFIRMED') {
        next = 'program'; trigger = 'program_confirmed';
      } else if (decision.reason === 'PROGRAM_QUORUM_MET') {
        next = 'program'; trigger = 'program_quorum_met';
      } else if (signals.some(s => s.source === 'caseShift' && s.weight < 0)) {
        next = 'program'; trigger = 'case_shift_program';
      }
    }

    if (next !== prev) {
      // Debounce: ignore boundaries that flip back within 5s (chattering)
      if (t - State.passiveBoundaryLastChangeMs < 5000) return;
      State.passiveBoundaryState = next;
      State.passiveBoundaryLastChangeMs = t;
      passiveLogPush({
        event: 'boundary',
        type: next === 'ad' ? 'ad_start' : 'ad_end',
        trigger,
        conf: confidence,
      });
    }
  }
```

**Step 2: Call boundary detector from `evaluate()`**

In the `evaluate` function, right after the `decide()` call (~line 1116), add:

```js
    passiveBoundaryCheck(confidence, decision, signals);
```

**Step 3: Commit**

```
v4.3.7: Add auto-boundary detection for ad start/end markers
```

---

### Task 7: Auto-Save via GM_download

**Files:**
- Modify: `youtubetv-auto-mute.user.js` — add auto-save functions in the PassiveLog section

**Step 1: Add the auto-save function**

```js
  function passiveAutoSave() {
    if (!S.passiveLogging || State.passiveLog.length === 0) return;

    // Build boundaries summary from inline events
    const boundaries = State.passiveLog
      .filter(r => r.event === 'boundary')
      .map(r => ({ type: r.type, t: r.t, trigger: r.trigger }));

    const report = {
      version: '4.3.7',
      format: 'passive_log',
      sessionStart: new Date(State.passiveSessionStart).toISOString(),
      savedAt: new Date().toISOString(),
      settings: {
        confidenceThreshold: S.confidenceThreshold,
        minAdLockMs: S.minAdLockMs,
        muteOnNoCCDelayMs: S.muteOnNoCCDelayMs,
        programVotesNeeded: S.programVotesNeeded,
        programQuorumLines: S.programQuorumLines,
        captionWindowSize: S.captionWindowSize,
      },
      entries: State.passiveLog,
      boundaries,
    };

    const d = new Date(State.passiveSessionStart);
    const pad = n => String(n).padStart(2, '0');
    const name = `yttp_passive_${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    const text = JSON.stringify(report, null, 2);
    downloadText(name, text);
    log('Passive log auto-saved:', name, `(${State.passiveLog.length} entries)`);
  }
```

**Step 2: Add the auto-save timer management**

```js
  function startPassiveSaveTimer() {
    stopPassiveSaveTimer();
    if (!S.passiveLogging) return;
    State.passiveSaveTimer = setInterval(passiveAutoSave, S.passiveSaveIntervalMs);
  }

  function stopPassiveSaveTimer() {
    if (State.passiveSaveTimer) {
      clearInterval(State.passiveSaveTimer);
      State.passiveSaveTimer = null;
    }
  }
```

**Step 3: Start the timer on boot**

In the BOOT section (~line 1785), after the session_start event emission, add:

```js
  startPassiveSaveTimer();
```

**Step 4: Commit**

```
v4.3.7: Add periodic auto-save of passive log via GM_download
```

---

### Task 8: Settings Panel Integration

**Files:**
- Modify: `youtubetv-auto-mute.user.js:1545-1584` (SETTING_FIELDS)
- Modify: `youtubetv-auto-mute.user.js:1652-1683` (actions tab)

**Step 1: Add passive logging toggle to SETTING_FIELDS**

In the `SETTING_FIELDS` array, after the `showTuningUI` entry (~line 1549), add:

```js
    { id: 'passiveLogging', tab: 'general', type: 'checkbox', label: 'Enable passive logging (continuous)' },
```

**Step 2: Add download button to actions tab**

In the actions tab content (~line 1664, the Logs section), after the `dlFeedback` button, add:

```js
        ${menuBtn('dlPassive','Download Passive Log (JSON)','')}
        ${menuBtn('clearPassive','Clear Passive Log','','#8b0000')}
```

**Step 3: Wire up the new buttons**

In the button event handler section (find where `dlFeedback` click handler is), add handlers:

```js
    panel.querySelector('#dlPassive')?.addEventListener('click', () => {
      if (State.passiveLog.length === 0) { alert('No passive log data.'); return; }
      passiveAutoSave();
    });
    panel.querySelector('#clearPassive')?.addEventListener('click', () => {
      if (confirm('Clear passive log? This cannot be undone.')) {
        State.passiveLog = [];
        State.passiveSessionStart = Date.now();
        State.passiveBoundaryState = 'program';
        kvSet(PASSIVE_LOG_KEY, []);
        log('Passive log cleared');
      }
    });
```

**Step 4: Restart save timer when settings change**

In the save handler (where settings are applied after Save & Apply), add after settings are written:

```js
    startPassiveSaveTimer();  // Restart with potentially new interval
```

**Step 5: Commit**

```
v4.3.7: Add passive logging toggle and download/clear to settings panel
```

---

### Task 9: Version Bump and Final Integration

**Files:**
- Modify: `youtubetv-auto-mute.user.js` — all 5 version string locations

**Step 1: Bump version to 4.3.7 in all locations**

- Line 2: `@name` → `YTTV Auto-Mute (v4.3.7: Signal Aggregation)`
- Line 5: `@version` → `4.3.7`
- Report `version:` string
- Settings panel title
- Boot log

**Step 2: Update all hardcoded version strings within passive log code**

Search for any `'4.3.7'` in the code added in previous tasks — these should all reference the same version. (They already do from the plan.)

**Step 3: Smoke test checklist**

Verify manually in the browser:
- [ ] Script boots without errors in console
- [ ] Passive log starts populating (`State.passiveLog` in console)
- [ ] `session_start` event is first entry
- [ ] Snapshots appear every ~5s
- [ ] Mute/unmute transitions appear immediately in the log
- [ ] Flag button writes to passive log
- [ ] Manual mute toggle emits events
- [ ] Auto-save fires after 15 min (or test with lower interval)
- [ ] Download button in settings works
- [ ] Page refresh: log persists, new `session_start` appended
- [ ] Existing tuning session system still works independently

**Step 4: Commit**

```
v4.3.7: Passive tuning system — continuous logging, auto-boundaries, auto-save
```

---

### Task 10: Write Tuning Runbook

**Files:**
- Create: `docs/tuning-runbook.md`

**Step 1: Write the runbook**

This is the documentation for future Claude sessions. Contents:

1. **Passive log format spec** — schema for every record type with examples
2. **Analysis procedure** — step-by-step: parse → verify boundaries → classify → find errors → signal analysis → regression → append labeled data
3. **Signal reference table** — all signals, weights, what they detect, known failure modes
4. **Labeled dataset format** — schema for corrected files in `docs/labeled/`
5. **Known failure patterns** — catalog with examples (pronoun-only imperativeVoice, quorum erosion from mild signals, etc.)
6. **Regression test procedure** — how to simulate scoring changes against historical data

**Step 2: Create labeled dataset directory**

```bash
mkdir -p docs/labeled
```

**Step 3: Commit**

```
Add tuning runbook and labeled dataset directory
```
