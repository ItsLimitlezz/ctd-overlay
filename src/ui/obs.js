// Follow OBS in the admin UI (09 §9.7): what OBS shows, in words ("OBS · landscape: Live ·
// vertical: BRB · Streaming"), and the "Follow OBS" card of a show's Details and of an overlay
// outside a show (its Scenes tab): on or off, whose OBS, which canvas drives it, and per OBS scene
// the scene to take, for every scene OBS has (`stream.obs[].scenes`, when the plugin sends its
// list), else the scenes OBS has shown (`stream.obs[].seen`), or typed when OBS hasn't shown one
// yet. Saved with If-Match (H16).
import * as api from './api.js';
import { field, h, mount, notice, run, toast } from './dom.js';

const list = (v) => (Array.isArray(v) ? v : []);
const CANVAS = { landscape: 'Landscape (main)', vertical: 'Vertical' };

// One feed's OBS in words: "landscape: Live · vertical: BRB V · Streaming · Recording".
export function obsWords(o) {
  const parts = [];
  if (o?.landscape?.scene) parts.push(`landscape: ${o.landscape.scene}`);
  if (o?.vertical?.scene) parts.push(`vertical: ${o.vertical.scene}`);
  if (o?.streaming === true) parts.push('Streaming');
  else if (o?.streaming === false) parts.push('Not streaming');
  if (o?.recording === true) parts.push('Recording');
  return `${parts.join(' · ')}${o?.stale ? ' (held)' : ''}`;
}

// A stream's OBS, a line per feed that reports it ("OBS · …", with the feed's name when several).
export function obsStrip(stream) {
  const feeds = list(stream?.obs).filter((o) => o && typeof o === 'object');
  if (!feeds.length) return null;
  // One line per thing to say: two connections relaying the same OBS under one name say it once.
  const lines = [...new Map(feeds.map((o) => {
    const head = feeds.length > 1 ? `OBS (${o.name || o.source})` : 'OBS';
    const words = ` · ${obsWords(o) || 'no scene yet'}`;
    return [`${head}${words}`, [head, words]];
  })).values()];
  return h('div.stack.obs-strip', { role: 'list', 'aria-label': 'OBS' }, lines.map(([head, words]) => h('p.small', { role: 'listitem' }, h('strong', head), words)));
}

// When OBS took the scene last: "Set by OBS (BRB, landscape) at 9:41 PM", or null.
export function byObsWords(byObs, timeZone) {
  if (!byObs || typeof byObs !== 'object' || !byObs.at) return null;
  let at = '';
  try { at = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) }).format(new Date(byObs.at)); } catch { at = ''; }
  return `Set by OBS${byObs.obsScene ? ` (${byObs.obsScene}${byObs.canvas ? `, ${byObs.canvas}` : ''})` : ''}${at ? ` at ${at}` : ''}.`;
}

