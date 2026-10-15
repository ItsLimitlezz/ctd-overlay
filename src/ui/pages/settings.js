// Settings (08 §8.1, §8.6; 07): how the admin looks, your account and two-factor, users, API
// tokens, who can reach the platform, the audit log, and what is running. Routes #/settings and
// #/settings/:tab. Each tab loads on its own: one whose request fails shows its error in the tab,
// and the others still work (H17).
import * as api from '../api.js';
import {
  ago, badge, confirm, copy, copyField, dialog, empty, field, h, menu, mount, notice, pageHead,
  prompt, q, run, statusDot, tabs, toast,
} from '../dom.js';

// ---- words -----------------------------------------------------------------------------------
const ROLES = {
  owner: { label: 'Owner', text: 'Everything, including users and this installation\'s settings. There is one owner.' },
  admin: { label: 'Admin', text: 'Everything an operator does, plus templates, media, connections and the audit log.' },
  operator: { label: 'Operator', text: 'Runs the show: scenes, actions, cues, overlays and the lineup. No access to connections or passwords.' },
  viewer: { label: 'Viewer', text: 'Sees the dashboard and previews, and changes nothing.' },
};
const ASSIGNABLE = ['admin', 'operator', 'viewer']; // src/auth/roles.js: one owner, made at setup
const roleLabel = (role) => ROLES[role]?.label || String(role || 'Unknown');

// What a token may do (src/auth/roles.js SCOPES): [scope, what it allows, a short name].
const SCOPE_GROUPS = [
  ['Overlays', [
    ['overlays:read', 'See overlays, their previews and URLs', 'See overlays'],
    ['overlays:write', 'Change overlay settings', 'Edit overlays'],
    ['overlays:control', 'Take scenes and fire actions (what a Stream Deck needs)', 'Control overlays'],
  ]],
  ['Shows', [
    ['timeline:read', 'See shows, the lineup and cues', 'See shows'],
    ['timeline:write', 'Change shows, the lineup and cues', 'Edit shows'],
  ]],
  ['Live data', [
    ['events:read', 'Read live events and values (viewer count, chat …)', 'Read live data'],
    ['events:publish', 'Send custom events', 'Send events'],
    ['state:write', 'Set custom values', 'Set values'],
  ]],
  ['Templates and media', [
    ['templates:read', 'See templates', 'See templates'],
    ['templates:write', 'Install and remove templates', 'Install templates'],
    ['media:write', 'Upload and delete media', 'Manage media'],
  ]],
  ['Connections', [
    ['connections:read', 'See connections (Twitch, OBS …)', 'See connections'],
    ['connections:write', 'Set up and change connections', 'Change connections'],
  ]],
  ['Administration', [
    ['audit:read', 'Read the audit log', 'Read audit log'],
    ['users:admin', 'Add, change and remove users', 'Manage users'],
    ['system:admin', 'Change this installation\'s name and logo', 'Installation settings'],
  ]],
];
const SCOPE_SHORT = Object.fromEntries(SCOPE_GROUPS.flatMap(([, list]) => list.map(([id, , short]) => [id, short])));

// Exposure modes (07 §7.8), and how to set them (src/config.js).
const EXPOSURE = {
  local: { title: 'This computer only', text: 'Only this computer can open the admin pages and the overlays. OBS on this computer works; a phone on your Wi-Fi can\'t reach it.' },
  lan: { title: 'Your local network', text: 'Phones and computers on the same network (your Wi-Fi) can reach it, after signing in. Nothing outside your network can.' },
  public: { title: 'The internet', text: 'Anyone on the internet can reach the sign-in page, over HTTPS. Remote control from anywhere and Kick chat need this. Everyone signs in; owners and admins should turn on two-factor.' },
};
const OPTIONS = [
  ['Exposure', '--exposure local|lan|public', 'SKP_EXPOSURE'],
  ['Public address', '--public-url https://…', 'SKP_PUBLIC_URL'],
  ['Certificate', '--tls-cert <file> --tls-key <file>', 'SKP_TLS_CERT, SKP_TLS_KEY'],
  ['Reverse proxy', '--trust-proxy <its address>', 'SKP_TRUST_PROXY'],
  ['More names', '--hosts nas.home.arpa', 'SKP_HOSTS'],
];

// Audit actions (src/**: audit.record), in plain words; others show as they are.
const ACTIONS = {
  setup: 'Owner account created', 'setup.failure': 'Wrong setup code',
  login: 'Signed in', 'login.failure': 'Failed sign-in', 'session.end': 'Signed out', 'session.revoke': 'Ended a session',
  'password.change': 'Changed their password', 'totp.enable': 'Turned on two-factor', 'totp.disable': 'Turned off two-factor',
  'totp.recovery-used': 'Signed in with a recovery code',
  'user.create': 'Added a user', 'user.role': 'Changed a role', 'user.password': 'Set a user\'s password',
  'user.totp-reset': 'Turned off a user\'s two-factor', 'user.delete': 'Removed a user',
  'token.create': 'Created an API token', 'token.revoke': 'Revoked an API token',
  'media.add': 'Uploaded media', 'media.remove': 'Deleted media',
  'overlay.create': 'Created an overlay', 'overlay.rename': 'Renamed an overlay', 'overlay.delete': 'Deleted an overlay',
  'overlay.upgrade': 'Upgraded an overlay', 'overlay.revert': 'Reverted an overlay',
  'overlay.key-required': 'Changed whether an overlay\'s URL needs its key', 'overlay.key-rotate': 'Made a new key for an overlay',
  'template.install': 'Installed a template', 'template.uninstall': 'Uninstalled a template', 'template.update': 'Updated a template by itself',
  'template.follow': 'Followed a template\'s repository', 'template.unfollow': 'Stopped following a template\'s repository',
  'import.v0.show.create': 'Imported a show from v0', 'import.v0.show.delete': 'Replaced a show with one from v0',
  'import.v0.overlay.create': 'Imported an overlay from v0', 'import.v0.overlay.update': 'Updated an overlay from v0',
  'import.v0.media.add': 'Imported v0\'s Line clip', 'import.v0.cues.build': 'Built a v0 show\'s cues', 'import.v0.cue.add': 'Imported a v0 cue',
  'import.v0.plan.add': 'Imported a v0 planned date', 'import.v0.connection.keep': 'Kept v0 credentials for a connection',
};
const REASONS = { password: 'wrong password', code: 'wrong code' };
// What the audit log can be narrowed to: the server matches a whole action or its first part
// ("login" is sign-ins and failed ones), so these are words, not action names to type.
const AUDIT_FILTERS = [
  ['', 'Everything'], ['login', 'Sign-ins, and failed ones'], ['session', 'Sign-outs and ended sessions'],
  ['password', 'Password changes'], ['totp', 'Two-factor'], ['user', 'Users added, changed or removed'],
  ['token', 'API tokens'], ['overlay', 'Overlays'], ['template', 'Templates'], ['media', 'Media'], ['import', 'Imports from v0'], ['setup', 'Setup'],
];
// A target is shown by name; an internal id ("ses_01J…") says nothing to a person, so it is left out.
const INTERNAL_ID = /^[a-z]{3}_[0-9A-Z]{26}$/;

