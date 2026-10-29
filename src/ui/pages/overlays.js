// Overlays (08 §8.3, §8.5): every overlay as a card, and one overlay's page: previews at each
// canvas, its URL for OBS, the settings form and what feeds it ("Fed by": every connection or only
// some), its role in OBS (for the CTD OBS plugin), scenes outside a show (and "Follow OBS", obs.js),
// the Simulate panel, template versions (upgrade, go back), and the More menu (rename, the key,
// delete). An overlay whose template reads a show (set times, the countdown, title cards) but that
// is in none says so first, with "Make a show from this overlay" and "Add it to a show"
// (show-from-overlay.js); quietly, when it reads only a show's times (a clock may have its own).
// One in a show offers a saved change to the show's other overlays of its template, since
// settings (the copy too) are each overlay's own. Leaving with a change not saved asks first.
import * as api from '../api.js';
import { needsWords } from '../action-needs.js';
import { ago, badge, confirm, copy, copyField, dialog, empty, field, h, isPhone, menu, mount, notice, pageHead, preview, prompt, run, settingsParam, tabs, toast } from '../dom.js';
import { followObsCard } from '../obs.js';
import { needsShow, passedLine, readsLineup, sampleWords, showNotice, showParts, showWords, wantsShowTimes } from '../show-from-overlay.js';
import { bindingName, connectionChip, fedByForm, fedByWords } from '../streams.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLUG_HELP = 'Use lower-case letters, digits and dashes, starting with a letter or digit (63 at most).';
const PREVIEW_DELAY_MS = 400;
const STATUS = {
  ok: { label: 'Ready', kind: 'ok' },
  'template-missing': { label: 'Template missing', kind: 'danger' },
  'template-unusable': { label: 'Template can\'t run', kind: 'danger' },
};
const statusOf = (o) => STATUS[o?.status] || { label: 'Unknown', kind: 'warn' };
const TABS = ['settings', 'scenes', 'test', 'version'];

// What the Simulate panel sends (src/overlays/simulate.js), in plain words. Live's overlay panel
// sends the same.
export const SIMULATIONS = [
  { kind: 'chat', label: 'Chat message', what: 'chat', done: () => 'Chat message sent.' },
  { kind: 'follow', label: 'Follow', what: 'follows', done: () => 'Follow sent.' },
  { kind: 'subscription', label: 'Subscription', what: 'subscriptions', done: () => 'Subscription sent.' },
  { kind: 'gift', label: 'Gift 25 subs', what: 'gifted subs', body: () => ({ count: 25 }), done: () => '25 gifted subs sent.' },
  { kind: 'raid', label: 'Raid', what: 'raids', done: () => 'Raid sent.' },
  { kind: 'cheer', label: 'Cheer 500 bits', what: 'cheers', body: () => ({ bits: 500 }), done: () => 'Cheer sent.' },
  { kind: 'tip', label: 'Tip $5', what: 'tips', done: () => 'Tip sent.' },
  { kind: 'track', label: 'Change track', what: 'the track playing', done: () => 'Track changed for a minute.' },
  { kind: 'viewers', label: 'Change viewer count', what: 'the viewer count', body: () => ({ value: 50 + Math.floor(Math.random() * 4950) }), done: (b) => `Viewer count set to ${b.value.toLocaleString()} for a minute.` },
  { kind: 'viewers-clear', label: 'Viewers absent', what: 'the viewer count', done: () => 'Viewer count hidden for a minute, as when no service reports one.' },
];

