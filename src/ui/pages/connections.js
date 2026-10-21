// Connections (08 §8.1, §8.7): what feeds the overlays (CTD Relay now; Twitch, Kick,
// YouTube, Spotify and OBS in later versions), their status, and their setup.
//
//   #/connections                    every connection with its status, values and buttons; what
//                                    can be added; live from system.connection events
//   #/connections/new/:connector     the setup guide (warnings first, the steps, the exact redirect
//                                    URI to register, the scopes and why), then the settings form
//   #/connections/:id                one connection: status, signing in (a code to type, or a
//                                    redirect with "Finish sign-in" to paste the address landed on),
//                                    what it feeds, its actions, its settings
//
// A connector that pairs (auth 'pairing', CTD Relay) is set up with its address only and
// Connect: the code to approve at the service shows on the connection's page, with its countdown,
// until the service hands over the token; "Paste a token instead" keeps the whole form. Its info
// (what the running connection tells about itself) shows the profile it follows and what it shares
// with the OBS plugin; a setting marked x-skp-choices takes its options from info.choices.
//
// Seeing connections takes connections:read and changing them connections:write (owners and
// admins); operators see each one's status, from GET /api/v1/system/health. Secrets are password
// fields that are never filled in (the API never sends them); leaving one empty keeps it.
import * as api from '../api.js';
import { ago, badge, clock, confirm, copyField, dialog, empty, every, field, h, menu, mount, notice, pageHead, run, statusDot, toast } from '../dom.js';
import { schemaForm } from '../schema-form.js';
import { profileChip } from '../streams.js';

const STATUS = {
  connected: ['ok', 'Connected'],
  degraded: ['warn', 'Partly working'],
  connecting: ['warn', 'Connecting…'],
  'needs-reauth': ['danger', 'Needs signing in'],
  error: ['danger', 'Not working'],
  disabled: [undefined, 'Turned off'],
};
const FEEDS = { 'chat.read': 'Chat', alerts: 'Alerts', viewers: 'Viewer count', 'stream.status': 'Live status', music: 'Now playing', obs: 'OBS scenes' };
const PLATFORM = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick', facebook: 'Facebook', x: 'X', instagram: 'Instagram', tiktok: 'TikTok', spotify: 'Spotify', obs: 'OBS', custom: 'Other' };
// What later versions add, shown until a connector for it exists.
const COMING = [
  { id: 'twitch', name: 'Twitch', what: 'Viewer count, live status, chat and alerts' },
  { id: 'kick', name: 'Kick', what: 'Viewer count, live status, chat and alerts' },
  { id: 'youtube', name: 'YouTube', what: 'Viewer count, live status and chat' },
  { id: 'spotify', name: 'Spotify', what: 'Now playing' },
  { id: 'obs', name: 'OBS', what: 'Scenes follow OBS, and "Add to OBS" makes browser sources' },
  { id: 'webhooks', name: 'Webhooks and custom hooks', what: 'Other apps send events and state, or hear about yours' },
];
const SIGN_IN = new Set(['device-code', 'oauth-pkce', 'oauth-code']);
const DELETE_CONSEQUENCE = 'Overlays showing its chat and viewer count stop showing them.';

const statusOf = (health) => STATUS[health?.status] || [undefined, health?.status || 'Unknown'];
const feedsOf = (caps = []) => caps.map((c) => FEEDS[c]).filter(Boolean);
const platformName = (p) => PLATFORM[p] || p;
// A connector's app icon, for the CTD family's own apps (decorative: the name is beside it).
const APP_ICONS = { 'ctd-multistream': '/ui/relay.svg' };
const appIcon = (id) => (APP_ICONS[id] ? h('img.app-icon', { src: APP_ICONS[id], alt: '', width: 28, height: 28 }) : null);
const signsIn = (def) => Boolean(def && SIGN_IN.has(def.auth));
const pairs = (def) => def?.auth === 'pairing';
// Connect, or Connect again once it has a token (a refused one, or another profile).
const connectLabel = (c) => (c.secretFields?.length ? 'Connect again' : 'Connect');
const needsConnect = (c) => !c.secretFields?.length || c.health?.status === 'needs-reauth';