// ---- small helpers ---------------------------------------------------------------------------
let seq = 0;
const uid = (prefix) => `${prefix}-${++seq}`;

function fmt(iso, opts) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try { return new Intl.DateTimeFormat(undefined, opts).format(d); } catch { return d.toLocaleString(); }
}
const dateTime = (iso) => fmt(iso, { dateStyle: 'medium', timeStyle: 'short' });
const day = (iso) => fmt(iso, { dateStyle: 'medium' });

function duration(s) {
  if (!Number.isFinite(s) || s < 0) return '';
  const d = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} day${d === 1 ? '' : 's'}, ${hh} h`;
  if (hh) return `${hh} h ${m} min`;
  if (m) return `${m} min`;
  return `${Math.round(s)} s`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const kv = (rows) => h('dl.kv', rows.filter(Boolean).map(([k, v]) => [h('dt', k), h('dd', v)]));
// Space above a heading that follows a list without a margin of its own.
function spaced(el) {
  el.style.marginTop = 'var(--gap)';
  return el;
}

// A status dot and its words, the dot staying beside the first line when the words wrap.
function statusLine(kind, label, ...words) {
  const dot = statusDot(kind, label);
  dot.style.marginTop = '0.5em';
  const el = h('p.row', dot, h('span', words));
  el.style.flexWrap = 'nowrap';
  el.style.alignItems = 'flex-start';
  return el;
}

// A command to copy, with its label.
function command(label, text) {
  const id = uid('cmd');
  return h('div.field', h('label', { for: id }, label), copyField(text, { id, copied: 'Copied' }));
}
const card = (title, ...children) => h('section.card', h('h2', title), children);
const headed = (title, actions, ...children) => h('section.card', h('div.card-head', h('h2', title), h('div.actions', actions)), children);

// A list item's text: lines a little apart, long words (a user agent, an IPv6 address) wrapped.
function lines(...children) {
  const el = h('div.grow', children);
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  el.style.gap = '4px';
  el.style.overflowWrap = 'anywhere';
  return el;
}

// A checkbox or radio with its words, the whole row a 44 px target (label.field.check), the box
// keeping its size when the words wrap.
function choiceRow(input, title, hint) {
  const el = h('label.field.check', input, h('span', title, hint ? [h('br'), h('span.hint', hint)] : null));
  el.style.marginBottom = '4px';
  return el;
}

// One of a few choices as toggle buttons (aria-pressed): theme, density.
function segmented(label, options, value, { hint } = {}) {
  const id = uid('seg');
  const buttons = options.map(([v, text]) => h('button.btn', { type: 'button', dataset: { value: v }, 'aria-pressed': String(v === value) }, text));
  const hintEl = hint ? h('span.hint', { id: `${id}-hint` }, hint) : null;
  const el = h('div.field', h('span.label', { id }, label),
    h('div.row', { role: 'group', 'aria-labelledby': id, 'aria-describedby': hintEl ? hintEl.id : undefined }, buttons), hintEl);
  el.set = (v) => { for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === v)); };
  el.onPick = (fn) => {
    for (const b of buttons) b.addEventListener('click', () => { if (b.getAttribute('aria-pressed') !== 'true') fn(b.dataset.value, b); });
  };
  return el;
}

const passwordField = { name: 'password', label: 'Your password', type: 'password', required: true, autocomplete: 'current-password' };

// The accent colour the theme uses now (with no colour of the user's own).
function themeAccent() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : '#0b7fa8';
}

// "Chrome on Windows" from a user agent.
function device(ua) {
  if (!ua) return 'Unknown device';
  const s = String(ua);
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android'
    : /Windows/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'ChromeOS' : /Macintosh|Mac OS X/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : '';
  const browser = /Edg(e|A|iOS)?\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\/|FxiOS/.test(s) ? 'Firefox'
    : /HeadlessChrome/.test(s) ? 'Chrome (headless)' : /Chrome\/|CriOS/.test(s) ? 'Chrome' : /OBS\//.test(s) ? 'OBS'
      : /Safari\//.test(s) ? 'Safari' : '';
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || s.split(/[\s/;(]/)[0].slice(0, 40) || 'Unknown device';
}

// Signed out (logout, or this device's session ended): the app forgets the session and shows the
// sign-in page, without the "Your session ended" error an unexpected sign-out gets.
let signedOut;
function leave() {
  if (signedOut) return signedOut();
  history.replaceState(null, '', '#/login');
  location.reload();
}

// A tab's content: Loading…, then what build() mounts, or its error with Try again (H17).
function load(panel, build) {
  const life = { alive: true };
  const attempt = async () => {
    mount(panel, h('p.loading', 'Loading…'));
    try {
      await build(panel, life);
    } catch (err) {
      if (!life.alive) return;
      mount(panel, h('div.card', { role: 'alert' },
        h('h2', 'This could not load'),
        h('p', err?.message || String(err)),
        h('div.row', h('button.btn.primary', { type: 'button', onclick: attempt }, 'Try again'))));
    }
  };
  attempt();
  return () => { life.alive = false; };
}

// ---- the page --------------------------------------------------------------------------------
let refocus; // the tab a click or an arrow key chose: focused again once the route has re-rendered

export async function settings(view, ctx) {
  signedOut = ctx.signedOut;
  const list = [
    { id: 'appearance', label: 'Appearance', build: appearanceTab },
    { id: 'account', label: 'Account', build: accountTab },
    ctx.can('users:admin') ? { id: 'users', label: 'Users', build: usersTab } : null,
    { id: 'tokens', label: 'API tokens', build: tokensTab },
    { id: 'security', label: 'Security', build: securityTab },
    ctx.can('audit:read') ? { id: 'audit', label: 'Audit log', build: auditTab } : null,
    { id: 'about', label: 'About', build: aboutTab },
  ].filter(Boolean);
  const asked = ctx.params?.tab;
  // A tab that doesn't exist, or that this role can't see: the first one.
  if (asked !== undefined && !list.some((t) => t.id === asked)) return ctx.navigate('/settings', { replace: true });
  const routeTab = asked ?? list[0].id;
  ctx.setTitle(`Settings · ${list.find((t) => t.id === routeTab).label}`);

  // Choosing a tab changes the route (so a reload or a shared link opens it), and the route
  // renders the page again with that tab: only the route's own tab renders, so it loads once.
  const root = tabs(list.map((t) => ({
    id: t.id,
    label: t.label,
    render: (panel) => (t.id === routeTab ? load(panel, (p, life) => t.build(p, ctx, life)) : undefined),
  })), {
    selected: routeTab,
    onChange: (id) => {
      if (id === routeTab) return;
      refocus = id;
      ctx.navigate(`/settings/${id}`, { replace: true });
    },
  });
  mount(view, pageHead('Settings'), root);
  const tabButton = q(`#tab-${routeTab}`, view);
  tabButton?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  if (refocus === routeTab) tabButton?.focus();
  refocus = undefined;
  return () => root.destroy?.();
}

