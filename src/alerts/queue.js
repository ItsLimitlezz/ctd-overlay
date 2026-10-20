// The alert queue (05 §5.5): alerts arrive in bursts, and the server, not the browser, paces them.
// One queue per show (its members show the same alert at the same moment) or per overlay outside
// a show. Each alert, when its turn comes, gets a display window ({ startAt, durationMs }, server
// time) and goes to the overlays of its queue that accept it; the runtime shows it in that window.
//
// - Pace: the members' alerts settings (mode, durationMs or its durationSetting, gapMs,
//   maxConcurrent, maxQueue, coalesce), the longest duration and gap among them. `serial` shows one
//   at a time; `stack` up to maxConcurrent.
// - Order: by priority (raid, superchat/tip, gift, subscription, membership, cheer/kicks, follow),
//   then by arrival. Past maxQueue, the oldest of the lowest priority is dropped.
// - Coalescing: a gift burst is one alert. Twitch sends a gift of 25 subs as one gift of 25 and
//   then 25 gifts of one (CTD Relay maps both to alert.gift): gifts from one person on one
//   platform waiting in the queue merge (the count is the larger of the bulk gift and the singles),
//   and singles arriving just after their bulk gift went on screen are part of it, not 25 more
//   alerts.
// - Each window starts LEAD_MS after it is sent, so every member (and a horizontal and a vertical
//   source) has it before it starts.
// - pause() holds alerts (they keep queueing); resume() goes on; skip(queue) ends what is on
//   screen (alerts.cut); replay(queue) queues the last one shown again.

const LEAD_MS = 400;
const RECENT_GIFT_MS = 15000;
const PRIORITY = { raid: 0, superchat: 1, tip: 1, gift: 2, subscription: 3, membership: 4, cheer: 5, kicks: 5, follow: 6 };
const DEFAULTS = { mode: 'serial', durationMs: 6000, gapMs: 500, maxConcurrent: 3, maxQueue: 50, coalesce: true };

const prio = (env) => PRIORITY[env.data?.kind] ?? 7;
const clampMs = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// What an overlay's template says about alerts, with its settings applied (durationSetting).
export function alertSpec(manifest, settings = {}) {
  const a = { ...DEFAULTS, ...(manifest?.alerts || {}) };
  let durationMs = Number(a.durationMs) > 0 ? Number(a.durationMs) : DEFAULTS.durationMs;
  if (a.durationSetting) {
    const v = Number(settings[a.durationSetting]);
    if (v > 0) durationMs = clampMs(v, 1000, 60000);
  }
  return {
    mode: a.mode === 'stack' ? 'stack' : 'serial',
    durationMs,
    gapMs: Number(a.gapMs) >= 0 ? Number(a.gapMs) : DEFAULTS.gapMs,
    maxConcurrent: Number.isInteger(a.maxConcurrent) && a.maxConcurrent > 0 ? a.maxConcurrent : DEFAULTS.maxConcurrent,
    maxQueue: Number.isInteger(a.maxQueue) && a.maxQueue > 0 ? a.maxQueue : DEFAULTS.maxQueue,
    coalesce: a.coalesce !== false,
  };
}

// A gift's count: amount.value (or gift.total), 1 when neither says.
const giftCount = (data) => {
  const v = Number(data?.amount?.value);
  if (Number.isInteger(v) && v > 0) return v;
  const t = Number(data?.gift?.total);
  return Number.isInteger(t) && t > 0 ? t : 1;
};
const giftKey = (env) => (env.data?.kind === 'gift' && env.data.user && !env.data.user.anonymous && (env.data.user.id || env.data.user.name)
  ? `${env.src?.platform || env.data.platform || ''}|${env.data.user.id || env.data.user.name}` : undefined);

