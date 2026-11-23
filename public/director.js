/**
 * Pure Frame-Deterministic Broadcast Stage Controller (`director.js`).
 *
 * Every visual element on screen is computed strictly as `f(frameIdx, fps)`
 * from `manifest.timelineV2` using `motion-math.js` (`interpolate`, `spring`, `dampedShake`).
 * Zero `setTimeout` animations, zero wall-clock drift!
 */

import {
  clamp,
  beatPulse,
  springTrack,
  interpolate,
  easeOutExpo,
  easeInCubic,
  md3Snappy,
  spring,
  SPRING_PRESETS,
  dampedShake,
} from './motion-math.js';

const $ = sel => document.querySelector(sel);

const COLORS = {
  white: [255, 255, 255],
  a: [182, 156, 255],     // Electric Violet highlight (high contrast on dark card)
  b: [213, 251, 70],      // Electric Lime highlight
  judge: [250, 204, 21],  // Ringside Gold highlight
  hook: [250, 204, 21],
};

function lerpRgb(rgbA, rgbB, t) {
  const u = clamp(t, 0, 1);
  const r = Math.round(rgbA[0] + (rgbB[0] - rgbA[0]) * u);
  const g = Math.round(rgbA[1] + (rgbB[1] - rgbA[1]) * u);
  const b = Math.round(rgbA[2] + (rgbB[2] - rgbA[2]) * u);
  return `rgb(${r}, ${g}, ${b})`;
}

const CAMERA_PRESETS = {
  'hook-punch':        { scale: 1.07, x: 0,   y: -10, rot: -0.4 },
  'hook-tight':        { scale: 1.12, x: -12, y: -18, rot: 0.45 },
  'vs-clash':          { scale: 1.0,  x: 0,   y: 0,   rot: 0 },
  'vs-topic-zoom':     { scale: 1.04, x: 0,   y: -14, rot: 0 },
  'wide-establish':    { scale: 1.0,  x: 0,   y: 0,   rot: 0 },
  'hero-medium':       { scale: 1.0,  x: 0,   y: 0,   rot: 0 },
  'hero-close':        { scale: 1.085,x: -8,  y: -22, rot: 0 },
  'rivalry-angle':     { scale: 1.045,x: 16,  y: -10, rot: -0.35 },
  'hero-low-push':     { scale: 1.07, x: -10, y: 14,  rot: 0.3 },
  'hero-push-tight':   { scale: 1.10, x: 6,   y: -24, rot: 0 },
  'diagonal-counter':  { scale: 1.055,x: -16, y: -8,  rot: 0.4 },
  'hero-medium-wide':  { scale: 0.985,x: 0,   y: 6,   rot: 0 },
  'low-angle-power':   { scale: 1.09, x: 10,  y: -16, rot: -0.3 },
  'punch-push':        { scale: 1.115,x: 0,   y: -26, rot: 0 },
  'punch-shake':       { scale: 1.13, x: 0,   y: -28, rot: 0 },
  'whip-pan':          { scale: 1.03, x: 0,   y: 0,   rot: 0 },
  'dual-standoff':     { scale: 1.0,  x: 0,   y: 0,   rot: 0 },
  'winner-slam':       { scale: 1.03, x: 0,   y: -8,  rot: 0 },
  'winner-glory-push': { scale: 1.09, x: 0,   y: -22, rot: 0 },
  'loop-whip-to-hook': { scale: 1.07, x: 0,   y: -10, rot: -0.4 },
};

let state = {
  manifest: null,
  tl: null,
  aspect: '9:16',
  fps: 30,
  lastCaptionPageIdx: -2,
  cameraTracks: null,
  speakerSteps: [],
  calm: false,
  reducedMotion: false,
};

function parseQueryAspect() {
  const s = String(window.location?.search || '');
  return /(?:^|[?&])aspect=16(?:%3A|:)9(?:&|$)/i.test(s) ? '16:9' : '9:16';
}

function setAspectClass(aspect) {
  state.aspect = aspect === '16:9' ? '16:9' : '9:16';
  document.body.classList.toggle('aspect-9-16', state.aspect === '9:16');
  document.body.classList.toggle('aspect-16-9', state.aspect === '16:9');
}

setAspectClass(parseQueryAspect());