// ---- Appearance (08 §8.6) ----------------------------------------------------------------------
async function appearanceTab(panel, ctx, life) {
  let prefs = { ...(ctx.session?.user?.preferences || {}) };

  const theme = segmented('Theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], prefs.theme || 'system',
    { hint: 'System follows this device\'s light or dark setting.' });
  const density = segmented('Density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], prefs.density || 'comfortable',
    { hint: 'Compact fits more on a screen. Buttons stay big enough to tap.' });
  const accent = h('input', { type: 'color', id: uid('accent'), value: prefs.accent || themeAccent() });
  const accentHint = h('span.hint', { id: `${accent.id}-hint` });
  accent.setAttribute('aria-describedby', accentHint.id);
  const resetAccent = h('button.btn', { type: 'button' }, 'Default');

  const sync = () => {
    theme.set(prefs.theme || 'system');
    density.set(prefs.density || 'comfortable');
    accent.value = prefs.accent || themeAccent();
    accentHint.textContent = prefs.accent ? `Your colour: ${prefs.accent}` : 'The theme\'s own colour.';
    resetAccent.disabled = !prefs.accent;
  };

  // Each choice is saved at once, and applied at once; the message says which.
  const saidAs = (patch) => {
    if ('theme' in patch) return `Theme: ${{ system: 'as this device is set', light: 'light', dark: 'dark' }[patch.theme] || patch.theme}`;
    if ('density' in patch) return `Density: ${patch.density}`;
    return patch.accent ? `Accent colour changed to ${patch.accent}` : 'Accent colour back to the theme\'s own';
  };
  async function save(patch, control) {
    const out = await run(control, () => api.put('/api/v1/auth/preferences', patch), { done: saidAs(patch) });
    if (out && typeof out === 'object') prefs = out;
    ctx.applyPreferences(prefs); // on a failure, this undoes the colour being tried
    if (life.alive) sync();
    if (out) ctx.refreshSession().catch(() => { /* the look is applied already */ });
  }
  theme.onPick((v, b) => save({ theme: v }, b));
  density.onPick((v, b) => save({ density: v }, b));
  accent.addEventListener('input', () => ctx.applyPreferences({ ...prefs, accent: accent.value }));
  accent.addEventListener('change', () => {
    const v = accent.value.toLowerCase();
    if (v !== prefs.accent) save({ accent: v }, accent);
  });
  resetAccent.addEventListener('click', () => save({ accent: null }, resetAccent));
  sync();

  mount(panel, h('div.stack',
    card('How the admin looks',
      h('p.muted', 'Just for you, on every device you sign in on. Overlays never change.'),
      theme,
      h('div.field', h('label', { for: accent.id }, 'Accent colour'), h('div.row', accent, resetAccent), accentHint),
      density),
    ctx.can('system:admin') ? installationCard(ctx, life) : null));
}

// The installation's name and logo, for everyone (system:admin).
function installationCard(ctx, life) {
  const body = h('div');
  const el = card('This installation', h('p.muted', 'The name and logo in the header and the browser tab, for everyone who signs in.'), body);
  const attempt = async () => {
    mount(body, h('p.loading', 'Loading…'));
    const [settingsR, mediaR] = await Promise.allSettled([api.get('/api/v1/system/settings'), api.all('/api/v1/media')]);
    if (!life.alive) return;
    if (settingsR.status === 'rejected') {
      mount(body, notice(settingsR.reason?.message || 'The installation\'s settings could not load.', 'danger'),
        h('button.btn', { type: 'button', onclick: attempt }, 'Try again'));
      return;
    }
    let current = settingsR.value || {};
    const images = mediaR.status === 'fulfilled'
      ? (mediaR.value || []).filter((m) => m?.url && (m.kind === 'image' || String(m.type || '').startsWith('image/')))
      : [];

    const name = h('input', { type: 'text', maxlength: 60, value: current.name || '', placeholder: 'Stream Kit', autocomplete: 'off' });
    const logo = h('select',
      h('option', { value: '' }, 'No logo'),
      images.map((m) => h('option', { value: m.url }, m.name || m.url)),
      current.logo && !images.some((m) => m.url === current.logo) ? h('option', { value: current.logo }, 'The current logo') : null);
    logo.value = current.logo || '';
    const preview = h('img', { alt: 'Logo preview' });
    preview.style.maxHeight = '64px';
    preview.style.width = 'auto';
    preview.style.borderRadius = 'var(--radius-sm)';
    const showPreview = () => {
      preview.hidden = !logo.value;
      if (logo.value) preview.src = logo.value;
      else preview.removeAttribute('src');
    };
    logo.addEventListener('change', showPreview);
    showPreview();

    const submit = h('button.btn.primary', { type: 'submit' }, 'Save name and logo');
    const form = h('form', { novalidate: true },
      field('Name', name, { hint: 'Up to 60 characters. Empty: "Stream Kit".' }),
      field('Logo', logo, { hint: images.length ? 'One of the images uploaded in Media.' : 'Upload an image in Media first, then choose it here.' }),
      mediaR.status === 'rejected' ? notice(`Your images could not be listed: ${mediaR.reason?.message || 'try again later'}`, 'warn') : null,
      preview,
      h('div.form-actions', submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      // Only what was changed here is sent (the server keeps the rest): a page open since before
      // someone else set the logo doesn't put back the old one when its name is saved.
      const patch = {};
      if (name.value.trim() !== (current.name || '')) patch.name = name.value.trim() || null;
      if (logo.value !== (current.logo || '')) patch.logo = logo.value || null;
      if (!Object.keys(patch).length) { toast('Nothing to save: the name and logo are as they were.'); return; }
      const what = Object.keys(patch).length === 2 ? 'name and logo' : 'name' in patch ? 'name' : 'logo';
      const out = await run(submit, () => api.put('/api/v1/system/settings', patch), { done: `Installation ${what} saved` });
      if (!out) return;
      current = out;
      ctx.applySystem(out);
      ctx.setTitle('Settings · Appearance');
    });
    mount(body, form);
  };
  attempt();
  return el;
}

