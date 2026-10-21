// Text & Clock (com.ctd.text-clock): up to three lines of text and a clock. Every reading comes
// from SK.clock.now(), the server's time, so every source of every overlay shows the same second
// (and the same frame) at once; clock.js does the arithmetic. The clock is painted once a second,
// on the second boundary, and for a timecode once a frame as well (requestAnimationFrame, only to
// show frames: the one-second timer still runs, H9). Nothing here throws on missing data: a
// countdown with nothing to count to hides its clock; a run time CTD Relay can't give shows "—".
//
// Data: stream.clock from CTD Relay (02 §2.5.2: the stream's start on this server's clock, its
// frame rate, and the offset to CTD Relay's clock); show.goLiveAt and show.recStartedAt when the
// countdown or count-up has no time of its own; show.timezone, which the time zone setting follows.
// Sample data (?mock=1) fills empty lines and an empty label, so a preview is never blank.
(() => {
  'use strict';
  if (!window.SK || !window.TextClock) return;
  const C = window.TextClock;
  const MODES = ['none', 'time', 'countdown', 'countup', 'runtime', 'timecode'];
  const POSITIONS = {
    'top-left': ['start', 'start'], top: ['start', 'center'], 'top-right': ['start', 'end'],
    left: ['center', 'start'], center: ['center', 'center'], right: ['center', 'end'],
    'bottom-left': ['end', 'start'], bottom: ['end', 'center'], 'bottom-right': ['end', 'end'],
  };
  const ALIGN = { start: 'left', center: 'center', end: 'right' };
  const SAMPLE_LINES = ['MIAMI OR BUST', 'Road to Miami · Day 3', ''];
  const SAMPLE_LABEL = { time: 'LOCAL TIME', countdown: 'STARTING IN', countup: 'ON AIR FOR', runtime: 'ON AIR FOR', timecode: 'TIMECODE' };
  const DASH = '—';
  const COLOR = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

  let s = {};
  let els = null;
  let secondTimer = 0;
  let frameReq = 0;
  let liteTimer = 0;
  let zeroAt = null; // { at, cancel }: a countdown's exact end, armed on server time
  let wasZero = null; // null: not painted since the settings changed
  let warned = false;

  const str = (v) => (typeof v === 'string' ? v : '');
  const num = (x) => typeof x === 'number' && isFinite(x);
  const mode = () => (MODES.indexOf(s.mode) >= 0 ? s.mode : 'countdown');
  const zone = () => C.zone(str(s.timezone).trim());
  const isMock = () => SK.transport.mode === 'mock';

  function find() {
    const root = document.querySelector('[data-tc]');
    if (!root) return null;
    return {
      root,
      box: root.querySelector('[data-box]'),
      lines: [1, 2, 3].map((n) => root.querySelector('[data-line="' + n + '"]')),
      wrap: root.querySelector('[data-clockwrap]'),
      label: root.querySelector('[data-label]'),
      clock: root.querySelector('[data-clock]'),
    };
  }

  // CTD Relay's stream clock (02 §2.5.2), checked: anything odd is treated as absent.
  function relay() {
    const v = SK.state('stream.clock');
    if (!v || typeof v !== 'object') return undefined;
    return {
      startedAt: num(v.startedAt) ? v.startedAt : undefined,
      fps: num(v.fps) && v.fps >= 1 && v.fps <= 240 ? Math.round(v.fps) : 30,
      offsetMs: num(v.offsetMs) ? v.offsetMs : 0,
    };
  }

  // The instant a countdown runs to (or a count-up runs from): the date and time set, a time alone
  // on its nearest day, else the show's go-live (or when it went live).
  function target(now, toward) {
    const date = str(s.targetDate);
    const time = str(s.targetTime);
    if (date) return C.zonedTime(date, time || '00:00', zone());
    if (time) return C.nearest(time, zone(), now);
    const v = SK.state(toward ? 'show.goLiveAt' : 'show.recStartedAt');
    return num(v) ? v : undefined;
  }

  // What the clock shows at server time t: { text } (undefined: nothing to show), zero for a
  // countdown that has arrived, at for its end.
  function reading(t) {
    switch (mode()) {
      case 'time':
        return { text: C.timeOfDay(t, zone(), { hour12: s.hour12 !== false, seconds: s.seconds !== false }) };
      case 'countdown': {
        const at = target(t, true);
        if (at === undefined) return {};
        if (t >= at) return { text: str(s.atZero).trim() || C.duration(0), zero: true };
        return { text: C.duration(at - t, { ceil: true }), at };
      }
      case 'countup': {
        const at = target(t, false);
        return { text: at === undefined ? undefined : C.duration(t - at) };
      }
      case 'runtime': {
        const r = relay();
        const from = r && r.startedAt !== undefined ? r.startedAt : target(t, false);
        return { text: from === undefined ? DASH : C.duration(t - from) };
      }
      case 'timecode': {
        const r = relay();
        const fps = r ? r.fps : 30;
        const relayNow = t + (r ? r.offsetMs : 0); // CTD Relay's clock, as its own timecodes are
        if (s.timecodeSource === 'utc') return { text: C.timecodeOfDay(relayNow, 'UTC', fps) };
        if (s.timecodeSource === 'local') return { text: C.timecodeOfDay(relayNow, zone(), fps) };
        return { text: r && r.startedAt !== undefined ? C.timecode(t - r.startedAt, fps) : DASH };
      }
      default:
        return {};
    }
  }

  function paint() {
    if (!els || !els.root.isConnected) els = find();
    if (!els) return;
    const t = SK.clock.now();
    let r;
    try {
      r = reading(t);
    } catch (err) {
      r = { text: DASH };
      if (!warned) {
        warned = true;
        SK.log.warn('the clock could not be worked out', { err: String((err && err.message) || err) });
      }
    }
    const shown = mode() !== 'none' && typeof r.text === 'string';
    els.wrap.hidden = !shown;
    if (shown && els.clock.textContent !== r.text) els.clock.textContent = r.text;
    els.clock.setAttribute('data-at', String(Math.round(t)));
    // Arrived while showing: one short flash (CSS); a page opened after it just shows it.
    const zero = r.zero === true;
    if (zero !== wasZero) {
      els.wrap.classList.toggle('zero', zero);
      els.wrap.classList.toggle('arrived', zero && wasZero === false);
      wasZero = zero;
    }
    // A countdown ends on its own instant, not at the next second's paint.
    if (r.at !== undefined && (!zeroAt || zeroAt.at !== r.at)) {
      if (zeroAt) zeroAt.cancel();
      zeroAt = { at: r.at, cancel: SK.clock.at(r.at, paint) };
    }
    els.box.hidden = els.wrap.hidden && els.lines.every((l) => l.hidden);
  }

  function stopTicking() {
    clearTimeout(secondTimer);
    clearInterval(liteTimer);
    if (frameReq) cancelAnimationFrame(frameReq);
    secondTimer = liteTimer = frameReq = 0;
  }
  // Once a second on the server's second boundary; a timecode once a frame as well (a phone
  // preview, lite, ten times a second).
  function startTicking() {
    stopTicking();
    if (mode() === 'none') return;
    const second = () => {
      paint();
      const n = SK.clock.now();
      secondTimer = setTimeout(second, 1000 - (((n % 1000) + 1000) % 1000) + 1);
    };
    second();
    if (mode() === 'timecode') {
      if (SK.env.lite) {
        liteTimer = setInterval(paint, 100);
      } else {
        const frame = () => {
          paint();
          frameReq = requestAnimationFrame(frame);
        };
        frameReq = requestAnimationFrame(frame);
      }
    }
  }

  function apply() {
    s = SK.settings || {};
    els = find();
    if (!els) return;
    const css = document.documentElement.style;
    const color = (v, fallback) => (COLOR.test(str(v)) ? v : fallback);
    const int = (v, lo, hi, fallback) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
    css.setProperty('--tc-color', color(s.color, '#ffffff'));
    css.setProperty('--tc-accent', color(s.accent, '#16e0ff'));
    css.setProperty('--tc-size', int(s.size, 20, 160, 56) + 'px');
    css.setProperty('--tc-clock-size', int(s.clockSize, 20, 240, 88) + 'px');
    css.setProperty('--tc-pill', 'rgba(8, 10, 12, ' + int(s.pillOpacity, 0, 100, 70) / 100 + ')');

    const [v, h] = POSITIONS[s.position] || POSITIONS['bottom-left'];
    const root = els.root;
    root.setAttribute('data-v', v);
    root.setAttribute('data-h', h);
    root.setAttribute('data-align', ['left', 'center', 'right'].indexOf(s.align) >= 0 ? s.align : ALIGN[h]);
    root.setAttribute('data-font', ['sans', 'condensed', 'mono'].indexOf(s.font) >= 0 ? s.font : 'sans');
    root.setAttribute('data-clock-font', ['sans', 'condensed', 'mono'].indexOf(s.clockFont) >= 0 ? s.clockFont : 'mono');
    root.classList.toggle('pill', s.pill !== false);
    root.classList.toggle('shadow', s.shadow !== false);
    els.wrap.classList.toggle('below', s.labelPosition === 'below');
    els.wrap.setAttribute('data-mode', mode());

    let lines = [s.line1, s.line2, s.line3].map((x) => str(x).trim());
    if (isMock() && lines.every((x) => !x)) lines = SAMPLE_LINES.slice();
    lines.forEach((text, i) => {
      els.lines[i].textContent = text;
      els.lines[i].hidden = !text;
    });
    const label = str(s.label).trim() || (isMock() ? SAMPLE_LABEL[mode()] || '' : '');
    els.label.textContent = label;
    els.label.hidden = !label;

    if (zeroAt) { zeroAt.cancel(); zeroAt = null; }
    wasZero = null;
    els.wrap.classList.remove('zero', 'arrived');
    els.clock.textContent = '';
    startTicking();
    paint();
  }

  SK.ready(() => {
    apply();
    SK.onSettings(apply);
    SK.onScene(apply);
    for (const key of ['stream.clock', 'show.goLiveAt', 'show.recStartedAt']) SK.onState(key, paint);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) paint(); });
  });
})();