window.__initDirectorStage = function (manifest, aspect = null, overrides = {}) {
  if (aspect) setAspectClass(aspect);
  state.manifest = manifest;
  state.tl = state.aspect === '9:16' ? (manifest.shortsTimelineV2 || manifest.timelineV2) : manifest.timelineV2;
  if (!state.tl) throw new Error(`Missing timeline for ${state.aspect}`);
  state.tl = { ...state.tl, events: [...(state.tl.events || [])].sort((a, b) => a.startMs - b.startMs) };
  state.calm = ['poetry', 'story'].includes(manifest.battle?.config?.mode);
  state.reducedMotion = overrides.reducedMotion ?? Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  state.cameraTracks = Object.fromEntries(['scale', 'x', 'y', 'rot'].map(key => [key, state.tl.events.filter(e => e.camera).map(e => ({ startMs: e.startMs, value: (CAMERA_PRESETS[e.camera] || CAMERA_PRESETS['hero-medium'])[key] }))]));
  const firstPerformer = state.tl.lines?.find(l => l.segmentType === 'verse' && ['a', 'b'].includes(l.side));
  state.speakerInitial = firstPerformer?.side === 'b' ? 0 : 1;
  state.speakerSteps = state.tl.events.filter(e => e.type === 'speaker-switch').map(e => ({ startMs: e.startMs, value: e.payload?.toSide === 'b' ? 0 : 1 }));
  // Two fixed compositions dissolve during a handoff, avoiding position/size
  // snapping and preserving readable nameplate typography throughout the move.
  for (const side of ['a', 'b']) {
    document.getElementById(`inset-${side}`)?.remove();
    const performer = $(`#performer-${side}`);
    performer.className = `performer performer-${side} is-hero`;
    performer.removeAttribute('style');
    const inset = performer.cloneNode(true);
    inset.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    inset.id = `inset-${side}`;
    inset.className = `performer performer-${side} is-mini performer-inset`;
    performer.parentElement.appendChild(inset);
  }
  state.fps = state.tl?.fps || 30;
  state.lastCaptionPageIdx = -2;

  const b = manifest.battle;
  const fA = b.fighters?.[0]?.stageName || b.fighters?.[0]?.name || 'CORNER A';
  const fB = b.fighters?.[1]?.stageName || b.fighters?.[1]?.name || 'CORNER B';
  const modeName = (b.config?.mode || 'rap').toUpperCase();
  const topicText = b.config?.topic || '';
  const shortTopic = manifest.roles?.label || topicText;

  const fontScale = Number(overrides.captionFontScale || state.tl?.captionFontScale || 1);
  document.documentElement.style.setProperty('--caption-scale', String(fontScale));

  // Populate static labels once
  $('#hud-name-a').textContent = fA;
  $('#hud-name-b').textContent = fB;
  $('#hud-mode').textContent = modeName;
  $('#hud-topic-strip').textContent = topicText;

  $('#hook-topic').textContent = shortTopic;

  $('#vs-name-a').textContent = fA;
  $('#vs-name-b').textContent = fB;
  $('#vs-role-a').textContent = manifest.roles?.a || 'THE CHALLENGER';
  $('#vs-role-b').textContent = manifest.roles?.b || 'THE CONTENDER';
  $('#vs-mode-tag').textContent = `AI ${modeName} BATTLE`;
  $('#vs-topic-text').textContent = topicText;

  $('#plate-name-a').textContent = fA;
  $('#plate-name-b').textContent = fB;

  $('#vote-name-a').textContent = fA;
  $('#vote-name-b').textContent = fB;
  $('#inset-a .performer-name').textContent = fA;
  $('#inset-b .performer-name').textContent = fB;
  const modeCopy = { rap: ['DROP THE BEAT', 'WAIT FOR THIS BAR…'], roast: ['NO HOLDING BACK', 'THIS GOT PERSONAL…'], debate: ['MAKE YOUR CASE', 'PICK A SIDE…'], poetry: ['LET IT LAND', 'LISTEN CLOSELY…'], story: ['THE NEXT CHAPTER', 'LISTEN TO THIS…'] }[b.config?.mode] || ['DROP THE BEAT', 'WAIT FOR THIS BAR…'];
  $('#round-slam-eyebrow').textContent = modeCopy[0];
  $('#hook-kicker').textContent = modeCopy[1];

  return true;
};

