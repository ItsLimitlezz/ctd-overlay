// Templates (08 §8.2): the gallery and a template's page, the path a non-technical user takes:
// browse → preview (live, with sample data) → use (it makes an overlay) → copy into OBS (the
// overlay's page shows its URL). Installing shows the package check first (04 §4.11), and a
// template from outside the platform says plainly that it is code that runs in OBS. Sources
// follow GitHub releases (or a link) so a template updates by itself (04 §4.13).
//
//   GET    /api/v1/templates · /:id · /:id/versions        the gallery, a template, its versions
//   GET    /api/v1/templates/:id/versions/:v/previews/:f   a preview image (an <img>)
//   POST   /api/v1/templates/validate (the raw package)     the check, without installing
//   POST   /api/v1/templates (the raw package, or { url })  install
//   DELETE /api/v1/templates/:id[?version=]                 uninstall a version, or every one
//   GET/POST /api/v1/templates/sources · DELETE …/:ref · POST …/sources/check[?source=]
//   GET    /api/v1/integrations/github/repos/:owner/:name/releases   Test: a repository's releases
//   POST   /api/v1/overlays { slug, template: { id, version } }   "Use template"
//   /o/~p.<id>@<version>?mock=1&canvas=&scene=               the live preview with sample data
import * as api from '../api.js';
import { ago, badge, bytes, confirm, dialog, empty, field, focusBack, h, menu, mount, notice, pageHead, preview, run, tabs, toast } from '../dom.js';
import { CONNECT_ROUTE, problemNotice, repoOf, repoTest } from '../github.js';

// ---- words -----------------------------------------------------------------------------------
const CATEGORIES = {
  show: 'Show package', chat: 'Chat', alerts: 'Alerts', 'now-playing': 'Now playing', 'lower-third': 'Lower third',
  background: 'Background', ticker: 'Ticker', goal: 'Goal', scoreboard: 'Scoreboard', widget: 'Widget',
};
const ORDER = Object.keys(CATEGORIES);
const categoryLabel = (c) => CATEGORIES[c] || (c ? String(c).charAt(0).toUpperCase() + String(c).slice(1).replace(/-/g, ' ') : 'Other');

// Where an installed version came from (the API's version view).
const ORIGINS = { bundled: 'Built in', github: 'From GitHub', url: 'From a link', package: 'From a file', installed: 'Installed' };
const originLabel = (source) => ORIGINS[source] || 'Installed';

// Core scenes (04 §4.2) as people know them: the show's buttons work across templates through them.
const CORES = {
  auto: 'Automatic', starting: 'Starting soon', program: 'Live', brb: 'Be right back', lineup: 'Lineup',
  outro: 'Outro', bg: 'Background', intro: 'Intro',
};

// What a template consumes (its state keys and event types), as the connections people know
// (08 §8.2, §8.8). Matched by the first part of each pattern; `*` is everything.
const FEEDS = [
  { ns: ['viewers'], label: 'Viewer count', from: 'Twitch, Kick or YouTube' },
  { ns: ['stream'], label: 'Stream status', from: 'Twitch, Kick or YouTube' },
  { ns: ['chat'], label: 'Chat', from: 'Twitch, Kick or YouTube' },
  { ns: ['alert', 'alerts'], label: 'Alerts', from: 'Follows, subs, gifts and raids from Twitch, Kick or YouTube' },
  { ns: ['music'], label: 'Now playing', from: 'Spotify' },
  { ns: ['obs'], label: 'OBS status', from: 'OBS' },
  { ns: ['show'], label: 'Show and lineup', from: 'Your show on this platform: scenes, lineup, title cards' },
  { ns: ['media'], label: 'Media clips', from: 'Clips and images you upload here' },
  { ns: ['custom'], label: 'Custom data', from: 'Other apps, through the API' },
];

const PACKAGE_LIMIT = 100 * 1024 * 1024; // 04 §4.1
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/; // an overlay's slug (overlays/registry.js)
const PREVIEW_ID = /^[a-z0-9][a-z0-9.-]*$/; // what /o/~p.<id>@<version> accepts (overlays/routes.js)
const PREVIEW_VERSION = /^[0-9A-Za-z.+-]+$/;

const pageOf = (id) => `#/templates/${api.seg(id)}`;
const apiOf = (id) => `/api/v1/templates/${api.seg(id)}`;
const overlayHref = (slug) => `#/overlays/${api.seg(slug)}`;
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const seconds = (ms) => `${Math.round(ms / 100) / 10} s`;
const authorOf = (m) => (typeof m?.author === 'string' ? m.author : typeof m?.author?.name === 'string' ? m.author.name : '');
const arr = (v) => (Array.isArray(v) ? v : []);

// ---- canvases --------------------------------------------------------------------------------
const COMMON = [[16, 9], [9, 16], [4, 3], [3, 4], [1, 1], [21, 9], [9, 21], [4, 5], [5, 4], [3, 2], [2, 3], [2, 1], [1, 2], [4, 1], [1, 4]];
function ratio(w, h) {
  if (!(w > 0 && h > 0)) return '';
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(Math.round(w), Math.round(h)) || 1;
  if (w / g <= 32 && h / g <= 32) return `${w / g}:${h / g}`;
  const near = COMMON.find(([a, b]) => Math.abs(a / b - w / h) / (w / h) < 0.02);
  return near ? `${near[0]}:${near[1]}` : `${w}×${h}`;
}
const shapeOf = (c) => (c.width > c.height ? 'Landscape' : c.width < c.height ? 'Vertical' : 'Square');
const canvasesOf = (m) => arr(m?.canvases).filter((c) => c && c.width > 0 && c.height > 0);