// The profile it follows at its service: "DPRTMNT · Live", since when; following every profile,
// each one so ("Miami or Bust · Offline").
const profileItem = (p) => h('div.row', { role: 'listitem' }, profileChip(p), p.status === 'live' && p.startedAt ? h('span.small.muted', `since ${clock(p.startedAt)}`) : null);
const everyProfile = (c) => c.info?.everyProfile === true || c.everyProfile === true;
const profilesOf = (c) => {
  const list = Array.isArray(c.info?.profiles) ? c.info.profiles : Array.isArray(c.profiles) ? c.profiles : [];
  return list.filter((p) => p && typeof p === 'object');
};
function profileLine(c) {
  if (everyProfile(c)) {
    const list = profilesOf(c);
    return h('div.stack.profiles',
      h('p.small', list.length ? `Follows every CTD Relay profile (${list.length}), each a stream of its own:` : 'Follows every CTD Relay profile: none yet.'),
      list.length ? h('div.stack', { role: 'list', 'aria-label': 'CTD Relay profiles' }, list.map(profileItem)) : null);
  }
  const p = c.info?.profile || (Array.isArray(c.profiles) && c.profiles.length === 1 ? c.profiles[0] : undefined);
  if (!p || typeof p !== 'object') return null;
  return h('div.row', profileChip(p), p.status === 'live' && p.startedAt ? h('span.small.muted', `since ${clock(p.startedAt)}`) : null);
}
// What each profile it follows feeds now, under the profile's name.
function feedValues(c) {
  const order = profilesOf(c).map((p) => p.id);
  const at = (f) => (order.includes(f.profile) ? order.indexOf(f.profile) : order.length);
  const feeds = (Array.isArray(c.feeds) ? [...c.feeds] : []).sort((a, b) => at(a) - at(b));
  const names = new Map(profilesOf(c).map((p) => [p.id, p.name]));
  return feeds.map((f) => {
    const rows = valueRows(f.state, f.stale);
    return rows.length ? h('div', h('h3.small', names.get(f.profile) || f.profile), kv(rows)) : null;
  });
}
// What it shares with the OBS plugin (CTD Relay's hub); a failure's reason is a warning.
function hubLine(c) {
  const hub = c.info?.hub;
  if (!hub || typeof hub !== 'object') return null;
  if (hub.status === 'shared') return h('p.small', `Shared with the OBS plugin: ${hub.overlays} overlay${hub.overlays === 1 ? '' : 's'}${hub.resources !== hub.overlays ? ` (${hub.resources} canvases)` : ''}.`);
  if (hub.status === 'starting') return h('p.small.muted', 'Sharing its overlays with the OBS plugin…');
  if (hub.status === 'failed') return h('p.small.muted', 'Not shared with the OBS plugin: see the warning.');
  return h('p.small.muted', `Not shared with the OBS plugin: ${hub.detail || 'off'}`);
}

// A settings schema with the choices the running connection offers (x-skp-choices: a profile to
// follow, say), or without those settings while it offers none.
function withChoices(schema, info) {
  if (!schema?.properties) return schema;
  const props = {};
  for (const [k, s] of Object.entries(schema.properties)) {
    if (!s?.['x-skp-choices']) { props[k] = s; continue; }
    const list = Array.isArray(info?.choices?.[k]) ? info.choices[k].filter((x) => typeof x?.value === 'string') : [];
    if (list.length) props[k] = { ...s, enum: list.map((x) => x.value), 'x-skp-labels': list.map((x) => x.label || x.value) };
  }
  return { ...schema, properties: props, ...(Array.isArray(schema.required) ? { required: schema.required.filter((k) => k in props) } : {}) };
}

// "Twitch viewers: 214", "Twitch live: yes" … for the values a connection sets now.
function valueRows(state = {}, stale = []) {
  const rows = [];
  for (const [key, value] of Object.entries(state)) {
    let m;
    let label;
    let text;
    if ((m = /^viewers\.([a-z0-9-]+)$/.exec(key))) { label = `${platformName(m[1])} viewers`; text = Number.isFinite(value) ? value.toLocaleString() : String(value); }
    else if ((m = /^stream\.([a-z0-9-]+)\.live$/.exec(key))) { label = `${platformName(m[1])} live`; text = value ? 'Yes' : 'No'; }
    else if ((m = /^stream\.([a-z0-9-]+)\.title$/.exec(key))) { label = `${platformName(m[1])} title`; text = String(value); }
    else if ((m = /^stream\.([a-z0-9-]+)\.startedAt$/.exec(key))) { label = `${platformName(m[1])} live since`; text = Number.isFinite(value) ? clock(new Date(value).toISOString()) : String(value); }
    else if (key === 'music.nowPlaying') { label = 'Now playing'; text = [value?.title, Array.isArray(value?.artists) ? value.artists.join(', ') : ''].filter(Boolean).join(' · '); }
    else if (key === 'obs.scene') continue; // the landscape scene's name, said by the row below
    else if ((m = /^obs\.scene\.(landscape|vertical)$/.exec(key))) { label = `OBS scene (${m[1]})`; text = typeof value?.scene === 'string' ? value.scene : JSON.stringify(value); }
    else if ((m = /^obs\.(streaming|recording)$/.exec(key))) { label = `OBS ${m[1]}`; text = value ? 'Yes' : 'No'; }
    else if ((m = /^obs\.(.+)$/.exec(key))) { label = `OBS ${m[1]}`; text = typeof value === 'object' ? JSON.stringify(value) : String(value); }
    else { label = key; text = typeof value === 'object' ? JSON.stringify(value) : String(value); }
    rows.push([label, stale.includes(key) ? `${text} (held: the service isn't answering)` : text]);
  }
  return rows;
}
const kv = (rows) => h('dl.kv', rows.map(([k, v]) => [h('dt', k), h('dd', v)]));