function showOnlyScene(sceneId) {
  const ids = ['scene-hook', 'scene-vs', 'scene-round', 'scene-battle', 'scene-vote', 'scene-verdict'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.hidden = id !== sceneId;
  }
}

function resolveScoreStateAt(events, tMs) {
  let scoreA = 0;
  let scoreB = 0;
  for (const ev of events) {
    if (ev.startMs > tMs) break;
    if (ev.type === 'score-change' && ev.payload) {
      scoreA = ev.payload.scoreA ?? scoreA;
      scoreB = ev.payload.scoreB ?? scoreB;
    } else if (ev.type === 'score-suspense' && ev.payload) {
      scoreA = ev.payload.scoreA ?? scoreA;
      scoreB = ev.payload.scoreB ?? '?';
    }
  }
  return { scoreA, scoreB };
}

function resolveCameraTransform(tl, frameIdx, tMs) {
  const fps = state.renderFps || tl.fps || 30;
  const currentCamEv = tl.events.filter(e => e.camera && e.startMs <= tMs).at(-1) || { camera: 'hero-medium' };
  const neutral = CAMERA_PRESETS['hero-medium'];
  const pose = Object.fromEntries(Object.entries(state.cameraTracks).map(([key, steps]) => [key, springTrack(tMs, steps, neutral[key])]));
  const strength = state.reducedMotion ? 0 : state.calm ? 0.12 : 0.3;
  // Keep composited text and inset plates inside broadcast safe areas. Most
  // perceived movement comes from the artwork, rather than rocking all text.
  let scale = 1 + clamp(pose.scale - 1, -0.015, 0.085) * strength;
  let x = clamp(pose.x, -10, 10) * strength;
  let y = clamp(pose.y, -20, 20) * strength;
  let rot = clamp(pose.rot, -0.25, 0.25) * strength;

  if (!state.calm && !state.reducedMotion) {
    for (const ev of tl.events) {
      if (ev.type !== 'punchline') continue;
      const sh = dampedShake({
        frame: frameIdx, fps, onsetFrame: ev.startMs * fps / 1000,
        durationMs: ev.payload?.shakeDurationMs || 165,
        ampPx: ev.payload?.tier === 'knockout' ? 5 : 2.5,
        rotAmpDeg: 0.12, scalePunch: 0.003,
      });
      x += sh.x; y += sh.y; rot += sh.rotDeg; scale += sh.scaleBoost;
    }
  }

  return { scale, x, y, rot, cameraName: currentCamEv.camera };
}

function renderSingleCaptionAt(tl, frameIdx, fps, tMs, hideCaptions = false) {
  const stage = $('#caption-stage');
  const pageEl = $('#caption-page');
  const speakerEl = $('#caption-speaker-pill');
  if (!stage || !pageEl || hideCaptions) {
    if (stage) stage.hidden = true;
    return null;
  }

  const timelineFrame = tMs * (tl.fps || fps) / 1000;
  const page = (tl.captionPages || []).find(p =>
    typeof p.startFrame === 'number'
      ? timelineFrame >= p.startFrame && timelineFrame < p.endFrame
      : tMs >= p.startMs && tMs < p.endMs,
  );
  if (!page || !page.words?.length) {
    stage.hidden = true;
    state.lastCaptionPageIdx = -1;
    return null;
  }

  stage.hidden = false;
  const roleKey = page.lineId?.startsWith('hook') ? 'hook' : (page.role || 'a');
  stage.dataset.role = roleKey;

  if (speakerEl) {
    speakerEl.textContent =
      roleKey === 'hook'
        ? 'COLD OPEN'
        : roleKey === 'judge'
          ? 'RINGSIDE JUDGE'
          : page.speaker || (roleKey === 'b' ? 'CORNER B' : 'CORNER A');
  }

  // Rebuild DOM word spans ONLY when page index changes
  if (state.lastCaptionPageIdx !== page.index) {
    pageEl.innerHTML = page.words
      .map((w, i) => `<span class="cap-word" data-widx="${i}">${escapeHtml(w.text)}</span>`)
      .join(' ');
    state.lastCaptionPageIdx = page.index;
  }

  // Apply pure speaker-color swap per word (100ms = 80-120ms md3Snappy color ease — ZERO size/weight/width change!)
  const activeColor = COLORS[roleKey] || COLORS.a;
  const spans = pageEl.querySelectorAll('.cap-word');
  let activeWordObj = null;

  page.words.forEach((w, idx) => {
    const sp = spans[idx];
    if (!sp) return;
    const isHl = typeof w.highlightFrame === 'number'
      ? timelineFrame >= w.highlightFrame && timelineFrame < (w.highlightEndFrame ?? w.highlightFrame + 3)
      : tMs >= w.highlightStartMs && tMs < w.highlightEndMs;
    const isPast = typeof w.highlightEndFrame === 'number'
      ? timelineFrame >= w.highlightEndFrame
      : tMs >= w.highlightEndMs;

    if (isHl) {
      const elapsedMs = Math.max(0, tMs - (typeof w.highlightFrame === 'number' ? w.highlightFrame * 1000 / (tl.fps || fps) : w.highlightStartMs));
      // 100ms ease (within 80–120ms spec): frame 0 of highlight starts clearly lit (0.58) -> 1.0 by 100ms
      const ramp = 0.58 + 0.42 * md3Snappy(clamp(elapsedMs / 100, 0, 1));
      sp.style.color = lerpRgb(COLORS.white, activeColor, ramp);
      sp.dataset.active = '1';
      activeWordObj = w;
    } else if (isPast) {
      // Already spoken word on the current 2-4 word page stays crisp soft-lit white
      sp.style.color = 'rgba(255, 255, 255, 0.84)';
      sp.dataset.active = '0';
    } else {
      sp.style.color = '#ffffff';
      sp.dataset.active = '0';
    }
  });

  return { pageIndex: page.index, activeWord: activeWordObj };
}