// The page of a template version in mock mode (08 §8.5), at one canvas and scene.
function previewUrl(id, version, { canvas, scene, dark } = {}) {
  if (!PREVIEW_ID.test(String(id)) || !PREVIEW_VERSION.test(String(version))) return undefined;
  const q = new URLSearchParams({ mock: '1' });
  if (canvas) q.set('canvas', canvas);
  if (scene) q.set('scene', scene);
  if (dark) q.set('bg', 'dark');
  return `/o/${api.seg(`~p.${id}@${version}`)}?${q}`;
}

// What a template can show, from its consumes (04 §4.2).
function feedsOf(manifest) {
  const c = manifest?.consumes || {};
  const spaces = new Set([...arr(c.state), ...arr(c.events)].filter((p) => typeof p === 'string').map((p) => p.split('.')[0]));
  if (c.chat && typeof c.chat === 'object') spaces.add('chat');
  return FEEDS.filter((f) => spaces.has('*') || f.ns.some((n) => spaces.has(n)));
}

// An overlay slug from a template id: its last part ("com.dprtmnt.takeover" → "takeover"), with
// -2, -3… when that one is taken.
function suggestSlug(id, taken) {
  const last = String(id).split('.').filter(Boolean).pop() || 'overlay';
  const base = last.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'overlay';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  return base;
}

// ---- dialogs that stay open while they work --------------------------------------------------
// dom.js's prompt() closes before the request runs, so an error would land behind the page. These
// keep the dialog open, show the problem's detail inside it, and can't be dismissed mid-request.

// askForm({ title, intro, note, fields: [{ name, label, type, value, hint, options, … }],
// submitLabel, onSubmit(values) }) → what onSubmit resolved with, or undefined when cancelled.
function askForm({ title, intro, note, fields, submitLabel = 'Save', onSubmit }) {
  const back = focusBack();
  return new Promise((resolve) => {
    const id = `dlg-${Math.random().toString(36).slice(2)}`;
    const inputs = {};
    const rows = fields.map((f) => {
      const input = f.type === 'select'
        ? h('select', { name: f.name }, arr(f.options).map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)))
        : h('input', {
          type: f.type || 'text', name: f.name, value: f.value ?? '', required: f.required, placeholder: f.placeholder,
          autocomplete: 'off', autocapitalize: f.autocapitalize, spellcheck: f.spellcheck, inputmode: f.inputmode,
        });
      inputs[f.name] = input;
      return field(f.label, input, { hint: f.hint });
    });
    const message = h('div', { 'aria-live': 'polite' });
    const cancel = h('button.btn', { type: 'button', onclick: () => d.close() }, 'Cancel');
    const submit = h('button.btn.primary', { type: 'submit' }, submitLabel);
    const form = h('form', { novalidate: true },
      h('div.dialog-body', h('h2', { id }, title), intro ? h('p.muted', intro) : null, note, rows, message),
      h('div.form-actions', cancel, submit));
    const d = h('dialog', { 'aria-labelledby': id }, form);
    let result;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      mount(message);
      const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
      let done = false;
      cancel.disabled = true;
      await run(submit, async () => {
        result = await onSubmit(values);
        done = true;
      }, { onError: (err) => mount(message, notice(err.message, 'danger')) });
      cancel.disabled = false;
      if (done) d.close();
    });
    d.addEventListener('cancel', (e) => { if (submit.disabled) e.preventDefault(); });
    d.addEventListener('close', () => { d.remove(); back(); resolve(result); });
    document.body.append(d);
    d.showModal();
    Object.values(inputs)[0]?.focus();
  });
}

// A check's findings (04 §4.11): { level, code, path, message }.
function findingsList(findings) {
  const items = arr(findings).filter(Boolean);
  if (!items.length) return null;
  return h('ul.list', items.map((f) => h('li',
    badge(f.level === 'error' ? 'Problem' : 'Warning', f.level === 'error' ? 'danger' : 'warn'),
    h('div.grow', h('div', f.message || f.code || 'Something is wrong with the package.'), f.path ? h('div.small.muted', f.path) : null))));
}

// "These overlays use it": a 409 from an uninstall, or what the page already knows.
function inUse(what, slugs, detail) {
  const close = (e) => e.currentTarget.closest('dialog')?.close();
  return dialog({
    title: `${what} is in use`,
    body: h('div',
      h('p', slugs.length
        ? `${slugs.length === 1 ? 'This overlay uses' : 'These overlays use'} it. Move ${slugs.length === 1 ? 'it' : 'them'} to another template or version first (or delete ${slugs.length === 1 ? 'it' : 'them'}), then try again.`
        : detail || 'Overlays use it. Move them to another template or version first, then try again.'),
      slugs.length ? h('ul.list', slugs.map((s) => h('li', h('a', { href: overlayHref(s), onclick: close }, s)))) : null),
    actions: [{ label: 'OK', value: true, kind: 'primary' }],
  });
}