// ---- Account (07 §7.3, §7.4) -------------------------------------------------------------------
async function accountTab(panel, ctx, life) {
  const [session, info] = await Promise.all([
    api.get('/api/v1/auth/session'),
    api.get('/api/v1/system/info').catch(() => null), // only for the two-factor nudge
  ]);
  if (!life.alive) return;
  let me = session?.user || ctx.session?.user || {};

  const sessions = sessionsCard(life);
  const signOut = h('button.btn', {
    type: 'button',
    onclick: async () => {
      const out = await run(signOut, () => api.post('/api/v1/auth/logout'));
      if (out !== undefined) leave();
    },
  }, 'Sign out');
  const role = me.role || session?.role;
  const you = headed('You', signOut,
    kv([
      ['Username', me.username || 'Unknown'],
      ['Role', [h('strong', roleLabel(role)), ROLES[role] ? [h('br'), h('span.small.muted', ROLES[role].text)] : null]],
      session?.expiresAt ? ['Signed in until', dateTime(session.expiresAt)] : null,
    ]));

  // ---- two-factor
  const twoFactor = h('section.card');
  const nudge = info?.exposure === 'public' && (role === 'owner' || role === 'admin');
  const showTwoFactor = () => {
    if (me.totp) {
      mount(twoFactor,
        h('div.card-head', h('h2', 'Two-factor sign-in'),
          h('div.actions', menu('More', [{ label: 'Turn off two-factor…', danger: true, onSelect: turnOff }], { ariaLabel: 'More for two-factor sign-in' }))),
        statusLine('ok', 'On', h('strong', 'On.'), ' Signing in asks for a code from your authenticator app.'));
      return;
    }
    const on = h('button.btn.primary', { type: 'button', onclick: () => turnOn(on) }, 'Turn on');
    mount(twoFactor,
      h('div.card-head', h('h2', 'Two-factor sign-in'), h('div.actions', on)),
      nudge ? notice('This platform can be reached from the internet: turn two-factor on, so a stolen password isn\'t enough to take over your stream.', 'warn') : null,
      statusLine(undefined, 'Off', h('strong', 'Off.'), ' Signing in needs only your password. With two-factor on, it also asks for a six-digit code from an app on your phone.'));
  };

  async function turnOn(button) {
    const answer = await prompt({
      title: 'Turn on two-factor',
      intro: 'You need an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password …). First, your password:',
      fields: [passwordField],
      submitLabel: 'Continue',
    });
    if (!answer) return;
    const enrolled = await run(button, () => api.post('/api/v1/auth/totp/enroll', { password: answer.password }));
    if (enrolled && life.alive) showEnroll(enrolled);
  }

  function showEnroll({ secret, uri } = {}) {
    const key = String(secret || '');
    const code = h('input', { type: 'text', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, spellcheck: 'false' });
    const verify = h('button.btn.primary', { type: 'submit' }, 'Turn on two-factor');
    const form = h('form', { novalidate: true },
      field('Six-digit code', code, { hint: 'The code the app shows now; it changes every 30 seconds.' }),
      h('div.form-actions', h('button.btn', { type: 'button', onclick: showTwoFactor }, 'Cancel'), verify));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = code.value.replace(/\s+/g, '');
      if (!/^\d{6}$/.test(value)) {
        toast('Enter the six digits the app shows.', { kind: 'error' });
        code.focus();
        return;
      }
      const out = await run(verify, () => api.post('/api/v1/auth/totp/verify', { code: value }));
      if (!out) { code.select(); return; }
      // Two-factor ends every session and starts this one again: read it, for the new CSRF token.
      await ctx.refreshSession().catch(() => { /* the next request says if it is gone */ });
      me = out.user || { ...me, totp: true };
      if (life.alive) { showTwoFactor(); sessions.refresh(); }
      await recoveryCodes(out.recoveryCodes);
      toast('Two-factor is on. Your other devices were signed out.');
    });
    const keyEl = h('code', key.replace(/(.{4})(?=.)/g, '$1 '));
    keyEl.style.fontSize = '1.05rem';
    mount(twoFactor,
      h('h2', 'Turn on two-factor'),
      h('ol',
        h('li', h('p', 'Add this platform to your authenticator app.'),
          uri ? h('p', h('strong', 'On this phone: '), h('a.btn', { href: uri }, 'Open in authenticator app')) : null,
          h('p', h('strong', 'On a computer: '), 'in the app on your phone, add an account by hand and type this key:'),
          h('p.row', keyEl, h('button.btn.small', { type: 'button', onclick: () => copy(key, 'Key copied') }, 'Copy key'))),
        h('li', h('p', 'Enter the code the app shows, within ten minutes.'), form)));
    code.focus();
  }

  async function turnOff() {
    const answer = await prompt({
      title: 'Turn off two-factor?',
      intro: 'Signing in will need only your password, and your other devices will be signed out. Enter your password to turn it off.',
      fields: [passwordField],
      submitLabel: 'Turn off',
    });
    if (!answer) return;
    const out = await run(null, () => api.del('/api/v1/auth/totp', { body: { password: answer.password } }),
      { done: 'Two-factor is off. Your other devices were signed out.' });
    if (!out) return;
    await ctx.refreshSession().catch(() => { /* the next request says if it is gone */ });
    me = out.user || { ...me, totp: false };
    if (life.alive) { showTwoFactor(); sessions.refresh(); }
  }

  showTwoFactor();
  mount(panel, h('div.stack', you, passwordCard(ctx, () => sessions.refresh()), twoFactor, sessions));
}

// The ten recovery codes, once (07 §7.4).
async function recoveryCodes(codes) {
  const list = Array.isArray(codes) ? codes : [];
  const ol = h('ol.mono', list.map((c) => h('li', c)));
  ol.style.columns = '2';
  await dialog({
    title: 'Your recovery codes',
    body: h('div',
      notice('Save these now: they are shown once.', 'warn'),
      h('p', 'Each code signs you in once if you lose your phone. Keep them somewhere safe, like a password manager or on paper.'),
      ol,
      h('p', h('button.btn', { type: 'button', onclick: () => copy(list.join('\n'), 'Recovery codes copied') }, 'Copy all'))),
    actions: [{ label: 'I saved them', value: true, kind: 'primary' }],
    dismissable: false,
  });
}