function quotaBar(q) {
  if (!q || !Number.isInteger(q.used)) return null;
  const pct = Number.isInteger(q.limit) && q.limit > 0 ? Math.min(100, Math.round((q.used / q.limit) * 100)) : undefined;
  const bar = h('span');
  if (pct !== undefined) bar.style.width = `${pct}%`;
  return h('div',
    h('p.small.muted', `Quota: ${q.used.toLocaleString()}${q.limit ? ` of ${q.limit.toLocaleString()}` : ''} used${q.resetsAt ? `, resets ${ago(q.resetsAt)}` : ''}`),
    pct !== undefined ? h('div.meter', { role: 'img', 'aria-label': `${pct}% of the quota used` }, bar) : null);
}
const warningsOf = (list) => (Array.isArray(list) && list.length ? list.map((w) => notice(w, 'warn')) : null);

// Splits a settings form's values into the definition's plain settings and its secrets.
function split(def, values) {
  const props = def?.fields?.properties || {};
  const config = {};
  const secrets = {};
  for (const [k, v] of Object.entries(values || {})) (props[k]?.writeOnly ? secrets : config)[k] = v;
  return { config, secrets };
}

function statusLine(c) {
  const [kind, label] = statusOf(c.health);
  return h('p', { class: 'row' }, statusDot(kind, label), h('strong', label), c.health?.detail ? h('span', c.health.detail) : null);
}

// A live check's outcome, as a dialog.
async function showTest(out, name) {
  await dialog({
    title: out.ok ? `${name} works` : `${name} has a problem`,
    body: h('ul.list', (out.checks || []).map((c) => h('li', statusDot(c.ok ? 'ok' : 'danger', c.ok ? 'Fine' : 'Problem'), h('div.grow', h('strong', c.name), c.detail ? h('div.small.muted', c.detail) : null)))),
  });
}

async function remove(c, done) {
  const fed = Array.isArray(c.overlays) && c.overlays.length ? ` Overlays it feeds: ${c.overlays.join(', ')}.` : '';
  const ok = await confirm({ title: `Delete ${c.name}?`, consequence: `${DELETE_CONSEQUENCE}${fed} Its saved secrets and sign-in are deleted too.`, confirmLabel: 'Delete' });
  if (!ok) return;
  const out = await run(null, () => api.del(`/api/v1/connections/${api.seg(c.id)}`, { ifMatch: c }), { done: `Deleted ${c.name}` });
  if (out) done();
}

async function setEnabled(button, c, on, after) {
  const out = await run(button, () => api.patch(`/api/v1/connections/${api.seg(c.id)}`, { enabled: on }, { ifMatch: c }), {
    done: on ? `${c.name} is on` : `${c.name} is off`,
    onError: (err) => toast(err.status === 412 ? 'It changed since you opened it: here it is again. Try once more.' : err),
  });
  after(out);
}

