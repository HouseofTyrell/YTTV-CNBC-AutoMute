#!/usr/bin/env node
/**
 * simulate-v44.js — Regression simulation for v4.4.x signal tuning changes
 *
 * Replays passive log entries and labeled data, applying proposed changes:
 *   v4.4.0 fixes:
 *     Fix A: Mild signal gate (captionBottomed + shortPunchyLines alone can't cross threshold)
 *     Fix B: Replace bare "quote" in adContext with specific ad phrases
 *     Fix C: New testimonialAd composite signal (+12)
 *     Fix D: Extended textFeatures dampening (90s window + quorum)
 *     Fix E: Narrow "stick around" in breakCue
 *   v4.4.1 fixes:
 *     Fix F: Unified caseShift(program) dampening (captionLoss suppression + corroboration)
 *     Fix G: Expanded programAllow suppression (flag-only, cannot fully simulate decision engine)
 *
 * Usage: node scripts/simulate-v44.js [--verbose] [--fix=A,B,C,D,E,F,G] [--file=path]
 */

const fs = require('fs');
const path = require('path');

// --- CLI args ---
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const fixArg = args.find(a => a.startsWith('--fix='));
const fileArg = args.find(a => a.startsWith('--file='));
const enabledFixes = fixArg
  ? new Set(fixArg.replace('--fix=', '').split(',').map(f => f.trim().toUpperCase()))
  : new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G']);

// --- Constants ---
const THRESHOLD = 65;  // S.confidenceThreshold (from v4.3.8+ defaults)
const BASE = 50;

// Mild signal set for Fix A
const MILD_SOURCES = new Set(['captionBottomed', 'shortPunchyLines']);

// Fix B: bare "quote" replacements
const QUOTE_AD_PHRASES = ['get a quote', 'free quote', 'quote today', 'quote now'];

// Fix E: "stick around" replacements
const STICK_AROUND_PHRASES = ['stick around for', "we'll stick around"];