function passwordCard(ctx, after) {
  const current = h('input', { type: 'password', name: 'current', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', name: 'password', autocomplete: 'new-password' });
  const again = h('input', { type: 'password', name: 'again', autocomplete: 'new-password' });
  const message = h('div', { 'aria-live': 'polite' });
  const submit = h('button.btn.primary', { type: 'submit' }, 'Change password');
  const form = h('form', { novalidate: true },
    field('Current password', current),
    field('New password', next, { hint: 'At least 12 characters; a few words make a good one. Your other devices will be signed out.' }),
    field('New password again', again),
    message,
    h('div.form-actions', submit));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(message);
    const problems = [];
    if (!current.value) problems.push('Enter your current password.');
    if (next.value.length < 12) problems.push('The new password needs at least 12 characters.');
    else if (next.value !== again.value) problems.push('The two new passwords are different.');
    if (problems.length) {
      mount(message, notice(problems.join(' '), 'danger'));
      return;
    }
    const out = await run(submit, () => api.post('/api/v1/auth/password', { current: current.value, password: next.value }),
      { done: 'Password changed. Your other devices were signed out.' });
    if (!out) return;
    // A new password ends every session and starts this one again: read it, for the new CSRF token.
    await ctx.refreshSession().catch(() => { /* the next request says if it is gone */ });
    current.value = '';
    next.value = '';
    again.value = '';
    after?.();
  });
  return card('Password', form);
}

// Where you're signed in, and ending a session (07 §7.3).
function sessionsCard(life) {
  const box = h('div', h('p.loading', 'Loading…'));
  const el = card('Where you\'re signed in', box);

  async function end(s) {
    const ok = await confirm({
      title: s.current ? 'Sign out on this device?' : 'End this session?',
      consequence: s.current
        ? 'You will be signed out here, and need your password to sign in again.'
        : `${device(s.device)} will be signed out, and need the password to sign in again.`,
      confirmLabel: s.current ? 'Sign out' : 'End session',
    });
    if (!ok) return;
    const out = await run(null, () => api.del(`/api/v1/auth/sessions/${api.seg(s.id)}`),
      { done: s.current ? undefined : 'Session ended: that device is signed out.' });
    if (!out) return;
    if (out.current) { leave(); return; }
    refresh();
  }

  const row = (s) => h('li',
    lines(
      h('div.row', h('strong', { title: s.device || '' }, device(s.device)), s.current ? badge('This device', 'accent') : null),
      h('span.small.muted', [
        s.ip ? `IP ${s.ip}` : null,
        s.current ? 'active now' : s.lastSeenAt ? `last seen ${ago(s.lastSeenAt)}` : null,
        s.createdAt ? `signed in ${dateTime(s.createdAt)}` : null,
      ].filter(Boolean).join(' · '))),
    menu('More', [{ label: s.current ? 'Sign out here…' : 'End this session…', danger: true, onSelect: () => end(s) }],
      { ariaLabel: `More for ${device(s.device)}${s.current ? ' (this device)' : ''}` }));

  async function refresh() {
    try {
      const list = await api.all('/api/v1/auth/sessions');
      if (!life.alive) return;
      mount(box, list.length ? h('ul.list', list.map(row)) : empty('No sessions', 'Nobody is signed in as you.'));
    } catch (err) {
      if (!life.alive) return;
      mount(box, notice(err.message, 'danger'), h('button.btn', { type: 'button', onclick: refresh }, 'Try again'));
    }
  }
  el.refresh = refresh;
  refresh();
  return el;
}

