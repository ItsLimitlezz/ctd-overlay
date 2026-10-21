// CTD Relay's hub (its docs/API.md §9.2, v1.2), for the ctd-multistream connector: apps
// register what they offer there, so the CTD OBS plugin, connected only to CTD Relay, can
// add this platform's overlays as browser sources and ask for new ones.
//
// - Registration: PUT /apps/<appId> with every overlay bound to this connection ("all" counts),
//   one resource per canvas: its URL for OBS (absolute, key included), size, and meta { canvas:
//   landscape | vertical, slot, transparent }. slot is the overlay's role in OBS, the same for the
//   equivalent overlay of every profile: its "Role in OBS", else the template's short name, plus
//   the canvas ("takeover-landscape"). Sent again every 30 s (the hub counts an app offline after
//   90 s) and a second after overlays change (made, deleted, renamed, re-keyed, re-bound). At most
//   200 resources and 256 KB: past that, the first ones (by slug) and a warning. appId:
//   ctd-overlay-<profile slug> for a token limited to one profile, ctd-overlay for one that reads
//   every profile; only the token that registered an id may update it (409 app_owned: a warning
//   saying where to delete the old one). Its id is remembered so deleting or turning off the
//   connection unregisters it (the definition's retire). Each resource's profileId: the profile
//   followed; following every profile, one resource per profile an overlay is fed by (its
//   "<connection>/<profile>" bindings, or every profile followed now when bound whole or "all"),
//   id "<overlay id>:<canvas id>:<profile id>": the OBS plugin lists a profile's overlays by
//   profileId (its §9.2), never unassigned ones. Registered again when the profiles change.
// - Messages (app.message to this app id): overlay.create { template, canvas? } makes an overlay
//   from an installed template (its id, or its short name or name), bound to this connection only
//   (following every profile: to the message's profileId, "<connection>/<profile>", or the whole
//   connection when it names none), when "Let other apps create overlays" is on; it is registered at once, then
//   the answer goes back: overlay.created { ok: true, resource } (the canvas asked for) or
//   { ok: true, resources } (every canvas). Every request addressed here gets an answer, refusals
//   included ({ ok: false, reason } in plain words; "error" for a type it doesn't handle);
//   broadcasts and replies are never answered. At most 10 overlays a minute, and 100 answers (the
//   hub takes 120 a minute per token); each message is handled once, across restarts too.
//
// The URLs carry the overlays' keys: they go to this hub only, which the owner set up on their
// network for exactly this (07 §7.6).
import { shortName } from '../share.js';

export const APP_ID = /^[a-z0-9-]{1,40}$/;
const EVERY_MS = 30000;
const SOON_MS = 1000;
const MAX_RESOURCES = 200;
const MAX_BODY = 256 * 1024;
const REPLIES_PER_MINUTE = 100;
const MAKES_PER_MINUTE = 10;
const HANDLED_KEEP = 50;
const QUEUE_MAX = 100;

const str = (v) => typeof v === 'string' && v.length > 0;
const tidy = (s, n) => String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, n).replace(/-+$/, '');

// The app id this connection registers under: one per profile-limited token, one for a token that
// reads every profile.
export function appIdFor({ limited, slug, id }) {
  const tail = limited ? tidy(slug || id, 28) : '';
  return tail ? `ctd-overlay-${tail}` : 'ctd-overlay';
}

// One overlay's resources, one per canvas that has a URL, assigned to profileId. tag: the profile,
// in the id ("<overlay id>:<canvas id>:<profile id>"), when the connection follows every profile
// (the same overlay may be registered for several).
export function resourcesOf(item, profileId, { tag } = {}) {
  const base = item.role || tidy(shortName(item.template?.id), 54) || 'overlay';
  const canvases = (item.canvases || []).filter((c) => str(c.url));
  const labels = canvases.map((c) => c.label || c.kind);
  const seen = new Map();
  return canvases.map((c, i) => {
    const n = (seen.get(c.kind) || 0) + 1;
    seen.set(c.kind, n);
    const label = labels.filter((l) => l === labels[i]).length > 1 ? `${labels[i]} (${c.id})` : labels[i];
    return {
      type: 'overlay',
      id: `${item.id}:${c.id}${tag ? `:${tag}` : ''}`.slice(0, 100),
      name: `${item.slug} — ${label}`.slice(0, 120),
      profileId: profileId ?? null,
      url: c.url,
      width: c.width,
      height: c.height,
      meta: { canvas: c.kind, slot: `${base}-${c.kind}${n > 1 ? `-${n}` : ''}`.slice(0, 64).replace(/-+$/, ''), transparent: true },
    };
  });
}