// --- Data loading ---
function loadJSON(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

// --- Simulation core ---

/**
 * For each entry, compute the "new" confidence by adjusting signals per the enabled fixes.
 * Returns { oldConf, newConf, oldMuted, newMuted, changes: string[], entry }
 */
function simulateEntry(entry, prevEntries, allEntries, idx) {
  if (entry.event) return null;  // skip events (session_start, boundary, mute/unmute, flag)
  if (!entry.signals || !Array.isArray(entry.signals)) return null;

  const oldConf = entry.conf;
  const oldMuted = entry.muted;
  const caption = (entry.caption || '').toLowerCase();
  const changes = [];

  // Clone signals for modification
  let signals = entry.signals.map(s => ({ source: s.s, weight: s.w, match: s.m }));
  let confDelta = 0;

  // --- Fix B: Remove bare "quote" from adContext ---
  if (enabledFixes.has('B')) {
    const acIdx = signals.findIndex(s => s.source === 'adContext');
    if (acIdx !== -1) {
      // Check if caption contains bare "quote" but NOT the specific ad phrases
      const hasAdQuotePhrase = QUOTE_AD_PHRASES.some(p => caption.includes(p));
      // Check if the adContext match was specifically "quote"
      const matchStr = (signals[acIdx].match || '').toLowerCase();
      if (matchStr === 'quote' || (caption.includes('quote') && !hasAdQuotePhrase && !caption.includes('.com'))) {
        // Determine if "quote" was the ONLY match. If other adContext phrases also match,
        // adContext would still fire. We conservatively remove if match field contains "quote"
        // and no other adContext phrases are evident.
        const otherAdContextTerms = [
          'sponsored by', 'brought to you by', 'offer ends', 'apply now', 'sign up',
          '.com', 'dot com', 'call now', 'free shipping', 'save today', 'member fdic',
          'promo code', 'discount code', 'limited supply', 'policy', 'prospectus',
          'presented by', 'paid for by', 'apply today', 'join now', 'get started',
          'start today', 'enroll', 'enrollment', 'speak to an agent', 'licensed agent',
          'call today', 'call the number', 'see details', 'not fdic insured',
          'use code', 'while supplies last', 'satisfaction guaranteed', 'money-back guarantee',
          'no obligation', 'risk-free', 'available at', 'sold at', 'find it at',
          'order yours', 'order now', 'shop now', 'for more information', 'available now',
          'now available', 'act now', "don't wait", 'official sponsor', 'proud sponsor',
          'proud partner', 'as seen on', 'gps voice', 'rerouting', 'underwritten by'
        ];
        const hasOtherAdContext = otherAdContextTerms.some(t => caption.includes(t));
        if (!hasOtherAdContext) {
          confDelta -= signals[acIdx].weight;
          changes.push(`Fix B: removed adContext(${signals[acIdx].weight}) for bare "quote"`);
          signals.splice(acIdx, 1);
        }
      }
    }
  }

  // --- Fix D: Extended textFeatures dampening ---
  if (enabledFixes.has('D')) {
    const tfIdx = signals.findIndex(s => s.source === 'textFeatures');
    if (tfIdx !== -1 && signals[tfIdx].weight > 12) {
      // Check for quorum dampening (quorum > 0 means program context active)
      const quorum = entry.quorum || 0;
      // Check for extended 90s window: look for strong program signals in last 90s
      // We approximate by checking quorum (which represents confirmed program state)
      // In the real code, quorum > 0 OR lastStrongProgramMs within 90s would trigger
      // Since we have quorum in the log data, use it as the primary indicator
      const hasRecentProgram = checkRecentProgram(allEntries, idx, 90000);
      if (quorum > 0 || hasRecentProgram) {
        const oldW = signals[tfIdx].weight;
        confDelta -= (oldW - 12);
        signals[tfIdx] = { ...signals[tfIdx], weight: 12 };
        changes.push(`Fix D: dampened textFeatures(${oldW} → 12) via ${quorum > 0 ? 'quorum' : '90s window'}`);
      }
    }
  }

  // --- Fix E: Remove bare "stick around" from breakCue ---
  if (enabledFixes.has('E')) {
    const bcIdx = signals.findIndex(s => s.source === 'breakCue');
    if (bcIdx !== -1) {
      const hasSpecificPhrase = STICK_AROUND_PHRASES.some(p => caption.includes(p));
      const matchStr = (signals[bcIdx].match || '').toLowerCase();
      // Check if match was "stick around" (bare)
      if ((matchStr === 'stick around' || (caption.includes('stick around') && !hasSpecificPhrase))) {
        // Check if other break phrases also match
        const otherBreakTerms = [
          'back after this', "we'll be right back", 'we will be right back',
          'stay with us', 'more after the break', 'right after this break',
          'the exchange is back after this', "don't go anywhere",
          'after the break', 'when we come back',
          "we'll have more after this", 'quick break', 'take a quick break',
          'much more ahead', "we'll be back in two minutes", "we'll be back in just a moment"
        ];
        const hasOtherBreak = otherBreakTerms.some(t => caption.includes(t));
        if (!hasOtherBreak) {
          confDelta -= signals[bcIdx].weight;
          changes.push(`Fix E: removed breakCue(${signals[bcIdx].weight}) for bare "stick around"`);
          signals.splice(bcIdx, 1);
        }
      }
    }
  }

  // --- Fix C: Testimonial ad detection ---
  if (enabledFixes.has('C')) {
    // Check conditions for testimonial ad pattern
    const hasCaptionBottomed = signals.some(s => s.source === 'captionBottomed');
    const capsRatio = estimateCapsRatio(entry.caption || '');
    const isMixedCase = capsRatio < 0.85;
    const hasSpeakerMarker = (entry.caption || '').includes('>>');
    const hasAnchor = signals.some(s => s.source === 'anchorName');
    const recentCaptionLoss = checkRecentCaptionLoss(allEntries, idx, 60000);

    if (hasCaptionBottomed && isMixedCase && !hasSpeakerMarker && !hasAnchor && recentCaptionLoss) {
      // Don't double-add if we already modified this entry
      confDelta += 12;
      signals.push({ source: 'testimonialAd', weight: 12, match: null });
      changes.push('Fix C: added testimonialAd(+12)');
    }
  }

  // --- Fix F: Unified caseShift(program) dampening ---
  if (enabledFixes.has('F')) {
    const csIdx = signals.findIndex(s => s.source === 'caseShift' && s.weight < 0);
    if (csIdx !== -1) {
      // Reconstruct original weight: v4.4.0 halves when adContext/ctaDetected present
      // If the signal was already dampened, its current weight = -14 and original was -28
      const hasAdSignal = signals.some(s => s.source === 'adContext' || s.source === 'ctaDetected');
      const hasCorroboration = signals.some(s => s.source === 'speakerMarker' || s.source === 'anchorName');
      const postCaptionLoss = checkRecentCaptionLoss(allEntries, idx, 15000);
      const CASE_SHIFT_PROGRAM = -28;

      // Figure out original weight (before any v4.4.0 dampening)
      const currentW = signals[csIdx].weight;
      const originalW = (hasAdSignal && currentW === Math.round(CASE_SHIFT_PROGRAM / 2)) ? CASE_SHIFT_PROGRAM : currentW;

      let newWeight = originalW;
      let reason = '';

      if (postCaptionLoss && !hasCorroboration) {
        newWeight = 0;
        reason = 'suppressed (post-captionLoss)';
      } else if (!postCaptionLoss && !hasCorroboration && hasAdSignal) {
        newWeight = Math.round(CASE_SHIFT_PROGRAM / 4); // -7
        reason = 'dampened (no corroboration + ad signal)';
      } else if (!postCaptionLoss && hasAdSignal) {
        newWeight = Math.round(CASE_SHIFT_PROGRAM / 2); // -14
        reason = 'dampened (ad signal)';
      } else if (!postCaptionLoss && !hasCorroboration) {
        newWeight = Math.round(CASE_SHIFT_PROGRAM / 2); // -14
        reason = 'dampened (no corroboration)';
      }
      // else: full weight

      if (newWeight !== currentW) {
        confDelta -= (currentW - newWeight);  // positive delta means less negative = higher conf
        signals[csIdx] = { ...signals[csIdx], weight: newWeight };
        changes.push(`Fix F: caseShift(${currentW} → ${newWeight}) ${reason}`);
      }
    }
  }

  // --- Fix G: Expanded programAllow suppression (flag-only) ---
  if (enabledFixes.has('G')) {
    const paIdx = signals.findIndex(s => s.source === 'programAllow');
    if (paIdx !== -1 && entry.reason === 'PROGRAM_CONFIRMED') {
      const hasBottomOrTestimonial = signals.some(s => s.source === 'captionBottomed' || s.source === 'testimonialAd');
      const hasCorroboration = signals.some(s => s.source === 'speakerMarker' || s.source === 'anchorName');
      const postCaptionLoss30 = checkRecentCaptionLoss(allEntries, idx, 30000);
      const hasBrand = signals.some(s => s.source === 'brandDetected');
      const wouldSuppress = hasBrand || hasBottomOrTestimonial || (postCaptionLoss30 && !hasCorroboration);
      if (wouldSuppress) {
        const reason = hasBrand ? 'brand' : hasBottomOrTestimonial ? 'bottom/testimonial' : 'post-captionLoss';
        changes.push(`Fix G: programAllow PROGRAM_CONFIRMED would be suppressed (${reason})`);
        // Note: can't simulate decision engine change, just flagging
      }
    }
  }

  // --- Fix A: Mild signal gate ---
  if (enabledFixes.has('A')) {
    const newConf = oldConf + confDelta;
    if (newConf >= THRESHOLD) {
      const positiveSignals = signals.filter(s => s.weight > 0);
      const allMild = positiveSignals.length > 0 && positiveSignals.every(s =>
        MILD_SOURCES.has(s.source) || (s.source === 'textFeatures' && s.weight <= 10)
      );
      // Don't gate if adLock is active
      const adLockActive = entry.adLock === true;
      if (allMild && !adLockActive) {
        const capped = THRESHOLD - 1;
        confDelta = capped - oldConf;
        changes.push(`Fix A: mild gate capped ${newConf} → ${capped}`);
      }
    }
  }

  const newConf = Math.max(0, Math.min(100, oldConf + confDelta));

  // Determine mute decision change based on threshold crossing only.
  // We can't model adLock/quorum/programAllow from log data alone, so we compare
  // whether the OLD conf and NEW conf are on different sides of the threshold.
  // This avoids false "regressions" from entries muted via adLock with conf < threshold.
  const oldCrossed = oldConf >= THRESHOLD;
  const newCrossed = newConf >= THRESHOLD;
  const decisionChanged = oldCrossed !== newCrossed && changes.length > 0;

  return {
    oldConf,
    newConf,
    oldMuted,
    newMuted: newCrossed,
    oldCrossed,
    newCrossed,
    decisionChanged,
    changes,
    entry,
    idx,
  };
}

/**
 * Estimate caps ratio from raw caption text
 */
function estimateCapsRatio(text) {
  if (!text || text.length < 5) return 0;
  const alpha = text.replace(/[^a-zA-Z]/g, '');
  if (alpha.length === 0) return 0;
  const upper = alpha.replace(/[^A-Z]/g, '').length;
  return upper / alpha.length;
}

/**
 * Check if there was a captionLoss signal within the last `windowMs` milliseconds
 * by scanning prior entries.
 */
function checkRecentCaptionLoss(entries, currentIdx, windowMs) {
  const currentT = entries[currentIdx].t;
  const cutoff = currentT - windowMs;
  // Scan backwards from current entry
  for (let i = currentIdx - 1; i >= 0 && i >= currentIdx - 60; i--) {
    const e = entries[i];
    if (!e || !e.t) continue;
    if (e.t < cutoff) break;
    if (e.signals && e.signals.some(s => s.s === 'captionLoss')) return true;
    // Also check boundary events for caption_loss trigger
    if (e.event === 'boundary' && e.trigger === 'caption_loss') return true;
  }
  return false;
}

/**
 * Check if there was a strong program signal within the last `windowMs` by scanning prior entries.
 * This approximates the 90s recentProgram check.
 */
function checkRecentProgram(entries, currentIdx, windowMs) {
  const currentT = entries[currentIdx].t;
  const cutoff = currentT - windowMs;
  const strongProgSources = new Set([
    'programAllow', 'returnFromBreak', 'anchorName', 'guestIntro', 'segmentName', 'speakerMarker'
  ]);
  for (let i = currentIdx - 1; i >= 0 && i >= currentIdx - 40; i--) {
    const e = entries[i];
    if (!e || !e.t) continue;
    if (e.t < cutoff) break;
    if (e.signals && e.signals.some(s => strongProgSources.has(s.s) && s.w <= -12)) return true;
  }
  return false;
}

// --- Report generation ---

function runSimulation(filePath, label) {
  const data = loadJSON(filePath);
  const entries = data.entries;
  const isLabeled = entries.some(e => e.label);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`Dataset: ${label}`);
  console.log(`File: ${filePath}`);
  console.log(`Entries: ${entries.length} (${isLabeled ? 'LABELED' : 'unlabeled'})`);
  console.log(`Fixes: ${[...enabledFixes].join(', ')}`);
  console.log('='.repeat(70));

  const results = [];
  let changedDecisions = 0;
  const fixCounts = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 };

  // For labeled data, track FP/FN changes
  let fpRemoved = 0, fpAdded = 0, fnRemoved = 0, fnAdded = 0;

  for (let i = 0; i < entries.length; i++) {
    const result = simulateEntry(entries[i], entries.slice(Math.max(0, i - 60), i), entries, i);
    if (!result) continue;
    results.push(result);

    if (result.changes.length > 0) {
      for (const c of result.changes) {
        if (c.startsWith('Fix A')) fixCounts.A++;
        if (c.startsWith('Fix B')) fixCounts.B++;
        if (c.startsWith('Fix C')) fixCounts.C++;
        if (c.startsWith('Fix D')) fixCounts.D++;
        if (c.startsWith('Fix E')) fixCounts.E++;
        if (c.startsWith('Fix F')) fixCounts.F++;
        if (c.startsWith('Fix G')) fixCounts.G++;
      }
    }

    if (result.decisionChanged) {
      changedDecisions++;

      if (isLabeled) {
        const entryLabel = entries[i].label;
        if (entryLabel) {
          // Old crossed threshold, new doesn't
          if (result.oldCrossed && !result.newCrossed) {
            if (entryLabel === 'program') fpRemoved++;  // was FP, now correct
            if (entryLabel === 'ad') fnAdded++;          // was correct, now FN
          }
          // Old didn't cross, new does
          if (!result.oldCrossed && result.newCrossed) {
            if (entryLabel === 'ad') fnRemoved++;        // was FN, now correct
            if (entryLabel === 'program') fpAdded++;     // was correct, now FP
          }
        }
      }

      if (verbose || result.decisionChanged) {
        const dir = result.newCrossed && !result.oldCrossed ? 'UNMUTE→MUTE' : 'MUTE→UNMUTE';
        const labelStr = isLabeled && entries[i].label ? ` [${entries[i].label.toUpperCase()}]` : '';
        console.log(`\n  ${dir}${labelStr} @ ${entries[i].ts} (idx ${i})`);
        console.log(`    conf: ${result.oldConf} → ${result.newConf}`);
        console.log(`    caption: "${(entries[i].caption || '').slice(0, 80)}"`);
        console.log(`    reason: ${entries[i].reason}`);
        console.log(`    changes: ${result.changes.join('; ')}`);
        if (entries[i].adLock) console.log(`    adLock: active`);
        if (entries[i].quorum > 0) console.log(`    quorum: ${entries[i].quorum}`);
      }
    }
  }

  // Summary
  console.log(`\n--- Summary ---`);
  console.log(`Snapshots analyzed: ${results.length}`);
  console.log(`Decision changes: ${changedDecisions}`);
  console.log(`\nPer-fix activation counts:`);
  for (const [fix, count] of Object.entries(fixCounts)) {
    if (enabledFixes.has(fix)) console.log(`  Fix ${fix}: ${count} entries affected`);
  }

  if (isLabeled) {
    console.log(`\nLabeled data impact:`);
    console.log(`  False positives removed: ${fpRemoved} (program correctly unmuted)`);
    console.log(`  False positives added:   ${fpAdded} (program incorrectly muted) *** REGRESSION ***`);
    console.log(`  False negatives removed: ${fnRemoved} (ad correctly muted)`);
    console.log(`  False negatives added:   ${fnAdded} (ad incorrectly unmuted) *** REGRESSION ***`);
    console.log(`  Net FP change: ${fpAdded - fpRemoved} (negative = improvement)`);
    console.log(`  Net FN change: ${fnAdded - fnRemoved} (negative = improvement)`);

    if (fpAdded > 0 || fnAdded > 0) {
      console.log(`\n  *** REGRESSIONS DETECTED ***`);
    } else {
      console.log(`\n  ✓ ZERO REGRESSIONS on labeled data`);
    }
  } else {
    // Unlabeled data: show direction of changes
    const toMute = results.filter(r => r.decisionChanged && r.newCrossed && !r.oldCrossed).length;
    const toUnmute = results.filter(r => r.decisionChanged && !r.newCrossed && r.oldCrossed).length;
    console.log(`\nUnlabeled data direction:`);
    console.log(`  Newly muted:   ${toMute} snapshots`);
    console.log(`  Newly unmuted: ${toUnmute} snapshots`);
  }

  // Score shift distribution for all affected entries
  const shifted = results.filter(r => r.changes.length > 0);
  if (shifted.length > 0) {
    const deltas = shifted.map(r => r.newConf - r.oldConf);
    const avgDelta = deltas.reduce((s, v) => s + v, 0) / deltas.length;
    const minDelta = Math.min(...deltas);
    const maxDelta = Math.max(...deltas);
    console.log(`\nScore shift stats (${shifted.length} affected entries):`);
    console.log(`  Avg delta: ${avgDelta.toFixed(1)}`);
    console.log(`  Min delta: ${minDelta}`);
    console.log(`  Max delta: ${maxDelta}`);
  }

  return { changedDecisions, fpAdded, fnAdded, fpRemoved, fnRemoved, fixCounts, isLabeled };
}