// ---- Users (users:admin; 07 §7.5) --------------------------------------------------------------
async function usersTab(panel, ctx, life) {
  const myId = ctx.session?.user?.id;
  const box = h('div');
  const path = (u) => `/api/v1/users/${api.seg(u.id)}`;

  const show = (users) => mount(box, users.length ? h('ul.list', users.map(row)) : empty('No users yet', 'Add the people who help run the show.'));
  async function refresh() {
    try {
      const users = await api.all('/api/v1/users');
      if (life.alive) show(users);
    } catch (err) {
      if (life.alive) toast(err);
    }
  }
  // A change to an account sends it as listed (H16), and an account changes whenever its person
  // signs in: a 412 reads the list again, so the next try is made on the account as it is now.
  const onError = (u) => (err) => {
    if (err?.status !== 412) { toast(err); return; }
    toast(`${u.username}'s account changed since you opened this list (signing in changes it too). The list is up to date now: try again.`, { kind: 'error', ms: 10000 });
    refresh();
  };

  async function changeRole(u) {
    const answer = await prompt({
      title: `Change ${u.username}'s role`,
      intro: 'They will be signed out everywhere, and sign in again with the new role.',
      fields: [{
        name: 'role', label: 'Role', type: 'select', value: u.role,
        options: ASSIGNABLE.map((r) => ({ value: r, label: roleLabel(r) })),
        hint: 'Admin: also templates, media and connections. Operator: runs the show. Viewer: watches only.',
      }],
      submitLabel: 'Change role',
    });
    if (!answer || answer.role === u.role) return;
    const out = await run(null, () => api.patch(path(u), { role: answer.role }, { ifMatch: u }),
      { done: (x) => `${x?.username || u.username} is now ${roleLabel(x?.role || answer.role).toLowerCase()}, and was signed out everywhere.`, onError: onError(u) });
    if (out) refresh();
  }

  async function setPassword(u) {
    const answer = await prompt({
      title: `New password for ${u.username}`,
      intro: 'They will be signed out everywhere. Tell them the new password; they can change it in Settings, Account.',
      fields: [
        { name: 'password', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 12 characters.' },
        { name: 'again', label: 'New password again', type: 'password', required: true, autocomplete: 'new-password' },
      ],
      submitLabel: 'Set password',
    });
    if (!answer) return;
    if (answer.password.length < 12) { toast('The password needs at least 12 characters. Nothing was changed.', { kind: 'error' }); return; }
    if (answer.password !== answer.again) { toast('The two passwords are different. Nothing was changed.', { kind: 'error' }); return; }
    const out = await run(null, () => api.patch(path(u), { password: answer.password }, { ifMatch: u }),
      { done: `New password set for ${u.username}. They were signed out everywhere.`, onError: onError(u) });
    if (out) refresh();
  }

  async function resetTwoFactor(u) {
    const ok = await confirm({
      title: `Turn off two-factor for ${u.username}?`,
      consequence: 'They can sign in with only their password until they turn it on again, and they are signed out everywhere. Do this when they lost their phone.',
      confirmLabel: 'Turn off two-factor',
    });
    if (!ok) return;
    const out = await run(null, () => api.patch(path(u), { totp: false }, { ifMatch: u }),
      { done: `Two-factor is off for ${u.username}. They were signed out everywhere.`, onError: onError(u) });
    if (out) refresh();
  }

  async function remove(u) {
    const ok = await confirm({
      title: `Remove ${u.username}?`,
      consequence: `${u.username} can't sign in any more, and their sessions and API tokens stop working at once. This can't be undone.`,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    const out = await run(null, () => api.del(path(u)), { done: `Removed ${u.username}`, onError: (err) => { toast(err); refresh(); } });
    if (out) refresh();
  }

  function row(u) {
    const self = u.id === myId;
    const actions = self
      ? h('a.btn', { href: '#/settings/account' }, 'Your account')
      : u.role === 'owner'
        ? null
        : menu('More', [
          { label: 'Change role…', onSelect: () => changeRole(u) },
          { label: 'Set a new password…', onSelect: () => setPassword(u) },
          u.totp ? { label: 'Turn off two-factor…', danger: true, onSelect: () => resetTwoFactor(u) } : null,
          { label: `Remove ${u.username}…`, danger: true, onSelect: () => remove(u) },
        ], { ariaLabel: `More for ${u.username}` });
    return h('li',
      lines(
        h('div.row', h('strong', u.username || u.id), badge(roleLabel(u.role), u.role === 'owner' ? 'accent' : undefined),
          self ? badge('You') : null, u.totp ? badge('Two-factor on', 'ok') : badge('No two-factor')),
        h('span.small.muted', [
          u.createdAt ? `Added ${day(u.createdAt)}` : null,
          u.lastLoginAt ? `last signed in ${ago(u.lastLoginAt)}` : 'never signed in',
        ].filter(Boolean).join(' · '))),
      actions);
  }

  show(await api.all('/api/v1/users'));
  if (!life.alive) return;
  mount(panel, h('div.stack',
    card('Users', h('p.muted', 'Everyone who can sign in, and what they may do.'), box),
    addUserCard(refresh)));
}

function addUserCard(onAdded) {
  const username = h('input', { type: 'text', name: 'username', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: 64 });
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'new-password' });
  const group = uid('role');
  const radios = ASSIGNABLE.map((r) => h('input', { type: 'radio', name: group, value: r, checked: r === 'operator' }));
  const message = h('div', { 'aria-live': 'polite' });
  const submit = h('button.btn.primary', { type: 'submit' }, 'Add user');
  const form = h('form', { novalidate: true },
    field('Username', username, { hint: 'Lower-case letters, digits, dots, dashes and underscores. They sign in with it.' }),
    field('Password', password, { hint: 'At least 12 characters. Tell them the password; they can change it in Settings, Account.' }),
    h('fieldset', h('legend', 'Role'), radios.map((input, i) => choiceRow(input, h('strong', roleLabel(ASSIGNABLE[i])), ROLES[ASSIGNABLE[i]].text))),
    message,
    h('div.form-actions', submit));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(message);
    const name = username.value.trim().toLowerCase();
    const role = radios.find((r) => r.checked)?.value;
    const problems = [];
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) problems.push('Choose a username: lower-case letters, digits, dots, dashes and underscores.');
    if (password.value.length < 12) problems.push('The password needs at least 12 characters.');
    if (!role) problems.push('Choose a role.');
    if (problems.length) {
      mount(message, notice(problems.join(' '), 'danger'));
      return;
    }
    const out = await run(submit, () => api.post('/api/v1/users', { username: name, password: password.value, role }),
      { done: (u) => `Added ${u?.username || name} as ${roleLabel(u?.role || role).toLowerCase()}` });
    if (!out) return;
    username.value = '';
    password.value = '';
    for (const r of radios) r.checked = r.value === 'operator';
    onAdded();
  });
  return card('Add a user', form);
}

// ---- API tokens (07 §7.5) ----------------------------------------------------------------------
async function tokensTab(panel, ctx, life) {
  // Whoever manages users (the owner) also sees everyone else's tokens, to revoke one that leaked
  // or belongs to someone who left: GET /api/v1/tokens?all=true.
  const admin = ctx.can('users:admin');
  const read = async () => {
    const [own, all] = await Promise.all([api.all('/api/v1/tokens'), admin ? api.all('/api/v1/tokens', { query: { all: 'true' } }) : []]);
    const ownIds = new Set(own.map((t) => t.id));
    return { own, others: all.filter((t) => !ownIds.has(t.id)) };
  };
  let { own: tokens, others } = await read();
  if (!life.alive) return;
  const mine = ctx.session?.scopes || [];
  const box = h('div');
  const othersBox = h('div');
  const formCard = h('section.card', { hidden: true });

  const show = () => {
    mount(box, tokens.length
      ? h('ul.list', tokens.map((t) => row(t)))
      : empty('No API tokens', 'A token lets an app, like a Stream Deck or a chat bot, use this platform without your password.'));
    mount(othersBox, others.length
      ? h('ul.list', others.map((t) => row(t, { whose: true })))
      : h('p.muted', 'Nobody else has an API token.'));
  };
  async function refresh() {
    try {
      ({ own: tokens, others } = await read());
      if (life.alive) show();
    } catch (err) {
      if (life.alive) toast(err);
    }
  }

  async function revoke(t, whose) {
    const ok = await confirm({
      title: `Revoke "${t.name}"${whose && t.user ? ` of ${t.user}` : ''}?`,
      consequence: whose ? `Apps ${t.user || 'its owner'} uses with this token will stop working.` : 'Apps using this token will stop working.',
      confirmLabel: 'Revoke',
    });
    if (!ok) return;
    const out = await run(null, () => api.del(`/api/v1/tokens/${api.seg(t.id)}`), { done: `Token "${t.name}" revoked` });
    if (out) refresh();
  }

  function row(t, { whose } = {}) {
    const scopes = Array.isArray(t.scopes) ? t.scopes : [];
    const expired = t.expiresAt && Date.parse(t.expiresAt) <= Date.now();
    const everything = !whose && scopes.length && mine.length && mine.every((s) => scopes.includes(s));
    const name = t.name || 'Unnamed token';
    return h('li',
      lines(
        h('div.row', h('strong', name), whose ? badge(t.user ? `Belongs to ${t.user}` : 'Belongs to no account') : null, expired ? badge('Expired', 'danger') : null),
        h('div.row', everything ? badge('Everything you can do') : scopes.map((s) => h('span.badge', { title: s }, SCOPE_SHORT[s] || s))),
        h('span.small.muted', [
          t.createdAt ? `Created ${day(t.createdAt)}` : null,
          t.expiresAt ? `${expired ? 'expired' : 'expires'} ${day(t.expiresAt)}` : 'never expires',
          t.lastUsedAt ? `last used ${ago(t.lastUsedAt)}` : 'never used',
          Array.isArray(t.ips) && t.ips.length ? `only from ${t.ips.join(', ')}` : null,
        ].filter(Boolean).join(' · '))),
      menu('More', [{ label: 'Revoke…', danger: true, onSelect: () => revoke(t, whose) }], { ariaLabel: `More for token ${name}${whose && t.user ? ` of ${t.user}` : ''}` }));
  }

  const newButton = h('button.btn.primary', { type: 'button' }, 'New token');
  const form = tokenForm(mine, {
    onCreated: async (created) => {
      formCard.hidden = true;
      refresh();
      await secretDialog(created);
      toast(`Token "${created.name}" created`);
      if (life.alive) newButton.focus();
    },
    onCancel: () => { formCard.hidden = true; newButton.focus(); },
  });
  newButton.addEventListener('click', () => {
    formCard.hidden = false;
    form.querySelector('input')?.focus();
  });
  mount(formCard, h('h2', 'New API token'), form);
  show();
  mount(panel, h('div.stack', headed('Your API tokens', newButton, box), formCard,
    admin ? card('Everyone else\'s tokens', h('p.muted', 'The tokens of the other people who sign in here. Revoke one that leaked, or that belongs to someone who no longer helps run the show.'), othersBox) : null));
}

