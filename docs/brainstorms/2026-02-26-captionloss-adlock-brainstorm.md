# CaptionLoss AdLock — Brainstorm

**Date:** 2026-02-26
**Data source:** v4.4.1 live data (Feb 26 13:32–14:17, 536 snapshots)
**Focus:** 10s false negative on Coventry Direct after captionLoss→ad transition

---

## What We're Building

Sustained captionLoss should set adLock, bridging the confidence cliff when captions return as ad content.

## Problem

- CaptionLoss pushes conf to 81 (shortPunchyLines(6) + captionLoss(25))
- adLock threshold is 82 — misses by 1 point
- When captions return, conf cliff-drops to 58 (adContext(10) + textFeatures(6) + caseShift(0) + conversational(-8))
- 10s false negative until price mentions push textFeatures to 31
- Sighting: Coventry Direct at 13:38:11 (v4.4.1 manual mute, vr=BUILDING_QUORUM)

## Key Decisions

1. **Approach**: Sustained captionLoss explicitly sets adLock in decide() (not threshold change or floor mechanism)
2. **Threshold**: captionLoss weight >= 15 (~20s of sustained no-CC)
3. **Mechanism**: Each captionLoss tick refreshes adLock, so the lock is always fresh when captions return
4. **Duration**: Standard `S.minAdLockMs` — same as confidence-based adLock

## Why This Approach

- CaptionLoss is the strongest structural signal of an ad break
- Refreshing every tick means the lock is only 5s old when captions return
- Weight >= 15 filters brief flickers; only sustained loss triggers
- Reuses existing adLock infrastructure — no new mechanisms

## What's Explicitly Out of Scope

- Lowering the 82 adLock threshold (global change)
- Post-captionLoss confidence floor (new mechanism)
- Changes to captionLoss signal weights