// ---- the gallery -----------------------------------------------------------------------------
export async function list(view, ctx) {
  ctx.setTitle('Templates');
  const canWrite = ctx.can('templates:write');
  let alive = true;
  const state = { category: ctx.query.get('category') || '', q: ctx.query.get('q') || '', templates: [], sources: [] };

  // The summaries carry what a card shows (author, tags, canvases, previews): one request in all.
  const loadTemplates = () => api.all('/api/v1/templates');
  const nameOf = (id) => state.templates.find((t) => t.id === id)?.name || id;

  // -- filters
  const category = h('select', { name: 'category', onchange: () => { state.category = category.value; renderGallery(); } });
  const search = h('input', {
    type: 'search', name: 'q', value: state.q, placeholder: 'Name or tag', autocomplete: 'off', spellcheck: 'false',
    oninput: () => { state.q = search.value; renderGallery(); },
  });
  const count = h('p.muted.small', { 'aria-live': 'polite' });
  const gallery = h('div', h('p.muted', 'Loading templates…'));

  function renderCategories() {
    const counts = new Map();
    for (const t of state.templates) counts.set(t.category, (counts.get(t.category) || 0) + 1);
    const present = [...counts.keys()].sort((a, b) => {
      const x = ORDER.indexOf(a);
      const y = ORDER.indexOf(b);
      return (x < 0 ? 99 : x) - (y < 0 ? 99 : y) || String(a).localeCompare(String(b));
    });
    if (state.category && !counts.has(state.category)) present.push(state.category);
    mount(category,
      h('option', { value: '', selected: !state.category }, `All categories (${state.templates.length})`),
      present.map((c) => h('option', { value: c ?? '', selected: c === state.category }, `${categoryLabel(c)} (${counts.get(c) || 0})`)));
  }

  const haystack = (t) => [t.name, t.id, authorOf(t), categoryLabel(t.category), ...arr(t.tags)].filter((x) => typeof x === 'string').join(' ').toLowerCase();

  function card(t) {
    const name = t.name || t.id;
    const author = authorOf(t);
    const canvases = canvasesOf(t);
    const origin = arr(t.versions)[0]?.source;
    const blank = () => h('div.thumb', { role: 'img', 'aria-label': 'No preview image' });
    const first = arr(t.previews).find((p) => typeof p === 'string');
    // The whole design, whatever its shape (a 4:1 chip is not cropped to 16:9).
    const picture = first
      ? h('img.thumb.contain', { src: first, alt: `Preview of ${name}`, loading: 'lazy', decoding: 'async', onerror: (e) => e.currentTarget.replaceWith(blank()) })
      : blank();
    return h('article.card.stack',
      picture,
      h('div',
        h('h2', h('a', { href: pageOf(t.id) }, name)),
        h('p.muted.small', [author ? `By ${author}` : null, categoryLabel(t.category)].filter(Boolean).join(' · '))),
      t.description ? h('p', t.description) : null,
      h('div.row',
        canvases.length ? badge(canvases.map((c) => ratio(c.width, c.height)).join(' · ')) : null,
        t.latest ? badge(`Version ${t.latest}`) : null,
        badge(originLabel(origin), origin === 'bundled' ? 'ok' : undefined)),
      h('div.row', h('a.btn.primary', { href: pageOf(t.id) }, 'Preview and use')));
  }

  function syncUrl() {
    if (!alive || !ctx.alive()) return; // left while loading: the address is another page's now
    const qs = new URLSearchParams();
    if (state.category) qs.set('category', state.category);
    if (state.q.trim()) qs.set('q', state.q.trim());
    const target = `#/templates${qs.toString() ? `?${qs}` : ''}`;
    if (location.hash !== target) history.replaceState(history.state, '', target);
  }

  function renderGallery() {
    const q = state.q.trim().toLowerCase();
    const shown = state.templates.filter((t) => (!state.category || t.category === state.category) && (!q || haystack(t).includes(q)));
    syncUrl();
    if (!state.templates.length) {
      mount(count);
      mount(gallery, empty('No templates installed', 'A template is a design for your stream. Install one from a file or from GitHub.', canWrite ? installButton('primary') : null));
      return;
    }
    mount(count, shown.length === state.templates.length ? plural(shown.length, 'template') : `${shown.length} of ${plural(state.templates.length, 'template')}`);
    if (!shown.length) {
      mount(gallery, empty('No templates match', 'Try another category, or other words.', h('button.btn', {
        type: 'button',
        onclick: () => { state.category = ''; state.q = ''; search.value = ''; renderCategories(); renderGallery(); search.focus(); },
      }, 'Show all templates')));
      return;
    }
    mount(gallery, h('div.grid', shown.map(card)));
  }

  async function refreshTemplates() {
    const next = await loadTemplates();
    if (!alive) return;
    state.templates = next.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    renderCategories();
    renderGallery();
  }

  // -- installing
  const installButton = (kind) => h('button.btn', { type: 'button', class: kind, onclick: () => installDialog() }, 'Install template');

  function installDialog() {
    const id = `dlg-${Math.random().toString(36).slice(2)}`;
    let mode = 'file';
    let file;
    let passed = false;
    let busy = false;
    let token = 0;
    // The browser's own file control is a small target; a full-size button opens it instead.
    const fileInput = h('input.sr-only', { type: 'file', name: 'package', tabindex: '-1', 'aria-hidden': 'true', accept: '.skp,.zip,application/zip,application/x-zip-compressed' });
    const fileName = h('span.muted.small', 'No file chosen');
    const choose = h('button.btn', { type: 'button', 'aria-describedby': `${id}-file-hint`, onclick: () => fileInput.click() }, 'Choose a .skp or .zip file');
    const fileStatus = h('div', { 'aria-live': 'polite' });
    const link = h('input', { type: 'text', name: 'url', inputmode: 'url', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'owner/name', 'aria-describedby': `${id}-link-hint` });
    const linkStatus = h('div', { 'aria-live': 'polite' });
    const cancel = h('button.btn', { type: 'button', onclick: () => d.close() }, 'Cancel');
    const install = h('button.btn.primary', { type: 'button', disabled: true, onclick: () => go() }, 'Install');
    // A GitHub repository: Test reads it (with the GitHub token, for a private one) and lists its
    // releases to pick one and its file from, instead of typing the tag.
    let choice;
    const tester = repoTest({ input: link, pick: true, onChange: (c) => { choice = c; update(); }, onLink: () => d.close() });
    const followBox = h('input', { type: 'checkbox', name: 'follow' });
    // The whole row a 44 px target, the box keeping its size when the words wrap.
    const followRow = h('label.field.check', followBox, h('span', 'Install its new releases by themselves', h('br'),
      h('span.hint', 'Follows the repository (Automatic updates, below the gallery), checked every hour.')));
    const update = () => {
      install.disabled = busy || (mode === 'file' ? !(file && passed) : !(choice || link.value.trim()));
      followRow.hidden = !repoOf(link.value);
    };
    link.addEventListener('input', () => { mount(linkStatus); tester.reset(); update(); });
    link.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!install.disabled) go(); } });

    fileInput.addEventListener('change', async () => {
      file = fileInput.files?.[0];
      passed = false;
      update();
      fileName.textContent = file ? `${file.name} (${bytes(file.size)})` : 'No file chosen';
      const mine = ++token;
      if (!file) return mount(fileStatus);
      if (file.size > PACKAGE_LIMIT) return mount(fileStatus, notice('This file is larger than 100 MB, the most a template package can be.', 'danger'));
      mount(fileStatus, h('p.muted', 'Checking the package…'));
      try {
        const r = await api.post('/api/v1/templates/validate', undefined, { raw: file, contentType: 'application/octet-stream' });
        if (mine !== token) return undefined;
        passed = Boolean(r?.valid);
        const errors = arr(r?.errors);
        const warnings = arr(r?.warnings);
        mount(fileStatus,
          passed
            ? notice(`It passed the check: ${r.id}, version ${r.version}.${warnings.length ? ' Worth knowing before you install:' : ''}`, 'ok')
            : notice(`It can't be installed: ${plural(errors.length, 'problem')} to fix. Send this list to whoever made it.`, 'danger'),
          findingsList([...errors, ...warnings]));
      } catch (err) {
        if (mine !== token) return undefined;
        mount(fileStatus, notice(err.message, 'danger'));
      }
      update();
      return undefined;
    });

    const panes = tabs([
      {
        id: 'install-file',
        label: 'From a file',
        render: (panel) => {
          mode = 'file';
          mount(panel,
            h('div.field', h('span.label', 'Template package'), h('div.row', choose, fileName), h('span.hint', { id: `${id}-file-hint` }, 'The file its maker gave you. It is checked before anything is installed.'), fileInput),
            fileStatus);
          update();
        },
      },
      {
        id: 'install-link',
        label: 'From GitHub or a link',
        render: (panel) => {
          mode = 'link';
          mount(panel,
            h('div.inline-form', field('GitHub repository or link', link), tester.button),
            h('p.small.muted', { id: `${id}-link-hint` }, 'owner/name from github.com/owner/name, then Test to pick a release. Or owner/name@v1.2.0 for one release, or an https link to a .skp or .zip.'),
            tester.results,
            followRow,
            linkStatus);
          update();
        },
      },
    ]);

    async function go() {
      const status = mode === 'file' ? fileStatus : linkStatus;
      const usedMode = mode;
      // The release and file picked after Test, else what was typed.
      const url = usedMode === 'link' ? choice?.url || link.value.trim() : undefined;
      const repo = usedMode === 'link' ? choice?.repo || repoOf(link.value) : undefined;
      const follow = usedMode === 'link' && repo && followBox.checked;
      busy = true;
      cancel.disabled = true;
      if (usedMode === 'link') mount(status, h('p.muted', 'Downloading and checking… this can take a minute.'));
      let out;
      try {
        out = await run(install, () => (usedMode === 'file'
          // Its file name, for where it came from. A header can't carry every letter (fetch refuses
          // most beyond ASCII), so those go as _.
          ? api.post('/api/v1/templates', undefined, { raw: file, contentType: 'application/octet-stream', headers: { 'x-skp-filename': file.name.replace(/[^\x20-\x7e]/g, '_') } })
          : api.post('/api/v1/templates', { url })), {
          onError: (err) => mount(status, problemNotice(err, { onLink: () => d.close() }), findingsList(err.body?.findings)),
        });
      } finally {
        busy = false;
        cancel.disabled = false;
        update();
      }
      if (!out) return;
      d.close();
      let name = out.id;
      try { name = (await api.get(apiOf(out.id)))?.name || out.id; } catch { /* the id will do */ }
      toast(out.installed ? `Installed "${name}" version ${out.version}` : `"${name}" version ${out.version} was already installed`);
      // Followed after installing: its tag prefix and file name come from what was installed, and
      // it may update this template even if it was first installed from a file (installing this
      // release and ticking the box says so); otherwise its next release is refused as id-taken.
      if (follow) {
        try {
          await api.post('/api/v1/templates/sources', { source: repo, template: out.id });
          toast(`Following ${repo}: its new releases install by themselves`);
        } catch (err) {
          if (err.status === 409) toast(`${repo} was already followed`);
          else toast(err);
        }
        refreshSources().catch(() => {});
      }
      // Warnings from a link weren't shown before installing (a file's were).
      if (usedMode === 'link' && arr(out.warnings).length) {
        await dialog({ title: 'Installed, with warnings', body: h('div', h('p', `"${name}" is installed. Its maker may want to know:`), findingsList(out.warnings)), actions: [{ label: 'Open the template', value: true, kind: 'primary' }] });
      }
      if (alive) ctx.navigate(`/templates/${api.seg(out.id)}`);
    }

    const d = h('dialog', { 'aria-labelledby': id },
      h('div.dialog-body',
        h('h2', { id }, 'Install a template'),
        notice('Templates are code: what you install runs in OBS and in the previews here. Install only templates from people you trust.', 'warn'),
        panes),
      h('div.form-actions', cancel, install));
    d.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
    const back = focusBack();
    d.addEventListener('close', () => { token += 1; d.remove(); back(); });
    document.body.append(d);
    d.showModal();
    d.querySelector('[role="tab"]')?.focus();
  }

  // -- sources (04 §4.13)
  const sourcesBody = h('div');
  const checkAll = canWrite ? h('button.btn', { type: 'button', onclick: () => check(checkAll) }, 'Check now') : null;
  const followButton = canWrite ? h('button.btn', { type: 'button', onclick: () => follow() }, 'Follow a repository') : null;

  async function refreshSources() {
    const next = await api.all('/api/v1/templates/sources');
    if (!alive) return;
    state.sources = next;
    renderSources();
  }

  function sourceItem(s) {
    const title = s.kind === 'github' ? `${s.repo || s.label}${s.tag !== undefined ? ` (release ${s.tag} only)` : ''}` : s.url || s.label || s.id;
    const pending = arr(s.pending).length;
    const facts = [
      s.checkedAt ? `Checked ${ago(s.checkedAt)}` : 'Not checked yet',
      pending ? `${plural(pending, 'overlay')} ${pending === 1 ? 'moves' : 'move'} after ${pending === 1 ? 'its' : 'their'} show` : null,
    ].filter(Boolean).join(' · ');
    return h('li',
      h('div.grow',
        h('div.truncate', { title }, h('strong', title)),
        h('div.row', badge(s.kind === 'github' ? 'GitHub' : 'Link'), s.autoUpgrade === 'off' ? badge('Overlays upgrade by hand') : badge('Overlays follow safe updates', 'ok')),
        h('div.small',
          s.templateId ? ['Updates ', h('a', { href: pageOf(s.templateId) }, nameOf(s.templateId)), s.version ? `, newest ${s.version}` : ''] : 'Nothing installed from it yet'),
        h('div.small.muted', facts),
        s.error?.message ? h('div.notice.danger.small', `The last check failed: ${s.error.message}`,
          s.error.fix === 'connect-github' && canWrite ? [' ', h('a', { href: CONNECT_ROUTE }, 'Connect GitHub in Settings')] : null) : null),
      canWrite ? menu('Options', [
        { label: 'Check now', onSelect: () => check(null, s) },
        { label: 'Stop following', danger: true, onSelect: () => unfollow(s) },
      ], { buttonClass: 'btn small', ariaLabel: `Options for ${title}` }) : null);
  }

  function renderSources() {
    if (!state.sources.length) {
      mount(sourcesBody, h('p.muted', 'No repositories are followed.'));
      if (checkAll) checkAll.hidden = true;
      return;
    }
    if (checkAll) checkAll.hidden = false;
    mount(sourcesBody, h('ul.list', state.sources.map(sourceItem)));
  }

  function checkMessage(items) {
    const results = arr(items);
    if (!results.length) return { text: 'There is nothing to check.' };
    const parts = [];
    const fresh = results.filter((r) => r.installed && !r.installed.noop);
    for (const r of fresh) parts.push(`Installed ${nameOf(r.installed.id)} version ${r.installed.version}.`);
    const moved = results.reduce((n, r) => n + arr(r.upgraded).length, 0);
    if (moved) parts.push(`${plural(moved, 'overlay')} moved to the new version.`);
    const waiting = results.reduce((n, r) => n + arr(r.waiting).length, 0);
    if (waiting) parts.push(`${plural(waiting, 'overlay')} stay${waiting === 1 ? 's' : ''} on the old version for now: open ${waiting === 1 ? 'it' : 'them'} to upgrade.`);
    const failed = results.filter((r) => r.error);
    if (failed.length) parts.push(failed.length === 1 ? `Couldn't check ${failed[0].source}: ${failed[0].error.message}` : `${failed.length} couldn't be checked: see below.`);
    if (!parts.length) parts.push(results.length === 1 ? 'Checked: no new release.' : 'Checked: no new releases.');
    return { text: parts.join(' '), error: failed.length > 0 && !fresh.length && !moved, installed: fresh.length > 0 };
  }

  async function check(button, source) {
    const out = await run(button, () => api.post('/api/v1/templates/sources/check', {}, { query: source ? { source: source.id } : undefined }));
    if (!out) return;
    const items = arr(out.items);
    // A new version shows in the gallery; a failure shows under its source.
    await Promise.all([items.some((r) => r.installed && !r.installed.noop) ? refreshTemplates().catch(() => {}) : null, refreshSources().catch(() => {})]);
    const msg = checkMessage(items);
    toast(msg.text, { kind: msg.error ? 'error' : undefined });
  }

  async function follow() {
    const added = await askForm({
      title: 'Follow a repository',
      intro: 'New releases of the template install by themselves, checked every hour.',
      note: notice('Templates are code that runs in OBS: follow only people you trust.', 'warn'),
      fields: [
        { name: 'source', label: 'GitHub repository or link', placeholder: 'owner/name', autocapitalize: 'none', spellcheck: 'false', inputmode: 'url', hint: 'owner/name from github.com/owner/name, owner/name@v1.2.0 for that release only, or an https link that always serves the newest package.' },
        {
          name: 'autoUpgrade', label: 'Overlays that use it', type: 'select', value: 'safe', options: [
            { value: 'safe', label: 'Move to new versions when nothing they use changes' },
            { value: 'off', label: 'Stay where they are: I upgrade them myself' },
          ],
        },
        { name: 'template', label: 'Template it updates (optional)', autocapitalize: 'none', spellcheck: 'false', hint: 'Only when this template is already installed from a file or a link: its id, like com.example.lower-third. Leave empty otherwise.' },
      ],
      submitLabel: 'Follow',
      onSubmit: (values) => {
        const source = values.source.trim();
        if (!source) throw new Error('Enter a GitHub repository (owner/name) or an https link.');
        const template = values.template.trim().toLowerCase();
        return api.post('/api/v1/templates/sources', { source, autoUpgrade: values.autoUpgrade, ...(template ? { template } : {}) });
      },
    });
    if (!added) return;
    const c = added.check;
    await Promise.all([c?.installed && !c.installed.noop ? refreshTemplates().catch(() => {}) : null, refreshSources().catch(() => {})]);
    const label = added.repo || added.url || added.label;
    if (c?.error) toast(`Following ${label}. Its first check failed: ${c.error.message}`, { kind: 'error' });
    else if (c?.installed) toast(`Following ${label}: ${c.installed.noop ? `${nameOf(c.installed.id)} ${c.installed.version} was already installed` : `installed ${nameOf(c.installed.id)} version ${c.installed.version}`}`);
    else toast(`Following ${label}`);
  }

  async function unfollow(s) {
    const label = s.repo || s.url || s.label;
    const ok = await confirm({
      title: `Stop following ${label}?`,
      consequence: 'Its new releases won\'t install any more. Templates already installed from it stay, and overlays keep working.',
      confirmLabel: 'Stop following',
    });
    if (!ok) return;
    try {
      await api.del(`/api/v1/templates/sources/${api.seg(s.id)}`);
      toast(`Stopped following ${label}`);
    } catch (err) {
      toast(err);
    }
    await refreshSources().catch(() => {});
  }

  // -- the page
  mount(view,
    pageHead('Templates', { actions: canWrite ? [installButton('primary')] : [] }),
    h('div.stack',
      h('p.muted', 'A template is a design for your stream. Pick one, preview it with sample data, then use it to make an overlay you add to OBS.'),
      h('div.inline-form', field('Category', category), field('Search', search)),
      count,
      gallery,
      h('section.card.stack',
        h('h2', 'Automatic updates'),
        h('p.muted', 'Follow a template\'s GitHub repository (or a link that always serves its newest package) and new releases install by themselves. Overlays move to a new version only when nothing they use changes, and never while their show is live.'),
        sourcesBody,
        canWrite ? h('div.row', followButton, checkAll) : null)));
  renderCategories();

  const [templatesOut, sourcesOut] = await Promise.allSettled([refreshTemplates(), refreshSources()]);
  if (templatesOut.status === 'rejected') throw templatesOut.reason; // the error boundary, with Try again
  if (sourcesOut.status === 'rejected') mount(sourcesBody, notice(`The followed repositories could not be read: ${sourcesOut.reason?.message || sourcesOut.reason}`, 'danger'));

  return () => { alive = false; };
}

