// D/PRTMNT TAKEOVER on the runtime SDK (04 §4.4). Ported from the v0 Stream Kit's overlay.js: the
// scenes are the same markup, but where v0 polled /api/live and timed graphics on each machine's
// own clock, this reads state through SK, and the server times every trigger (startAt +
// durationMs), so a horizontal and a vertical feed hit the same frame (05 §5.3).
//
// Data it reads (02 §2.5): show.lineup (slots with startAt; time is a label), show.currentSlot,
// show.headliner (through the "headliner" setting's binding), show.goLiveAt, show.date,
// show.recStartedAt, viewers.total, viewers.stale. Anything absent is hidden, never shown as a
// placeholder (H6).
//
// v0's operator controls are here too: the title card's and Now playing's hold times (settings, as
// v0's cardSec and npSec), Now playing held until Hide, the title card that shows by itself some
// time after an act comes on (v0's delaySec), and Play / Stop for The Line's clip.
(() => {
  'use strict';
  const html = document.documentElement;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // A headline setting: "|" starts a new line.
  const lines = (s) => String(s == null ? '' : s).split('|').map((l) => esc(l.trim())).join('<br>');
  const S = () => SK.settings || {};
  const isEvent = () => S().look === 'event';
  const vertical = () => SK.canvas.height > SK.canvas.width;
  const SCENES = ['auto', 'starting', 'program', 'brb', 'lineup', 'outro', 'bg', 'intro', 'headliner', 'line', 'pov'];

  // ---- data ------------------------------------------------------------------------------------
  function slots() {
    const raw = SK.state('show.lineup');
    return Array.isArray(raw) ? raw.filter((s) => s && typeof s.name === 'string' && s.name.trim()) : [];
  }
  function ordered() {
    return slots().slice().sort((a, b) => (Number(a.startAt) || 0) - (Number(b.startAt) || 0));
  }
  // The operator's pick (show.currentSlot), if it names an act.
  function picked() {
    const raw = SK.state('show.lineup');
    const i = SK.state('show.currentSlot');
    return Array.isArray(raw) && Number.isInteger(i) && raw[i] && typeof raw[i].name === 'string' && raw[i].name.trim() ? raw[i] : undefined;
  }
  // Who's on: the operator's pick, else the slot the clock is in.
  function current() {
    const pick = picked();
    if (pick) return pick;
    const now = SK.clock.now();
    let cur;
    for (const s of ordered()) if (typeof s.startAt === 'number' && s.startAt <= now) cur = s;
    return cur;
  }
  function nextAfter(cur) {
    const list = ordered();
    const i = list.findIndex((s) => s.name === cur.name && s.startAt === cur.startAt);
    return i >= 0 ? list[i + 1] : undefined;
  }
  const slotKey = (s) => (s ? `${s.startAt}|${s.name}` : '');
  // Names match loosely, so the lineup's spelling wins: VIKKSTAR, Vikkstar and VIK KSTAR are one
  // act, and so are BEYONCÉ and Beyonce. Letters of any script count; a name with none (only
  // symbols) must match exactly, so two such names are never taken for one act.
  const loose = (v) => String(v || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '').replace(/(.)\1+/gu, '$1');
  function sameAct(a, b) {
    const x = loose(a);
    const y = loose(b);
    return x || y ? x === y : String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase() && String(a || '').trim() !== '';
  }
  // An act, the same through lineup edits: its name and B2B, loosely. A set moved to another time
  // is the same act.
  const looseOr = (v) => loose(v) || String(v || '').trim().toLowerCase();
  const actOf = (s) => (s ? `${looseOr(s.name)}|${looseOr(s.b2b)}` : '');
  // The billed act (09 §9.1: the slot flagged headliner, which is not the closer). The setting is
  // bound to show.headliner, so it follows the lineup unless the operator typed a name.
  function headliner() {
    const name = String(S().headliner || '').trim();
    if (name) return slots().find((s) => sameAct(s.name, name)) || { name };
    return slots().find((s) => s.headliner);
  }
  const headlinerName = () => (headliner() || {}).name || S().presents || 'D/PRTMNT';
  function goLiveAt() {
    const at = SK.state('show.goLiveAt');
    if (typeof at === 'number') return at;
    const first = ordered()[0];
    return first && typeof first.startAt === 'number' ? first.startAt : undefined;
  }
  // REC counts from the show's recording anchor only: without one there is no recording to time,
  // and a time made up from the lineup would be a wrong number on air (H6).
  function recAnchor() {
    const at = SK.state('show.recStartedAt');
    return typeof at === 'number' ? at : undefined;
  }
  // "08.28" from show.date (the show's own calendar date, 09 §9.1).
  function dateLabel() {
    const d = SK.state('show.date');
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(d || '');
    return m ? `${m[1]}.${m[2]}` : '';
  }
  // A performer's logo from the lineup (uploaded media, or an https URL): never anything else.
  const logoOf = (slot) => (slot && typeof slot.logo === 'string' && /^(\/media\/|https:\/\/)/.test(slot.logo) ? slot.logo : '');
  function time12(label) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(label || '');
    if (!m) return label || '';
    const h = Number(m[1]);
    return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
  }
  function clock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const p = (n) => String(n).padStart(2, '0');
    const hh = Math.floor(total / 3600);
    const mm = Math.floor(total / 60) % 60;
    const ss = total % 60;
    return hh > 0 ? `${p(hh)}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
  }
  // An image: uploaded media or https (the overlay CSP's img-src). A video: uploaded media only
  // (media-src is 'self'; an https clip could never play, 04 §4.8).
  const mediaUrl = (v) => (typeof v === 'string' && /^(\/media\/|https:\/\/)/.test(v) ? v : '');
  const videoUrl = (v) => (typeof v === 'string' && /^\/media\/[^?#\s]+$/.test(v) ? v : '');

  // ---- look --------------------------------------------------------------------------------------
  function applyLook() {
    const s = S();
    html.setAttribute('data-look', isEvent() ? 'event' : 'takeover');
    html.setAttribute('data-star', s.starStyle || 'rake');
    html.setAttribute('data-scanlines', s.scanlines === false ? 'off' : 'on');
    html.style.setProperty('--cyan', s.accent || '#16e0ff');
    html.style.setProperty('--gold', s.gold || '#efc33f');
    // The headliner's own mark in place of the star (a quoted CSS string: nothing in it escapes).
    const mark = mediaUrl(s.eventMark);
    if (mark) html.style.setProperty('--vk-mark', `url(${JSON.stringify(mark)})`);
    else html.style.removeProperty('--vk-mark');
  }

  // ---- shared chrome -----------------------------------------------------------------------------
  const scene = (cls, inner) => {
    const el = document.createElement('div');
    el.className = `scene ${cls}`;
    el.innerHTML = inner;
    return el;
  };
  const bug = (sub) => `<div class="bug"><div class="dprtmnt-mark">D<span class="slash">/</span>PRTMNT</div>${sub ? '<div class="sub">TAKEOVER</div>' : ''}</div>`;
  const status = (rec) => `<div class="status"><div class="live-pill"><span class="dot"></span><span class="txt">LIVE</span><span class="vw hide" data-vw></span></div>${rec ? '<div class="rec hide" data-rec></div>' : ''}</div>`;
  const blooms = (defs) => `<div class="blooms">${defs.map(([w, pos, col]) => `<div class="bloom" style="width:${w}px;height:${w}px;${pos};background:radial-gradient(circle,${col},transparent 60%)"></div>`).join('')}</div>`;
  const fx = () => '<div class="vignette"></div><div class="scan"></div><div class="grain"></div>';
  function ticker() {
    const items = (S().tickerItems || []).filter(Boolean);
    if (!S().ticker || !items.length) return '';
    const run = `<span>${items.map(esc).join('&nbsp;&nbsp;✕&nbsp;&nbsp;')}&nbsp;&nbsp;✕&nbsp;&nbsp;</span>`;
    return `<div class="ticker"><div class="badge">● LIVE</div><div class="track"><div class="run">${run}${run}</div></div></div>`;
  }
  function billing(name, b2b) {
    return `<span>${esc(name)}</span>${b2b ? `<span class="b2b-grp"><span class="b2b-tag">B2B</span><span>${esc(b2b)}</span></span>` : ''}`;
  }

  // ---- the TAKEOVER look -------------------------------------------------------------------------
  const BASE = {
    program: () => scene('scene--broll program', `${bug(!vertical())}${status(!vertical())}${ticker()}`),
    starting: () => scene('scene--broll starting', `<div class="darkblur"></div>${fx()}
      <div class="center-stack">
        <div class="kicker"><span class="dot"></span><span class="label">D/PRTMNT TAKEOVER</span></div>
        <div class="h1">STARTING SOON</div>
        <div class="count hide" data-count></div>
        <div class="tag">${esc(S().tagline)}</div>
      </div>`),
    brb: () => scene('scene--solid brb', `${blooms([[1300, 'left:-280px;top:-300px', 'rgba(255,0,144,.32)'], [1100, 'right:-220px;bottom:-260px', 'rgba(22,224,255,.28)']])}
      <div class="vignette"></div><div class="sweepbar"></div><div class="scan"></div><div class="grain"></div>
      <div class="center-stack">
        <div class="kicker"><span class="dot"></span><span class="label">D/PRTMNT TAKEOVER</span></div>
        <div class="big">BE RIGHT<br>BACK</div>
        <div class="tag">${esc(S().brbTag)}</div>
      </div>`),
    outro: () => scene('scene--broll outro', `<div class="darkblur"></div>${fx()}
      <div class="center-stack">
        <div class="pre">${esc(S().outroPre)}</div>
        <div class="big">${esc(S().outroBig)}</div>
        <div class="tag">${[S().venue, S().doors].filter(Boolean).map(esc).join(' · ')}</div>
      </div>`),
    intro: () => scene('scene--broll intro', `<div class="intro-bg"><div class="scan"></div><div class="grain"></div><div class="sweepbar"></div></div>
      <div class="card intro-content">
        <div class="pre">${esc(S().presents)}</div>
        <img class="logo" src="assets/takeover-logo.png" alt="TAKEOVER">
        <div class="post">${esc(S().tagline)}</div>
      </div>`),
    // In this look the headliner gets the intro's sequence with their name for the logo.
    headliner: () => {
      const h = headliner() || {};
      const logo = logoOf(h);
      return scene('scene--broll intro', `<div class="intro-bg"><div class="scan"></div><div class="grain"></div><div class="sweepbar"></div></div>
        <div class="card intro-content">
          <div class="pre">NOW ON</div>
          ${logo ? `<img class="djlogo" src="${esc(logo)}" alt="">` : ''}
          <div class="djname">${esc(headlinerName())}</div>
          ${h.b2b ? `<div class="djb2b">B2B ${esc(h.b2b)}</div>` : ''}
          <div class="post">${esc(S().tagline)}</div>
        </div>`);
    },
    // Who's on is marked by paint(), so the mark moves with the clock as well as the operator.
    lineup: () => {
      const rows = ordered().map((s) => `<div class="row" data-row="${esc(slotKey(s))}"><span class="time">${esc(s.time || '')}</span><span class="who">${billing(s.name, s.b2b)}${s.closer ? '<span class="closer-tag">· CLOSER</span>' : ''}</span></div>`).join('');
      return scene('scene--broll lineup', `<div class="darkblur"></div>${fx()}
        <div class="mark-tr"><div class="dprtmnt-mark">D<span class="slash">/</span>PRTMNT</div></div>
        <div class="body">
          <div class="head"><span class="bar"></span><span class="label">TONIGHT'S LINEUP</span></div>
          ${rows ? `${rows}<div class="row cap"></div>` : '<div class="empty">LINEUP TBA</div>'}
        </div>`);
    },
    bg: () => {
      const pair = '<div class="row">D<span class="slash">/</span>PRTMNT</div><div class="row alt">TAKEOVER</div>';
      const half = pair.repeat(12);
      return scene('scene--solid bgscene', `${blooms([[1500, 'left:-320px;top:-380px', 'rgba(22,224,255,.46)'], [1300, 'right:-300px;bottom:-320px', 'rgba(255,0,144,.40)']])}
        <div class="wall"><div class="stack">${half}${half}</div></div>
        <div class="ctrscrim"></div><div class="sweepbar"></div>${fx()}`);
    },
    pov: () => scene('scene--broll pov', `<div class="lens"></div>${fx()}
      <div class="vf tl"></div><div class="vf tr"></div><div class="vf bl"></div><div class="vf br"></div>
      ${bug(false)}${status(true)}
      <div class="povtag"><span class="dot"></span><span class="label">POV</span><span class="sub">${esc(S().povLabel)}</span></div>
      <div class="whobar hide" data-who></div>`),
    // The clip itself is added by lineClipInto(): one <video> kept across rebuilds.
    line: () => {
      const clip = !SK.env.lite && videoUrl(S().lineClip);
      return scene('scene--broll line', `${clip ? '<div class="clip" data-line-clip></div>' : ''}
        <div class="botscrim"></div>${fx()}${bug(false)}${status(!vertical())}
        <div class="ll">
          <div class="eyebrow"><span class="dot"></span><span class="label">${esc(S().lineEyebrow)}</span></div>
          <div class="scene-label">${esc(S().lineLabel)}</div>
          <div class="sub">${esc(S().venue)}</div>
        </div>
        <div class="lr"><div class="k">${esc(S().lineKicker)}</div><div class="v">${esc(S().lineCorner)}</div></div>`);
    },
  };

  // ---- the headliner event look --------------------------------------------------------------------
  const address = () => S().address || S().venue || '';
  const vkFx = () => '<div class="vk-scan"></div><div class="vk-sweepline"></div>';
  function vkTopLeft() {
    return `<div class="vk-tl"><div class="vk-wordmark">D<i>/</i>PRTMNT</div>${address() ? `<div class="vk-addr">${esc(address())}</div>` : ''}</div>`;
  }
  function vkTopRight() {
    if (S().chip === false) return '';
    const date = dateLabel();
    return `<div class="vk-tr"><div class="vk-chip"><span class="dot"></span><span class="lbl">LIVE</span><span class="viewers hide" data-vw></span></div>${date ? `<div class="vk-date">${esc(date)}</div>` : ''}</div>`;
  }
  function vkLockup() {
    const h = headliner();
    if (!h || S().lockup === false) return '';
    return `<div class="vk-bl" data-lockup><div class="vk-kicker">TONIGHT</div>
      <div class="vk-lockup"><span class="vk-star"></span><span class="vk-name">${esc(h.name)}</span></div>
      ${h.b2b ? `<div class="vk-b2b">B2B ${esc(h.b2b)}</div>` : ''}</div>`;
  }
  function vkPosterBed() {
    const poster = S().showPoster === false ? '' : mediaUrl(vertical() ? S().posterV || S().posterH : S().posterH || S().posterV);
    // Without a poster, the watermarks the poster art would carry are drawn instead.
    const marks = poster ? '' : `${dateLabel() ? `<div class="vk-wm-date">${esc(dateLabel())}</div>` : ''}
      <div class="vk-wm-mark">D/PRTMNT</div>${address() ? `<div class="vk-wm-addr">${esc(address())}</div>` : ''}`;
    // The URL goes in through the CSSOM after the build (setPosters), never into a style attribute.
    return { cls: poster ? '' : ' vk-noposter', bed: `<div class="vk-card"><div class="vk-poster"${poster ? ` data-poster="${esc(poster)}"` : ''}></div><div class="vk-scrim"></div>${marks}</div>` };
  }
  function vkTitleSeq(kicker, name, meta) {
    return scene('scene--broll vk-intro', `<div class="vk-curtain"></div>
      <div class="vk-istack">
        <div class="vk-istarwrap"><div class="vk-iring"></div><div class="vk-istar"></div></div>
        <div class="vk-ikick">${esc(kicker)}</div>
        <div class="vk-iname">${esc(name)}</div>
        <div class="vk-irule"></div>
        <div class="vk-imeta">${esc(meta)}</div>
      </div>
      <div class="vk-flash"></div>`);
  }
  const EVENT = {
    program: () => scene('scene--broll vk-program', `${vkFx()}${vkTopLeft()}${vkTopRight()}${vkLockup()}`),
    starting: () => {
      const p = vkPosterBed();
      const bar = [dateLabel(), 'D/PRTMNT', address()].filter(Boolean).join(' · ');
      return scene(`scene--solid vk-starting${p.cls}`, `${p.bed}${vkFx()}
        <div class="vk-stack">
          <span class="vk-star"></span>
          <div class="vk-big">${esc(headlinerName())}</div>
          <div class="vk-eyebrow">STARTING SOON</div>
          <div class="vk-count hide" data-count></div>
          <div class="vk-bar">${esc(bar)}</div>
        </div>`);
    },
    brb: () => {
      const p = vkPosterBed();
      // One sprite strip stepped by transform: one animation, not one per bar (05 §5.8).
      const vu = S().vu === false ? '' : '<div class="vk-vu"><div class="vk-vu-strip"></div></div>';
      return scene(`scene--solid vk-brb${p.cls}`, `${p.bed}${vkFx()}
        <div class="vk-stack">
          <div class="vk-big">BE RIGHT<br>BACK</div>${vu}
          ${S().eventBrbTag ? `<div class="vk-eyebrow">${esc(S().eventBrbTag)}</div>` : ''}
          <div class="vk-sub">${esc(headlinerName())} · D/PRTMNT</div>
        </div>`);
    },
    outro: () => {
      const p = vkPosterBed();
      const s = S();
      return scene(`scene--solid vk-outro${p.cls}`, `${p.bed}${vkFx()}
        <div class="vk-stack">
          ${s.eventOutroPre ? `<div class="vk-eyebrow">${esc(s.eventOutroPre)}</div>` : ''}
          <div class="vk-big">${lines(s.eventOutroBig)}</div>
          <span class="vk-star" style="margin:30px 0 14px"></span>
          <div class="vk-sub">${esc(headlinerName())}</div>
          ${s.eventOutroBar ? `<div class="vk-bar">${esc(s.eventOutroBar)}</div>` : ''}
        </div>`);
    },
    intro: () => vkTitleSeq(S().presents || 'D/PRTMNT PRESENTS', headlinerName(), [dateLabel(), address()].filter(Boolean).join(' · ') || 'D/PRTMNT'),
    // At the takeover itself: "NOW ON", never an on-at time (that's for before they're on).
    headliner: () => vkTitleSeq('NOW ON', headlinerName(), address() || S().tagline || 'D/PRTMNT'),
    lineup: () => {
      const p = vkPosterBed();
      const h = headliner();
      const rows = ordered().map((s) => {
        const head = h && sameAct(s.name, h.name);
        return `<div class="row${head ? ' head' : ''}"><span class="star${head ? '' : ' none'}"></span>
          <span class="t">${esc(time12(s.time))}</span><span class="n">${esc(s.name)}${s.b2b ? `<span class="b2b">B2B ${esc(s.b2b)}</span>` : ''}</span></div>`;
      }).join('');
      return scene(`scene--solid vk-lineup${p.cls}`, `${p.bed}${vkFx()}
        <div class="vk-stack"><div class="vk-tt"><div class="vk-tt-head">TONIGHT</div>${rows || '<div class="row"><span class="n">LINEUP TBA</span></div>'}</div></div>`);
    },
    bg: () => {
      const pair = `<div class="row">${esc(headlinerName())}</div><div class="row alt">D/PRTMNT</div>`;
      const half = pair.repeat(12);
      return scene('scene--solid bgscene vk-bgscene', `${blooms([[1500, 'left:-320px;top:-380px', 'rgba(239,195,63,.34)'], [1300, 'right:-300px;bottom:-320px', 'rgba(239,195,63,.20)']])}
        <div class="wall"><div class="stack">${half}${half}</div></div>
        <div class="vk-bgstar"></div><div class="ctrscrim"></div><div class="sweepbar"></div>${vkFx()}`);
    },
  };

  // auto: the countdown until go-live, then the live scene, switching by itself at go-live (v0's
  // "main" source, one OBS source for the whole arc).
  let cancelAuto = null;
  function autoScene(ctx) {
    const at = goLiveAt();
    const before = at !== undefined && SK.clock.now() < at;
    if (cancelAuto) cancelAuto(); // go-live may have moved: arm for the time it is now
    cancelAuto = before ? SK.clock.at(at, () => {
      cancelAuto = null;
      if (SK.scene === 'auto') SK.defineScene('auto', (c) => build('auto', c));
    }) : null;
    const id = before ? 'starting' : 'program';
    return ((isEvent() && EVENT[id]) || BASE[id])(ctx);
  }

  // What each scene is built from. The scene on screen is rebuilt only when this changes, so a
  // lineup edit never restarts The Line's clip, and who's on (painted, not built) never rebuilds.
  function inputsOf(id) {
    const s = S();
    if (id === 'line' || id === 'pov') {
      // They never show the headliner, whose setting follows the lineup (x-skp-bind).
      const { headliner: _unused, ...rest } = s;
      return [rest];
    }
    if (id === 'auto' || id === 'starting') return [s, slots(), SK.state('show.date'), SK.state('show.headliner'), SK.state('show.goLiveAt')];
    return [s, slots(), SK.state('show.date'), SK.state('show.headliner')];
  }
  const builtFrom = new Map(); // scene id → inputsOf(id) when it was last built
  const active = new Map(); // action kind → { trigger, make, end, el }: actions inside their window
  let lineVideo = null; // The Line's clip, kept across rebuilds (lineClipInto)

  function build(id, ctx) {
    const make = id === 'auto' ? autoScene : (isEvent() && EVENT[id]) || BASE[id];
    const el = make ? make(ctx) : scene('scene--broll', '');
    // The event look's star flash on a take (not on a cut, and not on the first scene).
    if (isEvent() && S().stinger && ctx.root.getAttribute('data-skp-transition') !== 'cut' && built > 0) {
      el.insertAdjacentHTML('beforeend', '<div class="vk-stinger"><div class="s"></div></div>');
    }
    built++;
    builtFrom.set(id, JSON.stringify(inputsOf(id)));
    for (const p of el.querySelectorAll('[data-poster]')) p.style.backgroundImage = `url(${JSON.stringify(p.getAttribute('data-poster'))})`;
    lineClipInto(el);
    paint(el);
    // Once the scene is on the page: a moved clip plays on (moving a video pauses it), and actions
    // still inside their window come back if this is the live scene.
    setTimeout(() => {
      if (lineVideo && lineVideo.isConnected) play(lineVideo);
      for (const kind of [...active.keys()]) show(kind);
    }, 0);
    return el;
  }
  let built = 0;
  for (const id of SCENES) SK.defineScene(id, (ctx) => build(id, ctx));

  // ---- video: The Line's clip and the operator's (media.play) --------------------------------------
  // A clip gets its black backing only once it has a picture: one that can't load (missing,
  // refused) leaves the camera showing, never a black frame. Lite mode (phone previews) plays none.
  const clipLayer = document.querySelector('[data-clip]');
  function makeVideo(url) {
    const v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.autoplay = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.addEventListener('loadeddata', () => { if (v.parentNode) v.parentNode.classList.add('ready'); });
    v.addEventListener('error', () => { if (v.parentNode) v.parentNode.classList.remove('ready'); });
    v.src = url;
    return v;
  }
  function play(v) {
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  }
  // Moves a video, and its black backing with it. Moving pauses it: play() follows.
  function moveVideo(v, into) {
    if (v.parentNode === into) return;
    if (v.parentNode) v.parentNode.classList.remove('ready');
    into.appendChild(v);
    into.classList.toggle('ready', v.readyState >= 2);
  }

  // The Line's clip: one <video> for as long as the setting names the same file, so a rebuild or a
  // take neither restarts it nor flashes black. On The Line it plays in the scene. The operator's
  // Play (v0's Play Clip) moves it to the clip layer, under every scene's chrome, until Stop; The
  // Line shows it there too meanwhile, so taking The Line never dips it in the crossfade.
  let lineOn = false;
  function lineClip() {
    const url = !SK.env.lite && videoUrl(S().lineClip);
    if (!url) return null;
    if (!lineVideo || lineVideo.getAttribute('src') !== url) lineVideo = makeVideo(url);
    return lineVideo;
  }
  function lineClipInto(el) {
    const holder = el.querySelector('[data-line-clip]');
    const v = holder && !lineOn ? lineClip() : null;
    if (v) moveVideo(v, holder);
  }
  // The Line's own holder on screen, while The Line is the scene.
  const lineHolder = () => (SK.scene === 'line' ? document.querySelector('[data-skp-scene-root="line"]:not([data-skp-state="exit"]) [data-line-clip]') : null);

  // Play: from the start unless it is on screen already, looping, until Stop. It doesn't take The
  // Line, as v0's didn't.
  function linePlay() {
    const v = clipLayer && lineClip();
    if (!v) return;
    const showing = lineOn || (!!v.parentNode && v.parentNode === lineHolder());
    for (const other of clipLayer.querySelectorAll('video')) if (other !== v) other.remove(); // the operator's other clip
    lineOn = true;
    moveVideo(v, clipLayer);
    if (!showing) {
      try { v.currentTime = 0; } catch (err) { /* not seekable yet */ }
    }
    clipLayer.classList.remove('hide');
    play(v);
  }
  // Stop. On The Line the clip plays on in the scene, as in v0.
  function lineStop() {
    if (!lineOn) return;
    lineOn = false;
    if (!lineVideo || lineVideo.parentNode !== clipLayer) return;
    clipLayer.classList.add('hide');
    const holder = lineHolder();
    if (holder) {
      moveVideo(lineVideo, holder);
      play(lineVideo);
    } else {
      lineVideo.pause(); // kept loaded: the next Play doesn't flash black
    }
  }
  // Another clip named while Play is on plays in its place, from the start; none, and Play ends.
  function lineSettings() {
    if (!lineOn || !clipLayer) return;
    const old = lineVideo;
    const v = lineClip();
    if (v && v === old && v.parentNode === clipLayer) return;
    if (old && old !== v && old.parentNode === clipLayer) old.remove();
    lineOn = false;
    if (v) linePlay();
    else clipLayer.classList.add('hide');
  }

  // ---- what changes every moment: countdown, REC, viewers, who's on ------------------------------
  function paint(root) {
    root = root || document;
    const now = SK.clock.now();
    for (const el of root.querySelectorAll('[data-count]')) {
      const at = goLiveAt();
      el.classList.toggle('hide', at === undefined);
      if (at !== undefined) el.textContent = clock(at - now);
    }
    for (const el of root.querySelectorAll('[data-rec]')) {
      const at = recAnchor();
      const show = S().rec !== false && at !== undefined;
      el.classList.toggle('hide', !show);
      if (show) el.textContent = `REC ${clock(now - at)}`;
    }
    const total = SK.state('viewers.total');
    for (const el of root.querySelectorAll('[data-vw]')) {
      const show = S().viewers !== false && typeof total === 'number' && total >= 0;
      el.classList.toggle('hide', !show);
      el.classList.toggle('stale', SK.state('viewers.stale') === true);
      if (show) el.textContent = total.toLocaleString('en-US');
    }
    const cur = current();
    for (const el of root.querySelectorAll('[data-row]')) el.classList.toggle('live', !!cur && el.getAttribute('data-row') === slotKey(cur));
    for (const el of root.querySelectorAll('[data-who]')) {
      const key = cur ? `${cur.startAt}|${cur.name}|${cur.b2b || ''}` : '';
      if (el.getAttribute('data-slot') !== key) {
        el.setAttribute('data-slot', key);
        el.innerHTML = cur ? `<div class="eyebrow"><span class="dot"></span><span class="label">ON THE DECKS</span></div>
          <div class="name">${esc(cur.name)}</div>${cur.b2b ? `<div class="b2b">B2B ${esc(cur.b2b)}</div>` : ''}` : '';
      }
      el.classList.toggle('hide', !cur);
    }
  }
  setInterval(() => {
    paint();
    followAct();
    watchClock();
  }, 250);
  SK.onState('viewers.total', () => paint());

  // A change to what the scene on screen is built from rebuilds it; scenes not on screen are built
  // fresh when they are shown. The timed intros are left alone: rebuilding would restart them.
  function refresh() {
    applyLook();
    const id = SK.scene;
    if (!id || id === 'intro' || id === 'headliner' || builtFrom.get(id) === JSON.stringify(inputsOf(id))) return;
    SK.defineScene(id, (ctx) => build(id, ctx));
  }
  SK.onSettings(() => {
    refresh();
    lineSettings();
  });
  SK.onState('show.*', (key) => {
    if (key === 'show.lineup' || key === 'show.currentSlot') actMayChange();
    if (key === 'show.lineup') preloadLogos();
    if (key === 'show.currentSlot') {
      paint();
      followAct();
    } else if (/^show\.(lineup|date|headliner|goLiveAt)$/.test(key)) refresh();
  });

  // Performers' logos are decoded before an action first reveals them (05 §5.8).
  const preloaded = new Set();
  function preloadLogos() {
    if (SK.env.lite) return;
    for (const s of slots()) {
      const logo = logoOf(s);
      if (logo && !preloaded.has(logo)) {
        preloaded.add(logo);
        SK.preload(logo);
      }
    }
  }

  // ---- triggered graphics (actions, 04 §4.6) ------------------------------------------------------
  // Shown on the live scene ("program", or "auto" once it is live), from startAt until its end on
  // server time. An action stays active for its whole window: when the live scene is rebuilt (new
  // data, a setting) or taken again within it, the graphic comes back at the point it had reached.
  // The title card and Now playing stay as long as the overlay's settings say (v0's cardSec and
  // npSec). A trigger from the platform carries the action's durationMs from template.json, which
  // is only the default of those settings, so the setting replaces it; a trigger that asks for its
  // own duration gets it. Held, Now playing has no end: it stays until Hide, or the next one. Only
  // the pages that saw the trigger have it: a source that reloads meanwhile (an OBS refresh) comes
  // back without it, as no show state carries a hold (nor Play The Line's clip).
  const seconds = (v, fallback, min, max) => (typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback);
  // As the settings bound them (template.json).
  const cardMs = () => seconds(S().cardSec, 7, 2, 60) * 1000;
  const npMs = () => seconds(S().npSec, 22, 3, 120) * 1000;
  const declared = (name) => ((SK.meta.actions || []).find((a) => a.id === name) || {}).durationMs;
  const endOf = (t, name, setting) => t.startAt + (t.durationMs === declared(name) ? setting() : t.durationMs);
  function liveRoot() {
    if (SK.scene !== 'program' && SK.scene !== 'auto') return null;
    const root = document.querySelector(`[data-skp-scene-root="${SK.scene}"]:not([data-skp-state="exit"]) .scene`);
    return root && (root.classList.contains('program') || root.classList.contains('vk-program')) ? root : null;
  }
  function dimLockup() {
    const root = liveRoot();
    const lockup = root && root.querySelector('[data-lockup]');
    if (lockup) lockup.classList.toggle('dim', !!root.querySelector('[data-kind="np"], [data-kind="title"]'));
  }
  // end: the server time it goes (Infinity: held).
  function present(kind, trigger, make, end = trigger.startAt + trigger.durationMs) {
    active.set(kind, { trigger, make, end, el: null });
    show(kind);
  }
  function show(kind) {
    const a = active.get(kind);
    if (!a) return;
    if (SK.clock.now() >= a.end) {
      active.delete(kind);
      return;
    }
    const root = liveRoot();
    if (!root || (a.el && root.contains(a.el))) return;
    const el = a.make(a.trigger.args || {});
    a.who = whoOf(current());
    if (!el) return;
    for (const old of root.querySelectorAll(`[data-kind="${kind}"]`)) SK.unmount(old).then(dimLockup);
    el.setAttribute('data-kind', kind);
    a.el = el;
    SK.mount(el, { parent: root, offsetMs: Math.max(0, SK.clock.now() - a.trigger.startAt) });
    dimLockup();
    if (a.end === Infinity) return;
    const exitMs = parseFloat(getComputedStyle(el).getPropertyValue('--skp-exit-ms')) || 500;
    SK.clock.at(a.end - exitMs, () => {
      if (active.get(kind) === a) active.delete(kind);
      if (el.isConnected) SK.unmount(el).then(dimLockup);
    });
  }
  // Hide (v0's Hide): the title card and Now playing go at once, held or not. An automatic title
  // card on screen takes the Now playing it brings with it.
  function hideCards() {
    for (const kind of ['title', 'np']) {
      active.delete(kind);
      for (const el of document.querySelectorAll(`[data-kind="${kind}"]`)) SK.unmount(el).then(dimLockup);
    }
    if (npDue) npDue();
    npDue = null;
  }
  // Whether a trigger names its act (a cue can); one that doesn't is about who's on.
  function named(args) {
    return !!args && typeof args.name === 'string' && !!args.name.trim();
  }
  // The slot a trigger is about: the act it names, else who's on.
  function slotFor(args) {
    if (named(args)) return slots().find((s) => sameAct(s.name, args.name)) || { name: args.name, b2b: args.b2b };
    return current();
  }
  // A title card or Now playing that names no act follows who's on, as v0's did: picking the next
  // act (or the clock reaching their set) changes the card already up, held or not, in place, with
  // no new entrance. With nobody on, it goes, and comes back with the next act while it lasts.
  const whoOf = (s) => (s ? `${s.startAt}|${s.name}|${s.b2b || ''}|${logoOf(s)}` : '');
  function followAct() {
    const who = whoOf(current());
    for (const kind of ['title', 'np']) {
      const a = active.get(kind);
      if (!a || a.who === who || named(a.trigger.args)) continue;
      if (!a.el || !a.el.isConnected) {
        show(kind);
        continue;
      }
      a.who = who;
      const fresh = a.make(a.trigger.args || {});
      if (fresh) {
        if (fresh.innerHTML !== a.el.innerHTML) a.el.innerHTML = fresh.innerHTML;
      } else {
        SK.unmount(a.el).then(dimLockup);
        a.el = null;
      }
    }
  }
  const div = (cls, inner) => Object.assign(document.createElement('div'), { className: cls, innerHTML: inner });

  function titleCard(args) {
    const s = slotFor(args);
    if (!s) return null;
    const logo = logoOf(s);
    if (isEvent()) {
      return div('vk-titlecard', `${logo ? `<img class="djlogo" src="${esc(logo)}" alt="">` : '<span class="vk-star"></span>'}
        <div class="t-name">${esc(s.name)}</div>${s.b2b ? `<div class="t-b2b">B2B ${esc(s.b2b)}</div>` : ''}
        <div class="t-rule"></div><div class="t-sub">${esc(S().tagline)}</div>`);
    }
    return div('card title', `<div class="pre">NOW PLAYING</div>${logo ? `<img class="djlogo" src="${esc(logo)}" alt="">` : ''}
      <div class="djname">${esc(s.name)}</div>${s.b2b ? `<div class="djb2b">B2B ${esc(s.b2b)}</div>` : ''}<div class="post">${esc(S().tagline)}</div>`);
  }
  function nowPlaying(args) {
    const s = slotFor(args);
    // The event look's own switch (v0's evOpts.np).
    if (!s || (isEvent() && S().nowPlayingBar === false)) return null;
    const logo = logoOf(s);
    if (isEvent()) {
      return div('vk-np', `<div class="eyebrow">NOW PLAYING</div>${logo ? `<img class="logo" src="${esc(logo)}" alt="">` : ''}
        <div class="who">${esc(s.name)}</div>${s.b2b ? `<div class="sub">B2B ${esc(s.b2b)}</div>` : ''}`);
    }
    const next = s.startAt !== undefined ? nextAfter(s) : undefined;
    const tail = s.closer
      ? '<div class="closer"><span class="dot"></span><span class="label">CLOSING SET · LAST OF THE NIGHT</span></div>'
      : (next ? `<div class="next"><span class="k">NEXT</span><span class="v">${esc(next.name)} — ${esc(time12(next.time))}</span></div>` : '');
    return div('np', `<div class="eyebrow"><span class="dot"></span><span class="label">NOW PLAYING</span></div>
      ${logo ? `<img class="logo" src="${esc(logo)}" alt="">` : ''}<div class="name">${esc(s.name)}</div>${s.b2b ? `<div class="b2b">B2B ${esc(s.b2b)}</div>` : ''}${tail}`);
  }

  SK.action('titleCard', (t) => {
    const s = slotFor(t.args);
    if (s) titled.set(actOf(s), t.startAt);
    present('title', t, titleCard, endOf(t, 'titleCard', cardMs));
  });
  SK.action('nowPlaying', (t) => present('np', t, nowPlaying, endOf(t, 'nowPlaying', npMs)));
  SK.action('nowPlayingHold', (t) => present('np', t, nowPlaying, Infinity));
  SK.action('hideCards', hideCards);

  // The event look's schedule chips: who opens, and when the headliner is on (v0's evOpts.sched
  // switches them off).
  const chips = () => isEvent() && S().scheduleChips !== false;
  SK.action('chipOpening', (t) => present('chip', t, () => {
    const first = ordered()[0];
    if (!chips() || !first) return null;
    return div('vk-br', `<div class="k">OPENING</div><div class="v">${esc(first.name)}</div>`);
  }));
  SK.action('chipOnAt', (t) => present('chip', t, () => {
    const h = headliner();
    if (!chips() || !h || !h.time) return null;
    return div('vk-br', `<div class="k">${esc(h.name)}</div><div class="v">ON AT <em>${esc(time12(h.time))}</em></div>`);
  }));

  SK.action('linePlay', linePlay);
  SK.action('lineStop', lineStop);

  // ---- the title card by itself (v0's delaySec) ----------------------------------------------------
  // When the act on changes, their title card shows autoCardSec later, then Now playing, as v0's
  // clock-run links did. It counts from when the act came on, on the server's clock, so both
  // canvases and every overlay of the show show it on the same frame: a pick from the moment the
  // server made it, the clock's own change from the slot's start. A page loaded with an act
  // already picked doesn't know when that was, so it shows nothing for them (a reload replays
  // nothing); the clock's act it does know, and it keeps time with the others. An act whose title
  // card already showed since they came on (a timeline cue, the button, the headliner's intro)
  // doesn't get a second one, so turning it on beside a timeline built from the lineup is safe.
  // A cue that puts an act on and shows their card does both at once, and the card starts a moment
  // after the change (the server's lead on a trigger): the card by itself never starts sooner than
  // LEAD_MS after the change, so with no delay it still sees that one. The same on every page.
  const LEAD_MS = 1000;
  const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  // When the change being taken in reached the server. An envelope's id on this platform is a
  // ULID (02 §2.1 recommends one): its first ten characters are the server time it was made, the
  // same on every member. Any other id (mock data), or a time that can't be this change's, is now.
  function changedAt() {
    const now = SK.clock.now();
    const id = SK.transport.cursor;
    if (typeof id !== 'string' || !ULID.test(id)) return now;
    let t = 0;
    for (const c of id.slice(0, 10)) t = t * 32 + B32.indexOf(c);
    return t <= now + 2000 && t >= now - 60000 ? t : now;
  }
  const titled = new Map(); // act (actOf) → when its latest title card started
  let actOn; // the act on (actOf), undefined until the page has looked
  let settling = null; // a show change being taken in: its keys arrive one by one
  let changeAt = 0; // when its latest key reached the server
  let cardDue = null; // cancels the title card still to come
  let npDue = null; // cancels the Now playing that follows it

  // Show state changed: a lineup edit moves who's on (lineup, then currentSlot), so the act is
  // read once the change has settled, timed from its latest key (taken as it arrives: a page held
  // up runs the wait late, never with an older change's time).
  function actMayChange() {
    changeAt = changedAt();
    if (settling) return;
    settling = setTimeout(() => {
      settling = null;
      checkAct(changeAt);
    }, 150);
  }
  // The clock reached the next act's slot (nobody picked).
  function watchClock() {
    if (!settling && actOn !== undefined) checkAct();
  }
  // at: when the change came, on server time (undefined: the clock's own, or the first look).
  function checkAct(at) {
    const cur = current();
    const key = actOf(cur);
    if (key === actOn) return;
    const first = actOn === undefined;
    actOn = key;
    for (const cancel of [cardDue, npDue]) if (cancel) cancel();
    cardDue = npDue = null;
    if (!cur) return;
    const byClock = !picked() && typeof cur.startAt === 'number' && at === undefined;
    if (first && !byClock) return;
    const since = byClock ? cur.startAt : at === undefined ? SK.clock.now() : at;
    const startAt = since + Math.max(LEAD_MS, seconds(S().autoCardSec, 210, 0, 3600) * 1000);
    const args = { name: cur.name };
    // Armed whatever the setting: switched on meanwhile, it still shows; off, it doesn't.
    cardDue = SK.clock.at(startAt, () => {
      cardDue = null;
      if (S().autoCard !== true || actOf(current()) !== key || (titled.get(key) ?? -Infinity) >= since - 5000) return;
      const card = cardMs();
      titled.set(key, startAt);
      present('title', { startAt, durationMs: card, args }, titleCard);
      npDue = SK.clock.at(startAt + card, () => {
        npDue = null;
        if (actOf(current()) === key) present('np', { startAt: startAt + card, durationMs: npMs(), args }, nowPlaying);
      });
    });
  }
  // The headliner's own intro is their title card.
  SK.onScene((id) => {
    const h = id === 'headliner' && headliner();
    if (h) titled.set(actOf(h), SK.clock.now());
  });

  // ---- the operator's clip (media.play / media.stop) ----------------------------------------------
  SK.on('media.play', (env) => {
    const url = videoUrl(env.data && env.data.url);
    if (!clipLayer || !url || SK.env.lite) return;
    // The Line's own clip plays as Play The Line's clip does: the same one video.
    if (url === videoUrl(S().lineClip)) {
      linePlay();
      return;
    }
    lineStop();
    let video = clipLayer.querySelector('video');
    if (!video || video.getAttribute('src') !== url) {
      clipLayer.classList.remove('ready');
      clipLayer.textContent = '';
      video = makeVideo(url);
      clipLayer.appendChild(video);
    } else {
      try { video.currentTime = 0; } catch (err) { /* not seekable yet */ }
    }
    clipLayer.classList.remove('hide');
    play(video);
  });
  SK.on('media.stop', () => {
    if (!clipLayer) return;
    lineStop();
    clipLayer.classList.add('hide');
    const video = clipLayer.querySelector('video');
    if (video) video.pause(); // kept loaded: the next play doesn't flash black
  });

  SK.ready(() => {
    applyLook();
    // Decode the big images before their first reveal, or the first intro stutters (05 §5.8).
    if (!SK.env.lite) {
      SK.preload(SK.asset('assets/takeover-logo.png'));
      for (const p of [S().posterH, S().posterV, S().eventMark]) if (mediaUrl(p)) SK.preload(mediaUrl(p));
      preloadLogos();
    }
    paint();
    checkAct();
  });
  applyLook();
})();