/**
 * Pure deterministic frame renderer (`frameIdx = 0 .. totalFrames - 1`).
 */
window.__renderAtFrame = function (frameIdx, fpsOverride = null, options = {}) {
  const tl = state.tl;
  if (!tl) return null;
  const fps = fpsOverride || state.fps || 30;
  const tMs = (frameIdx / fps) * 1000;
  state.renderFps = fps;
  const gentle = state.calm || state.reducedMotion;
  const entranceSpring = gentle ? SPRING_PRESETS.camera : { stiffness: 220, damping: 28, mass: 1 };
  const roundAtTime = tl.events.filter(e => e.type === 'round-start' && e.startMs <= tMs).at(-1);
  $('#hud-round').textContent = `R${roundAtTime?.round || 1}`;
  $('#watermark-bg').textContent = roundAtTime ? `ROUND 0${roundAtTime.round || 1}` : 'BOTBRAWL';

  // 1. Beat pulse & 3-Tier Depth Parallax (Ambient 0.2x, Secondary 0.5x, Hero 1.0x)
  const beatMs = tl.beatGrid?.beatMs || 666.67;
  const beatKick = state.reducedMotion ? 0 : beatPulse(tMs, beatMs, tl.beatGrid?.offsetMs || 0);

  const cam = resolveCameraTransform(tl, frameIdx, tMs);
  const rig = $('#camera-rig');
  if (rig) {
    rig.style.transform = `translate3d(${cam.x.toFixed(2)}px, ${cam.y.toFixed(2)}px, 0) scale(${cam.scale.toFixed(4)}) rotate(${cam.rot.toFixed(3)}deg)`;
  }

  // Ambient layer 0.2x counter-parallax + beat breathing
  const amb = $('#ambient-layer');
  if (amb) {
    const ax = (-cam.x * 0.22).toFixed(2);
    const ay = (-cam.y * 0.22).toFixed(2);
    const aScale = (1.02 + beatKick * (gentle ? 0.003 : 0.008)).toFixed(4);
    amb.style.transform = `translate3d(${ax}px, ${ay}px, 0) scale(${aScale})`;
  }

  // 2. Determine Active Primary Scene from `tl.events`
  const hookEv = tl.events.find(e => e.type === 'hook' && tMs >= e.startMs && tMs < e.endMs);
  const vsEv = tl.events.find(e => e.type === 'vs-slam' && tMs >= e.startMs && tMs < e.endMs);
  const roundEv = tl.events.find(e => e.type === 'round-start' && tMs >= e.startMs && tMs < e.endMs);
  const voteEv = tl.events.find(e => e.type === 'vote-cta' && tMs >= e.startMs && tMs < e.endMs);
  const verdictEv = tl.events.find(e => e.type === 'verdict' && tMs >= e.startMs && tMs < e.endMs);
  const loopEv = tl.events.find(e => e.type === 'loop-bridge' && tMs >= e.startMs && tMs <= e.endMs + 20);

  // Live Scoreboard Update
  const scores = resolveScoreStateAt(tl.events, tMs);
  $('#hud-score-a').textContent = String(scores.scoreA);
  $('#hud-score-b').textContent = String(scores.scoreB);

  const numA = Number(scores.scoreA) || 0;
  const numB = typeof scores.scoreB === 'number' ? scores.scoreB : numA;
  const sumScores = numA + numB;
  const pctA = sumScores > 0 ? clamp(Math.round((numA / sumScores) * 100), 18, 82) : 50;
  $('#hud-mom-a').style.width = `${pctA}%`;
  $('#hud-mom-b').style.width = `${100 - pctA}%`;

  // Pop animation on scoreboard numbers during `score-change`
  const activeScoreChange = tl.events.find(e => e.type === 'score-change' && tMs >= e.startMs && tMs <= e.endMs);
  if (activeScoreChange) {
    const sf = state.reducedMotion ? 1 : spring({
      frame: frameIdx,
      fps,
      delayFrames: (activeScoreChange.startMs / 1000) * fps,
      ...SPRING_PRESETS.scorePop,
    });
    const popScale = (1 + Math.sin(clamp(sf, 0, 1) * Math.PI) * 0.12).toFixed(3);
    $('#hud-score-a').style.transform = `scale(${popScale})`;
    $('#hud-score-b').style.transform = `scale(${popScale})`;
  } else {
    $('#hud-score-a').style.transform = 'scale(1)';
    $('#hud-score-b').style.transform = 'scale(1)';
  }

  const hud = $('#hud-scoreboard');
  let activeSceneName = 'battle';
  let hideCaptions = false;

  if (hookEv || loopEv) {
    activeSceneName = 'hook';
    showOnlyScene('scene-hook');
    if (hud) hud.hidden = true;
    $('#watermark-bg').textContent = 'BOTBRAWL';

    if (loopEv) {
      // Seamless Frame-0 Loop Bridge: whip-zooms directly back into Frame 0's exact Hook visual state!
      hideCaptions = true;
      const p = easeInCubic(clamp((tMs - loopEv.startMs) / Math.max(1, loopEv.endMs - loopEv.startMs), 0, 1));
      $('#hook-kicker').style.opacity = String(p.toFixed(3));
      $('#hook-topic').style.opacity = String(p.toFixed(3));
    } else {
      $('#hook-kicker').style.opacity = '1';
      $('#hook-topic').style.opacity = '1';
    }
  } else if (vsEv) {
    activeSceneName = 'vs-slam';
    showOnlyScene('scene-vs');
    if (hud) hud.hidden = true;
    hideCaptions = true;

    const vsStartFrame = (vsEv.startMs / 1000) * fps;
    const slam = state.reducedMotion ? 1 : spring({ frame: frameIdx, fps, delayFrames: vsStartFrame, ...entranceSpring });
    const topicReveal = state.reducedMotion ? 1 : spring({ frame: frameIdx, fps, delayFrames: vsStartFrame + fps * 0.16, ...entranceSpring });

    const offsetA = interpolate(slam, [0, 1], [gentle ? -12 : -24, 0], { clampOut: false });
    const offsetB = interpolate(slam, [0, 1], [gentle ? 12 : 24, 0], { clampOut: false });
    $('#vs-panel-a').style.transform = `translate3d(${offsetA.toFixed(1)}px, 0, 0)`;
    $('#vs-panel-b').style.transform = `translate3d(${offsetB.toFixed(1)}px, 0, 0)`;
    $('#vs-panel-a').style.opacity = String(clamp(slam * 1.8, 0, 1));
    $('#vs-panel-b').style.opacity = String(clamp(slam * 1.8, 0, 1));
    $('#vs-emblem').style.transform = `translate(-50%, -50%) scale(${clamp(slam * 1.06, 0.01, 1.12).toFixed(3)})`;
    $('#vs-topic-card').style.opacity = String(clamp(topicReveal, 0, 1).toFixed(3));
    $('#vs-topic-card').style.transform = `translate3d(0, ${((1 - clamp(topicReveal, 0, 1)) * 42).toFixed(1)}px, 0)`;
  } else if (roundEv) {
    activeSceneName = 'round-start';
    showOnlyScene('scene-round');
    if (hud) hud.hidden = false;
    hideCaptions = true;
    const rTitle = roundEv.payload?.label || `ROUND 0${roundEv.round || 1}`;
    $('#round-slam-title').textContent = rTitle;
    $('#hud-round').textContent = `R${roundEv.round || 1}`;
    $('#watermark-bg').textContent = rTitle;

    const rs = state.reducedMotion ? 1 : spring({
      frame: frameIdx,
      fps,
      delayFrames: (roundEv.startMs / 1000) * fps,
      ...entranceSpring,
    });
    $('#round-slam-box').style.transform = `scale(${(0.96 + rs * 0.04).toFixed(3)})`;
  } else if (voteEv) {
    activeSceneName = 'vote-cta';
    showOnlyScene('scene-vote');
    if (hud) hud.hidden = false;
    hideCaptions = true; // Vote card carries its own giant headline — zero overlapping duplicate text!
    const vs = state.reducedMotion ? 1 : spring({
      frame: frameIdx,
      fps,
      delayFrames: (voteEv.startMs / 1000) * fps,
      ...entranceSpring,
    });
    $('#vote-card-box').style.transform = `translate3d(0, ${((1 - clamp(vs, 0, 1)) * 48).toFixed(1)}px, 0) scale(${(0.9 + clamp(vs, 0, 1.05) * 0.1).toFixed(3)})`;
  } else if (verdictEv) {
    activeSceneName = 'verdict';
    showOnlyScene('scene-verdict');
    if (hud) hud.hidden = false;
    hideCaptions = true; // Verdict card carries the giant winner stamp cleanly!

    const wSide = verdictEv.payload?.winnerSide || 'b';
    $('#verdict-winner-name').textContent = verdictEv.payload?.winnerName || 'WINNER';
    $('#verdict-score-a').textContent = String(verdictEv.payload?.totals?.a ?? scores.scoreA);
    $('#verdict-score-b').textContent = String(verdictEv.payload?.totals?.b ?? scores.scoreB);
    $('#verdict-art').src = wSide === 'a' ? 'assets/robot-violet.png' : 'assets/robot-lime.png';
    $('#verdict-kicker').className = `badge-kicker ${wSide === 'a' ? 'badge-violet' : 'badge-lime'}`;
    $('#verdict-card-box').style.borderColor = wSide === 'a' ? 'var(--violet)' : 'var(--lime)';

    const ws = state.reducedMotion ? 1 : spring({
      frame: frameIdx,
      fps,
      delayFrames: (verdictEv.startMs / 1000) * fps,
      ...entranceSpring,
    });
    $('#verdict-card-box').style.transform = `scale(${(0.96 + ws * 0.04).toFixed(3)})`;
  } else {
    // MAIN PERFORMANCE SCENE
    activeSceneName = 'battle';
    showOnlyScene('scene-battle');
    if (hud) hud.hidden = false;

    // Identify active line (or nearest upcoming/recent line during >=250ms breath gap)
    const activeLine =
      tl.lines.find(l => l.segmentType !== 'hook' && tMs >= l.startMs - 140 && tMs <= l.endMs + 220) ||
      tl.lines.filter(l => l.segmentType !== 'hook' && l.startMs <= tMs).at(-1) ||
      tl.lines.find(l => l.segmentType === 'verse');

    const judgeSpeaking = activeLine?.role === 'judge' || activeLine?.segmentType === 'judge';
    const emphasisA = clamp(springTrack(tMs, state.speakerSteps, state.speakerInitial, { stiffness: 190, damping: 28, mass: 1 }), 0, 1);
    const activeSide = emphasisA >= 0.5 ? 'a' : 'b';
    const roundNum = activeLine?.round || 1;
    $('#hud-round').textContent = activeLine?.suddenDeath ? 'OT' : `R${roundNum}`;
    $('#watermark-bg').textContent = `ROUND 0${roundNum}`;

    // Intensify active speaker's ambient spotlight cone
    $('#spotlight-a').style.opacity = activeSide === 'a' ? '1' : '0.42';
    $('#spotlight-b').style.opacity = activeSide === 'b' ? '1' : '0.42';

    const activePunch = gentle ? null : tl.events.find(e => e.type === 'punchline' && tMs >= e.startMs && tMs <= e.endMs + 180);
    for (const side of ['a', 'b']) {
      const performer = $(`#performer-${side}`);
      const inset = $(`#inset-${side}`);
      const emphasis = side === 'a' ? emphasisA : 1 - emphasisA;
      const bob = gentle ? 0 : -beatKick * 3.5 * emphasis;
      const scale = state.aspect === '16:9' && !state.reducedMotion ? 0.97 + emphasis * 0.03 : 1;
      performer.style.transform = `translate3d(0, ${bob.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
      performer.style.opacity = String(state.aspect === '16:9' ? 0.65 + emphasis * 0.35 : emphasis);
      performer.style.zIndex = emphasis >= 0.5 ? '5' : '4';
      inset.style.opacity = String(1 - emphasis);
      const onMic = side === activeSide;
      const label = judgeSpeaking ? 'JUDGE SCORECARD' : onMic ? 'ON THE MIC ●' : 'LISTENING';
      $(`#plate-state-${side}`).textContent = label;
      inset.querySelector('.performer-state').textContent = judgeSpeaking ? 'JUDGE SCORECARD' : 'LISTENING';
      const reacting = Boolean(activePunch && !onMic);
      inset.classList.toggle('is-recoiling', reacting);
      // A short decaying physical response, with zero displacement at either end.
      const recoilAge = activePunch ? (tMs - activePunch.startMs) / 1000 : 0;
      const recoil = reacting ? Math.sin(Math.PI * clamp(recoilAge / 0.32, 0, 1)) ** 2 * 3 : 0;
      inset.style.transform = `translate3d(${recoil.toFixed(2)}px, 0, 0)`;
    }

    // Secondary Layer: EQ Halo + Counter-Scaling Shadow (LottieFiles Counter-Motion rule!)
    const halo = $('#eq-halo');
    const shadow = $('#hero-shadow');
    if (halo) {
      const hScale = (0.98 + beatKick * (gentle ? 0.008 : 0.025)).toFixed(3);
      const hRot = ((tMs / 1000) * (state.reducedMotion ? 0 : gentle ? 1.5 : 4)).toFixed(1);
      halo.style.transform = `translate3d(${(-cam.x * 0.45).toFixed(1)}px, ${(-cam.y * 0.45).toFixed(1)}px, 0) scale(${hScale}) rotate(${hRot}deg)`;
      halo.style.borderColor = activeSide === 'b' ? 'rgba(213, 251, 70, 0.44)' : 'rgba(167, 139, 250, 0.44)';
    }
    if (shadow) {
      // Shadow scales DOWN 15% when Hero lifts UP on the beat
      const shScale = (1.0 - beatKick * (gentle ? 0 : 0.035)).toFixed(3);
      shadow.style.transform = `scaleX(${shScale})`;
    }

    // Punchline / Score Callout Badge
    const callout = $('#callout-badge');
    const calloutEv = activePunch || activeScoreChange;
    if (callout && calloutEv && calloutEv.payload?.badge) {
      callout.hidden = false;
      $('#callout-text').textContent = calloutEv.payload.badge;
      const cs = state.reducedMotion ? 1 : spring({
        frame: frameIdx,
        fps,
        delayFrames: (calloutEv.startMs / 1000) * fps,
        ...SPRING_PRESETS.scorePop,
      });
      callout.style.transform =
        state.aspect === '16:9'
          ? `translateX(-50%) scale(${clamp(cs, 0.1, 1.08).toFixed(3)}) rotate(-1deg)`
          : `scale(${clamp(cs, 0.1, 1.08).toFixed(3)}) rotate(-1deg)`;
    } else if (callout) {
      callout.hidden = true;
    }
  }

  // 3. Impact Flash Veil on VS Slam, Knockout Punchlines & Winner Slam (2-frame crisp flash)
  const flashEl = $('#impact-flash');
  if (flashEl) {
    let flashAlpha = 0;
    for (const ev of tl.events) {
      if (!gentle && (ev.type === 'vs-slam' || ev.type === 'verdict' || (ev.type === 'punchline' && ev.payload?.tier === 'knockout'))) {
        const dt = tMs - ev.startMs;
        if (dt >= 0 && dt < 90) {
          flashAlpha = Math.max(flashAlpha, Math.sin(Math.PI * dt / 90) ** 2 * 0.055);
        }
      }
    }
    flashEl.style.opacity = flashAlpha.toFixed(3);
  }

  // 4. Render Single Kinetic Caption Page
  const captionState = renderSingleCaptionAt(tl, frameIdx, fps, tMs, hideCaptions);

  // 5. Optional QA Debug Overlay (Contact Sheets ONLY — never visible in final MP4!)
  const qaOverlay = $('#qa-debug-overlay');
  if (qaOverlay) {
    if (options.debugSafeZones) {
      qaOverlay.hidden = false;
      $('#qa-timecode').textContent = `t=${(tMs / 1000).toFixed(2)}s | F#${String(frameIdx).padStart(4, '0')} | ${activeSceneName.toUpperCase()} | ${cam.cameraName}`;
    } else {
      qaOverlay.hidden = true;
    }
  }

  return {
    frameIdx,
    tMs,
    scene: activeSceneName,
    camera: cam.cameraName,
    caption: captionState,
  };
};

