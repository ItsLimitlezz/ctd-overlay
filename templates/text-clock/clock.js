// Text & Clock: the arithmetic, apart from the page (tests run it on their own). Every function
// takes the time it shows as an argument (server time from SK.clock.now(), epoch ms), never reads
// a clock itself, and never throws on missing or odd input: it answers undefined instead.
//
//   TextClock.zone(tz)                         a time zone the browser knows, or undefined (its own)
//   TextClock.timeOfDay(t, tz, { hour12, seconds })    "8:59:56 PM", "20:59:56", "20:59"
//   TextClock.duration(ms, { ceil })           "12:05", "1:02:03", "2d 03:04:05" (never negative)
//   TextClock.timecode(ms, fps)                "02:03:04:15": HH:MM:SS:FF, non-drop-frame, hours past 24
//   TextClock.timecodeOfDay(t, tz, fps)        the time of day in tz as a timecode
//   TextClock.zonedTime(date, time, tz)        "2026-10-17" + "21:00" in tz → epoch ms
//   TextClock.nearest(time, tz, now)           "21:00" in tz on the day that puts it nearest to now
(function (root) {
  'use strict';
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  const zones = new Map(); // tz → Intl.DateTimeFormat (h23), or null when the browser doesn't know it

  function formatter(tz) {
    const key = tz || '';
    if (!zones.has(key)) {
      try {
        zones.set(key, new Intl.DateTimeFormat('en-US', {
          timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        }));
      } catch (err) {
        zones.set(key, null); // not a zone this browser knows
      }
    }
    return zones.get(key);
  }

  // A zone name the browser knows (America/New_York, UTC), else undefined: the browser's own.
  function zone(tz) {
    return typeof tz === 'string' && tz && formatter(tz) ? tz : undefined;
  }

  // The wall clock in tz at t: { y, mo, d, h, mi, s, ms }.
  function wall(t, tz) {
    const f = formatter(zone(tz)) || formatter('');
    const parts = {};
    for (const p of f.formatToParts(new Date(t))) parts[p.type] = p.value;
    return {
      y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day),
      h: Number(parts.hour) % 24, mi: Number(parts.minute), s: Number(parts.second), ms: ((t % 1000) + 1000) % 1000,
    };
  }

  const finite = (x) => typeof x === 'number' && isFinite(x);

  function timeOfDay(t, tz, opts) {
    if (!finite(t)) return undefined;
    const o = opts || {};
    const w = wall(t, tz);
    const tail = (o.seconds === false ? '' : ':' + pad(w.s));
    if (o.hour12) return (w.h % 12 || 12) + ':' + pad(w.mi) + tail + (w.h < 12 ? ' AM' : ' PM');
    return pad(w.h) + ':' + pad(w.mi) + tail;
  }

  // A length of time: "MM:SS" under an hour, "H:MM:SS" under a day, "Nd HH:MM:SS" after.
  // ceil: a countdown shows 00:01 through its last second and reaches 00:00 at the instant.
  function duration(ms, opts) {
    if (!finite(ms)) return undefined;
    const total = Math.max(0, (opts && opts.ceil ? Math.ceil(ms / 1000) : Math.floor(ms / 1000)));
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    if (h >= 24) return Math.floor(h / 24) + 'd ' + pad(h % 24) + ':' + pad(m) + ':' + pad(s);
    if (h > 0) return h + ':' + pad(m) + ':' + pad(s);
    return pad(m) + ':' + pad(s);
  }

  const rate = (fps) => (finite(fps) && fps >= 1 && fps <= 240 ? Math.round(fps) : 30);

  // CTD Relay's rule (its §4): frames = floor((ms mod 1000) × fps / 1000); hours keep counting.
  function timecode(ms, fps) {
    if (!finite(ms)) return undefined;
    const r = rate(fps);
    const t = Math.max(0, Math.floor(ms));
    const sec = Math.floor(t / 1000);
    const ff = Math.min(r - 1, Math.floor(((t % 1000) * r) / 1000));
    return pad(Math.floor(sec / 3600)) + ':' + pad(Math.floor(sec / 60) % 60) + ':' + pad(sec % 60) + ':' + pad(ff);
  }

  function timecodeOfDay(t, tz, fps) {
    if (!finite(t)) return undefined;
    const r = rate(fps);
    const w = wall(t, tz);
    return pad(w.h) + ':' + pad(w.mi) + ':' + pad(w.s) + ':' + pad(Math.min(r - 1, Math.floor((w.ms * r) / 1000)));
  }

  // How far tz's wall clock is ahead of UTC at t, in ms.
  function offsetAt(t, tz) {
    const w = wall(t, tz);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - (t - (((t % 1000) + 1000) % 1000));
  }

  const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const TIME = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

  // A wall time in tz as an instant. In a clock change's gap it lands after the change; in its
  // overlap, on the first of the two.
  function zonedTime(date, time, tz) {
    const d = DATE.exec(typeof date === 'string' ? date : '');
    const h = TIME.exec(typeof time === 'string' && time ? time : '00:00');
    if (!d || !h) return undefined;
    const asUtc = Date.UTC(+d[1], +d[2] - 1, +d[3], +h[1], +h[2], +(h[3] || 0));
    const check = new Date(asUtc);
    if (!finite(asUtc) || check.getUTCMonth() !== +d[2] - 1 || check.getUTCDate() !== +d[3] || +h[1] > 23 || +h[2] > 59 || +(h[3] || 0) > 59) return undefined;
    const first = asUtc - offsetAt(asUtc, tz);
    const second = asUtc - offsetAt(first, tz);
    return Math.min(first, second) + offsetAt(Math.min(first, second), tz) === asUtc ? Math.min(first, second) : Math.max(first, second);
  }

  // A time with no date: on the day (yesterday, today or tomorrow in tz) that puts it nearest to
  // now, so "21:00" counts down through the day and stays reached until the next morning.
  function nearest(time, tz, now) {
    if (!finite(now) || !TIME.test(typeof time === 'string' ? time : '')) return undefined;
    let best;
    for (const dayMs of [-86400000, 0, 86400000]) {
      const w = wall(now + dayMs, tz);
      const at = zonedTime(w.y + '-' + pad(w.mo) + '-' + pad(w.d), time, tz);
      if (at !== undefined && (best === undefined || Math.abs(at - now) < Math.abs(best - now))) best = at;
    }
    return best;
  }

  root.TextClock = Object.freeze({ zone, timeOfDay, duration, timecode, timecodeOfDay, zonedTime, nearest });
})(globalThis);