// groupOf(channelId) → the queue's key (a show's id, else the overlay's own);
// specOf(channelId) → alertSpec() for that overlay, or undefined when it has none;
// deliver(channelId, env) → sends env to that channel if it is still there and accepts it;
// cut(channelIds, alertId) → publishes alerts.cut to those channels;
// stamp(env, data) → a new envelope of env's type and source with this data, a fresh id and time:
// an alert goes out when its turn comes, and a channel replays by id order (Last-Event-ID), so an
// id from when it arrived would sort before what was sent meanwhile and be skipped on a resume.
export function createAlertQueue({ groupOf, specOf, deliver, cut, stamp, now = Date.now, timers = { setTimeout, clearTimeout }, log } = {}) {
  const queues = new Map(); // group → { waiting: [], showing: Map(id → { env, endsAt, targets }), last, timer, members: Set }
  let paused = false;
  let seq = 0;

  function queueOf(group) {
    let q = queues.get(group);
    if (!q) {
      q = { group, waiting: [], showing: new Map(), last: undefined, timer: undefined, members: new Set(), recentGifts: new Map(), freeAt: 0 };
      queues.set(group, q);
    }
    return q;
  }

  // The group's pace: the longest duration and gap among the members that take alerts.
  function paceOf(q) {
    let pace;
    for (const id of q.members) {
      const s = specOf(id);
      if (!s) continue;
      if (!pace) { pace = { ...s }; continue; }
      pace.durationMs = Math.max(pace.durationMs, s.durationMs);
      pace.gapMs = Math.max(pace.gapMs, s.gapMs);
      if (s.mode === 'serial') pace.mode = 'serial';
      pace.maxConcurrent = Math.min(pace.maxConcurrent, s.maxConcurrent);
      pace.maxQueue = Math.min(pace.maxQueue, s.maxQueue);
      pace.coalesce = pace.coalesce && s.coalesce;
    }
    return pace || { ...DEFAULTS };
  }

  function mergeGift(into, env) {
    const d = into.env.data;
    const count = giftCount(env.data);
    if (count > 1) into.bulk = Math.max(into.bulk, count);
    else into.singles += 1;
    const recipients = [...(d.gift?.recipients || []), ...(env.data.gift?.recipients || [])].slice(0, 100);
    const total = Math.max(into.bulk, into.singles);
    into.env = { ...into.env, data: { ...d, amount: { ...(d.amount || {}), value: total, unit: 'count' }, gift: { ...(d.gift || {}), recipients, total }, coalesced: (d.coalesced || 1) + (env.data.coalesced || 1) } };
  }

  // An alert for the channels that accept it (the bus asks only for alert.* events).
  function enqueue(env, channelIds) {
    const byGroup = new Map();
    for (const id of channelIds) {
      if (!specOf(id)) { deliver(id, env); continue; } // takes alerts without a template spec: as is
      const g = groupOf(id) ?? id;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(id);
    }
    for (const [group, targets] of byGroup) {
      const q = queueOf(group);
      for (const id of targets) q.members.add(id);
      const pace = paceOf(q);
      const key = pace.coalesce ? giftKey(env) : undefined;
      if (key) {
        // Singles following a bulk gift already on screen (or just shown) belong to it.
        const recent = q.recentGifts.get(key);
        if (recent && now() - recent.at < RECENT_GIFT_MS && giftCount(env.data) === 1 && recent.absorbed < recent.bulk) {
          recent.absorbed += 1;
          continue;
        }
        const waiting = q.waiting.find((w) => w.giftKey === key);
        if (waiting) {
          mergeGift(waiting, env);
          continue;
        }
      }
      const count = key ? giftCount(env.data) : 0;
      q.waiting.push({ env, targets, giftKey: key, bulk: count > 1 ? count : 0, singles: key && count === 1 ? 1 : 0, prio: prio(env), seq: ++seq });
      if (q.waiting.length > pace.maxQueue) {
        // Drop the oldest of the lowest priority.
        let worst = 0;
        q.waiting.forEach((w, i) => { if (w.prio > q.waiting[worst].prio || (w.prio === q.waiting[worst].prio && w.seq < q.waiting[worst].seq)) worst = i; });
        const [dropped] = q.waiting.splice(worst, 1);
        log?.warn('alert queue full: dropped an alert', { group, kind: dropped.env.data?.kind });
      }
      pump(q);
    }
  }

  // Shows what can be shown now, and wakes when the next slot frees.
  function pump(q) {
    if (q.timer) { timers.clearTimeout(q.timer); q.timer = undefined; }
    const t = now();
    for (const [id, s] of q.showing) if (s.endsAt <= t) q.showing.delete(id);
    if (paused || !q.waiting.length) return;
    const pace = paceOf(q);
    const slots = pace.mode === 'stack' ? pace.maxConcurrent : 1;
    while (q.waiting.length && q.showing.size < slots && q.freeAt <= t) {
      q.waiting.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
      const item = q.waiting.shift();
      const startAt = t + LEAD_MS;
      const display = { startAt, durationMs: pace.durationMs };
      const env = stamp(item.env, { ...item.env.data, display });
      const endsAt = startAt + pace.durationMs + pace.gapMs;
      q.showing.set(env.id, { env, endsAt, targets: item.targets });
      q.last = item;
      // serial: the next one waits for this one to end; stack: for the gap only.
      q.freeAt = pace.mode === 'stack' ? t + pace.gapMs : endsAt;
      if (item.giftKey) q.recentGifts.set(item.giftKey, { at: t, bulk: item.bulk, absorbed: item.singles });
      for (const id of item.targets) deliver(id, env);
    }
    for (const [k, r] of q.recentGifts) if (t - r.at >= RECENT_GIFT_MS) q.recentGifts.delete(k);
    if (!q.waiting.length) return;
    const ends = [...q.showing.values()].map((s) => s.endsAt);
    const next = Math.max(q.freeAt, q.showing.size >= slots ? Math.min(...ends) : t);
    q.timer = timers.setTimeout(() => { q.timer = undefined; pump(q); }, Math.max(10, next - t));
    q.timer.unref?.();
  }

  return {
    enqueue,
    get paused() { return paused; },
    pause() { paused = true; for (const q of queues.values()) if (q.timer) { timers.clearTimeout(q.timer); q.timer = undefined; } },
    resume() { paused = false; for (const q of queues.values()) pump(q); },
    // What each queue holds: for the admin UI and the API.
    list() {
      return [...queues.values()].map((q) => ({
        group: q.group,
        showing: [...q.showing.values()].filter((s) => s.endsAt > now()).map((s) => ({ id: s.env.id, kind: s.env.data.kind, user: s.env.data.user?.name, display: s.env.data.display })),
        waiting: [...q.waiting].sort((a, b) => a.prio - b.prio || a.seq - b.seq).map((w) => ({ id: w.env.id, kind: w.env.data.kind, user: w.env.data.user?.name })),
      }));
    },
    // Ends what is on screen in a queue (or every queue) now; the next one follows after the gap.
    skip(group) {
      for (const q of queues.values()) {
        if (group !== undefined && q.group !== group) continue;
        const t = now();
        for (const [id, s] of q.showing) {
          if (s.endsAt <= t) continue;
          cut(s.targets, id);
          q.showing.delete(id);
        }
        q.freeAt = t + paceOf(q).gapMs;
        pump(q);
      }
    },
    // Queues the last alert shown again (at the front of its priority).
    replay(group) {
      const q = [...queues.values()].find((x) => group === undefined || x.group === group);
      if (!q?.last) return false;
      q.waiting.push({ ...q.last, giftKey: undefined, seq: -(++seq) });
      pump(q);
      return true;
    },
    // A channel went away (an overlay deleted, moved to another show): forget it.
    forget(channelId) {
      for (const q of queues.values()) q.members.delete(channelId);
    },
    close() {
      for (const q of queues.values()) if (q.timer) timers.clearTimeout(q.timer);
      queues.clear();
    },
  };
}