// ---- the list ------------------------------------------------------------------------------------
export async function list(view, ctx) {
  ctx.setTitle('Connections');
  if (!ctx.can('connections:read')) return operatorList(view);
  const canWrite = ctx.can('connections:write');
  let connectors = [];
  let items = [];
  const listBox = h('div.section');
  const addBox = h('div.section');
  mount(view, pageHead('Connections'), listBox, addBox);

  const defOf = (id) => connectors.find((d) => d.id === id);
  async function load() {
    [connectors, items] = await Promise.all([api.all('/api/v1/connectors'), api.all('/api/v1/connections')]);
    draw();
  }
  function card(c) {
    const def = defOf(c.connector);
    const feeds = feedsOf(c.capabilities);
    const values = valueRows(c.state, c.stale);
    const buttons = [];
    if (canWrite && signsIn(def) && (!c.signedIn || c.health?.status === 'needs-reauth')) buttons.push(h('a.btn.primary', { href: `#/connections/${api.seg(c.id)}` }, c.signedIn ? 'Re-authorize' : 'Authorize'));
    if (canWrite && pairs(def) && needsConnect(c)) buttons.push(h('a.btn.primary', { href: `#/connections/${api.seg(c.id)}` }, connectLabel(c)));
    if (canWrite) {
      const test = h('button.btn', { type: 'button', onclick: async () => { const out = await run(test, () => api.post(`/api/v1/connections/${api.seg(c.id)}/test`, {})); if (out) showTest(out, c.name); } }, 'Test');
      const toggle = h('button.btn', { type: 'button', onclick: () => setEnabled(toggle, c, !c.enabled, () => load()) }, c.enabled ? 'Turn off' : 'Turn on');
      buttons.push(test, toggle);
    }
    buttons.push(menu('More', [
      { label: 'Open', onSelect: () => ctx.navigate(`/connections/${encodeURIComponent(c.id)}`) },
      canWrite ? { label: 'Delete…', danger: true, onSelect: () => remove(c, () => load()) } : null,
    ], { ariaLabel: `More for ${c.name}` }));
    return h('article.card', { dataset: { id: c.id } },
      h('div.card-head', h('h2.with-icon', appIcon(c.connector), h('a', { href: `#/connections/${api.seg(c.id)}` }, c.name))),
      statusLine(c),
      profileLine(c),
      h('p.small.muted', [def?.name || c.connector, feeds.length ? `feeds ${feeds.join(', ').toLowerCase()}` : ''].filter(Boolean).join(' · ')),
      c.account ? h('p.small', `Signed in as ${c.account.name || c.account.login || c.account.id}`) : null,
      hubLine(c),
      values.length ? kv(values) : null,
      feedValues(c),
      c.health?.lastEventAt ? h('p.small.muted', `Last event ${ago(c.health.lastEventAt)}`) : null,
      quotaBar(c.health?.quota),
      warningsOf(c.health?.warnings),
      h('div.row', buttons));
  }
  function draw() {
    // A menu left open, or a button being pressed, waits for the next refresh.
    if (listBox.querySelector('details.menu[open]')) return;
    mount(listBox, items.length
      ? h('div.grid.wide', items.map(card))
      : empty('Nothing connected yet', connectors.length ? 'Connect a service below: overlays show its chat, alerts and counts as soon as it is on.' : 'This version of the platform has no connectors yet.'));
    const coming = COMING.filter((s) => !connectors.some((d) => d.id === s.id || (s.id === 'twitch' && d.platform === 'twitch')));
    mount(addBox,
      connectors.length ? h('section.section',
        h('h2', 'Add a connection'),
        h('div.grid', connectors.map((d) => h('div.card',
          h('div.card-head', h('h3.with-icon', appIcon(d.id), d.name), d.relay && d.id !== 'ctd-multistream' ? badge('Relay') : null),
          h('p.muted', feedsOf(d.capabilities).join(', ')),
          d.platforms?.length > 1 ? h('p.small.muted', `For ${d.platforms.map(platformName).join(', ')}`) : null,
          canWrite ? h('a.btn.primary', { href: `#/connections/new/${api.seg(d.id)}` }, 'Set up') : h('p.small.muted', 'Owners and admins set connections up.'))))) : null,
      coming.length ? h('section.section',
        h('h2', 'Coming in later versions'),
        h('div.grid', coming.map((s) => h('div.card',
          h('div.card-head', statusDot(undefined, 'Not available yet'), h('h3', s.name)),
          h('p.muted', s.what),
          badge('Not available yet'))))) : null);
  }

  await load();
  // Live: a connection's status changes as it happens (system.connection), and what it tells about
  // itself (its profile, what it shares) is read again then; values every 10 s.
  let pending = null;
  const stopEvents = api.events(['system.connection'], (env) => {
    const id = env.data?.connection;
    const i = items.findIndex((c) => c.id === id);
    if (i >= 0) items[i] = { ...items[i], health: { ...items[i].health, status: env.data.status, detail: env.data.detail, since: env.data.since, lastEventAt: env.data.lastEventAt, warnings: env.data.warnings || [] } };
    clearTimeout(pending);
    pending = setTimeout(() => load().catch(draw), 300);
  });
  let first = true;
  const stopPoll = every(10000, async () => { if (first) { first = false; return; } await load(); });
  return () => { stopEvents(); stopPoll(); clearTimeout(pending); };
}

// What an operator sees: every connection's status, as the Live strip has it.
async function operatorList(view) {
  let health;
  try { health = await api.get('/api/v1/system/health'); } catch { health = {}; }
  const list = Array.isArray(health.connections) ? health.connections : [];
  mount(view, pageHead('Connections'),
    notice('Owners and admins set up connections and their sign-ins. Here is how each one is doing.'),
    list.length
      ? h('ul.list', list.map((c) => {
        const [kind, label] = statusOf(c);
        const profiles = Array.isArray(c.profiles) ? c.profiles : [];
        return h('li', statusDot(kind, label), h('div.grow', h('strong', c.name), h('div.small.muted', [label, c.detail].filter(Boolean).join(' · ')),
          profiles.length ? h('div.chips', { role: 'list', 'aria-label': 'CTD Relay profiles' }, profiles.map((p) => { const chip = profileChip(p); chip.setAttribute('role', 'listitem'); return chip; })) : null),
        Number.isFinite(c.viewers) ? h('span', `${c.viewers.toLocaleString()} viewers`) : null);
      }))
      : empty('Nothing connected yet', 'Ask an owner or admin to connect your services.'));
  return undefined;
}

// ---- setup -------------------------------------------------------------------------------------
// The setup guide (08 §8.7): warnings first, the steps, the redirect URI to register exactly, the
// scopes asked for and why.
function guide(def) {
  const r = def.redirect;
  let away = false;
  try { away = Boolean(r?.origin) && new URL(r.origin).origin !== location.origin; } catch { away = false; }
  return h('section.card',
    h('h2', 'Before you start'),
    warningsOf(def.guide?.warnings),
    def.requiresPublicUrl && !def.publicUrlAvailable ? notice(`${def.name} delivers events to an address on the internet: set SKP_PUBLIC_URL (public mode) for its chat and alerts.`, 'warn') : null,
    def.guide?.before ? h('p', def.guide.before) : null,
    h('ol.steps', (def.guide?.steps || []).map((s) => h('li', s))),
    r?.uri ? [
      h('h3', 'Redirect URI'),
      h('p.small.muted', 'Register exactly this address with the service (it compares it letter for letter):'),
      copyField(r.uri, { copied: 'Redirect URI copied' }),
      away ? notice(`You opened this page at ${location.origin}, but the service sends you back to ${r.origin}. If that doesn't open on this device, copy the address you land on and paste it under "Finish sign-in" on the connection's page.`, 'warn') : null,
    ] : null,
    Array.isArray(def.scopes) && def.scopes.length ? [
      h('h3', 'What it asks for'),
      h('ul.list', def.scopes.map((s) => h('li', h('div.grow', h('strong', s.scope), h('div.small.muted', s.why))))),
    ] : null,
    Array.isArray(def.guide?.links) && def.guide.links.length ? h('p.small', def.guide.links.map((l, i) => [i ? ' · ' : '', h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.label)])) : null);
}