function tokenForm(mine, { onCreated, onCancel }) {
  const have = new Set(mine);
  const name = h('input', { type: 'text', name: 'name', maxlength: 80, autocomplete: 'off' });
  const boxes = [];
  const groups = SCOPE_GROUPS.map(([title, scopes]) => {
    const rows = scopes.filter(([id]) => have.has(id)).map(([id, text]) => {
      const input = h('input', { type: 'checkbox', value: id });
      boxes.push(input);
      return choiceRow(input, text);
    });
    return rows.length ? h('div', h('h3', title), rows) : null;
  });
  const days = h('input', { type: 'number', name: 'days', min: 1, max: 3650, step: 1, value: '90', inputmode: 'numeric' });
  const never = h('input', { type: 'checkbox', name: 'never' });
  never.addEventListener('change', () => { days.disabled = never.checked; });
  const ips = h('input', { type: 'text', name: 'ips', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: '192.168.1.0/24' });
  const message = h('div', { 'aria-live': 'polite' });
  const submit = h('button.btn.primary', { type: 'submit' }, 'Create token');
  const form = h('form', { novalidate: true },
    field('Name', name, { hint: 'What it\'s for, like "Stream Deck" or "Chat bot".' }),
    h('fieldset', h('legend', 'What it can do'),
      h('p.muted.small', 'Choose only what the app needs. A token can never do more than you can.'),
      groups),
    field('Expires after (days)', days, { hint: 'From 1 to 3650 days.' }),
    choiceRow(never, 'Never expires'),
    field('Only from these addresses (optional)', ips, { hint: 'Addresses or ranges separated by commas, like 192.168.1.20 or 192.168.1.0/24. Empty: any address.' }),
    message,
    h('div.form-actions', h('button.btn', { type: 'button', onclick: () => { reset(); onCancel(); } }, 'Cancel'), submit));

  function reset() {
    name.value = '';
    for (const b of boxes) b.checked = false;
    days.value = '90';
    days.disabled = false;
    never.checked = false;
    ips.value = '';
    mount(message);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(message);
    const problems = [];
    const label = name.value.trim();
    if (!label) problems.push('Give the token a name.');
    const scopes = boxes.filter((b) => b.checked).map((b) => b.value);
    if (!scopes.length) problems.push('Choose at least one thing it can do.');
    let expiresInDays;
    if (!never.checked) {
      expiresInDays = Number(days.value);
      if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650) problems.push('Expiry is a whole number of days from 1 to 3650, or tick "Never expires".');
    }
    const ipList = ips.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (problems.length) {
      mount(message, notice(problems.join(' '), 'danger'));
      return;
    }
    const body = { name: label, scopes, ...(expiresInDays ? { expiresInDays } : {}), ...(ipList.length ? { ips: ipList } : {}) };
    const out = await run(submit, () => api.post('/api/v1/tokens', body));
    if (!out) return;
    reset();
    onCreated(out);
  });
  return form;
}

// A new token's secret, once.
async function secretDialog(created) {
  const id = uid('secret');
  await dialog({
    title: 'Copy your new token',
    body: h('div',
      h('p', `"${created?.name || 'The token'}" is ready.`),
      notice('Copy it now: it won\'t be shown again.', 'warn'),
      h('label.sr-only', { for: id }, 'Your new token'),
      copyField(created?.token || '', { label: 'Copy', copied: 'Token copied', id }),
      h('p.muted.small', 'Paste it into the app that needs it. Anyone who has it can do what it allows: keep it private, and revoke it here if it leaks.')),
    actions: [{ label: 'I copied it', value: true, kind: 'primary' }],
    dismissable: false,
  });
}

// ---- Security & exposure (07 §7.8; read only) --------------------------------------------------
async function securityTab(panel, ctx, life) {
  const info = await api.get('/api/v1/system/info');
  if (!life.alive) return;
  const mode = info?.exposure;
  const about = EXPOSURE[mode] || { title: mode ? `"${mode}"` : 'Unknown', text: '' };
  const me = ctx.session?.user || {};
  const tls = Boolean(info?.capabilities?.tls);
  const https = location.protocol === 'https:';
  const needsTwoFactor = mode === 'public' && !me.totp && (me.role === 'owner' || me.role === 'admin');

  mount(panel, h('div.stack',
    card('Who can reach this platform',
      h('p.row', badge(mode || 'unknown', mode === 'public' ? 'warn' : 'ok'), h('strong', about.title)),
      about.text ? h('p', about.text) : null,
      needsTwoFactor ? notice(h('span', 'You don\'t have two-factor on yet. ', h('a', { href: '#/settings/account' }, 'Turn it on in Account'), '.'), 'warn') : null,
      kv([
        ['Exposure', h('code', mode || 'unknown')],
        ['Public address', info?.publicUrl ? h('a', { href: info.publicUrl, rel: 'noopener' }, info.publicUrl) : 'Not set (only needed for the internet)'],
        ['HTTPS', tls ? 'On: this platform has its own certificate' : mode === 'public' ? 'From the reverse proxy in front of it' : 'Off: traffic stays on this computer or your network'],
        ['This connection', `${https ? 'Encrypted (HTTPS)' : 'Not encrypted (HTTP)'} to ${location.host}`],
      ])),
    card('How to change it',
      h('p', 'Exposure is set when the platform starts: on its command line, in its environment, or in config.json in its config directory. Change it, then restart the platform.'),
      kv(OPTIONS.map(([label, flag, env]) => [label, [h('code', flag), ' or ', h('code', env)]])),
      spaced(h('h3', 'Examples')),
      command('Phones on your Wi-Fi can reach it', 'npm start -- --exposure lan'),
      command('The same, as an environment variable (Docker, a NAS)', 'SKP_EXPOSURE=lan'),
      command('The internet, with its own certificate', 'npm start -- --exposure public --public-url https://overlays.example.com --tls-cert cert.pem --tls-key key.pem'),
      h('p.muted.small', 'The internet needs HTTPS: a certificate (--tls-cert and --tls-key), or a reverse proxy such as Caddy that serves HTTPS, named with --trust-proxy and its address.'))));
}