/**
 * Exact DOM Geometry & Safe-Zone Sensor used by Phase 5 Automated Reviewer (`video-reviewer.js`).
 */
window.__measureLayoutTelemetry = function () {
  const isShorts = state.aspect === '9:16';
  const W = isShorts ? 1080 : 1920;
  const H = isShorts ? 1920 : 1080;
  const safe = isShorts
    ? { left: 52, right: W - 132, top: 215, bottom: H - 380 }
    : { left: 48, right: W - 48, top: 24, bottom: H - 32 };

  const violations = [];
  const overflows = [];

  const regions = [];
  const checkEls = document.querySelectorAll('.safe-check, .hook-center, .badge-kicker, .vs-meta, .vs-fighter-name, .vs-fighter-role, .vs-letters, .vs-mode-tag, .vs-topic-text, .round-slam-title, .performer-name, .performer-state, .hud-fname, .hud-score, .hud-mode-pill, .hud-round-pill, .hud-topic-strip, .caption-speaker-pill, .caption-page, .ending-headline, .ending-sub, .vote-pill strong, .verdict-winner-name, .verdict-scoreline');
  for (const el of checkEls) {
    if (el.hidden || el.closest('[hidden]')) continue;
    const style = window.getComputedStyle(el);
    let effectiveOpacity = 1;
    let visible = true;
    for (let ancestor = el; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      const ancestorStyle = window.getComputedStyle(ancestor);
      effectiveOpacity *= Number(ancestorStyle.opacity);
      if (ancestorStyle.display === 'none' || ancestorStyle.visibility === 'hidden') visible = false;
    }
    if (!visible || effectiveOpacity < 0.06) continue;

    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const rect = { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
    regions.push({ id: el.id || `${el.closest('[id]')?.id || 'stage'}:${el.className}`, rect, fontSizePx: parseFloat(style.fontSize) || 0, opacity: Number(effectiveOpacity.toFixed(3)) });

    if (r.left < safe.left - 4 || r.right > safe.right + 4 || r.top < safe.top - 4 || r.bottom > safe.bottom + 4) {
      violations.push({
        id: el.id || el.className,
        rect: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) },
        safe,
      });
    }
    if (el.scrollWidth > el.clientWidth + 6 || el.scrollHeight > el.clientHeight + 8) {
      overflows.push({
        id: el.id || el.className,
        scrollW: el.scrollWidth,
        clientW: el.clientWidth,
        scrollH: el.scrollHeight,
        clientH: el.clientHeight,
      });
    }
  }

  const capPage = $('#caption-page');
  const capStage = $('#caption-stage');
  const capVisible = Boolean(capStage && !capStage.hidden);
  const capFontPx = capVisible && capPage ? parseFloat(window.getComputedStyle(capPage).fontSize) || 0 : 0;

  return {
    aspect: state.aspect,
    captionVisible: capVisible,
    regions,
    captionFontSizePx: capFontPx,
    safeZoneViolations: violations,
    textOverflows: overflows,
  };
};

function escapeHtml(str) {
  return String(str ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