// The Follow OBS card. resource: the show or overlay as read (followObs, stream, its ETag);
// path: where it is changed; scenes: [{ value, label }] its templates have; what: "show" or
// "overlay"; canWrite; reload(): read it again (after a save, or when it changed meanwhile).
// Returns the card's element.
export function followObsCard({ resource, path, scenes, what = 'show', canWrite, reload }) {
  const saved = resource?.followObs && typeof resource.followObs === 'object' ? resource.followObs : { enabled: false, canvas: 'landscape', map: [] };
  const feeds = list(resource?.stream?.obs).filter((o) => o && typeof o.source === 'string');
  const card = h('section.card.stack#follow-obs', h('h2', 'Follow OBS'));
  const sceneOptions = list(scenes).filter((s) => s && typeof s.value === 'string');
  card.append(h('p.muted', `When the scene changes in OBS, this ${what} takes the scene you pick for it, so you switch once, in OBS. It needs the CTD OBS plugin sending its scenes through CTD Relay (v1.5 or newer).`));
  if (!sceneOptions.length) {
    card.append(h('p.muted', `This ${what}'s templates have no scenes to take.`));
    return card;
  }

  // What is chosen now (kept while the source or the canvas changes): OBS scene name → { scene, uuid }.
  const chosen = new Map(list(saved.map).map((r) => [r.obsScene, { scene: r.scene, uuid: r.obsSceneUuid }]));
  const extra = new Set(); // OBS scenes typed in here, not shown by OBS yet
  const disabled = !canWrite;
  const enabled = h('input', { type: 'checkbox', checked: saved.enabled === true, disabled });
  const source = h('select', { disabled },
    h('option', { value: '' }, feeds.length === 1 ? `The one that feeds it (${feeds[0].name})` : 'The one that feeds it'),
    feeds.map((o) => h('option', { value: o.source }, o.name || o.source)),
    saved.source && !feeds.some((o) => o.source === saved.source) ? h('option', { value: saved.source }, `${saved.source} (not reporting now)`) : null);
  source.value = saved.source || '';
  const canvas = h('select', { disabled }, Object.entries(CANVAS).map(([value, label]) => h('option', { value }, label)));
  canvas.value = saved.canvas === 'vertical' ? 'vertical' : 'landscape';
  const otherwise = sceneSelect(saved.otherwise, 'Any other OBS scene');
  const rowsBox = h('div.stack');
  const statusBox = h('div', { 'aria-live': 'polite' });
  const addName = h('input', { type: 'text', maxlength: '200', autocomplete: 'off', spellcheck: 'false', placeholder: 'Scene name in OBS', disabled });
  const addButton = h('button.btn', { type: 'button', disabled, onclick: () => {
    const name = addName.value.trim();
    if (!name) return;
    if (!chosen.has(name)) chosen.set(name, { scene: '' });
    extra.add(name);
    addName.value = '';
    drawRows();
    changed();
  } }, 'Add');
  const save = h('button.btn.primary', { type: 'button', disabled: true }, 'Save');

  function sceneSelect(value, label) {
    const s = h('select', { disabled, 'aria-label': label, onchange: () => changed() },
      h('option', { value: '' }, 'Leave the scene as it is'),
      sceneOptions.map((o) => h('option', { value: o.value }, o.label || o.value)),
      value && !sceneOptions.some((o) => o.value === value) ? h('option', { value }, `${value} (not in the templates now)`) : null);
    s.value = value || '';
    return s;
  }
  // The feed whose OBS it follows, as the server would pick it: the one chosen, else the only one.
  const followedFeed = () => (source.value ? feeds.find((o) => o.source === source.value) : feeds.length === 1 ? feeds[0] : undefined);

  let rowSelects = new Map(); // OBS scene name → its select
  function drawRows() {
    const f = followedFeed();
    const c = canvas.value;
    const now = f?.[c]?.scene;
    // Every scene of the canvas in OBS's order when the plugin sends its list; else the scenes this
    // OBS has shown on it (newest first). Then those mapped already, then typed.
    const all = Array.isArray(f?.scenes?.[c]) ? f.scenes[c] : undefined;
    const names = [];
    const uuids = new Map();
    for (const s of all || list(f?.seen?.[c])) if (s?.scene && !names.includes(s.scene)) { names.push(s.scene); if (s.sceneUuid) uuids.set(s.scene, s.sceneUuid); }
    if (now && !names.includes(now)) { names.unshift(now); if (f[c].sceneUuid) uuids.set(now, f[c].sceneUuid); }
    const inObs = new Set(names);
    for (const n of [...chosen.keys(), ...extra]) if (!names.includes(n)) names.push(n);
    for (const [n, u] of uuids) { const x = chosen.get(n); if (x && !x.uuid) x.uuid = u; }
    rowSelects = new Map();
    const rows = names.map((n) => {
      const sel = sceneSelect(chosen.get(n)?.scene, `Scene for the OBS scene ${n}`);
      sel.addEventListener('change', () => {
        chosen.set(n, { scene: sel.value, uuid: chosen.get(n)?.uuid || uuids.get(n) });
      });
      rowSelects.set(n, sel);
      return field(`${n}${n === now ? ' (on now)' : all && !inObs.has(n) ? ' (not in OBS now)' : ''}`, sel);
    });
    const none = all ? 'OBS has no scenes on this canvas.' : 'No scene from OBS yet: change scenes in OBS once to list them here, or add one by its name.';
    mount(rowsBox,
      h('h3', `OBS scenes, ${CANVAS[c].toLowerCase()} canvas`),
      all ? h('p.small.muted', `Every scene in ${f.name}'s OBS on this canvas, in OBS's order.`) : null,
      rows.length ? h('div.obs-map', rows) : h('p.muted', none),
      canWrite ? h('div.inline-form', field('Add an OBS scene', addName), addButton) : null,
      field('Any other OBS scene', otherwise, { hint: 'For a scene in OBS not listed above.' }));
    drawStatus();
  }
  function drawStatus() {
    const f = followedFeed();
    let msg = null;
    if (!feeds.length) msg = notice(`No OBS reports scenes for this ${what} yet: its connections need CTD Relay v1.5 and the CTD OBS plugin with scene publishing.`, 'warn');
    else if (!f) msg = notice(source.value ? 'The OBS picked isn\'t reporting now.' : `Several OBS feed this ${what}: pick the one it follows.`, 'warn');
    else msg = h('p', `Following ${f.name}${f[canvas.value]?.scene ? `: the ${canvas.value} canvas shows "${f[canvas.value].scene}" now` : ''}.`);
    mount(statusBox, msg);
  }

  // The followObs these controls say, as the API takes it.
  function value() {
    const map = [];
    for (const [n, sel] of rowSelects) {
      if (!sel.value) continue;
      const uuid = chosen.get(n)?.uuid;
      map.push({ obsScene: n, ...(uuid ? { obsSceneUuid: uuid } : {}), scene: sel.value });
    }
    return { enabled: enabled.checked, canvas: canvas.value, ...(source.value ? { source: source.value } : {}), map, ...(otherwise.value ? { otherwise: otherwise.value } : {}) };
  }
  const key = (f) => JSON.stringify([f.enabled === true, f.canvas || 'landscape', f.source || '', list(f.map).map((r) => [r.obsScene, r.scene]).sort(), f.otherwise || '']);
  function changed() {
    save.disabled = disabled || key(value()) === key(saved);
  }

  enabled.addEventListener('change', changed);
  source.addEventListener('change', () => { drawRows(); changed(); });
  canvas.addEventListener('change', () => {
    // Another canvas has other scenes: what was chosen for this one doesn't carry over.
    chosen.clear();
    extra.clear();
    if (canvas.value === (saved.canvas || 'landscape')) for (const r of list(saved.map)) chosen.set(r.obsScene, { scene: r.scene, uuid: r.obsSceneUuid });
    drawRows();
    changed();
  });
  save.addEventListener('click', () => run(save, async () => {
    const next = value();
    try {
      await api.patch(path, { followObs: next }, { ifMatch: resource });
    } catch (err) {
      if (err.status === 412) {
        toast(`The ${what} changed since you opened it: this is the latest. Make your change again.`, { kind: 'error' });
        await reload?.();
        return;
      }
      throw err;
    }
    toast(next.enabled ? `Following OBS: ${next.map.length} scene${next.map.length === 1 ? '' : 's'} mapped on the ${next.canvas} canvas.` : 'Not following OBS.');
    await reload?.();
  }));

  drawRows();
  card.append(
    statusBox,
    field('Follow OBS scenes', enabled),
    h('div.grid',
      field('Whose OBS', source, { hint: 'The CTD Relay profile whose OBS it follows.' }),
      field('Canvas', canvas, { hint: what === 'show' ? 'The show\'s overlays share one scene, so one OBS canvas drives it.' : 'The OBS canvas whose scene it follows.' })),
    rowsBox,
    canWrite ? h('div.form-actions', save) : h('p.muted', `Your role can see this but not change it.`));
  return card;
}