// --- Main ---
const projectRoot = path.resolve(__dirname, '..');
const mergedLog = fileArg ? fileArg.replace('--file=', '') : '/tmp/yttp_merged_new.json';
const mergedV44 = '/tmp/yttp_merged_v44.json';
const labeledData = path.join(projectRoot, 'docs/labeled/2026-02-25_1051_labeled.json');

console.log('v4.4.x Regression Simulation');
console.log(`Fixes enabled: ${[...enabledFixes].join(', ')}`);

// Run on labeled data first (most critical)
if (fs.existsSync(labeledData)) {
  const labeledResult = runSimulation(labeledData, 'Labeled dataset (v4.3.7)');
  if (labeledResult.fpAdded > 0 || labeledResult.fnAdded > 0) {
    console.log('\n*** FAIL: Regressions detected on labeled data. Investigate before proceeding. ***');
  }
}

// Run on merged passive log (v4.3.9)
if (fs.existsSync(mergedLog)) {
  runSimulation(mergedLog, 'Merged passive log (17h, v4.3.9)');
}

// Run on v4.4.0 log (only new fixes F,G matter here — A-E already baked in)
if (fs.existsSync(mergedV44)) {
  runSimulation(mergedV44, 'Merged v4.4.0 log (1.5h)');
}

console.log('\n' + '='.repeat(70));
console.log('Simulation complete.');