// ---- a template ------------------------------------------------------------------------------
export async function detail(view, ctx) {
  const id = ctx.params.id;
  ctx.setTitle('Template');
  let t;
  try {
    t = await api.get(apiOf(id));
  } catch (err) {
    if (err.status !== 404) throw err;
    ctx.setTitle('Template not found');
    mount(view,
      pageHead('Template not found', { crumbs: [{ label: 'Templates', href: '#/templates' }] }),
      empty(`There is no template "${id}"`, 'It may have been uninstalled. The gallery lists every template installed here.', h('a.btn.primary', { href: '#/templates' }, 'Back to templates')));
    return undefined;
  }

  const m = t?.manifest || {};
  const name = t.name || m.name || t.id;
  ctx.setTitle(name);
  const versions = arr(t.versions);
  const latest = t.latest || versions[0]?.version || m.version;
  const canWrite = ctx.can('templates:write');
  const canUse = ctx.can('overlays:write');
  const canvases = canvasesOf(m);
  const scenes = arr(m.scenes).filter((s) => s && typeof s.id === 'string');
  const actions = arr(m.actions).filter((a) => a && typeof a.id === 'string');
  const sceneLabel = (ref) => (scenes.find((s) => s.id === ref) || scenes.find((s) => s.core === ref))?.label || ref;
  const outside = versions.some((v) => v.source !== 'bundled');

  // -- use it: an overlay of this template, then its page (where the URL is, ready to copy)
  async function useTemplate(version = latest) {
    let taken = new Set();
    try { taken = new Set((await api.all('/api/v1/overlays')).map((o) => o.slug)); } catch { /* the server says when a name is taken */ }
    const fields = [{
      name: 'slug', label: 'Overlay name', value: suggestSlug(t.id, taken), autocapitalize: 'none', spellcheck: 'false',
      hint: 'Lower-case letters, digits and dashes. It is part of the overlay\'s link in OBS.',
    }];
    if (versions.length > 1) {
      fields.push({ name: 'version', label: 'Version', type: 'select', value: version, options: versions.map((v, i) => ({ value: v.version, label: i === 0 ? `${v.version} (newest)` : v.version })) });
    }
    const created = await askForm({
      title: `Use ${name}`,
      intro: 'This makes an overlay: a link you add to OBS as a browser source. Its page shows the link, ready to copy.',
      fields,
      submitLabel: 'Create overlay',
      onSubmit: (values) => {
        const slug = String(values.slug || '').trim().toLowerCase().replace(/\s+/g, '-');
        if (!SLUG.test(slug)) throw new Error('Choose a name of lower-case letters, digits and dashes that starts with a letter or digit (63 at most).');
        return api.post('/api/v1/overlays', { slug, template: { id: t.id, version: values.version || version } });
      },
    });
    if (!created?.slug) return;
    toast(`Overlay "${created.slug}" created`);
    ctx.navigate(`/overlays/${api.seg(created.slug)}`);
  }

  // -- remove: one version, or every one (H20: menu, then a confirmation naming the consequence)
  async function usedBy(version) {
    try {
      const fresh = await api.all(`${apiOf(t.id)}/versions`);
      return [...new Set(fresh.filter((v) => version === undefined || v.version === version).flatMap((v) => arr(v.overlays)))];
    } catch {
      return [];
    }
  }

  async function removeVersion(v) {
    if (arr(v.overlays).length) return inUse(`Version ${v.version}`, v.overlays);
    const only = versions.length === 1;
    const ok = await confirm({
      title: `Remove version ${v.version}?`,
      consequence: only
        ? `It is the only version, so "${name}" leaves the gallery. No overlay uses it: nothing on air changes.`
        : 'No overlay uses it: nothing on air changes. Overlays can\'t use this version again unless it is installed again.',
      confirmLabel: 'Remove version',
    });
    if (!ok) return undefined;
    try {
      await api.del(apiOf(t.id), { query: { version: v.version } });
    } catch (err) {
      if (err.status === 409) return inUse(`Version ${v.version}`, await usedBy(v.version), err.message);
      toast(err);
      return undefined;
    }
    toast(`Removed version ${v.version} of "${name}"`);
    if (only) ctx.navigate('/templates');
    else ctx.navigate(`/templates/${api.seg(t.id)}`, { replace: true });
    return undefined;
  }

  async function uninstall() {
    const used = [...new Set(versions.flatMap((v) => arr(v.overlays)))];
    if (used.length) return inUse(`"${name}"`, used);
    const ok = await confirm({
      title: `Uninstall "${name}"?`,
      consequence: `${versions.length === 1 ? 'Its version is' : `All ${versions.length} versions are`} deleted from this platform. No overlay uses it: nothing on air changes. To use it again, install it again.`,
      confirmLabel: 'Uninstall',
    });
    if (!ok) return undefined;
    try {
      await api.del(apiOf(t.id));
    } catch (err) {
      if (err.status === 409) return inUse(`"${name}"`, await usedBy(), err.message);
      toast(err);
      return undefined;
    }
    toast(`Uninstalled "${name}"`);
    ctx.navigate('/templates');
    return undefined;
  }

  // -- the live preview with sample data, at each canvas (H13: two at most load at once)
  // It opens on a scene that shows the design (Starting soon), else the live one.
  const firstScene = ctx.query.get('scene');
  let scene = scenes.some((s) => s.id === firstScene) ? firstScene : (scenes.find((s) => s.core === 'starting') || scenes.find((s) => s.core === 'program') || scenes[0])?.id;
  let dark = false;
  const shown = [];
  for (const c of canvases) {
    const url = previewUrl(t.id, latest, { canvas: c.id, scene, dark });
    if (!url) continue;
    const box = preview(url, {
      width: c.width, height: c.height, label: `${shapeOf(c)} ${ratio(c.width, c.height)}`,
      eager: shown.length < 2 ? undefined : false, title: `${name}, ${shapeOf(c).toLowerCase()} preview with sample data`,
    });
    shown.push({ box, canvas: c });
  }
  const reloadPreviews = () => {
    for (const p of shown) p.box.reload(previewUrl(t.id, latest, { canvas: p.canvas.id, scene, dark }));
  };
  const previewCard = h('section.card');
  const scenePick = scenes.length > 1
    ? h('select', { name: 'scene', onchange: () => { scene = scenePick.value; reloadPreviews(); } }, scenes.map((s) => h('option', { value: s.id, selected: s.id === scene }, s.label || s.id)))
    : null;
  const darkPick = h('input', { type: 'checkbox', name: 'dark', onchange: () => { dark = darkPick.checked; reloadPreviews(); } });
  const showScene = (s) => {
    scene = s.id;
    if (scenePick) scenePick.value = s.id;
    reloadPreviews();
    previewCard.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    toast(`Preview shows ${s.label || s.id}`);
  };
  mount(previewCard,
    h('h2', 'Preview with sample data'),
    h('p.muted.small', 'A sample lineup, chat, alerts and viewer counts: nothing here is live or on air.'),
    shown.length
      ? h('div.stack', h('div.inline-form', scenePick ? field('Scene', scenePick) : null, field('Dark backdrop behind see-through parts', darkPick)), h('div.grid.wide', shown.map((p) => p.box)))
      : arr(t.previews)[0]
        ? h('img.thumb.contain', { src: t.previews[0], alt: `Preview of ${name}` })
        : h('p.muted', 'This template has no preview.'));

  // -- what it has: cards in a grid
  const cell = (...children) => h('section.card', ...children);

  const scenesCard = cell(
    h('h2', 'Scenes'),
    scenes.length
      ? h('ul.list', scenes.map((s) => h('li',
        h('div.grow',
          h('div', s.label || s.id),
          h('div.small.muted', [
            s.core ? `Standard scene: ${CORES[s.core] || s.core}` : 'Extra scene',
            s.durationMs > 0 ? `plays ${seconds(s.durationMs)}${s.then ? `, then ${sceneLabel(s.then)}` : ''}` : null,
            s.transparent ? 'see-through' : null,
          ].filter(Boolean).join(' · '))),
        shown.length ? h('button.btn.small', { type: 'button', 'aria-label': `Preview ${s.label || s.id}`, onclick: () => showScene(s) }, 'Preview') : null)))
      : h('p.muted', 'This template lists no scenes.'));

  const actionsCard = cell(
    h('h2', 'Actions'),
    h('p.muted.small', 'Buttons on the Live page that play something on top of the scene, like a title card.'),
    actions.length
      ? h('ul.list', actions.map((a) => h('li', h('div.grow', h('div', a.label || a.id), a.durationMs > 0 ? h('div.small.muted', `On screen for ${seconds(a.durationMs)}`) : null))))
      : h('p.muted', 'This template has no actions.'));

  const feeds = feedsOf(m);
  const feedsCard = cell(
    h('h2', 'Connections it can use'),
    feeds.length
      ? h('ul.list', feeds.map((f) => h('li', h('div.grow', h('div', h('strong', f.label)), h('div.small.muted', f.from)))))
      : h('p.muted', 'It needs no connections: it shows what you type in its settings.'),
    h('p.small.muted', 'Set up Twitch, Kick, YouTube, Spotify and OBS on the ', h('a', { href: '#/connections' }, 'Connections'), ' page.'));

  const author = authorOf(m);
  const authorUrl = typeof m.author?.url === 'string' && /^https?:\/\//i.test(m.author.url) ? m.author.url : undefined;
  const obs = typeof m.engines?.obs === 'string' ? m.engines.obs.trim() : '';
  const obsText = /^>=\s*\d+(\.\d+)*$/.test(obs) ? `OBS ${obs.replace(/^>=\s*/, '')} or newer` : obs ? `OBS ${obs}` : '';
  const kv = (label, value) => (value === null || value === undefined || value === '' ? null : [h('dt', label), h('dd', value)]);
  const aboutCard = cell(
    h('h2', 'About'),
    h('dl.kv',
      kv('Made by', author ? (authorUrl ? h('a', { href: authorUrl, target: '_blank', rel: 'noopener noreferrer' }, author) : author) : 'Unknown'),
      kv('License', typeof m.license === 'string' ? m.license : ''),
      kv('Version', latest ? `${latest}${versions.length > 1 ? ` (and ${plural(versions.length - 1, 'older one')})` : ''}` : ''),
      kv('Category', categoryLabel(t.category ?? m.category)),
      kv('Sizes', canvases.length ? canvases.map((c) => `${shapeOf(c)} ${ratio(c.width, c.height)} (${c.width} × ${c.height})`).join(', ') : ''),
      kv('Tags', arr(m.tags).length ? h('div.chips', arr(m.tags).map((tag) => h('span.chip', String(tag)))) : ''),
      kv('Works with', obsText),
      kv('Template id', h('code', t.id))));

  const versionsCard = cell(
    h('h2', 'Versions'),
    versions.length
      ? h('ul.list', versions.map((v, i) => {
        const used = arr(v.overlays);
        const items = [
          canUse ? { label: i === 0 ? 'Use this version' : `Use version ${v.version}`, onSelect: () => useTemplate(v.version) } : null,
          canWrite && v.source !== 'bundled' ? { label: 'Remove this version', danger: true, onSelect: () => removeVersion(v) } : null,
        ].filter(Boolean);
        return h('li',
          h('div.grow',
            h('div.row', h('strong', `Version ${v.version}`), i === 0 ? badge('Newest', 'ok') : null, badge(originLabel(v.source))),
            h('div.small.muted', used.length
              ? ['Used by ', used.map((s, j) => [j ? ', ' : '', h('a', { href: overlayHref(s) }, s)])]
              : v.source === 'bundled' ? 'No overlay uses it. It comes with the platform.' : 'No overlay uses it.')),
          items.length ? menu('Options', items, { buttonClass: 'btn small', ariaLabel: `Options for version ${v.version}` }) : null);
      }))
      : h('p.muted', 'No versions are installed.'));

  // -- the page
  const headActions = [];
  if (canUse && latest) headActions.push(h('button.btn.primary', { type: 'button', onclick: () => useTemplate() }, 'Use template'));
  if (canWrite && versions.length && versions.every((v) => v.source !== 'bundled')) {
    headActions.push(menu('More', [{ label: 'Uninstall template', danger: true, onSelect: () => uninstall() }]));
  }
  const where = { github: ' from GitHub', url: ' from a link', package: ' from a file' }[versions.find((v) => v.source !== 'bundled')?.source] || '';
  mount(view,
    pageHead(name, { crumbs: [{ label: 'Templates', href: '#/templates' }], actions: headActions }),
    h('div.stack',
      t.description || m.description ? h('p', t.description || m.description) : null,
      outside ? notice(`This template was installed${where}, from outside the platform. Templates are code: this one runs in OBS and in the previews on this page.`, 'warn') : null,
      previewCard,
      h('div.grid.wide', scenesCard, actionsCard, feedsCard, aboutCard, versionsCard)));

  return () => { for (const p of shown) p.box.unload(); };
}