// ---- small helpers -------------------------------------------------------------------------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
const normalSlug = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
const overlayHref = (slug) => `#/overlays/${encodeURIComponent(slug)}`;
const showHref = (ref) => `#/shows/${encodeURIComponent(ref)}`;
// The same JSON whatever the key order, to tell edited settings from saved ones.
const stable = (v) => JSON.stringify(v ?? {}, (k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
// One setting's value against another's (absent is absent, not {}).
const sameValue = (a, b) => stable([a === undefined ? null : a]) === stable([b === undefined ? null : b]);
const andList = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

// SemVer precedence, as the platform orders versions (src/templates/registry.js).
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v ?? '').split('+')[0].split(/-(.*)/s);
    return { nums: core.split('.').map(Number), pre: pre === undefined ? [] : pre.split('.') };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return (x.nums[i] || 0) < (y.nums[i] || 0) ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// A schema with its $ref followed inside the manifest ("#/definitions/…").
function deref(root, schema) {
  for (let hops = 0; isObj(schema) && typeof schema.$ref === 'string' && hops < 8; hops++) {
    if (!schema.$ref.startsWith('#/')) return undefined;
    let node = root;
    for (const part of schema.$ref.slice(2).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      node = has(node, key) ? node[key] : undefined;
    }
    schema = node;
  }
  return isObj(schema) ? schema : undefined;
}
const settingsSchemaOf = (manifest) => {
  const schema = deref(manifest, manifest?.settings);
  return schema && isObj(schema.properties) && Object.keys(schema.properties).length ? schema : undefined;
};

// What the template should see while settings are being edited (?settings= replaces the resolved
// settings whole, src/sdk/sk.js): what it sees now, with the edited values over it; a value the
// user cleared falls back to its default.
function previewSettings(root, schema, values, resolved, saved, depth = 0) {
  const out = {};
  if (!isObj(schema?.properties) || depth > 3) return { ...(isObj(resolved) ? resolved : {}), ...(isObj(values) ? values : {}) };
  for (const [key, raw] of Object.entries(schema.properties)) {
    const f = deref(root, raw);
    if (!f) continue;
    const r = isObj(resolved) ? resolved[key] : undefined;
    if (f.type === 'object') {
      out[key] = previewSettings(root, f, has(values, key) ? values[key] : {}, r, isObj(saved) ? saved[key] : undefined, depth + 1);
    } else if (has(values, key) && values[key] !== undefined) {
      out[key] = values[key];
    } else if (has(saved, key)) {
      if (f.default !== undefined) out[key] = f.default;
    } else if (r !== undefined) {
      out[key] = r;
    }
  }
  return out;
}

// "Landscape · 1920 × 1080" for a canvas ({ canvas, width, height } from …/url).
function shapeOf(w, h2) {
  if (!w || !h2) return undefined;
  return w > h2 ? 'Landscape' : w < h2 ? 'Vertical' : 'Square';
}
function canvasNamer(canvases, manifest) {
  const names = canvases.map((c) => manifest?.canvases?.find((m) => m.id === c.canvas)?.label || shapeOf(c.width, c.height) || c.canvas || 'Canvas');
  return (c, i) => {
    const name = names.filter((n) => n === names[i]).length > 1 ? `${names[i]} (${c.canvas})` : names[i];
    return c.width ? `${name} · ${c.width} × ${c.height}` : name;
  };
}

// The overlay's URL with preview overrides (04 §4.9), on this origin: never what OBS gets.
function withPreview(url, { scene, mock, settings }) {
  const u = new URL(url, location.origin);
  for (const k of ['scene', 'mock', 'settings', 'lite', 'bg', 'debug']) u.searchParams.delete(k);
  if (scene) u.searchParams.set('scene', scene);
  if (mock) u.searchParams.set('mock', '1');
  if (settings) u.searchParams.set('settings', settings);
  return u.pathname + u.search;
}

// The previews in one wrapping row, centred (sizes through the CSSOM: the CSP refuses style="").
function previewRow(boxes) {
  const row = h('div.row', boxes);
  row.style.justifyContent = 'center';
  row.style.alignItems = 'flex-start';
  return row;
}

// A setting's value in plain words, for the upgrade plan.
function shown(v) {
  if (v === undefined || v === null || v === '') return 'empty';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.length === 1 ? '1 item' : `${v.length} items`;
  if (typeof v === 'object') return 'a group of settings';
  const s = String(v);
  return `"${s.length > 60 ? `${s.slice(0, 57)}…` : s}"`;
}

// A setting's name from its path ("/look"), as the form shows it: from the first of the manifests
// that has the setting (an upgrade's new version, then the old one for a setting it drops).
function settingName(manifests, path) {
  const parts = String(path || '').split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (const manifest of manifests.filter(Boolean)) {
    let schema = settingsSchemaOf(manifest);
    const names = [];
    for (const p of parts) {
      const f = isObj(schema?.properties) && has(schema.properties, p) ? deref(manifest, schema.properties[p]) : undefined;
      if (!f) break;
      names.push(f.title || p);
      schema = f;
    }
    if (names.length === parts.length) return names.join(' › ') || 'Settings';
  }
  return parts.join(' › ') || 'Settings';
}

// The URL of an overlay's first canvas, copied (the list's "Copy URL").
async function copyFirstUrl(button, o) {
  const answer = await run(button, () => api.get(`/api/v1/overlays/${api.seg(o.id || o.slug)}/url`));
  const first = answer?.urls?.[0];
  if (!answer) return;
  if (!first?.url) { toast('This overlay has no URL to copy.', { kind: 'error' }); return; }
  const what = shapeOf(first.width, first.height);
  const ok = await copy(first.url, `${what ? `${what} URL` : 'URL'} of "${o.slug}" copied: paste it into an OBS browser source.`);
  if (!ok) {
    const fieldEl = copyField(first.url, { label: 'Copy' });
    fieldEl.querySelector('input')?.setAttribute('aria-label', `URL of ${o.slug}`);
    await dialog({ title: `URL of "${o.slug}"`, body: h('div', h('p', 'Select it and copy it, then paste it into an OBS browser source.'), fieldEl), actions: [{ label: 'Done', value: true, kind: 'primary' }] });
  }
}

// "New overlay": a template and a name, then its page with the URL ready to copy.
async function newOverlay(ctx, templates, preset = {}) {
  if (!templates.length) {
    toast('Install a template first: Templates has the gallery.');
    ctx.navigate('/templates');
    return;
  }
  const answer = await prompt({
    title: 'New overlay',
    intro: 'An overlay is a template with your settings, and its own URL for OBS.',
    fields: [
      { name: 'template', label: 'Template', type: 'select', value: preset.template || templates[0].id, options: templates.map((t) => ({ value: t.id, label: `${t.name || t.id} (version ${t.latest})` })) },
      { name: 'slug', label: 'Name', value: preset.slug || '', required: true, placeholder: 'takeover-v', hint: 'Lower-case letters, digits and dashes. It is part of the overlay\'s URL in OBS.' },
    ],
    submitLabel: 'Create overlay',
  });
  if (!answer) return;
  const slug = normalSlug(answer.slug);
  const t = templates.find((x) => x.id === answer.template) || templates[0];
  if (!SLUG.test(slug)) {
    toast(SLUG_HELP, { kind: 'error' });
    return newOverlay(ctx, templates, { template: t.id, slug });
  }
  try {
    const created = await api.post('/api/v1/overlays', { slug, template: { id: t.id, version: t.latest } });
    toast(`Overlay "${created.slug}" created: copy its URL into OBS.`);
    ctx.navigate(`/overlays/${encodeURIComponent(created.slug)}`);
  } catch (err) {
    toast(err);
    return newOverlay(ctx, templates, { template: t.id, slug });
  }
  return undefined;
}

// ---- the list ------------------------------------------------------------------------------
export async function list(view, ctx) {
  ctx.setTitle('Overlays');
  const canWrite = ctx.can('overlays:write');
  const [overlays, templates, shows] = await Promise.all([
    api.all('/api/v1/overlays'),
    ctx.can('templates:read') ? api.all('/api/v1/templates').catch(() => []) : [],
    ctx.can('timeline:read') ? api.all('/api/v1/shows').catch(() => []) : [],
  ]);
  const templateOf = new Map(templates.map((t) => [t.id, t]));
  const showId = new Map(shows.map((s) => [s.name, s.id]));
  const create = () => newOverlay(ctx, templates);

  if (!overlays.length) {
    mount(view,
      pageHead('Overlays'),
      h('div.card', empty('No overlays yet',
        'An overlay is a template with your settings, and its own URL to paste into OBS. Start from a template.',
        h('a.btn.primary', { href: '#/templates' }, 'Browse templates'),
        canWrite && templates.length ? h('button.btn', { type: 'button', onclick: create }, 'New overlay') : null)));
    return;
  }

  const card = (o) => {
    const st = statusOf(o);
    const tpl = templateOf.get(o.template?.id);
    const version = o.template?.version;
    const newer = tpl?.latest && version && compareVersions(tpl.latest, version) > 0;
    const copyBtn = h('button.btn', { type: 'button', 'aria-label': `Copy the URL of ${o.slug}`, onclick: () => copyFirstUrl(copyBtn, o) }, 'Copy URL');
    return h('div.card',
      h('div.card-head', h('h2.truncate', h('a', { href: overlayHref(o.slug) }, o.slug)), badge(st.label, st.kind)),
      h('p', tpl?.name || o.template?.id || 'Unknown template', h('span.muted', version ? ` · version ${version}` : ''), newer ? [' ', badge('Update available', 'accent')] : null),
      h('p.muted', o.show ? ['In the show ', h('a', { href: showHref(showId.get(o.show) || o.show) }, o.show)] : 'Not in a show'),
      h('div.row', copyBtn, h('a.btn', { href: overlayHref(o.slug), 'aria-label': `Open ${o.slug}` }, 'Open')));
  };

  mount(view,
    pageHead('Overlays', { actions: [canWrite ? h('button.btn.primary', { type: 'button', onclick: create }, 'New overlay') : null].filter(Boolean) }),
    h('div.grid', overlays.map(card)));
}

// ---- one overlay ---------------------------------------------------------------------------
async function load(slug, ctx) {
  const path = `/api/v1/overlays/${api.seg(slug)}`;
  let overlay;
  try {
    overlay = await api.get(path);
  } catch (err) {
    if (err.status === 404) return { missing: true };
    throw err;
  }
  const { id: tid, version: tversion } = overlay.template || {};
  const readTemplates = typeof tid === 'string' && ctx.can('templates:read');
  const templatePath = readTemplates ? `/api/v1/templates/${api.seg(tid)}` : undefined;
  const [urls, pinned, versions, shows, formModule, health, overlays] = await Promise.all([
    api.get(`/api/v1/overlays/${api.seg(overlay.id)}/url`).then((r) => ({ list: Array.isArray(r?.urls) ? r.urls : [] }), (error) => ({ list: [], error })),
    // The version the overlay is pinned to (04 §4.10): its settings, scenes and canvases.
    templatePath && typeof tversion === 'string' ? api.get(`${templatePath}/versions/${api.seg(tversion)}`).catch(() => undefined) : undefined,
    // Every installed version, newest first: what it can upgrade to ([] when none is installed,
    // undefined when that couldn't be read).
    templatePath ? api.all(`${templatePath}/versions`).catch((err) => (err?.status === 404 ? [] : undefined)) : undefined,
    // Its show, or the shows it could join ("Add it to a show").
    ctx.can('timeline:read') ? api.all('/api/v1/shows').catch(() => []) : [],
    // Written separately (README "Settings form"); the page works without it.
    import('../schema-form.js').catch(() => undefined),
    // The connections to choose from for "Fed by" (operators read them here, by name and status).
    api.get('/api/v1/system/health').then((r) => ({ list: Array.isArray(r?.connections) ? r.connections : [] }), (error) => ({ list: [], error })),
    // The other overlays: those of its template in its show have settings of their own; outside a
    // show, the show its twin is in is the one to add it to.
    overlay.show || ctx.can('timeline:write') ? api.all('/api/v1/overlays').catch(() => []) : [],
  ]);
  return { overlay, urls, pinned, versions, shows, showId: shows.find((s) => s.name === overlay.show)?.id, formModule, health, overlays };
}

export async function detail(view, ctx) {
  const slug = ctx.params.slug;
  ctx.setTitle(slug);
  const requested = ctx.query.get('tab');
  const state = { tab: TABS.includes(requested) ? requested : 'settings', scene: '', mock: false, left: false, seq: 0, cleanup: undefined };

  const paint = (data, flash) => {
    state.cleanup?.();
    state.cleanup = undefined;
    if (data.missing) {
      mount(view,
        pageHead(`There is no overlay "${slug}"`, { crumbs: [{ label: 'Overlays', href: '#/overlays' }] }),
        h('div.card', h('p', 'It may have been renamed or deleted.'), h('a.btn.primary', { href: '#/overlays' }, 'Back to overlays')));
      return;
    }
    state.cleanup = renderOverlay(view, ctx, data, { state, flash, reload });
  };
  // Read it again (after a change, or a 412) and redraw, keeping the tab, scene and sample data.
  async function reload(flash) {
    const seq = ++state.seq;
    let data;
    try {
      data = await load(slug, ctx);
    } catch (err) {
      if (seq === state.seq && !state.left) toast(err);
      return;
    }
    if (seq !== state.seq || state.left) return;
    paint(data, flash);
  }

  paint(await load(slug, ctx));
  return () => {
    state.left = true;
    state.cleanup?.();
  };
}

function renderOverlay(view, ctx, data, { state, flash, reload }) {
  let overlay = data.overlay;
  const ref = () => `/api/v1/overlays/${api.seg(overlay.id)}`;
  const canWrite = ctx.can('overlays:write');
  const canControl = ctx.can('overlays:control');
  const pinned = overlay.template || {};
  // The manifest of the version the overlay is on (none when that version isn't installed).
  const manifest = data.pinned?.manifest;
  const tplName = manifest?.name || pinned.id || 'Unknown template';
  const scenes = Array.isArray(manifest?.scenes) ? manifest.scenes.filter((s) => s && s.id) : [];
  const st = statusOf(overlay);
  const ok = overlay.status === 'ok';
  const versionsKnown = Array.isArray(data.versions);
  const versions = versionsKnown ? data.versions : [];
  const newer = versions.filter((v) => compareVersions(v.version, pinned.version) > 0);
  // Another version's manifest (an upgrade's), read once.
  const manifests = new Map();
  const manifestOf = (version) => {
    if (version === pinned.version && manifest) return Promise.resolve(manifest);
    if (!manifests.has(version)) {
      manifests.set(version, api.get(`/api/v1/templates/${api.seg(pinned.id)}/versions/${api.seg(version)}`).then((t) => t?.manifest, () => undefined));
    }
    return manifests.get(version);
  };
  const stale = () => {
    toast('It changed since you opened it: here it is as it is now. Make your change again.', { kind: 'error' });
    return reload('It changed since you opened it (someone else, or another tab, saved it). This is it as it is now: make your change again.');
  };
  // A change that finds the overlay changed (412) or deleted meanwhile (404, its id in the
  // server's words) shows it as it is now: the page reads it again, or says it is gone.
  const outdated = async (err) => {
    if (err?.status === 412) { await stale(); return true; }
    if (err?.status === 404) {
      toast(`"${overlay.slug}" was deleted meanwhile (someone else, or another tab): nothing was changed.`, { kind: 'error' });
      await reload();
      return true;
    }
    return false;
  };
  const failed = async (err) => { if (!(await outdated(err))) toast(err); };
  const cleanups = [];

  // Canvases, as the overlay's URLs give them (its pinned version); else the manifest's.
  const canvases = data.urls.list.length
    ? data.urls.list
    : (manifest?.canvases || []).map((c, i) => ({ canvas: c.id, width: c.width, height: c.height, url: `/o/${encodeURIComponent(overlay.slug)}${i || !c.default ? `?canvas=${encodeURIComponent(c.id)}` : ''}` }));
  const canvasLabel = canvasNamer(canvases, manifest);

  // ---- the More menu (H20) ---------------------------------------------------------------
  async function rename(preset) {
    const answer = await prompt({
      title: `Rename "${overlay.slug}"`,
      intro: 'The name is part of the overlay\'s URL. After renaming, OBS sources using the old URL stop working until you paste the new URL into them.',
      fields: [{ name: 'slug', label: 'New name', value: preset ?? overlay.slug, required: true, hint: 'Lower-case letters, digits and dashes.' }],
      submitLabel: 'Rename',
    });
    if (!answer) return;
    const next = normalSlug(answer.slug);
    if (next === overlay.slug) return;
    if (!SLUG.test(next)) {
      toast(SLUG_HELP, { kind: 'error' });
      await rename(next);
      return;
    }
    try {
      overlay = await api.patch(ref(), { slug: next }, { ifMatch: overlay });
    } catch (err) {
      if (await outdated(err)) return;
      toast(err);
      await rename(next);
      return;
    }
    toast(`Renamed to "${overlay.slug}": paste the new URL into OBS.`);
    ctx.navigate(`/overlays/${encodeURIComponent(overlay.slug)}`, { replace: true });
  }

  async function toggleKey() {
    const on = !overlay.keyRequired;
    const yes = await confirm(on
      ? { title: 'Require the key in the URL?', consequence: 'OBS sources using the URL without its key will stop working: copy the new URL into them.', confirmLabel: 'Require the key' }
      : { title: 'Let the URL work without its key?', consequence: 'Anyone who can reach this platform and knows the overlay\'s name can open it. The URL in OBS keeps working.', confirmLabel: 'Stop requiring the key' });
    if (!yes) return;
    try {
      overlay = await api.patch(ref(), { keyRequired: on }, { ifMatch: overlay });
    } catch (err) {
      await failed(err);
      return;
    }
    toast(on ? 'The URL now needs its key: copy it into OBS again.' : 'The URL now works without its key.');
    await reload();
  }

  async function rotateKey() {
    const yes = await confirm({
      title: 'Make a new key?',
      consequence: overlay.keyRequired
        ? 'OBS sources using the current URL will stop working until you paste the new URL into them.'
        : 'The URL works without its key now, so OBS sources keep working; the new key counts once the key is required again.',
      confirmLabel: 'Make a new key',
    });
    if (!yes) return;
    const out = await run(null, () => api.post(`${ref()}/key/rotate`, {}), { onError: failed });
    if (!out) return;
    toast(overlay.keyRequired ? 'New key made: paste the new URL into OBS.' : 'New key made.');
    await reload();
  }

  async function remove() {
    const yes = await confirm({
      title: `Delete "${overlay.slug}"?`,
      consequence: `OBS sources using this overlay's URL will stop working, and its settings are gone for good.${overlay.show ? ` The show "${overlay.show}" carries on without it.` : ''}`,
      confirmLabel: 'Delete overlay',
    });
    if (!yes) return;
    try {
      await api.del(ref(), { ifMatch: overlay });
    } catch (err) {
      if (err?.status === 404) { toast(`"${overlay.slug}" was already deleted.`); ctx.navigate('/overlays', { replace: true }); return; }
      await failed(err);
      return;
    }
    toast(`Overlay "${overlay.slug}" deleted.`);
    ctx.navigate('/overlays', { replace: true });
  }

  // Letting a URL work without its key is the owner's call (system:admin): the server refuses
  // anyone else, so they see why instead of a choice that fails.
  const keyLocked = overlay.keyRequired && !ctx.can('system:admin');
  const more = canWrite ? menu('More', [
    { label: 'Rename…', onSelect: () => rename() },
    { label: `Require the key in the URL: ${overlay.keyRequired ? 'On' : 'Off'}${keyLocked ? ' (only the owner can turn it off)' : ''}`, disabled: keyLocked, onSelect: toggleKey },
    { label: 'Make a new key…', danger: true, onSelect: rotateKey },
    { label: 'Delete overlay…', danger: true, onSelect: remove },
  ]) : null;

  // ---- header and notices ----------------------------------------------------------------
  const showLink = overlay.show ? h('a', { href: showHref(data.showId || overlay.show) }, overlay.show) : null;
  const head = pageHead(overlay.slug, { crumbs: [{ label: 'Overlays', href: '#/overlays' }], actions: more ? [more] : [] });
  const meta = h('p.row',
    h('span', tplName), h('span.muted', pinned.version ? `version ${pinned.version}` : ''), badge(st.label, st.kind),
    newer.length && ok ? badge('Update available', 'accent') : null,
    overlay.show ? h('span', 'In the show ', showLink) : h('span.muted', 'Not in a show'));
  const notices = [];
  if (flash) notices.push(notice(flash, 'warn'));
  if (overlay.status === 'template-missing') {
    notices.push(notice([`The template this overlay uses (${tplName} ${pinned.version || ''}) isn't installed, so OBS shows nothing. Install that version again from `, h('a', { href: '#/templates' }, 'Templates'), newer.length ? ', or upgrade the overlay to an installed version (Version, below).' : '.'], 'danger'));
  } else if (overlay.status === 'template-unusable') {
    notices.push(notice([`The template this overlay uses (${tplName} ${pinned.version || ''}) is installed but can't run, so OBS shows nothing. Upgrade to another version (Version, below), or install it again from `, h('a', { href: '#/templates' }, 'Templates'), '.'], 'danger'));
  }
  // What its template reads from a show (set times, the countdown, title cards): outside a show
  // it gets none of it, so that comes first, with the way into one; in a show, where to edit it.
  // A template that reads only a show's times may have a time of its own: a quiet line instead.
  const outsideShow = needsShow(overlay, manifest);
  const timesOutside = wantsShowTimes(overlay, manifest);
  const addable = { overlay, manifest, shows: data.shows, overlays: data.overlays, onAdded: () => reload() };
  if (outsideShow) notices.push(showNotice(ctx, addable));
  let showLine = timesOutside ? showNotice(ctx, { ...addable, times: true }) : null;
  // Its show's night has passed (a weekly show left on last week's date): what it shows on air is
  // that night's countdown and set times, which only the show's page said.
  const myShow = overlay.show ? data.shows.find((s) => s.id === data.showId) : undefined;
  if (myShow && showParts(manifest).length) {
    const passed = passedLine(ctx, myShow, { onMoved: () => reload() });
    if (passed) notices.push(passed);
  }
  if (overlay.show) {
    const parts = showParts(manifest).map((p) => p.text);
    const at = (tab) => `${showHref(data.showId || overlay.show)}?tab=${tab}`;
    const links = [];
    if (parts.includes('set times')) links.push([h('a', { href: at('lineup') }, 'Lineup'), ' (the acts and their set times)']);
    if (parts.includes('the countdown')) links.push([h('a', { href: at('details') }, 'Details'), ' (the date and go-live time)']);
    if (links.length) {
      showLine = readsLineup(manifest)
        ? h('p.small.muted', `${showWords(manifest)} Edit them on the show: `, links.map((l, i) => [i ? ', ' : '', l]), '.')
        : h('p.small.muted', `${showWords(manifest).replace(/\ba show's\b/, 'the show\'s')} Its go-live time is on the show: `, links, '.');
    }
  }

  // ---- previews (H13) --------------------------------------------------------------------
  let previewSettingsParam; // ?settings= while edits are unsaved
  const unsavedBadge = badge('Showing unsaved settings', 'warn');
  unsavedBadge.hidden = true;
  const previewUrl = (c) => withPreview(c.url, { scene: state.scene, mock: state.mock, settings: previewSettingsParam });
  const boxes = ok ? canvases.map((c, i) => {
    const w = c.width || 1920;
    const hh = c.height || 1080;
    const box = preview(previewUrl(c), { width: w, height: hh, label: canvasLabel(c, i), eager: i < 2 ? undefined : false, title: `Preview of ${overlay.slug}, ${canvasLabel(c, i)}` });
    // Side by side at one height where they fit (each grows with its aspect ratio), one under the
    // other on a phone; never taller than the screen allows (the frame's scale follows the width).
    const r = w / hh;
    box.style.flex = `${r} 1 ${Math.round(r * 220)}px`;
    box.style.maxWidth = `min(100%, calc(${isPhone() ? 50 : 70}vh * ${r}))`;
    box.style.margin = '0';
    box.dataset.src = previewUrl(c);
    cleanups.push(() => box.unload());
    return box;
  }) : [];
  const refreshPreviews = () => {
    boxes.forEach((box, i) => {
      const next = previewUrl(canvases[i]);
      if (box.dataset.src !== next) {
        box.dataset.src = next;
        box.reload(next);
      }
    });
    unsavedBadge.hidden = !previewSettingsParam;
  };
  const sceneSelect = h('select', { onchange: () => { state.scene = sceneSelect.value; refreshPreviews(); } },
    h('option', { value: '' }, 'As on air'),
    scenes.map((s) => h('option', { value: s.id, selected: s.id === state.scene }, s.label || s.id)));
  const mockBox = h('input', { type: 'checkbox', checked: state.mock, onchange: () => { state.mock = mockBox.checked; refreshPreviews(); updateSimNote(); updateMockNote(); } });
  // Sample data makes up everything a show gives (src/sdk/mock.js): outside a show, say what of it
  // OBS doesn't have, so the preview doesn't pass for the real thing.
  const mockNote = h('div', { 'aria-live': 'polite' });
  function updateMockNote() {
    const on = state.mock && (outsideShow || timesOutside);
    mockNote.hidden = !on;
    mount(mockNote, on ? notice(sampleWords(manifest), outsideShow ? 'warn' : undefined) : null);
  }
  updateMockNote();
  const previewCard = h('section.card.stack',
    h('div.card-head', h('h2', 'Preview'), h('div.actions', unsavedBadge)),
    !ok ? h('p.muted', 'No preview: the overlay can\'t run until its template is fixed.')
      : !boxes.length ? h('p.muted', 'This overlay has no canvas to preview.')
        : [
          h('div.inline-form', scenes.length ? field('Scene in the preview', sceneSelect) : null, field('Sample data', mockBox)),
          mockNote,
          previewRow(boxes),
          h('p.small.muted', 'The scene and sample data change this preview only, never OBS.'),
        ]);

  // ---- the URL for OBS -------------------------------------------------------------------
  const urlCard = h('section.card.stack',
    h('h2', 'Add to OBS'),
    data.urls.error
      ? notice(`The URL could not be read: ${data.urls.error.message}`, 'danger')
      : canvases.length ? canvases.map((c, i) => {
        const label = canvasLabel(c, i);
        const copier = copyField(c.url, { label: 'Copy', copied: `${label.split(' · ')[0]} URL copied: paste it into an OBS browser source.` });
        copier.querySelector('input')?.setAttribute('aria-label', `${label} URL`);
        copier.querySelector('button')?.setAttribute('aria-label', `Copy the ${label} URL`);
        return h('div',
          h('h3', label),
          copier,
          h('p.small.muted', c.width ? `In OBS, add a Browser source with this URL and set Width ${c.width}, Height ${c.height}.` : 'In OBS, add a Browser source with this URL, at your canvas size.'));
      }) : h('p.muted', 'This overlay has no URL yet.'),
    h('p.small', 'This URL never changes when you change the settings, the theme or the template version. It changes only if you rename the overlay or make a new key.'),
    h('p.small.muted', overlay.keyRequired
      ? 'The URL carries the overlay\'s key: anyone who has it can show this overlay. Paste it only into OBS.'
      : 'This URL works without its key: anyone who can reach this platform and knows the overlay\'s name can open it.'));

  // ---- settings (04 §4.3) ----------------------------------------------------------------
  const schema = settingsSchemaOf(manifest);
  const settingsPanel = h('div.card');
  let form;
  let saved = isObj(overlay.settings) ? overlay.settings : {};
  let timer;
  cleanups.push(() => clearTimeout(timer));
  const saveBtn = h('button.btn.primary', { type: 'button', disabled: !canWrite, onclick: () => save() }, 'Save settings');
  const undoBtn = h('button.btn', { type: 'button', onclick: () => undo() }, 'Undo changes');
  undoBtn.hidden = true;
  const dirtyNote = h('span.small.muted', { 'aria-live': 'polite' });
  let settingsDirty = false; // what "Unsaved changes" says, for leaving the page
  const markDirty = (dirty) => {
    settingsDirty = dirty;
    undoBtn.hidden = !dirty;
    dirtyNote.textContent = dirty ? 'Unsaved changes' : '';
  };
  const showPending = (values) => {
    const dirty = stable(values) !== stable(saved);
    markDirty(dirty);
    previewSettingsParam = dirty ? settingsParam(previewSettings(manifest, schema, values, overlay.resolvedSettings, saved)) : undefined;
    refreshPreviews();
  };
  const onChange = (values, { live } = {}) => {
    clearTimeout(timer);
    const now = isObj(values) ? values : {};
    markDirty(stable(now) !== stable(saved));
    if (live) showPending(now);
    else timer = setTimeout(() => showPending(now), PREVIEW_DELAY_MS);
  };
  async function save() {
    if (!form) return;
    await run(saveBtn, async () => {
      const problems = form.validate() || [];
      if (problems.length) {
        toast(problems.length === 1 ? 'One setting needs fixing first: it is marked.' : `${problems.length} settings need fixing first: they are marked.`, { kind: 'error' });
        return;
      }
      const values = form.values() || {};
      const before = saved;
      try {
        overlay = await api.patch(ref(), { settings: values }, { ifMatch: overlay });
      } catch (err) {
        if (await outdated(err)) return;
        throw err;
      }
      saved = isObj(overlay.settings) ? overlay.settings : values;
      const changed = [...new Set([...Object.keys(before), ...Object.keys(saved)])].filter((k) => !sameValue(before[k], saved[k]));
      if (changed.length) offerAlso(changed).catch((err) => console.warn(err));
      // What the overlay sees now, for the form's placeholders.
      try { form.reset(structuredClone(saved), overlay.resolvedSettings || {}); } catch (err) { console.warn(err); }
      clearTimeout(timer);
      previewSettingsParam = undefined;
      markDirty(false);
      refreshPreviews();
      toast('Settings saved: the overlay shows them now, in OBS too.');
    });
  }
  function undo() {
    clearTimeout(timer);
    try { form?.reset(structuredClone(saved), overlay.resolvedSettings || {}); } catch (err) { console.warn(err); }
    previewSettingsParam = undefined;
    markDirty(false);
    refreshPreviews();
  }
  async function resetDefaults() {
    const yes = await confirm({ title: 'Reset the settings to the defaults?', consequence: 'Every setting you changed goes back to the template\'s default, on air at once. This can\'t be undone.', confirmLabel: 'Reset settings' });
    if (!yes) return;
    try {
      overlay = await api.patch(ref(), { settings: {} }, { ifMatch: overlay });
    } catch (err) {
      await failed(err);
      return;
    }
    toast('Settings reset to the template\'s defaults.');
    await reload();
  }

  // ---- the same change on the show's other overlays of this template -----------------------
  // Settings are each overlay's own, the copy too (a tagline is set on the landscape and on the
  // vertical overlay). After a save, the other overlays of this template in the show it is in now
  // (read fresh: it may have moved since the page was read) that hold something else in what
  // changed are offered the same change: only those settings, and only those their own version of
  // the template has (one on an older version is told what it lacks), each overlay with its own
  // If-Match as read for the offer (H16). What failed is said overlay by overlay, and offered again
  // on the overlay as it is now, unless its version can't take it (422: the same again would fail).
  const alsoBox = h('div.also-box', { 'aria-live': 'polite' });
  const pending = new Set(); // settings changed since the last offer was taken or left
  const siblings = overlay.show ? data.overlays.filter((o) => o && o.id !== overlay.id && o.show === overlay.show && o.template?.id === pinned.id) : [];
  const nameOf = (key) => settingName([manifest], `/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`);
  // Whether an overlay's version has a setting: from its own manifest (any setting, when that
  // can't be read: the server checks).
  async function fitsOf(o) {
    const version = o.template?.version;
    const m = typeof version === 'string' ? await manifestOf(version) : undefined;
    if (!m) return () => true;
    const props = settingsSchemaOf(m)?.properties;
    return (k) => has(props, k);
  }
  async function offerAlso(keys) {
    if (!canWrite) return;
    for (const k of keys) pending.add(k);
    if (!overlay.show) { pending.clear(); mount(alsoBox); return; }
    const show = await api.get(`/api/v1/shows/${api.seg(overlay.show)}`);
    if (!(show.overlays || []).includes(overlay.id)) return;
    const others = await Promise.all((show.overlays || []).filter((id) => id !== overlay.id).map((id) => api.get(`/api/v1/overlays/${api.seg(id)}`).catch(() => undefined)));
    await drawAlso(others.filter((o) => o?.template?.id === pinned.id), show.name);
  }
  // Each of them with the changed settings it holds otherwise and its version has, and those its
  // version doesn't have.
  async function targetsOf(others) {
    return Promise.all(others.map(async (o) => {
      const fits = await fitsOf(o);
      const differ = [...pending].filter((k) => !sameValue(isObj(o.settings) ? o.settings[k] : undefined, saved[k]));
      return { o, keys: differ.filter(fits), lacks: differ.filter((k) => !fits(k)) };
    }));
  }
  // "copy-v is on an older version of the template (1.0.0), which has no Tagline: upgrade it to
  // set that there."
  const lackWords = ({ o, lacks }) => {
    const older = compareVersions(o.template?.version, pinned.version) < 0;
    const what = andList(lacks.map(nameOf));
    return `${o.slug} is on ${older ? 'an older' : 'another'} version of the template (${o.template?.version}), which has no ${what}${older ? `: upgrade ${o.slug} to set ${lacks.length === 1 ? 'it' : 'them'} there` : ''}.`;
  };
  async function drawAlso(others, showName, outcome) {
    const all = await targetsOf(others);
    const targets = all.filter((t) => t.keys.length);
    const lacking = all.filter((t) => t.lacks.length);
    const lackNote = lacking.length ? h('p.small.muted', lacking.map(lackWords).join(' ')) : null;
    if (!targets.length) {
      pending.clear();
      mount(alsoBox, outcome, lackNote);
      return;
    }
    const names = targets.map((t) => t.o.slug);
    const fields = [...new Set(targets.flatMap((t) => t.keys))].map(nameOf);
    const one = targets.length === 1;
    const apply = h('button.btn.primary', { type: 'button', onclick: () => applyAlso(apply, targets, showName) }, `Also change: ${names.join(', ')}`);
    const leave = h('button.btn', { type: 'button', onclick: () => { pending.clear(); mount(alsoBox); } }, one ? 'Leave it as it is' : 'Leave them as they are');
    const offer = notice([
      h('p', `${andList(names)} (also in "${showName}") ${one ? 'has its' : 'have their'} own ${andList(fields)}: change ${one ? 'it' : 'them'} the same way?`),
      lackNote,
      h('div.row', apply, leave),
    ]);
    offer.classList.add('also-change');
    mount(alsoBox, outcome, offer);
  }
  async function applyAlso(button, targets, showName) {
    await run(button, async () => {
      const done = [];
      const refused = [];
      for (const t of targets) {
        const next = isObj(t.o.settings) ? structuredClone(t.o.settings) : {};
        for (const k of t.keys) {
          if (has(saved, k)) next[k] = structuredClone(saved[k]);
          else delete next[k];
        }
        try {
          await api.patch(`/api/v1/overlays/${api.seg(t.o.id)}`, { settings: next }, { ifMatch: t.o });
          done.push(t.o.slug);
        } catch (err) {
          refused.push({ t, err });
        }
      }
      if (!refused.length) {
        pending.clear();
        mount(alsoBox);
        toast(`Changed on ${andList(done)} too.`);
        return;
      }
      // In plain words: a version that can't take a value is said as such, not in the server's terms.
      const why = ({ t, err }) => (err?.status === 412 ? 'it changed since this page read it: someone else, or another tab'
        : err?.status === 404 ? 'it was deleted meanwhile'
          : err?.status === 422 ? `its version of the template, ${t.o.template?.version}, can't take ${t.keys.length === 1 ? 'that value' : 'those values'}`
            : String(err?.message || err).replace(/[.\s]+$/, ''));
      const outcome = notice([
        done.length ? `Changed on ${andList(done)}. ` : 'Nothing was changed. ',
        `Not changed on ${refused.map((r) => `${r.t.o.slug} (${why(r)})`).join(', ')}.`,
      ], 'danger');
      toast(`Not every overlay was changed: ${andList(refused.map((r) => r.t.o.slug))} ${refused.length === 1 ? 'was' : 'were'} not.`, { kind: 'error', ms: 10000 });
      // The ones refused, as they are now: offered again, to make the change on what they hold. Not
      // one deleted, nor one whose version refused it: the same again would fail the same way.
      const again = refused.filter((r) => r.err?.status !== 404 && r.err?.status !== 422 && r.err?.status !== 400);
      const now = await Promise.all(again.map((r) => api.get(`/api/v1/overlays/${api.seg(r.t.o.id)}`).catch(() => undefined)));
      await drawAlso(now.filter(Boolean), showName, outcome);
    });
  }

  {
    const resetMenu = canWrite && schema ? menu('More', [{ label: 'Reset to defaults…', danger: true, onSelect: resetDefaults }], { buttonClass: 'btn ghost' }) : null;
    const parts = [h('div.card-head', h('h2', 'Settings'), resetMenu ? h('div.actions', resetMenu) : null)];
    if (!manifest) {
      parts.push(h('p.muted', overlay.status === 'template-missing'
        ? 'The settings can\'t be shown: the template version this overlay uses isn\'t installed.'
        : 'The settings could not be read. Reload the page to try again.'));
    } else if (!schema) {
      parts.push(h('p.muted', 'This template has no settings.'));
    } else {
      if (!canWrite) parts.push(h('p.muted', 'Your role can see these settings but not change them.'));
      else if (siblings.length) {
        const one = siblings.length === 1;
        parts.push(h('p.small.muted', `These settings are this overlay's own: ${andList(siblings.map((o) => o.slug))}, also in "${overlay.show}", ${one ? 'has its' : 'have their'} own. When you save, you can change ${one ? 'it' : 'them'} the same way.`));
      }
      const make = data.formModule?.schemaForm;
      if (typeof make === 'function') {
        try {
          form = make({
            schema,
            definitions: manifest.definitions || {},
            values: structuredClone(saved),
            resolved: overlay.resolvedSettings || {},
            onChange,
            mediaList: async () => (await api.all('/api/v1/media')).filter((m) => !m.status || m.status === 'ready').map((m) => ({ url: m.url, name: m.name, type: m.type })),
          });
        } catch (err) {
          console.warn(err);
          form = undefined;
        }
      }
      if (form?.el) {
        const actions = h('div.form-actions', dirtyNote, undoBtn, saveBtn);
        actions.style.alignItems = 'center';
        parts.push(form.el, actions, alsoBox);
      } else {
        form = undefined;
        parts.push(notice('The settings form could not load. Reload the page to try again; everything else here works.', 'warn'));
      }
    }
    mount(settingsPanel, parts);
  }

  // ---- fed by (01 §1.3) ------------------------------------------------------------------
  // Which connections feed it: every one (made later too), or only some, so two streams at once
  // each show their own chat, alerts and viewers. Saved with If-Match like the settings (H16).
  const fedByPanel = h('section.card.stack#fed-by', h('h2', 'Fed by'));
  let fedChanged = () => false;
  {
    const binding = overlay.connections === 'all' ? 'all' : Array.isArray(overlay.connections) ? overlay.connections : 'all';
    const bound = Array.isArray(overlay.bound) ? overlay.bound : [];
    // (append() writes a null out as "null": only what there is.)
    fedByPanel.append(...[
      h('p', `Now: ${fedByWords(binding, bound)}`),
      bound.length ? h('div.chips', bound.map(connectionChip)) : null].filter(Boolean));
    if (data.health?.error) fedByPanel.append(notice(`The connections could not be read: ${data.health.error.message}`, 'warn'));
    if (!canWrite) {
      fedByPanel.append(h('p.muted', 'Your role can see what feeds this overlay but not change it.'));
    } else {
      const saveFed = h('button.btn.primary', { type: 'button', disabled: true, onclick: () => saveFedBy() }, 'Save connections');
      const fedForm = fedByForm({ connections: data.health?.list, value: binding, legend: 'Connections it shows', onChange: () => { saveFed.disabled = !fedForm.changed(); } });
      fedChanged = () => fedForm.changed();
      const nameOf = (entry) => bindingName(data.health?.list, entry);
      async function saveFedBy() {
        const next = fedForm.value();
        await run(saveFed, async () => {
          try {
            overlay = await api.patch(ref(), { connections: next }, { ifMatch: overlay });
          } catch (err) {
            if (await outdated(err)) return;
            throw err;
          }
          toast(`"${overlay.slug}" is fed by ${next === 'all' ? 'every connection' : next.length ? next.map(nameOf).join(', ') : 'no connection'} now.`);
          fedChanged = () => false; // saved: nothing to lose while the page is read again
          await reload();
        });
      }
      fedByPanel.append(fedForm.el, h('div.form-actions', saveFed));
    }
  }

  // ---- role in OBS (06 §6.11) ------------------------------------------------------------
  // How the CTD OBS plugin knows this overlay's place in a scene across streams: the same role
  // for the equivalent overlay of every CTD Relay profile, so switching profile re-points
  // its browser sources. Empty: the template's short name.
  const rolePanel = h('section.card.stack#role', h('h2', 'Role in OBS'));
  let roleChanged = () => false;
  {
    const fallback = String(pinned.id || '').split('.').pop() || 'overlay';
    const input = h('input', { type: 'text', value: overlay.role || '', maxlength: '54', autocomplete: 'off', spellcheck: 'false', placeholder: fallback, disabled: !canWrite, pattern: '[a-z0-9][a-z0-9\\-]*' });
    roleChanged = () => canWrite && input.value.trim().toLowerCase() !== (overlay.role || '');
    const saveRole = h('button.btn', { type: 'submit', disabled: !canWrite }, 'Save role');
    rolePanel.append(h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const next = input.value.trim().toLowerCase();
      if (next === (overlay.role || '')) return;
      await run(saveRole, async () => {
        try {
          overlay = await api.patch(ref(), { role: next || null }, { ifMatch: overlay });
        } catch (err) {
          if (await outdated(err)) return;
          throw err;
        }
        toast(next ? `"${overlay.slug}" plays the role "${next}" in OBS now.` : `"${overlay.slug}" plays its template's role in OBS now.`);
      });
    } },
    field('Role', input, { hint: `The same role for this overlay in every stream (like "chat-main"), so the CTD OBS plugin can switch its sources between CTD Relay profiles. Lowercase letters, digits and dashes. Empty: "${fallback}".` }),
    h('div.form-actions', saveRole)));
    if (!canWrite) rolePanel.append(h('p.muted', 'Your role can see this but not change it.'));
  }

  // ---- scenes (an overlay outside a show) ------------------------------------------------
  const scenesPanel = h('div.card.stack', h('h2', 'Scenes'));
  if (overlay.show) {
    scenesPanel.append(
      h('p', `This overlay is in the show "${overlay.show}". Take scenes on the show, so its overlays change together.`),
      h('div.row', h('a.btn.primary', { href: showHref(data.showId || overlay.show) }, 'Open the show'), h('a.btn', { href: '#/live' }, 'Go to Live')));
  } else if (!scenes.length) {
    scenesPanel.append(h('p.muted', 'This template has no scenes to take.'));
  } else if (!canControl) {
    scenesPanel.append(h('p.muted', 'Your role can\'t take scenes.'));
  } else {
    const buttons = scenes.map((s) => {
      const b = h('button.btn', { type: 'button', 'aria-pressed': 'false', onclick: async () => {
        const out = await run(b, () => api.put(`${ref()}/scene`, { scene: s.id }), { done: `Scene changed to ${s.label || s.id}` });
        if (out) for (const x of buttons) x.setAttribute('aria-pressed', String(x === b));
      } }, s.label || s.id);
      return b;
    });
    scenesPanel.append(h('p.muted', 'Not in a show: take a scene on this overlay alone. OBS follows at once.'), h('div.pad', buttons));
  }
  // Follow OBS outside a show (09 §9.7): its scene follows the OBS scene, saved with If-Match.
  const followPanel = !overlay.show && scenes.length
    ? followObsCard({ resource: overlay, path: ref(), scenes: scenes.map((s) => ({ value: s.id, label: s.label || s.id })), what: 'overlay', canWrite, reload: () => reload() })
    : null;

  // ---- simulate (08 §8.5) ----------------------------------------------------------------
  const simNote = h('div', { 'aria-live': 'polite' });
  function updateSimNote() {
    mount(simNote, state.mock ? notice('Sample data is on in the preview, so it doesn\'t show these: turn it off to watch them.', 'warn') : null);
  }
  updateSimNote();
  const testPanel = h('div.card.stack', h('h2', 'Test'));
  if (!canControl) {
    testPanel.append(h('p.muted', 'Your role can\'t send test events.'));
  } else {
    const items = SIMULATIONS.map((item) => {
      const out = h('span.small', { 'aria-live': 'polite' });
      const b = h('button.btn.block', { type: 'button', onclick: async () => {
        const body = { kind: item.kind, ...(item.body ? item.body() : {}) };
        const answer = await run(b, () => api.post(`${ref()}/simulate`, body));
        if (!answer) return;
        const takes = (answer.sent || []).some((s) => s.delivered);
        mount(out, takes ? badge('Used by this template', 'ok') : badge('Not used by this template', 'warn'));
        toast(takes ? item.done(body) : `This template doesn't show ${item.what}, so nothing changes.`);
      } }, item.label);
      return h('div', b, out);
    });
    const resetBtn = h('button.btn', { type: 'button', onclick: async () => {
      const answer = await run(resetBtn, () => api.post(`${ref()}/simulate`, { kind: 'reset' }));
      if (!answer) return;
      toast(answer.sent?.some((s) => s.reset) ? 'Test ended: the overlay shows the real values again.' : 'Nothing was being tested: the overlay already shows the real values.');
    } }, 'Reset');
    testPanel.append(
      h('p.muted', 'Send a sample event to this overlay only, to see how it looks. Nothing reaches other overlays, the show or webhooks.'),
      simNote,
      h('div.pad', items),
      h('div.row', resetBtn, h('span.small.muted', 'A viewer count or track you send lasts a minute, or until Reset.')));
  }

  // ---- version (04 §4.10) ----------------------------------------------------------------
  const describe = (c, ms) => {
    const name = `"${settingName(ms, c.path)}"`;
    switch (c.change) {
      case 'removed': return `${name}: your value (${shown(c.from)}) is dropped; the new version doesn't have this setting.`;
      case 'invalid': return `${name}: your value (${shown(c.from)}) doesn't fit the new version, so it goes back to ${shown(c.to)}.`;
      case 'added': return c.to === undefined ? `New setting ${name}.` : `New setting ${name}: ${shown(c.to)}.`;
      case 'default': return `${name} (you never set it) changes from ${shown(c.from)} to ${shown(c.to)}.`;
      case 'migrated':
        if (c.from === undefined) return `${name} is set to ${shown(c.to)} by the version's update script.`;
        if (c.to === undefined) return `${name}: your value (${shown(c.from)}) is taken out by the version's update script.`;
        return `${name} changes from ${shown(c.from)} to ${shown(c.to)}, by the version's update script.`;
      default: return `${name} changes.`;
    }
  };
  // What the new version brings beside its settings: its new scenes, and its new actions (buttons on
  // Live, things a cue can do), each with what it needs of the settings (action-needs.js).
  function newInVersion(target, ms) {
    const had = (key) => new Set((Array.isArray(manifest?.[key]) ? manifest[key] : []).map((x) => x?.id));
    const added = (key) => (Array.isArray(target?.[key]) ? target[key] : []).filter((x) => x && typeof x.id === 'string' && !had(key).has(x.id));
    const scenes = added('scenes');
    const actions = added('actions');
    if (!scenes.length && !actions.length) return null;
    return [
      h('h3', 'New in this version'),
      scenes.length ? h('p', `${scenes.length === 1 ? 'A scene' : 'Scenes'}: ${andList(scenes.map((s) => `"${s.label || s.id}"`))}, on Live and for cues.`) : null,
      actions.length ? h('ul', actions.map((a) => {
        const needs = needsWords(target.id, a.id, (name) => settingName(ms, `/${name}`));
        return h('li', `"${a.label || a.id}": a new button on Live, and something a cue can do${needs ? `; ${needs}` : ''}.`);
      })) : null,
    ];
  }
  function planBody(plan, migrateBox, target) {
    const ms = [target, manifest];
    const changes = Array.isArray(plan.changes) ? plan.changes : [];
    const gone = plan.removed || {};
    const list = (ids) => (ids || []).join(', ');
    return h('div',
      h('p', `From version ${plan.from} to ${plan.to}. The overlay's URL stays the same; OBS sources reload with the new version by themselves.`),
      plan.major ? notice('This is a major update: the overlay may look or behave differently. Check the preview after upgrading.', 'warn') : null,
      gone.scenes?.length ? notice(`Scenes this version doesn't have: ${list(gone.scenes)}. A show, button or cue that takes them won't work.`, 'warn') : null,
      gone.actions?.length ? notice(`Actions this version doesn't have: ${list(gone.actions)}. Buttons and cues that fire them won't work.`, 'warn') : null,
      gone.canvases?.length ? notice(`Canvases this version doesn't have: ${list(gone.canvases)}. OBS sources using them show the default canvas.`, 'warn') : null,
      newInVersion(target, ms),
      h('h3', 'Settings'),
      changes.length ? h('ul', changes.map((c) => h('li', describe(c, ms)))) : h('p.muted', 'No setting changes.'),
      plan.migrated === true ? h('p.muted', 'The version\'s update script carried your settings over.') : null,
      migrateBox ? [
        h('h3', 'Update script'),
        h('p.small.muted', 'This version comes with a script that carries your settings over. It is code from the template and runs on this platform\'s server: allow it only for a template you trust. Without it, renamed settings show above as dropped.'),
        field('Run the update script, then show me the changes again', migrateBox),
      ] : null);
  }
  async function upgrade(button, version) {
    let runMigrate = false;
    for (;;) {
      // The plan, and the new version's manifest to name its settings as its form does.
      const plan = await run(button, async () => {
        const [out] = await Promise.all([
          api.post(`${ref()}/upgrade`, { version, dryRun: true, ...(runMigrate ? { runMigrate: true } : {}) }),
          manifestOf(version),
        ]);
        return out;
      }, { onError: failed });
      if (!plan) return;
      const target = await manifestOf(plan.to || version);
      // Ticked, the dialog's button says it shows the plan again rather than upgrading.
      const box = plan.migrated === 'skipped' ? h('input', { type: 'checkbox', onchange: () => {
        const primary = box.closest('dialog')?.querySelector('.form-actions .btn.primary');
        if (primary) primary.textContent = box.checked ? 'Continue' : 'Upgrade';
      } }) : null;
      const go = await dialog({ title: `Upgrade to version ${version}?`, body: planBody(plan, box, target), actions: [{ label: 'Cancel', value: false }, { label: 'Upgrade', value: true, kind: 'primary' }] });
      if (!go) return;
      if (box?.checked) { runMigrate = true; continue; } // show what the script does first
      const out = await run(button, () => api.post(`${ref()}/upgrade`, { version, confirm: true, ...(runMigrate ? { runMigrate: true } : {}) }), { onError: failed });
      if (!out) return;
      toast(`Upgraded to version ${out.to || version}: OBS sources reload with it by themselves.`);
      await reload();
      return;
    }
  }
  // Going back discards the settings changed since (H20): in the panel's More menu, behind a
  // confirmation that says so.
  async function revert(back) {
    const yes = await confirm({
      title: `Go back to version ${back}?`,
      consequence: `The overlay returns to version ${back} with the settings it had then, on air at once: every setting changed since is lost. The URL stays the same.`,
      confirmLabel: `Go back to ${back}`,
    });
    if (!yes) return;
    const out = await run(null, () => api.post(`${ref()}/revert`, {}), { onError: failed });
    if (!out) return;
    toast(`Back on version ${out.to || back}, with the settings it had then.`);
    await reload();
  }
  const previousVersion = overlay.previous?.template?.version;
  const versionMenu = canWrite && previousVersion
    ? menu('More', [{ label: `Go back to version ${previousVersion}…`, danger: true, onSelect: () => revert(previousVersion) }], { buttonClass: 'btn ghost', ariaLabel: 'More for the version' })
    : null;
  const versionPanel = h('div.card.stack', h('div.card-head', h('h2', 'Version'), versionMenu ? h('div.actions', versionMenu) : null));
  {
    const rows = [
      h('dt', 'Template'), h('dd', versions.length ? h('a', { href: `#/templates/${encodeURIComponent(pinned.id)}` }, tplName) : tplName),
      h('dt', 'Version'), h('dd', pinned.version || 'Unknown', versions.length ? h('span.muted', newer.length ? ' · a newer version is installed' : versions.some((v) => v.version === pinned.version) ? ' · the newest installed' : '') : null),
    ];
    if (overlay.previous?.template) rows.push(h('dt', 'Before the last change'), h('dd', `Version ${overlay.previous.template.version}${overlay.previous.at ? ` (changed ${ago(overlay.previous.at)})` : ''}`));
    versionPanel.append(h('dl.kv', rows));
    if (canWrite && newer.length) {
      const pick = h('select', newer.map((v, i) => h('option', { value: v.version, selected: i === 0 }, `Version ${v.version}`)));
      const up = h('button.btn.primary', { type: 'button', onclick: () => upgrade(up, pick.value) }, 'Upgrade…');
      versionPanel.append(newer.length > 1
        ? h('div.inline-form', field('Upgrade to', pick), up)
        : h('div.row', h('span', `Version ${newer[0].version} is installed.`), up));
    }
    if (!versionsKnown) versionPanel.append(h('p.muted', 'The installed versions could not be read. Reload the page to try again.'));
    else if (!versions.length) versionPanel.append(h('p.muted', 'No version of this template is installed.'));
  }

  // ---- the page --------------------------------------------------------------------------
  const panels = { settings: settingsPanel, scenes: scenesPanel, test: testPanel, version: versionPanel };
  const tabList = tabs([
    { id: 'settings', label: 'Settings', render: (p) => { p.append(panels.settings, fedByPanel, rolePanel); } },
    { id: 'scenes', label: 'Scenes', render: (p) => { p.append(panels.scenes); if (followPanel) p.append(followPanel); } },
    { id: 'test', label: 'Test', render: (p) => { p.append(panels.test); } },
    { id: 'version', label: 'Version', render: (p) => { p.append(panels.version); } },
  ], { selected: state.tab, onChange: (id) => { state.tab = id; } });
  cleanups.push(() => tabList.destroy?.());
  // Leaving the page (a link, Back, a reload) with a change on the Settings tab not saved yet asks
  // first (app.js), whichever tab is open: its settings, what feeds it, its role in OBS.
  cleanups.push(ctx.guardLeave(() => {
    const parts = [canWrite && settingsDirty ? 'its settings' : '', fedChanged() ? 'what feeds it' : '', roleChanged() ? 'its role in OBS' : ''].filter(Boolean);
    return parts.length ? `Your changes to ${andList(parts)} are lost; the overlay stays as it was saved.` : '';
  }));

  mount(view, head, meta, showLine, notices, h('div.stack', previewCard, urlCard, tabList));
  return () => { for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* gone */ } } };
}