export async function create(view, ctx) {
  ctx.setTitle('New connection');
  const crumbs = [{ label: 'Connections', href: '#/connections' }];
  if (!ctx.can('connections:write')) {
    mount(view, pageHead('New connection', { crumbs }), notice('Owners and admins set connections up.'));
    return undefined;
  }
  let def;
  try {
    def = await api.get(`/api/v1/connectors/${api.seg(ctx.params.connector)}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    mount(view, pageHead('New connection', { crumbs }), empty(`There is no connector "${ctx.params.connector}"`, 'This version of the platform doesn\'t offer it.', h('a.btn', { href: '#/connections' }, 'Back to Connections')));
    return undefined;
  }
  ctx.setTitle(`Connect ${def.name}`);
  const nameInput = h('input', { type: 'text', value: def.name, maxlength: '80', autocomplete: 'off' });
  const on = h('input', { type: 'checkbox', checked: true });
  const form = schemaForm({ schema: withChoices(def.fields), values: {}, resolved: {} });
  const save = h('button.btn.primary', { type: 'submit' }, 'Save');
  const submit = async (e) => {
    e.preventDefault();
    if (form.validate().length) { toast('Check the marked settings.', { kind: 'error' }); return; }
    const { config, secrets } = split(def, form.values());
    const made = await run(save, () => api.post('/api/v1/connections', { connector: def.id, name: nameInput.value.trim() || def.name, enabled: on.checked, config, secrets }), { done: (c) => `Added ${c.name}` });
    if (made) ctx.navigate(`/connections/${encodeURIComponent(made.id)}`);
  };
  const settings = h('form', { onsubmit: submit },
    field('Name', nameInput, { hint: 'What you call it here, like "Relay (NAS)".' }),
    form.el,
    field('Turn it on when saved', on),
    h('div.form-actions', h('a.btn', { href: '#/connections' }, 'Cancel'), save));
  mount(view,
    pageHead(`Connect ${def.name}`, { crumbs }),
    guide(def),
    pairs(def)
      ? [pairingSetup(ctx, def), h('section.card', h('details', h('summary', 'Paste a token instead'), h('p.small.muted', `Made a token in ${def.name} yourself? Paste it here with the address; the rest works the same.`), settings))]
      : h('section.card', h('h2', 'Settings'), settings));
  return undefined;
}

// Pairing (the default for a connector that pairs): the address only, then Connect. The connection
// is made and asks the service for a code; its page shows the code until it is approved there. If
// the service can't be asked, the connection isn't kept, so the address can be fixed here.
function pairingSetup(ctx, def) {
  const s = def.fields?.properties?.baseUrl || {};
  const address = h('input', { type: 'url', inputmode: 'url', autocomplete: 'off', required: true, maxlength: String(s.maxLength || 300), placeholder: s.examples?.[0] || '' });
  const go = h('button.btn.primary', { type: 'submit' }, 'Connect');
  const problem = h('div', { 'aria-live': 'polite' });
  const submit = async (e) => {
    e.preventDefault();
    mount(problem);
    const baseUrl = address.value.trim();
    if (!baseUrl) { address.focus(); return; }
    await run(go, async () => {
      const made = await api.post('/api/v1/connections', { connector: def.id, config: { baseUrl } });
      try {
        await api.post(`/api/v1/connections/${api.seg(made.id)}/authorize`, {});
      } catch (err) {
        await api.del(`/api/v1/connections/${api.seg(made.id)}`, { ifMatch: made }).catch(() => {});
        throw err;
      }
      ctx.navigate(`/connections/${encodeURIComponent(made.id)}`);
    }, { onError: (err) => mount(problem, notice(err?.message || String(err), 'danger')) });
  };
  return h('section.card',
    h('h2', `Connect to ${def.name}`),
    h('form', { onsubmit: submit },
      field(s.title || 'API address', address, { hint: s.description }),
      problem,
      h('div.form-actions', h('a.btn', { href: '#/connections' }, 'Cancel'), go)));
}

// ---- one connection ----------------------------------------------------------------------------
export async function detail(view, ctx) {
  ctx.setTitle('Connection');
  const crumbs = [{ label: 'Connections', href: '#/connections' }];
  if (!ctx.can('connections:read')) {
    mount(view, pageHead('Connection', { crumbs }), notice('Owners and admins see and change connections.'));
    return undefined;
  }
  const id = ctx.params.id;
  const canWrite = ctx.can('connections:write');
  let c;
  let def;
  const load = async () => {
    c = await api.get(`/api/v1/connections/${api.seg(id)}`);
    if (!def || def.id !== c.connector) def = await api.get(`/api/v1/connectors/${api.seg(c.connector)}`).catch(() => undefined);
  };
  try {
    await load();
  } catch (err) {
    if (err.status !== 404) throw err;
    mount(view, pageHead('Connection', { crumbs }), empty(`There is no connection "${id}"`, 'It may have been deleted.', h('a.btn', { href: '#/connections' }, 'Back to Connections')));
    return undefined;
  }
  ctx.setTitle(c.name);

  const outcome = ctx.query.get('authorize');
  if (outcome === 'done') toast('Signed in');
  else if (outcome === 'denied') toast('The sign-in was declined at the service.', { kind: 'error' });
  else if (outcome === 'failed') toast('Signing in didn\'t work: try Authorize again. The status below says why.', { kind: 'error' });

  const head = h('div');
  const statusBox = h('section.card');
  const signBox = h('section.card');
  const valuesBox = h('section.card');
  const actionsBox = h('section.card');
  const settingsBox = h('section.card');
  let tick = null;
  let started = null; // a sign-in this page started: { flow, url, redirectUri } (redirect)
  let shownRev; // the version the settings form shows
  let shownChoices; // and the choices it offered

  function drawHead() {
    mount(head, pageHead(c.name, {
      crumbs,
      actions: canWrite ? [menu('More', [
        signsIn(def) && c.signedIn ? { label: 'Sign out…', onSelect: signOut } : null,
        { label: 'Delete…', danger: true, onSelect: () => remove(c, () => ctx.navigate('/connections')) },
      ], { ariaLabel: `More for ${c.name}` })] : [],
    }));
  }

  function drawStatus() {
    const test = h('button.btn', { type: 'button', onclick: async () => { const out = await run(test, () => api.post(`/api/v1/connections/${api.seg(c.id)}/test`, {})); if (out) showTest(out, c.name); } }, 'Test');
    const toggle = h('button.btn', { type: 'button', onclick: () => setEnabled(toggle, c, !c.enabled, () => refresh()) }, c.enabled ? 'Turn off' : 'Turn on');
    mount(statusBox,
      h('h2', 'Status'),
      statusLine(c),
      profileLine(c),
      hubLine(c),
      h('p.small.muted', [c.health?.since ? `Since ${ago(c.health.since)}` : '', c.health?.lastEventAt ? `last event ${ago(c.health.lastEventAt)}` : ''].filter(Boolean).join(', ')),
      quotaBar(c.health?.quota),
      warningsOf(c.health?.warnings),
      c.deliveries ? h('p.small.muted', `Deliveries: ${c.deliveries.accepted} accepted, ${c.deliveries.refused} refused (bad signature)`) : null,
      canWrite ? h('div.row', test, toggle) : null);
  }

  // A countdown to an ISO instant ("9:41"), ticking while the page shows it.
  function countdownTo(iso) {
    const left = h('span.countdown');
    const update = () => {
      const ms = Date.parse(iso) - api.serverNow();
      left.textContent = ms > 0 ? `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}` : 'expired';
    };
    update();
    tick = setInterval(update, 1000);
    return left;
  }

  // Pairing: Connect asks the service for a code; an admin approves it there (and picks the
  // profile); the platform collects the token by itself.
  function drawPairing() {
    const a = c.authorization;
    const parts = [h('h2', 'Connection')];
    if (a?.flow === 'pairing' && a.status === 'pending') {
      parts.push(
        h('p', `Approve this code in ${def.name} → Settings → API, and pick the profile this connection follows:`),
        h('p.device-code', { 'aria-label': `Code ${String(a.code).split('').join(' ')}` }, a.code),
        a.approveUrl ? h('p', h('a', { href: a.approveUrl, target: '_blank', rel: 'noopener noreferrer' }, `Open ${def.name}'s Settings → API`)) : null,
        h('p.small.muted', 'Waiting for the approval: it connects by itself. The code works for ', countdownTo(a.expiresAt), '.'),
        canWrite ? h('div.row', h('button.btn', { type: 'button', onclick: (e) => cancel(e.currentTarget) }, 'Cancel')) : null);
      mount(signBox, parts);
      return;
    }
    if (a && a.status !== 'pending' && a.flow === 'pairing') {
      parts.push(notice(a.status === 'done' ? `Connected: ${def.name} approved it.` : a.detail || 'Connecting didn\'t work.', a.status === 'done' ? 'ok' : 'danger'));
    }
    const p = c.info?.profile;
    const up = c.health?.status === 'connected' || c.health?.status === 'degraded';
    const every = everyProfile(c);
    if (c.secretFields?.length && c.health?.status !== 'needs-reauth') {
      parts.push(h('p', every
        ? ['Follows every profile', profilesOf(c).length ? [': ', h('strong', profilesOf(c).map((x) => x.name).join(', '))] : '', '. Each one is a stream of its own: pick which feeds an overlay in its "Fed by" (or one profile only in Settings below).']
        : p ? ['Follows the profile ', h('strong', p.name), `${c.info?.choices?.profile ? ' (pick another, or "Every profile", in Settings below)' : ''}.`] : up ? 'Running with its token.' : 'It has a token, but isn\'t running now: see Status.'));
    }
    else parts.push(h('p.muted', `Not connected: press ${connectLabel(c)}, then approve the code in ${def.name} → Settings → API.`));
    if (canWrite) {
      const go = h('button.btn', { class: needsConnect(c) ? 'primary' : undefined, type: 'button', onclick: () => authorize(go) }, connectLabel(c));
      parts.push(h('div.row', go), h('p.small.muted', 'Connect again for another profile (or every profile), or after the token was revoked. Or paste a token under Settings.'));
    }
    mount(signBox, parts);
  }

  function drawSignIn() {
    clearInterval(tick);
    tick = null;
    signBox.hidden = !signsIn(def) && !pairs(def);
    if (pairs(def)) { drawPairing(); return; }
    if (!signsIn(def)) return;
    const a = c.authorization;
    const parts = [h('h2', 'Sign-in')];
    if (c.signedIn) parts.push(h('p', `Signed in${c.account ? ` as ${c.account.name || c.account.login || c.account.id}` : ''}${c.authorizedAt ? `, ${ago(c.authorizedAt)}` : ''}.`));
    else parts.push(h('p.muted', `Not signed in: Authorize to connect ${def.name}.`));
    if (c.needsReauth) parts.push(notice(`Sign in again: ${c.needsReauth.reason}.`, 'danger'));
    if (a?.flow === 'device' && a.status === 'pending') {
      parts.push(
        h('p', 'On any device, open ', h('a', { href: a.verificationUriComplete || a.verificationUri, target: '_blank', rel: 'noopener noreferrer' }, a.verificationUri), ' and enter this code:'),
        h('p.device-code', { 'aria-label': `Code ${a.userCode.split('').join(' ')}` }, a.userCode),
        h('p.small.muted', 'Waiting for you to approve it. The code works for ', countdownTo(a.expiresAt), '.'),
        canWrite ? h('div.row', h('button.btn', { type: 'button', onclick: (e) => cancel(e.currentTarget) }, 'Cancel')) : null);
    } else {
      if (a && a.status !== 'pending') {
        parts.push(notice(a.status === 'done' ? 'Signed in.' : a.detail || (a.status === 'expired' ? 'The code expired before it was used.' : 'Signing in didn\'t work.'), a.status === 'done' ? 'ok' : 'danger'));
      }
      if (canWrite) {
        const go = h('button.btn.primary', { type: 'button', onclick: () => authorize(go) }, c.signedIn ? 'Re-authorize' : 'Authorize');
        parts.push(h('div.row', go));
      }
      if (started?.flow === 'redirect') {
        parts.push(h('p', h('a.btn.primary', { href: started.url, rel: 'noreferrer' }, `Continue to ${def.name}`)));
      }
    }
    // Always there for a redirect flow: the browser that lands back may not be this one (a phone,
    // or a redirect URI on 127.0.0.1 that only the platform's machine opens).
    if (canWrite && (def.auth === 'oauth-pkce' || def.auth === 'oauth-code')) {
      const address = h('input', { type: 'url', inputmode: 'url', autocomplete: 'off', placeholder: 'http://…/oauth/callback/…?code=…' });
      const finish = h('button.btn', { type: 'submit' }, 'Finish sign-in');
      parts.push(h('form', { onsubmit: async (e) => {
        e.preventDefault();
        if (!address.value.trim()) return;
        const out = await run(finish, () => api.post(`/api/v1/connections/${api.seg(c.id)}/authorize/complete`, { url: address.value.trim() }), { done: 'Signed in' });
        if (out) { address.value = ''; started = null; await refresh(); }
      } }, field('Finish sign-in: paste the address you landed on', address, { hint: 'If the service sent you to a page that didn\'t open, copy its whole address from the address bar and paste it here.' }), h('div.row', finish)));
    }
    mount(signBox, parts);
  }

  function drawValues() {
    const rows = valueRows(c.state, c.stale);
    const fed = Array.isArray(c.overlays) ? c.overlays : [];
    mount(valuesBox,
      h('h2', 'What it feeds now'),
      rows.length ? kv(rows) : null,
      feedValues(c),
      !rows.length && !c.feeds?.length ? h('p.muted', c.health?.status === 'connected' ? 'Nothing yet: values appear as the service sends them.' : 'Nothing while it isn\'t connected.') : null,
      h('h3', 'Overlays it feeds'),
      fed.length ? h('ul.list', fed.map((slug) => h('li', h('a', { href: `#/overlays/${api.seg(slug)}` }, slug)))) : h('p.small.muted', 'None: no overlay is bound to it.'));
  }

  function drawActions() {
    const list = (def?.actions || []).filter((a) => ctx.can(a.scope || 'overlays:control'));
    actionsBox.hidden = !list.length;
    if (!list.length) return;
    mount(actionsBox, h('h2', 'Actions'), list.map((a) => {
      const form = a.args ? schemaForm({ schema: a.args, values: {}, resolved: {} }) : null;
      const go = h('button.btn', { type: 'submit' }, a.label);
      return h('form', { onsubmit: async (e) => {
        e.preventDefault();
        if (form?.validate().length) return;
        await run(go, () => api.post(`/api/v1/connections/${api.seg(c.id)}/actions/${api.seg(a.name)}`, { args: form ? form.values() : {} }), { done: `${a.label}: done` });
      } }, form ? form.el : null, h('div.row', go));
    }));
  }

  function drawSettings() {
    if (!canWrite) { settingsBox.hidden = true; return; }
    const read = c; // the version this form edits (If-Match, H16)
    shownRev = c.rev;
    shownChoices = JSON.stringify(c.info?.choices || null);
    const nameInput = h('input', { type: 'text', value: c.name, maxlength: '80', autocomplete: 'off' });
    const schema = def ? withChoices(def.fields, c.info) : undefined;
    // A setting whose choices the connection offers none of now is kept as it is, not dropped.
    const hiddenValues = Object.fromEntries(Object.entries(c.config || {}).filter(([k]) => def?.fields?.properties?.[k] && !schema?.properties?.[k]));
    // The choice it follows when none is set (every profile), as the placeholder.
    const resolved = schema?.properties?.profile && (everyProfile(c) || c.info?.profile) ? { profile: everyProfile(c) ? '*' : c.info.profile.id } : {};
    const form = def ? schemaForm({ schema, values: c.config || {}, resolved, saved: c.secretFields || [] }) : null;
    const save = h('button.btn.primary', { type: 'submit' }, 'Save');
    mount(settingsBox,
      h('h2', 'Settings'),
      h('form', { onsubmit: async (e) => {
        e.preventDefault();
        if (form?.validate().length) { toast('Check the marked settings.', { kind: 'error' }); return; }
        const { config: shown, secrets } = split(def, form ? form.values() : {});
        const config = { ...hiddenValues, ...shown };
        const body = { name: nameInput.value.trim() || c.name, ...(form ? { config } : {}), ...(Object.keys(secrets).length ? { secrets } : {}) };
        const out = await run(save, () => api.patch(`/api/v1/connections/${api.seg(c.id)}`, body, { ifMatch: read }), {
          done: 'Settings saved',
          onError: async (err) => {
            toast(err.status === 412 ? 'It changed since you opened it: here it is again. Make your change once more.' : err);
            if (err.status === 412) { await refresh(); drawSettings(); }
          },
        });
        if (out) { c = out; drawAll(); }
      } },
      field('Name', nameInput),
      form ? form.el : notice(`The connector "${c.connector}" isn't in this version of the platform: its settings can't be changed.`, 'warn'),
      c.secretFields?.length ? h('p.small.muted', 'Saved secrets aren\'t shown. Leave a secret empty to keep it.') : null,
      h('div.form-actions', save)));
  }

  function drawAll() {
    drawHead();
    drawStatus();
    drawSignIn();
    drawValues();
    drawActions();
    drawSettings();
  }

  async function refresh() {
    try { await load(); } catch (err) { if (err.status === 404) { ctx.navigate('/connections'); return; } throw err; }
    drawHead();
    drawStatus();
    // A box keeps what is being typed in it; the settings are drawn again when the connection
    // changed (renamed after its profile, a profile list arrived) and nobody is editing them.
    const typing = (box) => box.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (!typing(signBox)) drawSignIn();
    drawValues();
    const choices = JSON.stringify(c.info?.choices || null);
    if ((c.rev !== shownRev || choices !== shownChoices) && !settingsBox.contains(document.activeElement)) drawSettings();
  }

  async function authorize(button) {
    const out = await run(button, () => api.post(`/api/v1/connections/${api.seg(c.id)}/authorize`, {}));
    if (!out) return;
    if (out.flow === 'redirect') {
      started = out;
      let here = false;
      try { here = new URL(out.redirectUri).origin === location.origin; } catch { here = false; }
      // Back to this same address: go now. Elsewhere: say so first (the paste box is there).
      if (here) { location.assign(out.url); return; }
      toast(`After signing in, ${def.name} sends you to ${new URL(out.redirectUri).origin}. If that doesn't open here, paste its address under "Finish sign-in".`);
    }
    await refresh();
  }
  async function cancel(button) {
    await run(button, () => api.del(`/api/v1/connections/${api.seg(c.id)}/authorize`), { done: 'Sign-in cancelled' });
    await refresh();
  }
  async function signOut() {
    const ok = await confirm({ title: `Sign ${c.name} out?`, consequence: `It stops until someone signs in again. ${DELETE_CONSEQUENCE}`, confirmLabel: 'Sign out' });
    if (!ok) return;
    await run(null, () => api.del(`/api/v1/connections/${api.seg(c.id)}/authorize`), { done: 'Signed out' });
    await refresh();
  }

  mount(view, head, statusBox, signBox, valuesBox, actionsBox, settingsBox);
  drawAll();
  if (outcome) history.replaceState(null, '', `#/connections/${encodeURIComponent(c.id)}`);

  // Live: its status as it changes; values and a sign-in in progress every few seconds.
  const stopEvents = api.events(['system.connection'], (env) => { if (env.data?.connection === c.id) refresh().catch(() => {}); });
  let ticks = 0;
  const stopPoll = every(3000, async () => {
    ticks += 1;
    if (ticks === 1) return; // just drawn
    if (c.authorization?.status === 'pending' || ticks % 5 === 0) await refresh();
  });
  return () => { stopEvents(); stopPoll(); clearInterval(tick); };
}