// request: the connector's (token, address, TLS pin); onChange(): its health and info changed;
// reauth(): the token was refused; isOld(env): a message replayed after being away too long.
// The resources a connection registers for the overlays it feeds (ctx.overlays.list() items):
// following one profile, every overlay's is that profile's. Following every profile, each is
// registered once per profile it is fed by, assigned to it (the OBS plugin lists a profile's
// overlays by profileId, GET /profiles/{id}/overlays, never the unassigned ones): bound to some of
// its profiles, those; bound to the whole connection (or "all"), every profile it follows now
// (profiles). The same URL, canvas and slot for each.
export function resourcesFor(items, { every, profileId, profiles = [] }) {
  return items.flatMap((item) => {
    if (!every) return resourcesOf(item, profileId);
    const list = Array.isArray(item.profiles) ? item.profiles : profiles;
    return list.flatMap((p) => resourcesOf(item, p, { tag: p }));
  });
}

// every: the connection follows every profile (profileId null); profileOf(id): { id, slug? } of a
// profile it follows then, or undefined; profiles(): the ids of every profile it follows now.
export function createHub(ctx, { request, appId, profileId, profileSlug, every = false, profileOf = () => undefined, profiles = () => [], version, allowMaking, isOld, onChange, reauth }) {
  let warning;
  let busy = null; // the registration under way
  let next = null; // the one asked for while it was
  let soonTimer = null;
  let off = null;
  let stopped = false;
  const queue = []; // answers waiting for room under the hub's limit
  const sent = []; // when the last minute's answers went
  const made = []; // when the last minute's overlays were made
  let flushing = false;
  let flushLater = null;

  const show = (info, warn) => {
    warning = warn;
    ctx.setInfo('hub', { appId, ...info });
    onChange();
  };

  // ---- registration ----------------------------------------------------------------------------
  function payload() {
    const all = resourcesFor(ctx.overlays.list(), { every, profileId, profiles: profiles() });
    const body = (resources) => ({
      name: 'CTD Overlay', kind: 'ctd-overlay', version,
      ...(ctx.overlays.baseUrl ? { baseUrl: ctx.overlays.baseUrl } : {}),
      capabilities: ['overlays', 'overlay.create'], resources,
    });
    let kept = all.slice(0, MAX_RESOURCES);
    while (kept.length && Buffer.byteLength(JSON.stringify(body(kept))) > MAX_BODY) kept = kept.slice(0, Math.floor(kept.length * 0.9));
    return { body: body(kept), total: all.length, kept: kept.length, overlays: new Set(kept.map((r) => r.id.split(':')[0])).size };
  }

  async function put() {
    const p = payload();
    let r;
    try {
      r = await request(`/apps/${appId}`, { method: 'PUT', json: p.body, acceptStatus: (s) => s !== 401 && s < 500 });
    } catch (err) {
      if (stopped) return;
      if (err.status === 401) { reauth(); return; }
      show({ status: 'failed', detail: `Couldn't reach it (${err.message})` }, `Sharing overlays with the OBS plugin through CTD Relay failed (${err.message}); trying again in 30 s.`);
      return;
    }
    if (stopped) return;
    if (r.status >= 400) {
      const code = r.data?.code;
      const said = str(r.data?.detail) ? r.data.detail.slice(0, 200) : `it answered ${r.status}`;
      if (r.status === 404) { show({ status: 'off', detail: 'This CTD Relay has no hub to share overlays through (it is older than v1.2).' }); return; }
      const why = code === 'app_owned' ? `Another CTD Relay token already registered the app "${appId}", so the OBS plugin can't see these overlays. In CTD Relay → Settings → API, delete the old "${appId}" app (or revoke the token that made it): this connection registers again within 30 s.`
        : code === 'limit' ? 'CTD Relay has as many apps registered as it allows, so these overlays aren\'t shared with the OBS plugin: remove apps you no longer use in its Settings → API.'
          : code === 'missing_scope' ? 'The token can\'t share overlays with the OBS plugin (it lacks apps:write): Connect again to get one that can.'
            : `CTD Relay refused the overlay list for the OBS plugin: ${said}`;
      show({ status: 'failed', detail: why }, why);
      return;
    }
    ctx.memory.set('hubApp', appId);
    const notes = [];
    if (!ctx.overlays.baseUrl) notes.push(`The OBS plugin sees no overlay URLs: ${ctx.overlays.baseProblem}`);
    if (p.kept < p.total) notes.push(`Only ${p.kept} of ${p.total} overlay URLs are shared with the OBS plugin: CTD Relay takes ${MAX_RESOURCES} per app. Bind fewer overlays to this connection.`);
    show({ status: 'shared', overlays: p.overlays, resources: p.kept, at: new Date(ctx.now()).toISOString() }, notes[0]);
  }

  // Registers now; a call while one is under way runs once more after it, so what it sends is
  // never older than the call.
  function register() {
    if (stopped) return Promise.resolve();
    if (busy) {
      next ??= busy.then(() => { next = null; return register(); });
      return next;
    }
    busy = put().catch((err) => ctx.log.warn('the overlays could not be registered', { err: err.message })).finally(() => { busy = null; });
    return busy;
  }

  function soon() {
    if (soonTimer || stopped) return;
    soonTimer = ctx.schedule(SOON_MS, () => { soonTimer = null; register(); });
  }

  // ---- messages --------------------------------------------------------------------------------
  const handled = () => (Array.isArray(ctx.memory.get('hubHandled')) ? ctx.memory.get('hubHandled') : []);
  const recent = (list) => { const t = ctx.now(); while (list.length && t - list[0] >= 60000) list.shift(); return list; };

  async function handle(m, env) {
    if (!m || typeof m !== 'object' || !str(m.id) || !str(m.type) || !str(m.from)) return;
    // Only requests addressed here: broadcasts and replies aren't answered (no ping-pong).
    if (m.to !== appId || m.from === appId || m.replyTo) return;
    const seen = handled();
    if (seen.includes(m.id)) return;
    ctx.memory.set('hubHandled', [...seen, m.id].slice(-HANDLED_KEEP));
    const about = str(m.profileId) ? m.profileId : null;
    if (about && profileId && about !== profileId) return answer(m, { ok: false, reason: 'This CTD Overlay connection follows another CTD Relay profile.' });
    const feed = every && about ? profileOf(about) : undefined;
    if (every && about && !feed) return answer(m, { ok: false, reason: `CTD Overlay doesn't follow a CTD Relay profile "${about.slice(0, 100)}" (yet): try again in a moment.` });
    if (m.type !== 'overlay.create') return answer(m, { ok: false, reason: `CTD Overlay doesn't handle ${m.type.slice(0, 64)}.` });
    if (isOld(env)) return answer(m, { ok: false, reason: 'CTD Overlay wasn\'t connected when this was asked: ask again.' });
    if (!allowMaking()) return answer(m, { ok: false, reason: 'Making overlays from other apps is turned off in CTD Overlay (the "Let other apps create overlays" setting of its CTD Relay connection).' });
    if (!ctx.overlays.baseUrl) return answer(m, { ok: false, reason: `CTD Overlay doesn't know the address OBS would open it at: ${ctx.overlays.baseProblem}` });
    if (recent(made).length >= MAKES_PER_MINUTE) return answer(m, { ok: false, reason: `CTD Overlay makes at most ${MAKES_PER_MINUTE} overlays a minute for other apps: ask again in a minute.` });
    const d = m.data && typeof m.data === 'object' && !Array.isArray(m.data) ? m.data : {};
    let item;
    try {
      // Following every profile: bound to the profile it was asked for (to every profile when
      // it names none); else to this connection, which follows one.
      item = ctx.overlays.create({
        template: d.template, canvas: d.canvas ?? undefined, from: m.from,
        slugBase: every ? (feed ? feed.slug || feed.id : undefined) : profileSlug,
        ...(feed ? { profile: feed.id } : {}),
      });
    } catch (err) {
      return answer(m, { ok: false, reason: String(err.message || 'It could not be made.').slice(0, 300) });
    }
    made.push(ctx.now());
    // Registered before the answer, so the hub lists it when the answer arrives.
    await register();
    const list = resourcesFor([item], { every, profileId, profiles: profiles() });
    const want = every ? (feed ? `${item.id}:${item.canvas}:${feed.id}`.slice(0, 100) : undefined) : `${item.id}:${item.canvas}`;
    const one = item.canvas && want ? list.find((r) => r.id === want) : undefined;
    return answer(m, { ok: true, ...(one ? { resource: one } : { resources: list }) });
  }

  function answer(m, data) {
    if (queue.length >= QUEUE_MAX) {
      ctx.log.warn('too many answers to other apps are waiting; this one was dropped', { to: m.from, type: m.type });
      return;
    }
    const about = str(m.profileId) ? m.profileId : profileId ?? null;
    queue.push({ to: m.from, from: appId, type: m.type === 'overlay.create' ? 'overlay.created' : 'error', profileId: about, replyTo: m.id, data });
    flush();
  }

  async function flush() {
    if (flushing || stopped) return;
    flushing = true;
    try {
      while (queue.length && !stopped) {
        if (recent(sent).length >= REPLIES_PER_MINUTE) {
          if (!flushLater) flushLater = ctx.schedule(Math.max(100, sent[0] + 60000 - ctx.now()), () => { flushLater = null; flush(); });
          return;
        }
        const body = queue.shift();
        sent.push(ctx.now());
        try {
          await request('/messages', { method: 'POST', json: body, retries: 0 });
        } catch (err) {
          ctx.log.warn('an answer to another app could not be sent', { to: body.to, type: body.type, err: err.message });
        }
      }
    } finally {
      flushing = false;
    }
  }

  return {
    get warning() { return warning; },
    start() {
      off = ctx.overlays.onChange(soon);
      show({ status: 'starting' });
      register();
      ctx.every(EVERY_MS, () => { register(); });
    },
    stop() {
      stopped = true;
      off?.();
    },
    // An app.message event's data, with its envelope (for its age).
    message(m, env) {
      handle(m, env).catch((err) => ctx.log.warn('a message from another app could not be handled', { err: err.message }));
    },
    soon,
  };
}
