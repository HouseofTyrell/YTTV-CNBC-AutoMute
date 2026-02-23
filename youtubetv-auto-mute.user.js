// ==UserScript==
// @name         YTTV Auto-Mute (v4.0.0: Signal Aggregation)
// @namespace    http://tampermonkey.net/
// @description  Auto-mute ads on YouTube TV using signal-aggregation confidence scoring. 18 weighted signals (ad + program leaning) feed a 0-100 confidence meter — no single signal triggers a mute. Guest intro detection, imperative voice analysis, brand suppression, PhraseIndex with compiled regex, HUD with signal breakdown.
// @version      4.0.0
// @updateURL    https://raw.githubusercontent.com/HouseofTyrell/YTTV-CNBC-AutoMute/main/youtubetv-auto-mute.user.js
// @downloadURL  https://raw.githubusercontent.com/HouseofTyrell/YTTV-CNBC-AutoMute/main/youtubetv-auto-mute.user.js
// @match        https://tv.youtube.com/watch/*
// @match        https://tv.youtube.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_download
// @run-at       document-start
// @license      MIT
// @noframes
// ==/UserScript==

(function(){
  'use strict';

  /* ---------- SINGLE NAMESPACE ---------- */
  const NSKEY='__yttpMute__';
  const NS=window[NSKEY]=window[NSKEY]||{};
  try{
    if(NS.intervalId)clearInterval(NS.intervalId);
    if(NS.ccAttachTimer)clearInterval(NS.ccAttachTimer);
    if(NS.ccObserver?.disconnect)NS.ccObserver.disconnect();
    // routeObserver removed — using History API interception
    if(NS.hudTimer)clearTimeout(NS.hudTimer);
    if(NS.hudAnimTimer)clearTimeout(NS.hudAnimTimer);
  }catch{}
  Object.assign(NS,{intervalId:null,ccAttachTimer:null,ccObserver:null,routeObserver:null,
    hudEl:null,panelEl:null,hudText:'',hudTimer:null,hudAnimTimer:null,
    flagBtn:null,btnContainer:null,settingsBtn:null,muteBtn:null,_lastUrl:location.href,_hudBuilt:false});

  /* ---------- STORAGE SHIMS ---------- */
  const hasGM_get = typeof GM_getValue==='function';
  const hasGM_set = typeof GM_setValue==='function';
  const hasGM_dl  = typeof GM_download==='function';
  const kvGet=(k,d)=>{try{if(hasGM_get)return GM_getValue(k,d);const r=localStorage.getItem('yttp__'+k);return r?JSON.parse(r):d;}catch{return d;}};
  const kvSet=(k,v)=>{try{if(hasGM_set)return GM_setValue(k,v);localStorage.setItem('yttp__'+k,JSON.stringify(v));}catch{}};
  const downloadText=(name,text)=>{
    try{if(hasGM_dl){const url='data:text/plain;charset=utf-8,'+encodeURIComponent(text);GM_download({url,name,saveAs:false});return;}}catch{}
    const blob=new Blob([text],{type:'text/plain;charset=utf-8'});const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=name;document.documentElement.appendChild(a);a.click();
    setTimeout(()=>{URL.revokeObjectURL(url);a.remove();},300);
  };

  /* ---------- UTILITIES ---------- */
  const truncate = (text, max = 140) =>
    text ? (text.length > max ? text.slice(0, max - 3) + '\u2026' : text) : '';

  /* ---------- DEBOUNCED LOG FLUSH ---------- */
  let _logDirty = false;
  let _logFlushTimer = null;
  function scheduleLogFlush() {
    _logDirty = true;
    if (_logFlushTimer) return;
    _logFlushTimer = setTimeout(() => {
      _logFlushTimer = null;
      if (_logDirty) { kvSet(CAPLOG_KEY, window._captions_log); _logDirty = false; }
    }, 5000);
  }

  /* ---------- DEFAULTS ---------- */
  const DEFAULTS={
    useTrueMute:true,
    intervalMs:150,
    debug:true,
    debugVerboseCC:false,

    // Review features
    llmReviewEnabled:false,
    showFrequentWords:false,

    // Caption visibility
    hideCaptions:false,

    // HUD
    showHUD:false,
    hudAutoOnMute:true,
    hudAutoDelayMs:1000,
    hudFadeMs:250,
    hudSlidePx:8,

    // Confidence Meter
    showConfidenceMeter:true,
    confidenceMeterStyle:'bar',  // 'bar', 'numeric', 'both'
    confidenceThreshold:65,      // Mute when confidence >= this value (0-100)
    showHudSlider:true,          // Show threshold slider on HUD (can disable to reduce HUD size)

    // Timing / CC loss
    muteOnNoCCDelayMs:2500,  // ms before muting on caption loss
    noCcHitsToMute:2,        // needs consecutive hits
    unmuteDebounceMs:350,    // reduced from 500 for faster unmute

    // Ad lock
    minAdLockMs:75000,       // 75s covers typical CNBC ad breaks

    // Program gating
    programVotesNeeded:2,
    programQuorumLines:3,    // reduced from 4 for faster unmute
    fastRecheckRAF:true,

    // Manual override window after FP flag (prevents immediate re-mute unless hard ad)
    manualOverrideMs:8000,

    captionLogLimit:8000,
    autoDownloadEveryMin:0,

    // --- Phrase sets ---
    // Medicare / benefits: heavily weighted in hard/ad-context
    hardPhrases: [
      // classic Rx disclaimers
      "ask your doctor","talk to your doctor","call your doctor","side effects include",
      "do not take if you are allergic","risk of serious","use as directed","available by prescription",
      "eligible patients",
      // additional pharma disclaimers
      "tell your doctor about all the medicines you take","important safety information",
      "results may vary","individual results","injection site reactions","risk of thyroid tumors",
      // paid programming
      "paid programming","paid advertisement","the following is a paid","the preceding was a paid",

      // finance/offer
      "terms apply","limited time offer","0% apr","zero percent apr","get started today","apply today",
      "see store for details","not available in all states","learn more at","learn more on","visit",
      "get your money right","policy for only","guaranteed buyback option","own your place in the future",

      // MEDICARE/BENEFITS — strong ad signals kept here
      "licensed agent","call the number","tty",
      "$0 premium","$0 copay","speak to a licensed agent","talk to a licensed agent"
    ].join('\n'),

    brandTerms: [
      // Telecom
      "capital one","t-mobile","tmobile","verizon","at&t","att","comcast","xfinity",
      // Insurance
      "liberty mutual","progressive","geico","state farm","allstate","nationwide","usaa","farmers","travelers",
      // Pharma
      "ozempic","mounjaro","trulicity","jardiance","humira","rinvoq","skyrizi",
      "dupixent","keytruda","eliquis","xarelto","otezla","cosentyx","entresto","farxiga","rybelsus","wegovy",
      // Medicare / health plan brands (moved from hardPhrases for context-aware scoring)
      "medicare","medicare advantage","part c","dual-eligible","special needs plan",
      "enrollment ends","annual election period","aep","open enrollment","enroll by",
      "humana","unitedhealthcare","anthem","aetna","cigna","centene","molina",
      "over-the-counter","otc","benefits card","allowance","prepaid card","supplemental benefits",
      "in-network","out-of-network","formulary","prescription drug coverage",
      // Financial
      "fidelity","schwab","charles schwab","ameritrade","td ameritrade","e-trade","etrade","robinhood",
      "vanguard","blackrock","jp morgan","jpmorgan","goldman sachs","morgan stanley",
      "merrill lynch","wells fargo","citibank","citi","bank of america","sofi","ally bank","chime",
      // Tech
      "iphone","samsung","google pixel","microsoft","salesforce","oracle","ibm","dell","cisco",
      // Gold / precious metals
      "rosland capital","goldco","augusta precious metals","birch gold","noble gold",
      // Auto
      "toyota","ford","chevrolet","chevy","honda","hyundai","kia","nissan","bmw","mercedes","lexus",
      // Legal
      "if you or a loved one","class action","lawsuit","mesothelioma",
      // Other
      "aarp","whopper","subway","expedia","trivago","indeed","ziprecruiter"
    ].join('\n'),

    adContext: [
      "sponsored by","brought to you by","presented by","paid for by","underwritten by",
      "offer ends","apply now","apply today","learn more","visit","sign up","join now",
      "get started","start today","enroll","enrollment","speak to an agent","licensed agent",
      ".com","dot com","call now","call today","call the number","free shipping","save today",
      "see details","member fdic","not fdic insured","policy","quote",
      "promo code","use code","discount code","limited supply","while supplies last",
      "satisfaction guaranteed","money-back guarantee","no obligation","risk-free",
      "available at","sold at","find it at","order yours","order now","shop now"
    ].join('\n'),

    ctaTerms: ["apply","sign up","join now","call","visit","learn more","enroll","enrollment","get started","download","claim","see details","speak to an agent","licensed agent"],
    offerTerms: ["policy for only","only $","per month","per mo","per year","limited time","guarantee","guaranteed","get a quote","$0 premium","$0 copay","allowance","benefits card","prepaid card","over-the-counter"],

    // Strong program cues — instant allow override (clear lock + unmute)
    allowPhrases: [
      "joining me now","joins us now","from washington","live in","live at",
      "earnings","guidance","conference call","analyst","beat estimates","raised guidance",
      "tariff","tariffs","supreme court","breaking news",
      "economic data","cpi","ppi","jobs report","nonfarm payrolls",
      "market breadth","s&p","nasdaq","dow","back to you","we're back","we are back","back with",
      "chief investment officer","portfolio manager","senior analyst","ceo","cfo","chair",
      "welcome to closing bell","overtime is back","welcome back",
      // CNBC show names
      "squawk box","squawk on the street","power lunch","fast money","mad money",
      "halftime report","money movers","last call","worldwide exchange","the exchange",
      "cnbc special report",
      // Welcome variants
      "welcome to squawk","welcome to power lunch","welcome to fast money",
      "welcome to the halftime report","welcome to mad money",
      // Conversational anchoring
      "let's get to","let's bring in","let's go to","i want to bring in",
      "thanks for being with us","thank you for joining us","good to have you",
      "appreciate your time","let's get a check on",
      // Market / macro terms
      "the ten-year","treasury yield","federal reserve","rate cut","rate hike","basis points",
      // Teaser / transition
      "take a look at this","straight ahead","still to come","coming up","up next on"
    ],

    // Explicit break cues — enter ad-lock quickly
    breakPhrases: [
      "back after this","we'll be right back","we will be right back",
      "stay with us","more after the break","right after this break",
      "the exchange is back after this",
      "don't go anywhere","stick around","after the break","when we come back",
      "we'll have more after this"
    ],

    // CNBC anchor names — program signal
    anchorNames: [
      "sara eisen","scott wapner","jim cramer","carl quintanilla","david faber",
      "melissa lee","kelly evans","joe kernen","becky quick","andrew ross sorkin",
      "brian sullivan","tyler mathisen","rick santelli","steve liesman","mike santoli",
      "diana olick","robert frank","meg tirrell","dominic chu","leslie picker",
      "kate rooney","courtney reagan","deirdre bosa","julia boorstin","frank holland",
      "contessa brewer","seema mody","kristina partsinevelos","bertha coombs",
      "guy adami","karen finerman","tim seymour","dan nathan"
    ],

    // Named CNBC segments — program signal
    segmentNames: [
      "final trades","lightning round","stop trading","call of the day","stock draft",
      "investment committee","options action","cramer's game plan","cramer's lightning round",
      "off the charts","the bottom line","market zone","halftime overtime","unusual activity"
    ],

    // Return-from-break phrases — strong program signal
    returnFromBreakPhrases: [
      "and we are back","all right we are back","okay we are back",
      "welcome back everybody","welcome back to squawk","welcome back to closing bell",
      "welcome back to the halftime report","welcome back to power lunch",
      "welcome back to fast money","before the break we were","as we were discussing"
    ],
  };

  const SETTINGS_KEY='yttp_settings_v3_0';
  const loadSettings=()=>({...DEFAULTS,...(kvGet(SETTINGS_KEY,{}) )});
  const saveSettings=(s)=>kvSet(SETTINGS_KEY,s);
  let S=loadSettings();

  const toLines=(t)=>(t||'').split('\n').map(s=>s.trim()).filter(Boolean);

  /* ---------- VERDICT ENUM ---------- */
  const Verdict = Object.freeze({
    AD_HARD: 'AD_HARD',
    AD_BREAK: 'AD_BREAK',
    AD_BRAND_WITH_CONTEXT: 'AD_BRAND_WITH_CONTEXT',
    AD_SIGNAL_SCORE: 'AD_SIGNAL_SCORE',
    PROGRAM_ALLOW: 'PROGRAM_ALLOW',
    PROGRAM_ANCHOR: 'PROGRAM_ANCHOR',
    PROGRAM: 'PROGRAM',
  });
  const isAdVerdict = (v) => v === Verdict.AD_HARD || v === Verdict.AD_BREAK ||
    v === Verdict.AD_BRAND_WITH_CONTEXT || v === Verdict.AD_SIGNAL_SCORE;
  const isProgramVerdict = (v) => v === Verdict.PROGRAM || v === Verdict.PROGRAM_ANCHOR;

  /* ---------- WEIGHT CONSTANTS ---------- */
  const WEIGHT = Object.freeze({
    BASE: 50,
    HARD_PHRASE: 40,
    BREAK_CUE: 38,
    BRAND_DETECTED: 15,
    AD_CONTEXT: 10,
    CTA_DETECTED: 8,
    OFFER_DETECTED: 8,
    URL_PRESENT: 10,
    PHONE_PRESENT: 10,
    IMPERATIVE_VOICE: 8,
    SHORT_PUNCHY: 6,
    CAPS_HEAVY: 6,
    PUNCT_HEAVY: 4,
    PRICE_MENTION: 5,
    CAPTION_LOSS_MAX: 18,
    CAPTION_BOTTOMED: 4,
    PROGRAM_ALLOW: -45,
    RETURN_FROM_BREAK: -42,
    ANCHOR_NAME: -28,
    PROGRAM_ANCHOR: -25,
    GUEST_INTRO: -22,
    SEGMENT_NAME: -18,
    CONVERSATIONAL: -12,
    THIRD_PERSON: -8,
    LOCK_FLOOR: 65,
    QUORUM_REDUCTION_PER: 4,
  });

  /* ---------- STATE ---------- */
  const log=(...a)=>{if(S.debug)console.log('[YTTV-Mute]',...a);};
  const nowStr=()=>new Date().toLocaleTimeString();
  const CAPLOG_KEY='captions_log';
  const _loadedLog = kvGet(CAPLOG_KEY, []);
  window._captions_log = Array.isArray(_loadedLog) ? _loadedLog : [];

  const FEEDBACK_KEY = 'yttp_feedback_log';
  let _feedbackLog = kvGet(FEEDBACK_KEY, []);
  if (!Array.isArray(_feedbackLog)) _feedbackLog = [];

  const State = {
    enabled: true,
    videoRef: null,
    lastMuteState: null,
    lastCaptionLine: '',
    lastCcSeenMs: 0,
    lastProgramGoodMs: 0,
    lastAutoDlMs: Date.now(),
    rafScheduled: false,
    adLockUntil: 0,
    programVotes: 0,
    manualOverrideUntil: 0,
    noCcConsec: 0,
    bottomConsec: 0,
    programQuorumCount: 0,
    lastCaptionVisibility: null,
    currentConfidence: 0,
    manualMuteActive: false,
    captionWindow: [],
    lastSignals: [],

    reset(full = false) {
      if (full) {
        this.lastMuteState = null;
        this.lastCaptionLine = '';
        this.videoRef = null;
      }
      this.lastCcSeenMs = Date.now();
      this.lastProgramGoodMs = 0;
      this.adLockUntil = 0;
      this.programVotes = 0;
      this.manualOverrideUntil = 0;
      this.noCcConsec = 0;
      this.bottomConsec = 0;
      this.programQuorumCount = 0;
      this.lastCaptionVisibility = null;
      this.currentConfidence = 0;
      this.captionWindow = [];
    }
  };

  const URL_RE=/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i;
  const PHONE_RE=/\b(?:\d{3}[-\s.]?\d{3}[-\s.]?\d{4})\b/;

  /* ---------- PHRASE INDEX ---------- */
  const PhraseIndex = {
    _compiled: {},
    lists: {},

    rebuild(settings) {
      const norm = (val) => {
        const raw = Array.isArray(val) ? val.join('\n') : (val || '');
        return raw.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
      };
      const compile = (phrases) => {
        if (!phrases.length) return null;
        const escaped = phrases.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        return new RegExp('(' + escaped.join('|') + ')', 'i');
      };

      this.lists = {
        hard: norm(settings.hardPhrases),
        brand: norm(settings.brandTerms),
        adContext: norm(settings.adContext),
        cta: norm(settings.ctaTerms),
        offer: norm(settings.offerTerms),
        allow: norm(settings.allowPhrases),
        break_: norm(settings.breakPhrases),
        anchor: norm(settings.anchorNames || []),
        segment: norm(settings.segmentNames || []),
        returnBreak: norm(settings.returnFromBreakPhrases || []),
      };

      for (const [key, list] of Object.entries(this.lists)) {
        this._compiled[key] = compile(list);
      }
    },

    match(category, text) {
      const re = this._compiled[category];
      if (!re) return null;
      const m = text.match(re);
      return m ? m[1] : null;
    },

    matchAll(category, text) {
      const re = this._compiled[category];
      if (!re) return [];
      const globalRe = new RegExp(re.source, 'gi');
      const matches = [];
      let m;
      while ((m = globalRe.exec(text)) !== null) matches.push(m[1]);
      return matches;
    }
  };
  PhraseIndex.rebuild(S);

  /* ---------- TEXT ANALYZER ---------- */
  const TextAnalyzer = {
    analyze(text) {
      if (!text) return { capsRatio: 0, punctDensity: 0, shortText: false, priceCount: 0, wordCount: 0 };
      let upper = 0, letter = 0, punct = 0, wordCount = 0, inWord = false;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 65 && c <= 90) { upper++; letter++; }
        else if (c >= 97 && c <= 122) { letter++; }
        else if (c === 33 || c === 63) { punct++; }
        const isAlpha = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
        if (isAlpha && !inWord) { wordCount++; inWord = true; }
        else if (!isAlpha) { inWord = false; }
      }
      const priceCount = (text.match(/\$\d+|\d+\s?(?:dollars?|cents?)/gi) || []).length;
      return {
        capsRatio: letter > 0 ? upper / letter : 0,
        punctDensity: text.length > 0 ? punct / text.length : 0,
        shortText: text.length > 0 && text.length < 50,
        priceCount,
        wordCount,
      };
    },

    imperativeScore(text) {
      const words = text.toLowerCase().split(/\s+/);
      if (words.length < 3) return 0;
      const pronouns = new Set(['you', 'your', "you're", 'yourself']);
      const imperatives = new Set(['get', 'call', 'visit', 'try', 'ask', 'switch', 'start', 'save', 'protect', 'discover', 'order', 'apply', 'enroll', 'join', 'claim']);
      let count = 0;
      for (const w of words) {
        if (pronouns.has(w) || imperatives.has(w)) count++;
      }
      return count / words.length;
    },

    conversationalScore(text) {
      const words = text.toLowerCase().split(/\s+/);
      if (words.length < 5) return 0;
      const thirdPerson = new Set(['they', 'their', 'them', 'the company', 'analysts', 'investors', 'the market', 'the stock']);
      const analytical = new Set(['reported', 'expects', 'estimates', 'revenue', 'growth', 'decline', 'forecast', 'quarter', 'year-over-year', 'consensus', 'guidance']);
      let count = 0;
      for (const w of words) {
        if (thirdPerson.has(w) || analytical.has(w)) count++;
      }
      return count / words.length;
    }
  };

  /* ---------- SIGNAL COLLECTOR ---------- */
  const SignalCollector = {
    signals: [],
    register(name, fn) { this.signals.push({ name, fn }); },
    collectAll(ccText, env) {
      const results = [];
      for (const s of this.signals) {
        const r = s.fn(ccText, env);
        if (r) results.push({ source: s.name, ...r });
      }
      return results;
    }
  };

  // --- Ad-leaning signals ---
  SignalCollector.register('hardPhrase', (text) => {
    const match = PhraseIndex.match('hard', text);
    return match ? { weight: WEIGHT.HARD_PHRASE, label: 'Hard ad phrase', match } : null;
  });

  SignalCollector.register('breakCue', (text) => {
    const match = PhraseIndex.match('break_', text);
    return match ? { weight: WEIGHT.BREAK_CUE, label: 'Break cue', match } : null;
  });

  SignalCollector.register('brandDetected', (text, env) => {
    const match = PhraseIndex.match('brand', text);
    if (!match) return null;
    if (env.guestIntroDetected) return null;
    const w = (State.adLockUntil > Date.now()) ? WEIGHT.BRAND_DETECTED : Math.round(WEIGHT.BRAND_DETECTED * 0.5);
    return { weight: w, label: 'Brand detected', match };
  });

  SignalCollector.register('adContext', (text) => {
    const match = PhraseIndex.match('adContext', text);
    if (!match && !URL_RE.test(text) && !PHONE_RE.test(text)) return null;
    return { weight: WEIGHT.AD_CONTEXT, label: 'Ad context', match: match || 'url/phone' };
  });

  SignalCollector.register('ctaDetected', (text) => {
    const match = PhraseIndex.match('cta', text);
    return match ? { weight: WEIGHT.CTA_DETECTED, label: 'CTA', match } : null;
  });

  SignalCollector.register('offerDetected', (text) => {
    const match = PhraseIndex.match('offer', text);
    return match ? { weight: WEIGHT.OFFER_DETECTED, label: 'Offer', match } : null;
  });

  SignalCollector.register('urlOrPhone', (text) => {
    const hasUrl = URL_RE.test(text);
    const hasPhone = PHONE_RE.test(text);
    if (!hasUrl && !hasPhone) return null;
    const w = (hasUrl ? WEIGHT.URL_PRESENT : 0) + (hasPhone ? WEIGHT.PHONE_PRESENT : 0);
    return { weight: w, label: hasUrl && hasPhone ? 'URL+Phone' : hasUrl ? 'URL' : 'Phone', match: null };
  });

  SignalCollector.register('textFeatures', (text, env) => {
    const f = env.textFeatures;
    let w = 0, parts = [];
    if (f.capsRatio > 0.3) { w += WEIGHT.CAPS_HEAVY; parts.push('caps'); }
    if (f.punctDensity > 0.05) { w += WEIGHT.PUNCT_HEAVY; parts.push('punct'); }
    if (f.priceCount > 0) { w += f.priceCount * WEIGHT.PRICE_MENTION; parts.push('price'); }
    return w > 0 ? { weight: w, label: 'Text features: ' + parts.join('+'), match: null } : null;
  });

  SignalCollector.register('imperativeVoice', (text, env) => {
    const score = env.imperativeScore;
    if (score <= 0.08) return null;
    const w = Math.min(WEIGHT.IMPERATIVE_VOICE, Math.round(score * 100));
    return { weight: w, label: 'Imperative voice', match: `ratio=${score.toFixed(2)}` };
  });

  SignalCollector.register('shortPunchyLines', () => {
    const win = State.captionWindow;
    if (win.length < 3) return null;
    const avgLen = win.reduce((s, l) => s + l.length, 0) / win.length;
    if (avgLen >= 50) return null;
    return { weight: WEIGHT.SHORT_PUNCHY, label: 'Short punchy lines', match: `avgLen=${Math.round(avgLen)}` };
  });

  SignalCollector.register('captionLoss', (text, env) => {
    if (env.captionsExist) { State.noCcConsec = 0; return null; }
    State.noCcConsec++;
    if (env.noCcMs < S.muteOnNoCCDelayMs || State.noCcConsec < S.noCcHitsToMute) return null;
    const w = Math.min(WEIGHT.CAPTION_LOSS_MAX, Math.round(env.noCcMs / 400));
    return { weight: w, label: 'Caption loss', match: `noCcMs=${env.noCcMs}` };
  });

  SignalCollector.register('captionBottomed', (text, env) => {
    if (!env.captionsBottomed) { State.bottomConsec = 0; return null; }
    State.bottomConsec++;
    return State.bottomConsec >= 2 ? { weight: WEIGHT.CAPTION_BOTTOMED, label: 'Bottom captions', match: null } : null;
  });

  // --- Program-leaning signals ---
  SignalCollector.register('programAllow', (text) => {
    const match = PhraseIndex.match('allow', text);
    return match ? { weight: WEIGHT.PROGRAM_ALLOW, label: 'Program allow', match } : null;
  });

  SignalCollector.register('returnFromBreak', (text) => {
    const match = PhraseIndex.match('returnBreak', text);
    return match ? { weight: WEIGHT.RETURN_FROM_BREAK, label: 'Return from break', match } : null;
  });

  SignalCollector.register('anchorName', (text) => {
    const match = PhraseIndex.match('anchor', text);
    return match ? { weight: WEIGHT.ANCHOR_NAME, label: 'Anchor name', match } : null;
  });

  SignalCollector.register('programAnchor', (text) => {
    const m = PROGRAM_ANCHOR_RE.exec(text);
    return m ? { weight: WEIGHT.PROGRAM_ANCHOR, label: 'Program anchor', match: m[1] } : null;
  });

  SignalCollector.register('guestIntro', (text, env) => {
    if (!env.guestIntroDetected) return null;
    return { weight: WEIGHT.GUEST_INTRO, label: 'Guest intro', match: env.guestIntroMatch };
  });

  SignalCollector.register('segmentName', (text) => {
    const match = PhraseIndex.match('segment', text);
    return match ? { weight: WEIGHT.SEGMENT_NAME, label: 'Segment name', match } : null;
  });

  SignalCollector.register('conversational', (text, env) => {
    const score = env.conversationalScore;
    const longLine = text.length > 80;
    if (score <= 0.05 && !longLine) return null;
    let w = 0;
    if (score > 0.05) w += Math.min(Math.abs(WEIGHT.CONVERSATIONAL), Math.round(score * 120));
    if (longLine) w += Math.abs(WEIGHT.THIRD_PERSON);
    return { weight: -w, label: 'Conversational', match: `score=${score.toFixed(2)},len=${text.length}` };
  });

  /* ---------- CONFIDENCE SCORER ---------- */
  function calculateConfidence(signalResults) {
    let score = WEIGHT.BASE;
    for (const signal of signalResults) {
      score += signal.weight;
    }
    if (State.adLockUntil > Date.now() && score < WEIGHT.LOCK_FLOOR) {
      score = WEIGHT.LOCK_FLOOR;
    }
    score -= State.programQuorumCount * WEIGHT.QUORUM_REDUCTION_PER;
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /* ---------- DECISION ENGINE ---------- */
  function decide(confidence, signalResults) {
    const t = Date.now();

    if (State.manualMuteActive) return { shouldMute: true, reason: 'MANUAL_MUTE' };
    if (!State.enabled) return { shouldMute: false, reason: 'DISABLED' };
    if (t < State.manualOverrideUntil) return { shouldMute: false, reason: 'MANUAL_OVERRIDE' };

    const meetsThreshold = confidence >= S.confidenceThreshold;
    const hasStrongProgram = signalResults.some(s =>
      s.source === 'programAllow' || s.source === 'returnFromBreak');

    if (hasStrongProgram) {
      State.adLockUntil = 0;
      State.programVotes = S.programVotesNeeded;
      State.programQuorumCount = S.programQuorumLines;
      return { shouldMute: false, reason: 'PROGRAM_CONFIRMED' };
    }

    if (meetsThreshold && confidence >= 75) {
      State.adLockUntil = Math.max(State.adLockUntil, t + S.minAdLockMs);
      State.programVotes = 0;
      State.programQuorumCount = 0;
      State.lastProgramGoodMs = 0;
    }

    const lockActive = t < State.adLockUntil;

    const programSignal = signalResults.some(s => s.weight < -10);
    if (programSignal && !lockActive) {
      State.programVotes = Math.min(S.programVotesNeeded, State.programVotes + 1);
      State.programQuorumCount = Math.min(S.programQuorumLines, State.programQuorumCount + 1);
      if (!State.lastProgramGoodMs) State.lastProgramGoodMs = t;
    } else if (meetsThreshold) {
      State.programQuorumCount = 0;
      State.programVotes = 0;
      State.lastProgramGoodMs = 0;
    }

    if (lockActive && meetsThreshold) return { shouldMute: true, reason: 'AD_LOCK' };
    if (lockActive) return { shouldMute: State.lastMuteState === true, reason: 'AD_LOCK_FADING' };

    if (meetsThreshold) return { shouldMute: true, reason: 'CONFIDENCE_HIGH' };

    const votesOK = State.programVotes >= S.programVotesNeeded;
    const quorumOK = State.programQuorumCount >= S.programQuorumLines;
    const timeOK = State.lastProgramGoodMs && (t - State.lastProgramGoodMs >= S.unmuteDebounceMs);
    if (votesOK && quorumOK && timeOK) return { shouldMute: false, reason: 'PROGRAM_QUORUM_MET' };

    return { shouldMute: State.lastMuteState === true, reason: 'BUILDING_QUORUM' };
  }

  /* ---------- HUD ---------- */
  function ensureHUD(){
    if(NS.hudEl)return;
    const el=document.createElement('div');
    el.style.cssText=[
      'position:fixed','left:50%','bottom:80px','z-index:2147483647',
      'font:11px/1.2 system-ui,sans-serif','background:rgba(0,0,0,.8)','color:#fff',
      'padding:6px 10px','border-radius:6px','pointer-events:none','white-space:nowrap',
      'overflow:hidden',
      `opacity:0`,`transform:translateX(-50%) translateY(${S.hudSlidePx|0}px)`,
      `transition:opacity ${S.hudFadeMs|0}ms ease,transform ${S.hudFadeMs|0}ms ease`
    ].join(';');
    el.textContent=NS.hudText||'';document.documentElement.appendChild(el);NS.hudEl=el;
  }
  function hudFadeTo(v){ensureHUD();if(!NS.hudEl)return; if(NS.hudAnimTimer){clearTimeout(NS.hudAnimTimer);NS.hudAnimTimer=null;}
    NS.hudEl.style.opacity=v?'1':'0';NS.hudEl.style.transform=v?`translateX(-50%) translateY(0px)`:`translateX(-50%) translateY(${S.hudSlidePx|0}px)`;}
  let _hudBuilt = false;
  const _hudRefs = {};
  function _buildHUDInner() {
    if (_hudBuilt || !NS.hudEl) return;
    NS.hudEl.innerHTML = `<span id="yttp-hud-status" style="font-weight:600"></span>` +
      `<span style="color:#aaa;margin:0 4px;">·</span><span id="yttp-hud-reason"></span>` +
      `<span style="color:#aaa;margin:0 4px;">·</span><span id="yttp-hud-meter"></span>` +
      `<span id="yttp-hud-slider-wrap" style="margin-left:8px;pointer-events:auto;display:inline-flex;align-items:center;gap:4px;">` +
        `<span style="color:#888;font-size:10px;">Thr:</span>` +
        `<input type="range" id="yttp-threshold-slider" min="0" max="100" value="${S.confidenceThreshold}" style="width:60px;height:12px;cursor:pointer;accent-color:#1f6feb;vertical-align:middle;">` +
        `<span id="yttp-threshold-value" style="color:#fff;font-size:10px;">${S.confidenceThreshold}%</span>` +
      `</span>` +
      `<span id="yttp-hud-signals" style="color:#888;margin-left:6px;font-size:10px;"></span>`;
    _hudRefs.status = NS.hudEl.querySelector('#yttp-hud-status');
    _hudRefs.reason = NS.hudEl.querySelector('#yttp-hud-reason');
    _hudRefs.meter = NS.hudEl.querySelector('#yttp-hud-meter');
    _hudRefs.sliderWrap = NS.hudEl.querySelector('#yttp-hud-slider-wrap');
    _hudRefs.slider = NS.hudEl.querySelector('#yttp-threshold-slider');
    _hudRefs.sliderVal = NS.hudEl.querySelector('#yttp-threshold-value');
    _hudRefs.signals = NS.hudEl.querySelector('#yttp-hud-signals');
    if (_hudRefs.slider) {
      _hudRefs.slider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        S.confidenceThreshold = val;
        if (_hudRefs.sliderVal) _hudRefs.sliderVal.textContent = val + '%';
        saveSettings(S);
      });
    }
    _hudBuilt = true;
  }
  function updateHUDText(t, confidence, signals) {
    NS.hudText = t;
    if (!NS.hudEl) return;
    _buildHUDInner();

    const parts = t.split('\n').filter(Boolean);
    const status = parts[0] || '';
    const reason = parts[1] ? parts[1].replace('Reason: ', '') : '';

    if (_hudRefs.status) _hudRefs.status.textContent = status;
    if (_hudRefs.reason) _hudRefs.reason.textContent = reason;

    if (S.showConfidenceMeter && _hudRefs.meter) {
      const color = confidence >= S.confidenceThreshold ? '#f85149' : (confidence > 40 ? '#d29922' : '#3fb950');
      if (S.confidenceMeterStyle === 'bar' || S.confidenceMeterStyle === 'both') {
        const barWidth = 15;
        const filled = Math.round((confidence / 100) * barWidth);
        _hudRefs.meter.textContent = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled) + ' ' + confidence + '%';
      } else {
        _hudRefs.meter.textContent = confidence + '%';
      }
      _hudRefs.meter.style.color = color;
      _hudRefs.meter.style.display = '';
    } else if (_hudRefs.meter) {
      _hudRefs.meter.style.display = 'none';
    }

    if (_hudRefs.sliderWrap) {
      _hudRefs.sliderWrap.style.display = (S.showConfidenceMeter && S.showHudSlider) ? '' : 'none';
    }

    // Show top 3 signals
    if (_hudRefs.signals && S.showHUD && signals && signals.length > 0) {
      const topSignals = [...signals].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 3);
      _hudRefs.signals.textContent = topSignals.map(s => `${s.weight > 0 ? '+' : ''}${s.weight} ${s.source}`).join(', ');
    } else if (_hudRefs.signals) {
      _hudRefs.signals.textContent = '';
    }
  }
  function scheduleHudVisibility(desired){if(NS.hudTimer)clearTimeout(NS.hudTimer);const tok=Symbol('hud');NS._hudDesiredToken=tok;
    NS.hudTimer=setTimeout(()=>{if(NS._hudDesiredToken!==tok)return;const vis=S.showHUD||(S.hudAutoOnMute&&desired);hudFadeTo(vis);},Math.max(0,S.hudAutoDelayMs|0));}

  /* ---------- SETTINGS & MANUAL MUTE BUTTONS ---------- */
  function ensureSettingsButton(){
    if(NS.settingsBtn)return;
    const btn=document.createElement('button');
    btn.textContent='⚙️';
    btn.title='Settings (Ctrl+Shift+S)';
    btn.style.cssText=[
      'position:fixed','right:12px','bottom:12px','z-index:2147483647',
      'background:#1f6feb','color:#fff','border:none','border-radius:8px',
      'padding:8px 12px','font:16px/1 system-ui,sans-serif',
      'box-shadow:0 6px 18px rgba(0,0,0,.3)','cursor:pointer','pointer-events:auto'
    ].join(';');
    btn.addEventListener('click',togglePanel);
    document.documentElement.appendChild(btn);
    NS.settingsBtn=btn;
    ensureManualMuteButton();
  }

  function ensureManualMuteButton(){
    if(NS.muteBtn)return;
    const btn=document.createElement('button');
    btn.textContent='🔇';
    btn.title='Manual Mute Toggle';
    btn.style.cssText=[
      'position:fixed','right:68px','bottom:12px','z-index:2147483647',
      'background:#444','color:#fff','border:none','border-radius:8px',
      'padding:8px 12px','font:16px/1 system-ui,sans-serif',
      'box-shadow:0 6px 18px rgba(0,0,0,.3)','cursor:pointer','pointer-events:auto'
    ].join(';');
    btn.addEventListener('click',()=>{
      State.manualMuteActive = !State.manualMuteActive;
      btn.textContent = State.manualMuteActive ? '🔇' : '🔊';
      btn.style.background = State.manualMuteActive ? '#8b0000' : '#444';
      btn.title = State.manualMuteActive ? 'Manual Mute Active (Click to Unmute)' : 'Manual Mute Toggle';
      log(`Manual mute ${State.manualMuteActive?'ENABLED':'DISABLED'}`);
      scheduleImmediateCheck();
    });
    document.documentElement.appendChild(btn);
    NS.muteBtn=btn;
  }

  /* ---------- LOG ---------- */
  function pushCaption(text){
    const entry=`[${nowStr()}] ${text}`;
    window._captions_log.push(entry);
    if(window._captions_log.length>S.captionLogLimit)window._captions_log.splice(0,window._captions_log.length-S.captionLogLimit);
    scheduleLogFlush();
  }
  function pushEventLog(kind,p={}){
    const t=new Date(),pad=n=>String(n).padStart(2,'0');
    const ts=`${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    const line=[
      `[${ts}] >>> ${kind}`,
      p.reason?`reason=${p.reason}`:null,
      p.match?`match="${p.match}"`:null,
      p.noCcMs!==undefined?`noCcMs=${p.noCcMs}`:null,
      p.ccSnippet?`cc="${p.ccSnippet}"`:null,
      p.url?`url=${p.url}`:null,
      p.lock?`adLockMsLeft=${p.lock}`:null,
      p.pv!==undefined?`programVotes=${p.pv}`:null,
      p.quorum!==undefined?`programQuorum=${p.quorum}`:null
    ].filter(Boolean).join(' | ');
    window._captions_log.push(line);
    if(window._captions_log.length>S.captionLogLimit)window._captions_log.splice(0,window._captions_log.length-S.captionLogLimit);
    scheduleLogFlush();
  }
  function downloadCaptionsNow(){
    const pad=n=>String(n).padStart(2,'0'),d=new Date();
    const name=`youtubetv_captions_${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
    downloadText(name,window._captions_log.join('\n')||'(no captions logged yet)');
  }

  /* ---------- PROGRAM ANCHOR REGEX ---------- */
  const PROGRAM_ANCHOR_RE = new RegExp(
    String.raw`\b(joins us now|joining me now|welcome to|welcome back|we'?re back|back with|back to you|from washington|live (?:in|at)|earnings|beat estimates|raised guidance|analyst|conference call|tariffs?|supreme court|breaking news|economic data|cpi|ppi|jobs report|nonfarm payrolls|market (?:breadth|reaction)|s&p|nasdaq|dow|chief investment officer|portfolio manager|senior analyst|ceo|cfo|chair|closing bell|overtime|squawk box|squawk on the street|power lunch|fast money|mad money|halftime report|money movers|last call|worldwide exchange|the exchange|lightning round|final trades|stop trading)\b`,
    'i'
  );

  /* ---------- MUTE/UNMUTE ---------- */
  function setMuted(video,shouldMute,info){
    if(!video)return;

    if(State.manualMuteActive){
      shouldMute = true;
    } else if(!State.enabled){
      shouldMute=false;
    }

    const changed=(State.lastMuteState!==shouldMute);

    if(S.useTrueMute){ if(video.muted!==shouldMute) video.muted=shouldMute; }
    else { video.volume = shouldMute ? 0.01 : Math.max(video.volume||1.0,0.01); }

    if(changed){
      const lockMsLeft=Math.max(0,State.adLockUntil-Date.now());
      pushEventLog(shouldMute?'MUTED':'UNMUTED', {
        reason:info.reason,match:info.match,ccSnippet:info.ccSnippet,url:location.href,
        noCcMs:info.noCcMs,lock:lockMsLeft,pv:State.programVotes,quorum:State.programQuorumCount
      });
      if(S.hudAutoOnMute) scheduleHudVisibility(shouldMute);
      else if(S.showHUD) hudFadeTo(true);
    }
    State.lastMuteState=shouldMute;

    const statusPrefix = State.manualMuteActive ? '[MANUAL MUTE] ' : (State.enabled?'':'[PAUSED] ');
    // Truncate CC snippet for HUD display stability (max 60 chars)
    const hudCcSnippet = truncate(info.ccSnippet, 60);
    updateHUDText(
      statusPrefix+`${shouldMute?'MUTED':'UNMUTED'}\n`+
      `Reason: ${info.reason}\n`+
      (info.match?`Match: "${truncate(info.match, 30)}"\n`:'' )+
      (hudCcSnippet?`CC: "${hudCcSnippet}"`:'' ),
      info.confidence || State.currentConfidence,
      info.signals
    );
  }

  /* ---------- DOM / LOOP ---------- */
  let _cachedVideo = null, _cachedCaptionWindow = null, _cacheValidUntil = 0;
  function detectNodes(){
    const now = Date.now();
    if (now < _cacheValidUntil && _cachedVideo?.isConnected && _cachedCaptionWindow?.isConnected) {
      return { video: _cachedVideo, captionWindow: _cachedCaptionWindow };
    }
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    const captionWindow = document.querySelector('div.caption-window') ||
      document.querySelector('.ytp-caption-window-container') || document.querySelector('.ytp-caption-window');
    _cachedVideo = video;
    _cachedCaptionWindow = captionWindow;
    _cacheValidUntil = now + 2000;
    return { video, captionWindow };
  }
  function scheduleImmediateCheck(){
    if(!S.fastRecheckRAF) return tick();
    if(State.rafScheduled) return; State.rafScheduled=true; requestAnimationFrame(()=>{State.rafScheduled=false;tick();});
  }

  function evaluate(video, ccText, captionsExist, captionsBottomed) {
    const t = Date.now();
    if (captionsExist) State.lastCcSeenMs = t;
    const noCcMs = t - State.lastCcSeenMs;

    // Pre-compute features for signals
    const textFeatures = TextAnalyzer.analyze(ccText);
    const imperativeScore = ccText ? TextAnalyzer.imperativeScore(ccText) : 0;
    const conversationalScore = ccText ? TextAnalyzer.conversationalScore(ccText) : 0;

    // Guest intro detection (pre-pass so brandDetected can suppress)
    let guestIntroDetected = false, guestIntroMatch = null;
    if (ccText && PhraseIndex.match('brand', ccText)) {
      const introRe = /(?:joining us|joins us|let's bring in|with us from|our guest from|from)\s+/i;
      const titleRe = /(?:ceo|cfo|coo|president|chairman|chief|analyst|strategist|manager|economist|director)\b/i;
      if (introRe.test(ccText) || titleRe.test(ccText)) {
        guestIntroDetected = true;
        guestIntroMatch = ccText;
      }
    }

    const env = { captionsExist, captionsBottomed, noCcMs, textFeatures, imperativeScore, conversationalScore, guestIntroDetected, guestIntroMatch };

    // Collect all signals
    const signals = SignalCollector.collectAll(ccText || '', env);

    // Calculate confidence
    const confidence = calculateConfidence(signals);
    State.currentConfidence = confidence;

    // Decide mute state
    const decision = decide(confidence, signals);

    // Store last signals for feedback system
    State.lastSignals = signals;

    // Apply mute
    setMuted(video, decision.shouldMute, {
      reason: decision.reason,
      match: signals.find(s => s.match)?.match || null,
      ccSnippet: truncate(ccText),
      noCcMs,
      confidence,
      signals,
    });
  }

  function tick(){
    const {video,captionWindow}=detectNodes();
    if(!video){ if(State.videoRef)log('Video disappeared; waiting…'); State.videoRef=null; updateHUDText('Waiting for player…',0); return; }
    if(!State.videoRef){
      State.videoRef=video; log('Player found. Ready.');
      State.reset(false);
    }

    let ccText='',captionsExist=false,captionsBottomed=false;
    if(captionWindow){
      // Hide or show captions based on setting - only update if changed to prevent flickering
      if(S.hideCaptions!==State.lastCaptionVisibility){
        State.lastCaptionVisibility=S.hideCaptions;
        if(S.hideCaptions){
          // Use setAttribute for more forceful style override
          captionWindow.setAttribute('style',(captionWindow.getAttribute('style')||'')+';opacity:0!important;visibility:hidden!important;pointer-events:none!important');
        }else{
          // Remove our overrides by resetting to original style without our additions
          const styleAttr=captionWindow.getAttribute('style')||'';
          const cleanedStyle=styleAttr.replace(/;?opacity:0!important/g,'').replace(/;?visibility:hidden!important/g,'').replace(/;?pointer-events:none!important/g,'');
          captionWindow.setAttribute('style',cleanedStyle);
        }
      }

      ccText=(captionWindow.textContent||'').trim();
      captionsExist=ccText.length>0;
      const b=captionWindow.style && captionWindow.style.bottom;
      captionsBottomed=!!(b && b!=='auto' && b!=='');
    }

    if(S.debugVerboseCC){
      const captionSegment=document.querySelector('span.ytp-caption-segment')||document.querySelector('.ytp-caption-segment');
      const seg=captionSegment?.textContent;
      if(seg && seg!==State.lastCaptionLine){ State.lastCaptionLine=seg; console.log('[YTTV-Mute] CC:',seg); }
    }
    if(ccText && ccText!==State.lastCaptionLine){ State.lastCaptionLine=ccText; pushCaption(ccText); }

    if(S.autoDownloadEveryMin>0){
      const since=(Date.now()-State.lastAutoDlMs)/60000;
      if(since>=S.autoDownloadEveryMin){ State.lastAutoDlMs=Date.now(); downloadCaptionsNow(); }
    }

    evaluate(video,ccText,captionsExist,captionsBottomed);
  }

  function startLoop(){
    if(NS.intervalId)clearInterval(NS.intervalId);
    NS.intervalId=setInterval(tick,S.intervalMs);
    log('Loop started. INTERVAL_MS:',S.intervalMs,'URL:',location.href);
    ensureHUD();
    ensureSettingsButton();
    if(S.showHUD){hudFadeTo(true);updateHUDText('Initializing…',0);}
    else if(S.hudAutoOnMute){hudFadeTo(false);} else {hudFadeTo(false);}
    ensureControlButtons();
  }

  /* ---------- OBSERVERS ---------- */
  function attachCcObserver(){
    const {captionWindow}=detectNodes(); if(!captionWindow)return;
    if(!NS.ccObserver) NS.ccObserver=new MutationObserver(()=>scheduleImmediateCheck()); else {try{NS.ccObserver.disconnect();}catch{}}
    try{
      NS.ccObserver.observe(captionWindow,{subtree:true,childList:true,characterData:true});
      log('CC observer attached.');
      if(NS.ccAttachTimer){clearInterval(NS.ccAttachTimer);NS.ccAttachTimer=null;}
    }catch{}
  }
  if(NS.ccAttachTimer)clearInterval(NS.ccAttachTimer);
  NS.ccAttachTimer=setInterval(attachCcObserver,1000);

  function watchRouteChanges() {
    function onRouteChange() {
      if (NS._lastUrl === location.href) return;
      NS._lastUrl = location.href;
      log('Route change →', NS._lastUrl);
      State.reset(true);
      if (NS.hudTimer) { clearTimeout(NS.hudTimer); NS.hudTimer = null; }
      if (NS.hudAnimTimer) { clearTimeout(NS.hudAnimTimer); NS.hudAnimTimer = null; }
      startLoop();
    }
    const origPush = history.pushState;
    history.pushState = function() { origPush.apply(this, arguments); onRouteChange(); };
    const origReplace = history.replaceState;
    history.replaceState = function() { origReplace.apply(this, arguments); onRouteChange(); };
    window.addEventListener('popstate', onRouteChange);
  }
  watchRouteChanges();

  /* ---------- BOTTOM-LEFT CONTROL BUTTONS ---------- */
  function ensureControlButtons(){
    if(NS.btnContainer)return;

    // Create container for all buttons
    const container=document.createElement('div');
    container.style.cssText=[
      'position:fixed','left:12px','bottom:12px','z-index:2147483647',
      'display:flex','flex-direction:column','gap:8px','pointer-events:none'
    ].join(';');
    NS.btnContainer=container;
    document.documentElement.appendChild(container);

    // Common button style
    const btnStyle=[
      'background:#1f6feb','color:#fff','border:none','border-radius:8px',
      'padding:8px 10px','font:12px/1.3 system-ui,sans-serif',
      'box-shadow:0 6px 18px rgba(0,0,0,.3)','cursor:pointer','pointer-events:auto',
      'min-width:160px','text-align:center'
    ].join(';');

    // Flag Incorrect State button
    const flagBtn=document.createElement('button');
    flagBtn.textContent='Flag Incorrect State';
    flagBtn.style.cssText=btnStyle.replace('#1f6feb','#e5534b');
    flagBtn.addEventListener('click',flagIncorrectState);
    container.appendChild(flagBtn); NS.flagBtn=flagBtn;
  }

  function flagIncorrectState(){
    const {captionWindow,video}=detectNodes();
    const cc=(captionWindow?.textContent||'').trim();
    const wasMuted=State.lastMuteState===true;

    const entry = {
      timestamp: new Date().toISOString(),
      action: wasMuted ? 'FALSE_POSITIVE' : 'FALSE_NEGATIVE',
      wasMuted,
      captionText: truncate(cc, 200),
      lastNLines: [...State.captionWindow],
      confidence: State.currentConfidence,
      signals: (State.lastSignals || []).map(s => ({
        source: s.source, weight: s.weight, match: s.match
      })),
      adLockActive: Date.now() < State.adLockUntil,
      url: location.href,
      programQuorum: State.programQuorumCount,
    };

    _feedbackLog.push(entry);
    kvSet(FEEDBACK_KEY, _feedbackLog);

    pushEventLog('FLAG_INCORRECT_STATE',{
      reason:entry.action,
      ccSnippet:entry.captionText,
      url:entry.url,
      noCcMs:Date.now()-State.lastCcSeenMs,
      lock:Math.max(0,State.adLockUntil-Date.now()),
      pv:State.programVotes,
      quorum:State.programQuorumCount
    });

    if(video){
      if(wasMuted){
        State.adLockUntil=0;
        State.programQuorumCount=S.programQuorumLines;
        State.manualOverrideUntil=Date.now()+S.manualOverrideMs;
        setMuted(video,false,{reason:'FLAG_UNMUTE',match:null,ccSnippet:truncate(cc),noCcMs:Date.now()-State.lastCcSeenMs,confidence:State.currentConfidence,signals:[]});
      }else{
        setMuted(video,true,{reason:'FLAG_MUTE',match:null,ccSnippet:truncate(cc),noCcMs:Date.now()-State.lastCcSeenMs,confidence:State.currentConfidence,signals:[]});
      }
    }

    log('Feedback logged:', entry.action, 'confidence:', entry.confidence, 'signals:', entry.signals.length);
  }

  /* ---------- SETTINGS PANEL ---------- */
  function clampInt(v,min,max,fb){const n=Math.round(parseInt(v,10));return Number.isNaN(n)?fb:Math.min(max,Math.max(min,n));}

  const SETTING_FIELDS = [
    // General tab
    { id: 'useTrueMute', tab: 'general', type: 'checkbox', label: 'True mute (vs low volume)' },
    { id: 'debug', tab: 'general', type: 'checkbox', label: 'Console debug logging' },
    { id: 'debugVerboseCC', tab: 'general', type: 'checkbox', label: 'Verbose CC debug' },
    { id: 'llmReviewEnabled', tab: 'general', type: 'checkbox', label: 'Enable LLM Review', section: 'Review Features' },
    { id: 'showFrequentWords', tab: 'general', type: 'checkbox', label: 'Show Frequent Words' },
    { id: 'hideCaptions', tab: 'general', type: 'checkbox', label: 'Hide captions from view', section: 'Caption Display' },
    // HUD tab
    { id: 'showHUD', tab: 'hud', type: 'checkbox', label: 'Show HUD always' },
    { id: 'hudAutoOnMute', tab: 'hud', type: 'checkbox', label: 'Auto HUD on mute' },
    { id: 'showConfidenceMeter', tab: 'hud', type: 'checkbox', label: 'Show confidence meter', section: 'Confidence Meter' },
    { id: 'showHudSlider', tab: 'hud', type: 'checkbox', label: 'Show threshold slider on HUD' },
    { id: 'confidenceMeterStyle', tab: 'hud', type: 'select', label: 'Meter style', options: [['bar','Bar'],['numeric','Numeric'],['both','Both']] },
    { id: 'confidenceThreshold', tab: 'hud', type: 'range', min: 0, max: 100, label: 'Mute confidence threshold' },
    { id: 'hudAutoDelayMs', tab: 'hud', type: 'number', min: 0, max: 60000, label: 'Auto delay (ms)', section: 'Animation' },
    { id: 'hudFadeMs', tab: 'hud', type: 'number', min: 0, max: 2000, label: 'Fade (ms)' },
    { id: 'hudSlidePx', tab: 'hud', type: 'number', min: 0, max: 50, label: 'Slide (px)' },
    // Timing tab
    { id: 'intervalMs', tab: 'timing', type: 'number', min: 50, max: 2000, label: 'Poll interval (ms)' },
    { id: 'muteOnNoCCDelayMs', tab: 'timing', type: 'number', min: 0, max: 5000, label: 'Mute on CC loss (ms)' },
    { id: 'noCcHitsToMute', tab: 'timing', type: 'number', min: 1, max: 6, label: 'No-CC hits to mute' },
    { id: 'unmuteDebounceMs', tab: 'timing', type: 'number', min: 0, max: 5000, label: 'Unmute debounce (ms)' },
    { id: 'minAdLockMs', tab: 'timing', type: 'number', min: 0, max: 120000, label: 'Ad lock (ms)', section: 'Ad Lock' },
    { id: 'programVotesNeeded', tab: 'timing', type: 'number', min: 1, max: 6, label: 'Program votes needed' },
    { id: 'programQuorumLines', tab: 'timing', type: 'number', min: 1, max: 10, label: 'Quorum lines' },
    { id: 'manualOverrideMs', tab: 'timing', type: 'number', min: 0, max: 60000, label: 'Manual override (ms)' },
    // Phrases tab
    { id: 'hardPhrases', tab: 'phrases', type: 'textarea', rows: 7, label: 'Hard Ad Phrases' },
    { id: 'brandTerms', tab: 'phrases', type: 'textarea', rows: 6, label: 'Brand Terms' },
    { id: 'adContext', tab: 'phrases', type: 'textarea', rows: 6, label: 'Ad Context' },
    { id: 'ctaTerms', tab: 'phrases', type: 'textarea', rows: 5, label: 'CTA Terms' },
    { id: 'offerTerms', tab: 'phrases', type: 'textarea', rows: 5, label: 'Offer Terms' },
    { id: 'allowPhrases', tab: 'phrases', type: 'textarea', rows: 6, label: 'Allow Phrases (program cues)' },
    { id: 'breakPhrases', tab: 'phrases', type: 'textarea', rows: 5, label: 'Break Phrases' },
    { id: 'anchorNames', tab: 'phrases', type: 'textarea', rows: 5, label: 'CNBC Anchor Names' },
    { id: 'segmentNames', tab: 'phrases', type: 'textarea', rows: 5, label: 'Segment Names' },
    { id: 'returnFromBreakPhrases', tab: 'phrases', type: 'textarea', rows: 5, label: 'Return-from-Break Phrases' },
  ];

  function populatePanel(panel, settings) {
    for (const f of SETTING_FIELDS) {
      const el = panel.querySelector('#' + f.id);
      if (!el) continue;
      const val = settings[f.id];
      if (f.type === 'checkbox') el.checked = !!val;
      else if (f.type === 'textarea') el.value = Array.isArray(val) ? val.join('\n') : (val || '');
      else el.value = val;
    }
    const thrVal = panel.querySelector('#confidenceThresholdValue');
    if (thrVal) thrVal.textContent = settings.confidenceThreshold + '%';
  }

  function readPanel(panel) {
    const out = {};
    for (const f of SETTING_FIELDS) {
      const el = panel.querySelector('#' + f.id);
      if (!el) continue;
      if (f.type === 'checkbox') out[f.id] = el.checked;
      else if (f.type === 'number' || f.type === 'range') out[f.id] = clampInt(el.value, f.min, f.max, DEFAULTS[f.id]);
      else if (f.type === 'textarea') {
        const lines = el.value.split('\n').map(s => s.trim()).filter(Boolean);
        out[f.id] = Array.isArray(DEFAULTS[f.id]) ? lines : el.value;
      }
      else out[f.id] = el.value;
    }
    return out;
  }

  function buildPanel(){
    if(NS.panelEl)return NS.panelEl;
    const panel=document.createElement('div'); NS.panelEl=panel;
    panel.style.cssText='position:fixed;right:16px;top:16px;z-index:2147483647;width:560px;max-width:95vw;max-height:85vh;background:#111;color:#fff;border:1px solid #333;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5);font:13px/1.4 system-ui,sans-serif;display:flex;flex-direction:column';
    const btnS='background:#1f6feb;border:none;color:#fff;padding:6px 10px;border-radius:7px;cursor:pointer';
    const inputS='width:100%;box-sizing:border-box;background:#000;color:#fff;border:1px solid #333;border-radius:7px;padding:6px';
    const tabS='background:transparent;border:none;color:#888;padding:8px 12px;cursor:pointer;border-bottom:2px solid transparent;font:13px system-ui,sans-serif';
    const activeTabS='color:#fff;border-bottom-color:#1f6feb';
    const tabNames = ['general','hud','timing','phrases','actions'];

    // Build tab content from SETTING_FIELDS
    const tabContent = {};
    for (const tn of tabNames) tabContent[tn] = '';
    let lastSection = {};
    for (const f of SETTING_FIELDS) {
      if (f.section && f.section !== lastSection[f.tab]) {
        lastSection[f.tab] = f.section;
        tabContent[f.tab] += `<div style="display:grid;gap:8px;border-top:1px solid #333;padding-top:8px;"><div style="font-weight:600;font-size:13px;">${f.section}</div>`;
      }
      if (f.type === 'checkbox') {
        tabContent[f.tab] += `<label><input type="checkbox" id="${f.id}"> ${f.label}</label>`;
      } else if (f.type === 'number') {
        tabContent[f.tab] += `<label>${f.label} <input id="${f.id}" type="number" min="${f.min}" max="${f.max}" style="${inputS}"></label>`;
      } else if (f.type === 'range') {
        tabContent[f.tab] += `<label>${f.label}<div style="display:flex;align-items:center;gap:8px;"><input id="${f.id}" type="range" min="${f.min}" max="${f.max}" style="flex:1;height:20px;"><span id="${f.id}Value" style="min-width:40px;text-align:right;"></span></div></label>`;
      } else if (f.type === 'select') {
        const opts = f.options.map(([v,l]) => `<option value="${v}">${l}</option>`).join('');
        tabContent[f.tab] += `<label>${f.label} <select id="${f.id}" style="${inputS}">${opts}</select></label>`;
      } else if (f.type === 'textarea') {
        tabContent[f.tab] += `<div><div style="margin:6px 0 4px;font-weight:600;">${f.label} (one per line)</div><textarea id="${f.id}" rows="${f.rows}" style="${inputS};font-family:ui-monospace,Menlo,Consolas,monospace;"></textarea></div>`;
      }
    }

    // Actions tab (static)
    tabContent.actions = `
      <div style="display:grid;gap:8px;">
        <div style="font-weight:600;font-size:13px;">Caption Logging</div>
        <label>Auto-download captions every N minutes (0=off) <input id="autoDownloadEveryMin" type="number" min="0" max="360" style="${inputS}"></label>
        <label>Caption log limit (lines) <input id="captionLogLimit" type="number" min="200" max="50000" style="${inputS}"></label>
      </div>
      <div style="display:grid;gap:8px;border-top:1px solid #333;padding-top:8px;">
        <div style="font-weight:600;font-size:13px;">Quick Actions</div>
        <button id="dl" style="${btnS}">Download Captions (Ctrl+D)</button>
        <button id="clearlog" style="${btnS};background:#8b0000">Clear Caption Log</button>
      </div>
      <div style="display:grid;gap:8px;border-top:1px solid #333;padding-top:8px;">
        <div style="font-weight:600;font-size:13px;">Feedback Log</div>
        <button id="dlFeedback" style="${btnS}">Download Feedback Log (JSON)</button>
        <button id="clearFeedback" style="${btnS};background:#8b0000">Clear Feedback Log</button>
      </div>
      <div style="display:grid;gap:8px;border-top:1px solid #333;padding-top:8px;">
        <div style="font-weight:600;font-size:13px;">Settings Management</div>
        <button id="export" style="${btnS}">Export Settings to File</button>
        <label style="${btnS};display:inline-block;position:relative;overflow:hidden;">Import Settings<input id="import" type="file" accept="application/json" style="opacity:0;position:absolute;left:0;top:0;width:100%;height:100%;cursor:pointer;"></label>
        <button id="reset" style="${btnS};background:#444">Reset All to Defaults</button>
      </div>
      <div style="border-top:1px solid #333;padding-top:8px;">
        <div style="font-weight:600;font-size:13px;margin-bottom:8px;">Keyboard Shortcuts</div>
        <div style="font-size:12px;color:#bbb;line-height:1.6;">
          <b>Ctrl+M</b> Toggle mute | <b>Ctrl+D</b> Download log | <b>Ctrl+Shift+S</b> Settings | <b>Ctrl+Shift+F</b> Flag incorrect
        </div>
      </div>`;

    const tabBar = tabNames.map((tn,i) =>
      `<button class="yttp-tab" data-tab="${tn}" style="${tabS}${i===0?';'+activeTabS:''}">${tn[0].toUpperCase()+tn.slice(1)}</button>`
    ).join('');

    const tabPanels = tabNames.map((tn,i) =>
      `<div class="yttp-tab-content" data-tab="${tn}" style="padding:12px;display:${i===0?'grid':'none'};gap:12px;">${tabContent[tn]}</div>`
    ).join('');

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #333;">
        <div style="font-weight:600;font-size:14px;">YTTV Auto-Mute v4.0 — Settings</div>
        <div style="margin-left:auto;display:flex;gap:8px;">
          <button id="yttp-save" style="${btnS}">Save & Apply</button>
          <button id="yttp-close" style="${btnS};background:#444">Close</button>
        </div>
      </div>
      <div style="display:flex;border-bottom:1px solid #333;background:#0d1117;">${tabBar}</div>
      <div style="overflow:auto;flex:1;">${tabPanels}</div>`;
    document.documentElement.appendChild(panel);

    // Tab switching
    const tabs = panel.querySelectorAll('.yttp-tab');
    const tabContents = panel.querySelectorAll('.yttp-tab-content');
    tabs.forEach(tb => {
      tb.addEventListener('click', () => {
        const target = tb.getAttribute('data-tab');
        tabs.forEach(t => { t.style.color = t.getAttribute('data-tab') === target ? '#fff' : '#888'; t.style.borderBottomColor = t.getAttribute('data-tab') === target ? '#1f6feb' : 'transparent'; });
        tabContents.forEach(tc => { tc.style.display = tc.getAttribute('data-tab') === target ? 'grid' : 'none'; });
      });
    });

    // Populate fields
    populatePanel(panel, S);
    panel.querySelector('#autoDownloadEveryMin').value = S.autoDownloadEveryMin;
    panel.querySelector('#captionLogLimit').value = S.captionLogLimit;

    // Range slider live update
    const thrSlider = panel.querySelector('#confidenceThreshold');
    if (thrSlider) thrSlider.addEventListener('input', (e) => {
      const v = panel.querySelector('#confidenceThresholdValue');
      if (v) v.textContent = e.target.value + '%';
    });

    // Action buttons
    panel.querySelector('#yttp-close').onclick = () => togglePanel();
    panel.querySelector('#dl').onclick = downloadCaptionsNow;
    panel.querySelector('#clearlog').onclick = () => { window._captions_log = []; kvSet(CAPLOG_KEY, window._captions_log); alert('Caption log cleared.'); };
    panel.querySelector('#dlFeedback').onclick = () => downloadText('yttp_feedback.json', JSON.stringify(_feedbackLog, null, 2));
    panel.querySelector('#clearFeedback').onclick = () => { _feedbackLog = []; kvSet(FEEDBACK_KEY, _feedbackLog); alert('Feedback log cleared.'); };
    panel.querySelector('#export').onclick = () => {
      const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(S, null, 2));
      const a = document.createElement('a'); a.href = url; a.download = 'yttp_settings.json'; a.click();
    };
    panel.querySelector('#import').onchange = (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => { try { S = { ...DEFAULTS, ...JSON.parse(r.result) }; PhraseIndex.rebuild(S); saveSettings(S); applySettings(true); alert('Imported.'); NS.panelEl.remove(); NS.panelEl = null; buildPanel(); } catch { alert('Invalid file.'); } };
      r.readAsText(f);
    };
    panel.querySelector('#reset').onclick = () => { if (!confirm('Reset to defaults?')) return; S = { ...DEFAULTS }; PhraseIndex.rebuild(S); saveSettings(S); applySettings(true); NS.panelEl.remove(); NS.panelEl = null; buildPanel(); };
    panel.querySelector('#yttp-save').onclick = () => {
      Object.assign(S, readPanel(panel));
      S.autoDownloadEveryMin = clampInt(panel.querySelector('#autoDownloadEveryMin').value, 0, 360, DEFAULTS.autoDownloadEveryMin);
      S.captionLogLimit = clampInt(panel.querySelector('#captionLogLimit').value, 200, 50000, DEFAULTS.captionLogLimit);
      PhraseIndex.rebuild(S);
      saveSettings(S);
      applySettings(true);
      alert('Settings saved and applied.');
    };
    return panel;
  }
  function togglePanel(){ if(!NS.panelEl)buildPanel(); NS.panelEl.style.display=(NS.panelEl.style.display==='none'?'block':'none'); }
  function applySettings(restart=false){ if(NS.hudEl)NS.hudEl.style.transition=`opacity ${S.hudFadeMs|0}ms ease, transform ${S.hudFadeMs|0}ms ease`; if(restart)startLoop(); }

  /* ---------- HOTKEYS ---------- */
  window.addEventListener('keydown',(e)=>{
    if(e.ctrlKey && (e.key==='m'||e.key==='M')){State.enabled=!State.enabled;log(`Toggled → ${State.enabled?'ENABLED':'PAUSED'}`);e.preventDefault();}
    if(e.ctrlKey && (e.key==='d'||e.key==='D')){downloadCaptionsNow();e.preventDefault();}
    if(e.ctrlKey && e.shiftKey && (e.key==='s'||e.key==='S')){togglePanel();e.preventDefault();}
    if(e.ctrlKey && e.shiftKey && (e.key==='f'||e.key==='F')){flagIncorrectState();e.preventDefault();}
  },true);

  /* ---------- BOOT ---------- */
  applySettings(false);
  startLoop();
  log('Booted v4.0.0',{signals:SignalCollector.signals.length,phraseCategories:Object.keys(PhraseIndex.lists).length,confidenceThreshold:S.confidenceThreshold,hideCaptions:S.hideCaptions,confidenceMeter:S.showConfidenceMeter,hudSlider:S.showHudSlider});
})();