// ---- Audit log (audit:read; 07 §7.12) ----------------------------------------------------------
async function auditTab(panel, ctx, life) {
  const PAGE = 50;
  let filter = '';
  let next;
  const list = h('ul.list');
  const more = h('button.btn', { type: 'button', hidden: true }, 'Load more');
  const status = h('p.muted.small', { 'aria-live': 'polite' });
  const box = h('div');

  const row = (e) => {
    const plain = ACTIONS[e.action];
    const target = typeof e.target === 'string' && !INTERNAL_ID.test(e.target) ? e.target : undefined;
    const what = e.details?.username || e.details?.name || target;
    const reason = e.details?.reason ? REASONS[e.details.reason] || e.details.reason : null;
    return h('li', lines(
      h('div.spread', h('strong', plain || e.action),
        h('time.small.muted', { datetime: e.at }, dateTime(e.at))),
      h('span.small.muted', [
        `by ${e.actor || 'unknown'}`,
        what ? `on ${what}` : null,
        reason,
        e.ip ? `IP ${e.ip}` : null,
      ].filter(Boolean).join(' · '))));
  };

  const fetchPage = (cursor) => api.get('/api/v1/system/audit', { query: { limit: PAGE, cursor, action: filter || undefined } });
  const showPage = (page, append) => {
    const items = Array.isArray(page?.items) ? page.items : [];
    if (!append) list.replaceChildren();
    list.append(...items.map(row));
    next = page?.next;
    more.hidden = !next;
    if (!list.children.length) {
      const label = AUDIT_FILTERS.find(([v]) => v === filter)?.[1];
      mount(box, empty('Nothing recorded', filter ? `Nothing of "${label || filter}" in the log. Choose Everything to see what is.` : 'Sign-ins and changes show up here.'));
    } else {
      mount(box, list);
    }
    status.textContent = list.children.length ? `${list.children.length} shown, newest first${next ? '' : '. That\'s all of them'}.` : '';
  };

  more.addEventListener('click', async () => {
    const page = await run(more, () => fetchPage(next));
    if (page && life.alive) showPage(page, true);
  });

  const input = h('select', { name: 'action' }, AUDIT_FILTERS.map(([value, label]) => h('option', { value }, label)));
  const apply = h('button.btn', { type: 'submit' }, 'Show');
  const form = h('form.inline-form', { role: 'search' }, field('What', input), apply);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    filter = input.value;
    const page = await run(apply, () => fetchPage(undefined));
    if (page && life.alive) showPage(page, false);
  });

  showPage(await fetchPage(undefined), false);
  if (!life.alive) return;
  mount(panel, card('Audit log',
    h('p.muted', 'Who did what, and when: sign-ins, users, tokens, overlays and media. Kept 90 days unless set otherwise.'),
    form,
    box,
    status,
    h('div.row', more)));
}

// ---- About -------------------------------------------------------------------------------------
async function aboutTab(panel, ctx, life) {
  const [infoR, healthR] = await Promise.allSettled([api.get('/api/v1/system/info'), api.get('/api/v1/system/health')]);
  if (!life.alive) return;
  if (infoR.status === 'rejected' && healthR.status === 'rejected') throw infoR.reason;

  let platform;
  if (infoR.status === 'fulfilled') {
    const info = infoR.value || {};
    const store = info.store || {};
    const caps = info.capabilities || {};
    const counts = info.counts || {};
    const storeName = store.kind === 'sqlite' ? 'SQLite' : store.kind === 'json' ? 'JSON files' : store.kind || 'Unknown';
    platform = card('This platform', kv([
      ['Version', info.version || 'Unknown'],
      ['Standard', info.standard || 'Unknown'],
      ['Running for', duration(info.uptimeS) || 'Unknown'],
      ['Data store', `${storeName}${store.schemaVersion !== undefined ? `, schema version ${store.schemaVersion}` : ''}`],
      ['Video conversion', caps.ffmpeg
        ? `ffmpeg${caps.ffmpegVersion ? ` ${caps.ffmpegVersion}` : ''}: phone videos are converted for OBS`
        : 'ffmpeg not found: phone videos are kept as uploaded, and OBS may not play them. Install ffmpeg, or set SKP_FFMPEG.'],
      ['Contents', [plural(counts.overlays ?? 0, 'overlay'), plural(counts.shows ?? 0, 'show'), plural(counts.templates ?? 0, 'template')].join(' · ')],
      ['API', h('a', { href: '/api/v1/openapi.json', target: '_blank', rel: 'noopener' }, 'The API description (OpenAPI)')],
    ]));
  } else {
    platform = card('This platform', notice(infoR.reason?.message || 'It could not load.', 'danger'));
  }

  let health;
  if (healthR.status === 'fulfilled') {
    const hv = healthR.value || {};
    const ok = hv.status === 'ok';
    const off = Array.isArray(hv.overlaysOffAir) ? hv.overlaysOffAir : [];
    health = card('Health',
      statusLine(ok ? 'ok' : 'warn', ok ? 'All good' : 'Degraded', h('strong', ok ? 'All good' : 'Something needs attention')),
      off.length
        ? [h('p', 'These overlays are off air: their template is missing. Install it again, or move them to another template.'),
          h('ul', off.map((slug) => h('li', h('a', { href: `#/overlays/${encodeURIComponent(slug)}` }, slug))))]
        : !ok ? h('p', `The platform reports "${hv.status || 'unknown'}".`) : null);
  } else {
    health = card('Health', notice(healthR.reason?.message || 'It could not load.', 'danger'));
  }

  mount(panel, h('div.stack', health, platform));
}
