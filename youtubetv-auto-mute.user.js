// ==UserScript==
// @name         YTTV Auto-Mute (v3.2: Tabbed Settings + UI Improvements)
// @namespace    http://tampermonkey.net/
// @description  Auto-mute ads on YouTube TV using captions + heuristics. Medicare/benefits ads weighted, program quorum to unmute after breaks, faster CC-loss mute (with safety), HUD, tabbed settings UI, caption visibility toggle, floating settings button, logs, and "Flag Incorrect State" button with toggle controls for LLM Review and Frequent Words.
// @version      3.2
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
    if(NS.routeObserver?.disconnect)NS.routeObserver.disconnect();
    if(NS.hudTimer)clearTimeout(NS.hudTimer);
    if(NS.hudAnimTimer)clearTimeout(NS.hudAnimTimer);
  }catch{}
  Object.assign(NS,{intervalId:null,ccAttachTimer:null,ccObserver:null,routeObserver:null,
    hudEl:null,panelEl:null,hudText:'',hudTimer:null,hudAnimTimer:null,
    flagBtn:null,llmReviewBtn:null,freqWordsBtn:null,btnContainer:null,settingsBtn:null,_lastUrl:location.href});

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

    // Timing / CC loss
    muteOnNoCCDelayMs:180,   // lower/faster
    noCcHitsToMute:2,        // needs consecutive hits
    unmuteDebounceMs:500,

    // Ad lock
    minAdLockMs:20000,

    // Program gating
    programVotesNeeded:2,
    programQuorumLines:4,    // NEW: need N consecutive program-leaning lines before unmute (unless strong allow)
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

      // finance/offer
      "terms apply","limited time offer","0% apr","zero percent apr","get started today","apply today",
      "see store for details","not available in all states","learn more at","learn more on","visit",
      "get your money right","policy for only","guaranteed buyback option","own your place in the future",

      // MEDICARE/BENEFITS (strong)
      "medicare","medicare advantage","part c","dual-eligible","special needs plan",
      "enrollment ends","annual election period","aep","open enrollment","enroll by",
      "licensed agent","call the number","tty",
      "over-the-counter","otc","benefits card","allowance","prepaid card","supplemental benefits",
      "$0 premium","$0 copay","in-network","out-of-network","formulary","prescription drug coverage",
      "talk to a licensed agent","speak to a licensed agent","humana","unitedhealthcare","anthem","aetna"
    ].join('\n'),

    brandTerms: [
      "capital one","t-mobile","tmobile","verizon","at&t","att","comcast","xfinity",
      "liberty mutual","progressive","geico","state farm","allstate",
      "ozempic","mounjaro","trulicity","jardiance","humira","rinvoq","skyrizi",
      "iphone","whopper","medicare","humana","unitedhealthcare","aarp"
    ].join('\n'),

    adContext: [
      "sponsored by","brought to you by","presented by",
      "offer ends","apply now","apply today","learn more","visit","sign up","join now",
      "get started","start today","enroll","enrollment","speak to an agent","licensed agent",
      ".com","dot com","call now","call today","call the number","free shipping","save today",
      "see details","member fdic","not fdic insured","policy","quote"
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
      "welcome to closing bell","overtime is back","welcome back"
    ],

    // Explicit break cues — enter ad-lock quickly
    breakPhrases: [
      "back after this","we'll be right back","we will be right back",
      "stay with us","more after the break","right after this break",
      "the exchange is back after this"
    ],
  };

  const SETTINGS_KEY='yttp_settings_v3_0';
  const loadSettings=()=>({...DEFAULTS,...(kvGet(SETTINGS_KEY,{}) )});
  const saveSettings=(s)=>kvSet(SETTINGS_KEY,s);
  let S=loadSettings();

  const toLines=(t)=>(t||'').split('\n').map(s=>s.trim()).filter(Boolean);
  let HARD_AD_PHRASES = toLines(S.hardPhrases);
  let BRAND_TERMS     = toLines(S.brandTerms);
  let AD_CONTEXT      = toLines(S.adContext);
  let ALLOW_PHRASES   = toLines(Array.isArray(S.allowPhrases)?S.allowPhrases.join('\n'):S.allowPhrases);
  let BREAK_PHRASES   = toLines(Array.isArray(S.breakPhrases)?S.breakPhrases.join('\n'):S.breakPhrases);
  let CTA_TERMS       = Array.isArray(S.ctaTerms)?S.ctaTerms.map(s=>s.toLowerCase()):toLines(S.ctaTerms?.join?.('\n')||'');
  let OFFER_TERMS     = Array.isArray(S.offerTerms)?S.offerTerms.map(s=>s.toLowerCase()):toLines(S.offerTerms?.join?.('\n')||'');

  /* ---------- STATE ---------- */
  const log=(...a)=>{if(S.debug)console.log('[YTTV-Mute]',...a);};
  const nowStr=()=>new Date().toLocaleTimeString();
  const CAPLOG_KEY='captions_log';
  window._captions_log = Array.isArray(kvGet(CAPLOG_KEY,[]))?kvGet(CAPLOG_KEY,[]):[];

  let enabled=true, videoRef=null, lastMuteState=null, lastCaptionLine='';
  let lastCcSeenMs=0, lastProgramGoodMs=0, lastAutoDlMs=Date.now(), rafScheduled=false;
  let adLockUntil=0, programVotes=0, manualOverrideUntil=0;
  let noCcConsec=0, bottomConsec=0;
  let programQuorumCount=0;   // NEW

  const URL_RE=/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i;
  const PHONE_RE=/\b(?:\d{3}[-\s.]?\d{3}[-\s.]?\d{4})\b/;
  const DOLLAR_RE=/\$\s?\d/;
  const PER_RE=/\b\d+\s?(?:per|\/)\s?(?:month|mo|yr|year)\b/i;

  /* ---------- HUD ---------- */
  function ensureHUD(){
    if(NS.hudEl)return;
    const el=document.createElement('div');
    el.style.cssText=[
      'position:fixed','right:12px','bottom:52px','z-index:2147483647',
      'font:12px/1.3 system-ui,sans-serif','background:rgba(0,0,0,.72)','color:#fff',
      'padding:8px 10px','border-radius:8px','max-width:360px','pointer-events:none','white-space:pre-wrap',
      `opacity:0`,`transform:translateY(${S.hudSlidePx|0}px)`,
      `transition:opacity ${S.hudFadeMs|0}ms ease,transform ${S.hudFadeMs|0}ms ease`
    ].join(';');
    el.textContent=NS.hudText||'';document.documentElement.appendChild(el);NS.hudEl=el;
  }
  function hudFadeTo(v){ensureHUD();if(!NS.hudEl)return; if(NS.hudAnimTimer){clearTimeout(NS.hudAnimTimer);NS.hudAnimTimer=null;}
    NS.hudEl.style.opacity=v?'1':'0';NS.hudEl.style.transform=v?'translateY(0px)':`translateY(${S.hudSlidePx|0}px)`;}
  function updateHUDText(t){NS.hudText=t; if(NS.hudEl)NS.hudEl.textContent=t;}
  function scheduleHudVisibility(desired){if(NS.hudTimer)clearTimeout(NS.hudTimer);const tok=Symbol('hud');NS._hudDesiredToken=tok;
    NS.hudTimer=setTimeout(()=>{if(NS._hudDesiredToken!==tok)return;const vis=S.showHUD||(S.hudAutoOnMute&&desired);hudFadeTo(vis);},Math.max(0,S.hudAutoDelayMs|0));}

  /* ---------- SETTINGS BUTTON ---------- */
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
  }

  /* ---------- LOG ---------- */
  function pushCaption(text){
    const entry=`[${nowStr()}] ${text}`;
    window._captions_log.push(entry);
    if(window._captions_log.length>S.captionLogLimit)window._captions_log.splice(0,window._captions_log.length-S.captionLogLimit);
    kvSet(CAPLOG_KEY,window._captions_log);
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
    kvSet(CAPLOG_KEY,window._captions_log);
  }
  function downloadCaptionsNow(){
    const pad=n=>String(n).padStart(2,'0'),d=new Date();
    const name=`youtubetv_captions_${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
    downloadText(name,window._captions_log.join('\n')||'(no captions logged yet)');
  }

  /* ---------- DETECTION ---------- */
  const containsAny=(txt,arr)=>{for(const t of arr){if(t&&txt.includes(t))return t;}return null;};

  // Program anchors: strong indicators the show is on (beyond general "program")
  const PROGRAM_ANCHOR_RE = new RegExp(
    String.raw`\b(joins us now|joining me now|welcome to|welcome back|we'?re back|back with|back to you|from washington|live (?:in|at)|earnings|beat estimates|raised guidance|analyst|conference call|tariffs?|supreme court|breaking news|economic data|cpi|ppi|jobs report|nonfarm payrolls|market (?:breadth|reaction)|s&p|nasdaq|dow|chief investment officer|portfolio manager|senior analyst|ceo|cfo|chair|closing bell|overtime)\b`,
    'i'
  );

  function isProgramAnchor(text){ return PROGRAM_ANCHOR_RE.test(text); }

  // Non-text ad signal with consecutive gates
  function nonTextAdSignal({captionsExist,captionsBottomed,noCcMs}){
    if(!captionsExist && noCcMs>S.muteOnNoCCDelayMs){ noCcConsec++; } else { noCcConsec=0; }
    if(captionsBottomed){ bottomConsec++; } else { bottomConsec=0; }
    if(noCcConsec>=S.noCcHitsToMute && (bottomConsec>=1 || noCcConsec>=S.noCcHitsToMute+1)){
      return {verdict:'AD_SIGNAL_SCORE',matched:`noCCx${noCcConsec}${bottomConsec?`+bottomx${bottomConsec}`:''}`};
    }
    return null;
  }

  function detectAdSignals(ccText,{captionsExist,captionsBottomed,noCcMs}){
    const text=(ccText||'').toLowerCase();

    // Instant allow (clear lock + unmute)
    const allowHit=containsAny(text,ALLOW_PHRASES);
    if(allowHit) return {verdict:'PROGRAM_ALLOW',matched:allowHit};

    // Explicit break cues
    const breakHit=containsAny(text,BREAK_PHRASES);
    if(breakHit) return {verdict:'AD_BREAK',matched:breakHit};

    // Hard phrases (includes Medicare/benefits)
    for(const p of HARD_AD_PHRASES){ if(text.includes(p)) return {verdict:'AD_HARD',matched:p}; }

    // Brand + context + CTA/OFFER
    const brandHit=containsAny(text,BRAND_TERMS);
    if(brandHit){
      const ctxHit = containsAny(text,AD_CONTEXT) || (URL_RE.test(text)?'url':null) || (PHONE_RE.test(text)?'phone':null);
      if(ctxHit){
        const ctaHit = containsAny(text,CTA_TERMS) || containsAny(text,OFFER_TERMS) ||
                       (DOLLAR_RE.test(text)?'$':null) || (PER_RE.test(text)?'per':null);
        if(ctaHit) return {verdict:'AD_BRAND_WITH_CONTEXT',matched:`${brandHit}+${ctxHit}+${ctaHit}`};
      }
    }

    // Non-textual (with safety)
    const nonText = nonTextAdSignal({captionsExist,captionsBottomed,noCcMs});
    if(nonText) return nonText;

    // Program anchor?
    if(isProgramAnchor(text)) return {verdict:'PROGRAM_ANCHOR',matched:null};

    return {verdict:'PROGRAM',matched:null};
  }

  /* ---------- MUTE/UNMUTE ---------- */
  function setMuted(video,shouldMute,info){
    if(!video)return;
    if(!enabled) shouldMute=false;
    const changed=(lastMuteState!==shouldMute);

    if(S.useTrueMute){ if(video.muted!==shouldMute) video.muted=shouldMute; }
    else { video.volume = shouldMute ? 0.01 : Math.max(video.volume||1.0,0.01); }

    if(changed){
      const lockMsLeft=Math.max(0,adLockUntil-Date.now());
      pushEventLog(shouldMute?'MUTED':'UNMUTED', {
        reason:info.reason,match:info.match,ccSnippet:info.ccSnippet,url:location.href,
        noCcMs:info.noCcMs,lock:lockMsLeft,pv:programVotes,quorum:programQuorumCount
      });
      if(S.hudAutoOnMute) scheduleHudVisibility(shouldMute);
      else if(S.showHUD) hudFadeTo(true);
    }
    lastMuteState=shouldMute;
    updateHUDText(
      (enabled?'':'[PAUSED] ')+`${shouldMute?'MUTED':'UNMUTED'}\n`+
      `Reason: ${info.reason}\n`+
      (info.match?`Match: "${info.match}"\n`:'' )+
      (info.ccSnippet?`CC: "${info.ccSnippet}"`:'' )
    );
  }

  /* ---------- DOM / LOOP ---------- */
  function detectNodes(){
    const video=document.querySelector('video.html5-main-video')||document.querySelector('video');
    const captionSegment=document.querySelector('span.ytp-caption-segment')||document.querySelector('.ytp-caption-segment');
    const captionWindow=document.querySelector('div.caption-window')||document.querySelector('.ytp-caption-window-container')||document.querySelector('.ytp-caption-window');
    return {video,captionSegment,captionWindow};
  }
  function scheduleImmediateCheck(){
    if(!S.fastRecheckRAF) return tick();
    if(rafScheduled) return; rafScheduled=true; requestAnimationFrame(()=>{rafScheduled=false;tick();});
  }

  function evaluate(video,ccText,captionsExist,captionsBottomed){
    const t=Date.now();
    if(captionsExist) lastCcSeenMs=t;

    const noCcMs=t-lastCcSeenMs;
    const res=detectAdSignals(ccText,{captionsExist,captionsBottomed,noCcMs});

    let shouldMute=false;
    let reason='PROGRAM_DETECTED';
    let match=res.matched;

    // Manual override: force UNMUTE unless hard ad/brand+context
    const manualActive = t < manualOverrideUntil;
    const hardAd = (res.verdict==='AD_HARD'||res.verdict==='AD_BRAND_WITH_CONTEXT');
    if(manualActive && !hardAd){
      setMuted(video,false,{reason:'MANUAL_OVERRIDE_ACTIVE',match,ccSnippet:ccText?ccText.slice(0,140)+(ccText.length>140?'…':''):'',noCcMs});
      return;
    }

    // Enter/extend ad lock for ad-like verdicts
    if(res.verdict==='AD_BREAK'||res.verdict==='AD_HARD'||res.verdict==='AD_BRAND_WITH_CONTEXT'||res.verdict==='AD_SIGNAL_SCORE'){
      adLockUntil=Math.max(adLockUntil,t+S.minAdLockMs);
      programVotes=0; programQuorumCount=0; lastProgramGoodMs=0;
    }

    const lockActive=t<adLockUntil;

    // Instant allow (clear lock + immediate unmute)
    if(res.verdict==='PROGRAM_ALLOW'){
      adLockUntil=0; programVotes=S.programVotesNeeded; programQuorumCount=S.programQuorumLines;
      setMuted(video,false,{reason:'PROGRAM_ALLOW_INSTANT',match,ccSnippet:ccText?ccText.slice(0,140)+(ccText.length>140?'…':''):'',noCcMs});
      return;
    }

    // Count program quorum (only on clean program-y lines)
    const programish = (res.verdict==='PROGRAM'||res.verdict==='PROGRAM_ANCHOR');
    if(programish && captionsExist && !captionsBottomed){
      programVotes=Math.min(S.programVotesNeeded, programVotes+1);
      programQuorumCount = Math.min(S.programQuorumLines, programQuorumCount + (res.verdict==='PROGRAM_ANCHOR'?2:1));
      if(lastProgramGoodMs===0) lastProgramGoodMs=t;
    } else if(!captionsExist || captionsBottomed || !programish){
      // reset quorum if we get ad-ish or lose captions
      if(res.verdict!=='PROGRAM' && res.verdict!=='PROGRAM_ANCHOR') programQuorumCount=0;
      if(!captionsExist) lastProgramGoodMs=0;
      programVotes = (res.verdict==='PROGRAM'||res.verdict==='PROGRAM_ANCHOR')?programVotes:0;
    }

    if(lockActive){
      shouldMute=true; reason='AD_LOCK';
    }else{
      if(res.verdict==='AD_BREAK'||res.verdict==='AD_HARD'||res.verdict==='AD_BRAND_WITH_CONTEXT'||res.verdict==='AD_SIGNAL_SCORE'){
        shouldMute=true; reason=res.verdict; lastProgramGoodMs=0; programQuorumCount=0;
      }else if(captionsExist && !captionsBottomed){
        const votesOK = programVotes>=S.programVotesNeeded;
        const quorumOK= programQuorumCount>=S.programQuorumLines;
        const timeOK  = lastProgramGoodMs && ((t-lastProgramGoodMs)>=S.unmuteDebounceMs);
        if( (votesOK && quorumOK && timeOK) || res.verdict==='PROGRAM_ANCHOR'){
          shouldMute=false; reason=(res.verdict==='PROGRAM_ANCHOR')?'PROGRAM_ANCHOR_OK':'PROGRAM_CONFIRMED';
        }else{
          shouldMute=(lastMuteState===true);
          reason = !votesOK ? 'PROGRAM_VOTING' : (!quorumOK ? 'PROGRAM_QUORUM' : 'PROGRAM_DEBOUNCE');
        }
      }else{
        // hold mute briefly when CC vanishes
        shouldMute=(lastMuteState===true)&&(noCcMs<S.muteOnNoCCDelayMs);
        if(shouldMute)reason='HOLD_PREV_STATE';
      }
    }

    setMuted(video,shouldMute,{
      reason,match,ccSnippet:ccText?ccText.slice(0,140)+(ccText.length>140?'…':''):'',noCcMs
    });
  }

  function tick(){
    const {video,captionSegment,captionWindow}=detectNodes();
    if(!video){ if(videoRef)log('Video disappeared; waiting…'); videoRef=null; updateHUDText('Waiting for player…'); return; }
    if(!videoRef){
      videoRef=video; log('Player found. Ready.');
      lastCcSeenMs=Date.now(); lastProgramGoodMs=0; adLockUntil=0; programVotes=0; manualOverrideUntil=0;
      noCcConsec=0; bottomConsec=0; programQuorumCount=0;
    }

    let ccText='',captionsExist=false,captionsBottomed=false;
    if(captionWindow){
      // Hide or show captions based on setting
      if(S.hideCaptions){
        if(captionWindow.style.opacity!=='0'){
          captionWindow.style.opacity='0';
          captionWindow.style.visibility='hidden';
        }
      }else{
        if(captionWindow.style.opacity==='0'||captionWindow.style.visibility==='hidden'){
          captionWindow.style.opacity='';
          captionWindow.style.visibility='';
        }
      }

      ccText=(captionWindow.textContent||'').trim();
      captionsExist=ccText.length>0;
      const b=captionWindow.style && captionWindow.style.bottom;
      captionsBottomed=!!(b && b!=='auto' && b!=='');
    }

    if(S.debugVerboseCC && captionSegment?.textContent){
      const seg=captionSegment.textContent;
      if(seg && seg!==lastCaptionLine){ lastCaptionLine=seg; console.log('[YTTV-Mute] CC:',seg); }
    }
    if(ccText && ccText!==lastCaptionLine){ lastCaptionLine=ccText; pushCaption(ccText); }

    if(S.autoDownloadEveryMin>0){
      const since=(Date.now()-lastAutoDlMs)/60000;
      if(since>=S.autoDownloadEveryMin){ lastAutoDlMs=Date.now(); downloadCaptionsNow(); }
    }

    evaluate(video,ccText,captionsExist,captionsBottomed);
  }

  function startLoop(){
    if(NS.intervalId)clearInterval(NS.intervalId);
    NS.intervalId=setInterval(tick,S.intervalMs);
    log('Loop started. INTERVAL_MS:',S.intervalMs,'URL:',location.href);
    ensureHUD();
    ensureSettingsButton();
    if(S.showHUD){hudFadeTo(true);updateHUDText('Initializing…');}
    else if(S.hudAutoOnMute){hudFadeTo(false);} else {hudFadeTo(false);}
    ensureControlButtons();
  }

  /* ---------- OBSERVERS ---------- */
  function attachCcObserver(){
    const {captionWindow}=detectNodes(); if(!captionWindow)return;
    if(!NS.ccObserver) NS.ccObserver=new MutationObserver(()=>scheduleImmediateCheck()); else {try{NS.ccObserver.disconnect();}catch{}}
    try{ NS.ccObserver.observe(captionWindow,{subtree:true,childList:true,characterData:true}); log('CC observer attached.'); }catch{}
  }
  if(NS.ccAttachTimer)clearInterval(NS.ccAttachTimer);
  NS.ccAttachTimer=setInterval(attachCcObserver,1000);

  function attachRouteObserver(){
    if(NS.routeObserver){try{NS.routeObserver.disconnect();}catch{}}
    NS.routeObserver=new MutationObserver(()=>{
      if(NS._lastUrl!==location.href){
        NS._lastUrl=location.href; log('Route change →',NS._lastUrl);
        lastMuteState=null; lastCaptionLine=''; videoRef=null;
        lastCcSeenMs=Date.now(); lastProgramGoodMs=0; adLockUntil=0; programVotes=0; manualOverrideUntil=0;
        noCcConsec=0; bottomConsec=0; programQuorumCount=0;
        if(NS.hudTimer){clearTimeout(NS.hudTimer);NS.hudTimer=null;}
        if(NS.hudAnimTimer){clearTimeout(NS.hudAnimTimer);NS.hudAnimTimer=null;}
        startLoop();
      }
    });
    NS.routeObserver.observe(document,{subtree:true,childList:true});
  }
  attachRouteObserver();

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

    // LLM Review toggle button
    const llmBtn=document.createElement('button');
    updateLLMButtonText(llmBtn);
    llmBtn.style.cssText=btnStyle;
    llmBtn.addEventListener('click',toggleLLMReview);
    container.appendChild(llmBtn); NS.llmReviewBtn=llmBtn;

    // Frequent Words toggle button
    const freqBtn=document.createElement('button');
    updateFreqWordsButtonText(freqBtn);
    freqBtn.style.cssText=btnStyle;
    freqBtn.addEventListener('click',toggleFrequentWords);
    container.appendChild(freqBtn); NS.freqWordsBtn=freqBtn;
  }

  function updateLLMButtonText(btn){
    if(!btn)btn=NS.llmReviewBtn;
    if(btn)btn.textContent=S.llmReviewEnabled?'LLM Review: ON':'LLM Review: OFF';
  }

  function updateFreqWordsButtonText(btn){
    if(!btn)btn=NS.freqWordsBtn;
    if(btn)btn.textContent=S.showFrequentWords?'Frequent Words: ON':'Frequent Words: OFF';
  }

  function flagIncorrectState(){
    const {captionWindow,video}=detectNodes();
    const cc=(captionWindow?.textContent||'').trim();
    const currentMuted=lastMuteState===true;

    pushEventLog('FLAG_INCORRECT_STATE',{
      reason:currentMuted?'was_muted_toggling_unmute':'was_unmuted_toggling_mute',
      ccSnippet:cc?cc.slice(0,200)+(cc.length>200?'…':''):'',
      url:location.href,
      noCcMs:Date.now()-lastCcSeenMs,
      lock:Math.max(0,adLockUntil-Date.now()),
      pv:programVotes,
      quorum:programQuorumCount
    });

    if(video){
      if(currentMuted){
        // Was muted, toggle to unmute
        adLockUntil=0;
        programQuorumCount=S.programQuorumLines;
        manualOverrideUntil=Date.now()+S.manualOverrideMs;
        setMuted(video,false,{reason:'FLAG_INCORRECT_STATE_UNMUTE',match:null,ccSnippet:cc.slice(0,140),noCcMs:Date.now()-lastCcSeenMs});
      }else{
        // Was unmuted, toggle to mute
        setMuted(video,true,{reason:'FLAG_INCORRECT_STATE_MUTE',match:null,ccSnippet:cc.slice(0,140),noCcMs:Date.now()-lastCcSeenMs});
      }
    }
  }

  function toggleLLMReview(){
    S.llmReviewEnabled=!S.llmReviewEnabled;
    saveSettings(S);
    updateLLMButtonText();
    log('LLM Review toggled:',S.llmReviewEnabled?'ON':'OFF');
  }

  function toggleFrequentWords(){
    S.showFrequentWords=!S.showFrequentWords;
    saveSettings(S);
    updateFreqWordsButtonText();
    log('Frequent Words toggled:',S.showFrequentWords?'ON':'OFF');
  }

  /* ---------- SETTINGS PANEL ---------- */
  function clampInt(v,min,max,fb){const n=Math.round(parseInt(v,10));return Number.isNaN(n)?fb:Math.min(max,Math.max(min,n));}
  function buildPanel(){
    if(NS.panelEl)return NS.panelEl;
    const panel=document.createElement('div'); NS.panelEl=panel;
    panel.style.cssText=[
      'position:fixed','right:16px','top:16px','z-index:2147483647','width:560px','max-width:95vw','max-height:85vh',
      'background:#111','color:#fff','border:1px solid #333','border-radius:10px','box-shadow:0 10px 30px rgba(0,0,0,.5)','font:13px/1.4 system-ui,sans-serif',
      'display:flex','flex-direction:column'
    ].join(';');
    const btn='background:#1f6feb;border:none;color:#fff;padding:6px 10px;border-radius:7px;cursor:pointer';
    const input='width:100%;box-sizing:border-box;background:#000;color:#fff;border:1px solid #333;border-radius:7px;padding:6px';
    const tab='background:transparent;border:none;color:#888;padding:8px 12px;cursor:pointer;border-bottom:2px solid transparent;font:13px system-ui,sans-serif';
    const activeTab='color:#fff;border-bottom-color:#1f6feb';
    panel.innerHTML=`
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #333;background:#111;">
        <div style="font-weight:600;font-size:14px;">YTTV Auto-Mute — Settings</div>
        <div style="margin-left:auto;display:flex;gap:8px;">
          <button id="yttp-save" style="${btn}">Save & Apply</button>
          <button id="yttp-close" style="${btn};background:#444">Close (Ctrl+Shift+S)</button>
        </div>
      </div>

      <div style="display:flex;border-bottom:1px solid #333;background:#0d1117;">
        <button class="yttp-tab" data-tab="general" style="${tab};${activeTab}">General</button>
        <button class="yttp-tab" data-tab="hud" style="${tab}">HUD</button>
        <button class="yttp-tab" data-tab="timing" style="${tab}">Timing</button>
        <button class="yttp-tab" data-tab="phrases" style="${tab}">Phrases</button>
        <button class="yttp-tab" data-tab="actions" style="${tab}">Actions</button>
      </div>

      <div style="overflow:auto;flex:1;">
        <!-- General Tab -->
        <div class="yttp-tab-content" data-tab="general" style="padding:12px;display:grid;gap:12px;">
          <div style="display:grid;gap:8px;">
            <div style="font-weight:600;font-size:13px;">Basic Settings</div>
            <label><input type="checkbox" id="useTrueMute"> True mute (vs low volume)</label>
            <label><input type="checkbox" id="debug"> Console debug logging</label>
            <label><input type="checkbox" id="debugVerboseCC"> Verbose CC debug</label>
          </div>

          <div style="display:grid;gap:8px;border-top:1px solid #333;padding-top:8px;">
            <div style="font-weight:600;font-size:13px;">Review Features</div>
            <label><input type="checkbox" id="llmReviewEnabled"> Enable LLM Review</label>
            <label><input type="checkbox" id="showFrequentWords"> Show Frequent Words</label>
          </div>

          <div style="display:grid;gap:8px;border-top:1px solid #333;padding-top:8px;">
            <div style="font-weight:600;font-size:13px;">Caption Display</div>
            <label><input type="checkbox" id="hideCaptions"> Hide captions from view (still processed for muting)</label>
          </div>
        </div>

        <!-- HUD Tab -->
        <div class="yttp-tab-content" data-tab="hud" style="padding:12px;display:none;gap:12px;">
          <div style="display:grid;gap:8px;">
            <div style="font-weight:600;font-size:13px;">HUD Visibility</div>
            <label><input type="checkbox" id="showHUD"> Show HUD always</label>
            <label><input type="checkbox" id="hudAutoOnMute"> Auto HUD on mute (hide on unmute)</label>
          </div>

          <div style="display:grid;gap:8px;border-top:1px solid #333;padding-top:8px;">
            <div style="font-weight:600;font-size:13px;">HUD Animation</div>
            <label>HUD auto show/hide delay (ms) <input id="hudAutoDelayMs" type="number" min="0" max="60000" step="100" style="${input}"></label>
            <label>HUD fade duration (ms) <input id="hudFadeMs" type="number" min="0" max="2000" step="10" style="${input}"></label>
            <label>HUD slide distance (px) <input id="hudSlidePx" type="number" min="0" max="50" step="1" style="${input}"></label>
          </div>
        </div>

        <!-- Timing Tab -->
        <div class="yttp-tab-content" data-tab="timing" style="padding:12px;display:none;gap:12px;">
          <div style="display:grid;gap:6px;">
            <div style="font-weight:600;font-size:13px;">Detection Timing</div>
            <label>Poll interval (ms) <input id="intervalMs" type="number" min="50" max="1000" step="10" style="${input}"></label>
            <label>Fast mute when CC missing (ms) <input id="muteOnNoCCDelayMs" type="number" min="0" max="5000" step="10" style="${input}"></label>
            <label>Consecutive no-CC hits to mute <input id="noCcHitsToMute" type="number" min="1" max="6" step="1" style="${input}"></label>
            <label>Unmute debounce (ms) <input id="unmuteDebounceMs" type="number" min="0" max="5000" step="10" style="${input}"></label>
          </div>

          <div style="display:grid;gap:6px;border-top:1px solid #333;padding-top:8px;">
            <div style="font-weight:600;font-size:13px;">Ad Lock & Program Detection</div>
            <label>Ad-lock duration (ms) <input id="minAdLockMs" type="number" min="0" max="60000" step="100" style="${input}"></label>
            <label>Program votes needed (1–4) <input id="programVotesNeeded" type="number" min="1" max="4" step="1" style="${input}"></label>
            <label>Program quorum lines (1–8) <input id="programQuorumLines" type="number" min="1" max="8" step="1" style="${input}"></label>
            <label>Manual override after flag (ms) <input id="manualOverrideMs" type="number" min="0" max="60000" step="100" style="${input}"></label>
          </div>
        </div>

        <!-- Phrases Tab -->
        <div class="yttp-tab-content" data-tab="phrases" style="padding:12px;display:none;gap:12px;">
          <div><div style="margin:6px 0 4px;font-weight:600;">Hard Ad Phrases (one per line)</div>
            <textarea id="hardPhrases" rows="7" style="${input};font-family:ui-monospace,Menlo,Consolas,monospace;"></textarea>
          </div>
          <div><div style="margin:6px 0 4px;font-weight:600;">Brand Terms (one per line)</div>
            <textarea id="brandTerms" rows="6" style="${input};font-family:ui-monospace,Menlo,Consolas,monospace;"></textarea>
          </div>
          <div><div style="margin:6px 0 4px;font-weight:600;">Ad Context Phrases (one per line)</div>
            <textarea id="adContext" rows="6" style="${input};font-family:ui-monospace,Menlo,Consolas,monospace;"></textarea>
          </div>
          <div><div style="margin:6px 0 4px;font-weight:600;">CTA Terms (one per line)</div>
            <textarea id="ctaTerms" rows="5" style="${input};font-family:ui-monospace,Menlo,Consolas,monospace;"></textarea>
          </div>
          <div><div style="margin:6px 0 4px;font-weight:600;">Offer Terms (one per line)</div>
            <textarea id="offerTerms" rows="5" style="${input};font-family:ui-monospace,Menlo,Consolas,monospace;"></textarea>
          </div>
          <div><div style="margin:6px 0 4px;font-weight:600;">Allow Phrases (program cues, one per line)</div>
            <textarea id="allowPhrases" rows="6" style="${input};font-family:ui-monospace,Menlo,Consolas,monospace;"></textarea>
          </div>
          <div><div style="margin:6px 0 4px;font-weight:600;">Break Phrases (one per line)</div>
            <textarea id="breakPhrases" rows="5" style="${input};font-family:ui-monospace,Menlo,Consolas,monospace;"></textarea>
          </div>
        </div>

        <!-- Actions Tab -->
        <div class="yttp-tab-content" data-tab="actions" style="padding:12px;display:none;gap:12px;">
          <div style="display:grid;gap:8px;">
            <div style="font-weight:600;font-size:13px;">Caption Logging</div>
            <label>Auto-download captions every N minutes (0=off) <input id="autoDownloadEveryMin" type="number" min="0" max="360" step="1" style="${input}"></label>
            <label>Caption log limit (lines) <input id="captionLogLimit" type="number" min="200" max="50000" step="100" style="${input}"></label>
          </div>

          <div style="display:grid;gap:8px;border-top:1px solid #333;padding-top:8px;">
            <div style="font-weight:600;font-size:13px;">Quick Actions</div>
            <button id="dl" style="${btn}">Download Captions (Ctrl+D)</button>
            <button id="clearlog" style="${btn};background:#8b0000">Clear Caption Log</button>
          </div>

          <div style="display:grid;gap:8px;border-top:1px solid #333;padding-top:8px;">
            <div style="font-weight:600;font-size:13px;">Settings Management</div>
            <button id="export" style="${btn}">Export Settings to File</button>
            <label style="${btn};display:inline-block;position:relative;overflow:hidden;">
              Import Settings from File<input id="import" type="file" accept="application/json" style="opacity:0;position:absolute;left:0;top:0;width:100%;height:100%;cursor:pointer;">
            </label>
            <button id="reset" style="${btn};background:#444">Reset All to Defaults</button>
          </div>

          <div style="border-top:1px solid #333;padding-top:8px;">
            <div style="font-weight:600;font-size:13px;margin-bottom:8px;">Keyboard Shortcuts</div>
            <div style="font-size:12px;color:#bbb;line-height:1.6;">
              • <b>Ctrl+M</b> - Toggle mute/unmute<br>
              • <b>Ctrl+D</b> - Download captions log<br>
              • <b>Ctrl+Shift+S</b> - Open/close settings<br>
              • <b>Ctrl+F</b> - Flag incorrect state
            </div>
          </div>
        </div>
      </div>`;
    document.documentElement.appendChild(panel);

    // Tab switching logic
    const tabs=panel.querySelectorAll('.yttp-tab');
    const tabContents=panel.querySelectorAll('.yttp-tab-content');
    tabs.forEach(tab=>{
      tab.addEventListener('click',()=>{
        const targetTab=tab.getAttribute('data-tab');
        tabs.forEach(t=>t.style.cssText=t.getAttribute('data-tab')===targetTab?`${tab};${activeTab}`:`${tab}`);
        tabContents.forEach(tc=>{tc.style.display=tc.getAttribute('data-tab')===targetTab?'grid':'none';});
      });
    });

    // populate
    panel.querySelector('#useTrueMute').checked=S.useTrueMute;
    panel.querySelector('#debug').checked=S.debug;
    panel.querySelector('#debugVerboseCC').checked=S.debugVerboseCC;
    panel.querySelector('#llmReviewEnabled').checked=S.llmReviewEnabled;
    panel.querySelector('#showFrequentWords').checked=S.showFrequentWords;
    panel.querySelector('#hideCaptions').checked=S.hideCaptions;
    panel.querySelector('#showHUD').checked=S.showHUD;
    panel.querySelector('#hudAutoOnMute').checked=S.hudAutoOnMute;
    panel.querySelector('#hudAutoDelayMs').value=S.hudAutoDelayMs;
    panel.querySelector('#hudFadeMs').value=S.hudFadeMs;
    panel.querySelector('#hudSlidePx').value=S.hudSlidePx;
    panel.querySelector('#intervalMs').value=S.intervalMs;
    panel.querySelector('#muteOnNoCCDelayMs').value=S.muteOnNoCCDelayMs;
    panel.querySelector('#noCcHitsToMute').value=S.noCcHitsToMute;
    panel.querySelector('#unmuteDebounceMs').value=S.unmuteDebounceMs;
    panel.querySelector('#minAdLockMs').value=S.minAdLockMs;
    panel.querySelector('#programVotesNeeded').value=S.programVotesNeeded;
    panel.querySelector('#programQuorumLines').value=S.programQuorumLines;
    panel.querySelector('#manualOverrideMs').value=S.manualOverrideMs;
    panel.querySelector('#autoDownloadEveryMin').value=S.autoDownloadEveryMin;
    panel.querySelector('#captionLogLimit').value=S.captionLogLimit;
    panel.querySelector('#hardPhrases').value=S.hardPhrases;
    panel.querySelector('#brandTerms').value=S.brandTerms;
    panel.querySelector('#adContext').value=S.adContext;
    panel.querySelector('#ctaTerms').value=(Array.isArray(S.ctaTerms)?S.ctaTerms.join('\n'):S.ctaTerms||'');
    panel.querySelector('#offerTerms').value=(Array.isArray(S.offerTerms)?S.offerTerms.join('\n'):S.offerTerms||'');
    panel.querySelector('#allowPhrases').value=Array.isArray(S.allowPhrases)?S.allowPhrases.join('\n'):S.allowPhrases;
    panel.querySelector('#breakPhrases').value=Array.isArray(S.breakPhrases)?S.breakPhrases.join('\n'):S.breakPhrases;

    // actions
    const close=()=>togglePanel();
    panel.querySelector('#yttp-close').onclick=close;
    panel.querySelector('#dl').onclick=downloadCaptionsNow;
    panel.querySelector('#clearlog').onclick=()=>{window._captions_log=[];kvSet(CAPLOG_KEY,window._captions_log);alert('Caption log cleared.');};
    panel.querySelector('#export').onclick=()=>{const data=JSON.stringify(S,null,2);
      const url='data:application/json;charset=utf-8,'+encodeURIComponent(data);
      const a=document.createElement('a');a.href=url;a.download='yttp_settings.json';a.click();};
    panel.querySelector('#import').onchange=(e)=>{const f=e.target.files?.[0];if(!f)return;const r=new FileReader();
      r.onload=()=>{try{const parsed=JSON.parse(r.result);S={...DEFAULTS,...parsed};saveSettings(S);applySettings(true);alert('Settings imported and applied.');
        NS.panelEl.remove();NS.panelEl=null;buildPanel();}catch{alert('Invalid settings file.');}};
      r.readAsText(f);};
    panel.querySelector('#reset').onclick=()=>{if(!confirm('Reset settings to defaults?'))return;S={...DEFAULTS};saveSettings(S);applySettings(true);NS.panelEl.remove();NS.panelEl=null;buildPanel();};
    panel.querySelector('#yttp-save').onclick=()=>{
      S.useTrueMute=panel.querySelector('#useTrueMute').checked;
      S.debug=panel.querySelector('#debug').checked;
      S.debugVerboseCC=panel.querySelector('#debugVerboseCC').checked;
      S.llmReviewEnabled=panel.querySelector('#llmReviewEnabled').checked;
      S.showFrequentWords=panel.querySelector('#showFrequentWords').checked;
      S.hideCaptions=panel.querySelector('#hideCaptions').checked;
      S.showHUD=panel.querySelector('#showHUD').checked;
      S.hudAutoOnMute=panel.querySelector('#hudAutoOnMute').checked;
      S.hudAutoDelayMs=clampInt(panel.querySelector('#hudAutoDelayMs').value,0,60000,DEFAULTS.hudAutoDelayMs);
      S.hudFadeMs=clampInt(panel.querySelector('#hudFadeMs').value,0,2000,DEFAULTS.hudFadeMs);
      S.hudSlidePx=clampInt(panel.querySelector('#hudSlidePx').value,0,50,DEFAULTS.hudSlidePx);
      S.intervalMs=clampInt(panel.querySelector('#intervalMs').value,50,2000,DEFAULTS.intervalMs);
      S.muteOnNoCCDelayMs=clampInt(panel.querySelector('#muteOnNoCCDelayMs').value,0,5000,DEFAULTS.muteOnNoCCDelayMs);
      S.noCcHitsToMute=clampInt(panel.querySelector('#noCcHitsToMute').value,1,6,DEFAULTS.noCcHitsToMute);
      S.unmuteDebounceMs=clampInt(panel.querySelector('#unmuteDebounceMs').value,0,5000,DEFAULTS.unmuteDebounceMs);
      S.minAdLockMs=clampInt(panel.querySelector('#minAdLockMs').value,0,60000,DEFAULTS.minAdLockMs);
      S.programVotesNeeded=clampInt(panel.querySelector('#programVotesNeeded').value,1,4,DEFAULTS.programVotesNeeded);
      S.programQuorumLines=clampInt(panel.querySelector('#programQuorumLines').value,1,8,DEFAULTS.programQuorumLines);
      S.manualOverrideMs=clampInt(panel.querySelector('#manualOverrideMs').value,0,60000,DEFAULTS.manualOverrideMs);
      S.autoDownloadEveryMin=clampInt(panel.querySelector('#autoDownloadEveryMin').value,0,360,DEFAULTS.autoDownloadEveryMin);
      S.captionLogLimit=clampInt(panel.querySelector('#captionLogLimit').value,200,50000,DEFAULTS.captionLogLimit);

      S.hardPhrases=panel.querySelector('#hardPhrases').value;
      S.brandTerms=panel.querySelector('#brandTerms').value;
      S.adContext=panel.querySelector('#adContext').value;
      S.ctaTerms=panel.querySelector('#ctaTerms').value.split('\n').map(s=>s.trim()).filter(Boolean);
      S.offerTerms=panel.querySelector('#offerTerms').value.split('\n').map(s=>s.trim()).filter(Boolean);
      S.allowPhrases=panel.querySelector('#allowPhrases').value.split('\n').map(s=>s.trim()).filter(Boolean);
      S.breakPhrases=panel.querySelector('#breakPhrases').value.split('\n').map(s=>s.trim()).filter(Boolean);

      HARD_AD_PHRASES=toLines(S.hardPhrases);
      BRAND_TERMS=toLines(S.brandTerms);
      AD_CONTEXT=toLines(S.adContext);
      CTA_TERMS=Array.isArray(S.ctaTerms)?S.ctaTerms.map(s=>s.toLowerCase()):toLines(S.ctaTerms?.join?.('\n')||'');
      OFFER_TERMS=Array.isArray(S.offerTerms)?S.offerTerms.map(s=>s.toLowerCase()):toLines(S.offerTerms?.join?.('\n')||'');
      ALLOW_PHRASES=toLines(Array.isArray(S.allowPhrases)?S.allowPhrases.join('\n'):S.allowPhrases);
      BREAK_PHRASES=toLines(Array.isArray(S.breakPhrases)?S.breakPhrases.join('\n'):S.breakPhrases);

      updateLLMButtonText();
      updateFreqWordsButtonText();
      saveSettings(S); applySettings(true); alert('Settings saved and applied.');
    };
    return panel;
  }
  function togglePanel(){ if(!NS.panelEl)buildPanel(); NS.panelEl.style.display=(NS.panelEl.style.display==='none'?'block':'none'); }
  function applySettings(restart=false){ if(NS.hudEl)NS.hudEl.style.transition=`opacity ${S.hudFadeMs|0}ms ease, transform ${S.hudFadeMs|0}ms ease`; if(restart)startLoop(); }

  /* ---------- HOTKEYS ---------- */
  window.addEventListener('keydown',(e)=>{
    if(e.ctrlKey && (e.key==='m'||e.key==='M')){enabled=!enabled;log(`Toggled → ${enabled?'ENABLED':'PAUSED'}`);e.preventDefault();}
    if(e.ctrlKey && (e.key==='d'||e.key==='D')){downloadCaptionsNow();e.preventDefault();}
    if(e.ctrlKey && e.shiftKey && (e.key==='s'||e.key==='S')){togglePanel();e.preventDefault();}
    if(e.ctrlKey && (e.key==='f'||e.key==='F')){flagIncorrectState();e.preventDefault();}
  },true);

  /* ---------- BOOT ---------- */
  applySettings(false);
  startLoop();
  log('Booted v3.2',{hardCount:HARD_AD_PHRASES.length,brandCount:BRAND_TERMS.length,ctxCount:AD_CONTEXT.length,allowCount:ALLOW_PHRASES.length,breakCount:BREAK_PHRASES.length,llmReview:S.llmReviewEnabled,freqWords:S.showFrequentWords,hideCaptions:S.hideCaptions});
})();
