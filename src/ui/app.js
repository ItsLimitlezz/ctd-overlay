// The admin UI's shell (08): who is signed in, the look they chose, the navigation, and a hash
// router that hands each page its view. Pages live in pages/; each exports one function per
// route, render(view, ctx), which may return a cleanup function (or a promise of one).
import * as api from './api.js';
import { h, mount, q, toast } from './dom.js';

const ROUTES = [
  { path: '/login', page: 'auth', fn: 'login', open: true, title: 'Sign in' },
  { path: '/setup', page: 'auth', fn: 'setup', open: true, title: 'Set up' },
  { path: '/live', page: 'live', fn: 'live', title: 'Live' },
  { path: '/overlays', page: 'overlays', fn: 'list', title: 'Overlays' },
  { path: '/overlays/:slug', page: 'overlays', fn: 'detail', title: 'Overlay' },
  { path: '/templates', page: 'templates', fn: 'list', title: 'Templates' },
  { path: '/templates/:id', page: 'templates', fn: 'detail', title: 'Template' },
  { path: '/shows', page: 'shows', fn: 'list', title: 'Shows' },
  { path: '/shows/:id', page: 'shows', fn: 'detail', title: 'Show' },
  { path: '/connections', page: 'connections', fn: 'list', title: 'Connections' },
  { path: '/connections/new/:connector', page: 'connections', fn: 'create', title: 'New connection' },
  { path: '/connections/:id', page: 'connections', fn: 'detail', title: 'Connection' },
  { path: '/media', page: 'media', fn: 'list', title: 'Media' },
  { path: '/settings', page: 'settings', fn: 'settings', title: 'Settings' },
  { path: '/settings/:tab', page: 'settings', fn: 'settings', title: 'Settings' },
];

const state = { session: undefined, system: {}, cleanup: undefined, seq: 0 };

function match(hashPath) {
  const parts = hashPath.split('/').filter(Boolean);
  for (const route of ROUTES) {
    const want = route.path.split('/').filter(Boolean);
    if (want.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < want.length; i += 1) {
      if (want[i].startsWith(':')) {
        try { params[want[i].slice(1)] = decodeURIComponent(parts[i]); } catch { ok = false; }
      } else if (want[i] !== parts[i]) ok = false;
      if (!ok) break;
    }
    if (ok) return { route, params };
  }
  return undefined;
}

export function navigate(hash, { replace } = {}) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (replace) history.replaceState(null, '', target);
  else if (location.hash !== target) { location.hash = target; return; }
  render();
}

// The look a user chose (08 §8.6): theme, accent and density, as tokens on <html>.
export function applyPreferences(prefs = {}) {
  const root = document.documentElement;
  if (prefs.theme === 'light' || prefs.theme === 'dark') root.dataset.theme = prefs.theme;
  else delete root.dataset.theme;
  if (prefs.density === 'compact') root.dataset.density = 'compact';
  else delete root.dataset.density;
  if (prefs.accent && /^#[0-9a-f]{6}$/i.test(prefs.accent)) {
    root.style.setProperty('--accent', prefs.accent);
    root.style.setProperty('--accent-text', readableOn(prefs.accent));
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-text');
  }
}

// Black or white text, whichever reads better on a colour (WCAG relative luminance).
function readableOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (lum + 0.05) / 0.05 > 1.05 / (lum + 0.05) ? '#000000' : '#ffffff';
}

// The installation's name and logo (08 §8.6), in the header and the tab title.
export function applySystem(system = {}) {
  state.system = system;
  const name = system.name || 'CTD Overlay';
  const nameEl = q('[data-brand-name]');
  if (nameEl) nameEl.textContent = name;
  const brand = q('[data-brand]');
  const mark = brand?.querySelector('.brand-mark, .brand-logo');
  if (brand && mark) {
    const next = system.logo ? h('img.brand-logo', { src: system.logo, alt: '' }) : h('span.brand-mark', { 'aria-hidden': 'true' });
    mark.replaceWith(next);
  }
}

async function loadSession() {
  try {
    const session = await api.get('/api/v1/auth/session');
    state.session = session;
    api.setCsrf(session.csrf, session.user?.id);
    applyPreferences(session.user?.preferences);
    return session;
  } catch (err) {
    if (err.status === 401) {
      state.session = null;
      return null;
    }
    throw err;
  }
}

// What the page gets. seq is the render it belongs to: once the user has gone elsewhere, a page
// still finishing its requests can't move the address or the tab title from under them.
function context(route, params, seq) {
  const session = state.session;
  const scopes = new Set(session?.scopes || []);
  const alive = () => seq === state.seq;
  return {
    params,
    query: new URLSearchParams(location.hash.split('?')[1] || ''),
    session,
    system: state.system,
    can: (scope) => scopes.has(scope),
    alive,
    navigate: (hash, opts) => { if (alive()) navigate(hash, opts); },
    setTitle: (t) => { if (alive()) document.title = `${t} · ${state.system.name || 'CTD Overlay'}`; },
    applyPreferences,
    applySystem,
    // After a sign-in, a sign-out or a preference change: read the session again and redraw.
    refreshSession: async () => {
      await loadSession();
      updateShell();
    },
    // After a deliberate sign-out: forget the session, without the "session ended" error.
    signedOut: () => {
      state.session = null;
      api.endSession();
      updateShell();
      navigate('/login', { replace: true });
    },
    signedIn: async (next = '/live') => {
      await loadSession();
      await loadSystem();
      updateShell();
      navigate(next, { replace: true });
    },
  };
}

async function loadSystem() {
  try { applySystem(await api.get('/api/v1/system/settings')); } catch { /* the default name will do */ }
}

function updateShell() {
  const shell = q('[data-shell]');
  if (shell) shell.hidden = !state.session;
  const path = location.hash.replace(/^#/, '').split('?')[0];
  for (const a of document.querySelectorAll('[data-nav] a')) {
    const target = a.getAttribute('href').slice(1);
    if (path === target || path.startsWith(`${target}/`)) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

// Each page draws in a <main> of its own. A page left while it was still loading (slow requests)
// draws, when they arrive, into the one it was given, which is out of the document by then: it
// can't cover the page the user went to, nor leave a console there whose buttons no longer work.
function freshView() {
  const old = q('[data-view]');
  if (!old) return undefined;
  const view = old.cloneNode(false); // id, data-view, tabindex: the skip link and styles still find it
  view.className = 'main';
  view.append(h('p.loading', 'Loading…'));
  old.replaceWith(view);
  return view;
}

async function render() {
  const seq = ++state.seq;
  const view = freshView();
  if (!view) return;
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  const nav = q('[data-nav]');
  nav?.classList.remove('open');
  q('[data-menu-toggle]')?.setAttribute('aria-expanded', 'false');

  try { await state.cleanup?.(); } catch (err) { console.warn(err); }
  state.cleanup = undefined;

  if (state.session === undefined) await loadSession().catch(() => { state.session = null; });
  if (seq !== state.seq) return;

  let found = match(path);
  if (!found) {
    navigate(state.session ? '/live' : '/login', { replace: true });
    return;
  }
  if (!found.route.open && !state.session) {
    let setupNeeded = false;
    try { setupNeeded = (await api.get('/api/v1/setup')).needed; } catch { /* sign in */ }
    navigate(setupNeeded ? '/setup' : `/login?next=${encodeURIComponent(path)}`, { replace: true });
    return;
  }
  if (found.route.open && state.session && found.route.page === 'auth') {
    navigate('/live', { replace: true });
    return;
  }

  updateShell();
  view.classList.toggle('narrow', found.route.page === 'auth');
  const ctx = context(found.route, found.params, seq);
  ctx.setTitle(found.route.title);
  try {
    const mod = await import(`./pages/${found.route.page}.js`);
    if (seq !== state.seq) return;
    view.replaceChildren();
    const cleanup = await mod[found.route.fn](view, ctx);
    if (seq !== state.seq) { try { await cleanup?.(); } catch { /* gone */ } return; }
    state.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
  } catch (err) {
    console.error(err);
    if (seq !== state.seq) return;
    // H17: a page that fails still leaves the app usable.
    mount(view,
      h('div.card', { role: 'alert' },
        h('h1', 'This page could not load'),
        h('p', err?.message || String(err)),
        h('div.row', h('button.btn.primary', { type: 'button', onclick: () => render() }, 'Try again'), h('a.btn', { href: '#/live' }, 'Go to Live'))));
  }
  // A new page starts at its top, and a screen reader starts reading it (unless it focused a field).
  window.scrollTo(0, 0);
  if (!view.contains(document.activeElement)) view.focus({ preventScroll: true });
}

function wireShell() {
  // "Skip to content" moves the focus to the page; following its #main would be a route here.
  q('.skip')?.addEventListener('click', (e) => {
    e.preventDefault();
    q('[data-view]')?.focus();
  });
  const toggle = q('[data-menu-toggle]');
  const nav = q('[data-nav]');
  toggle?.addEventListener('click', () => {
    const open = !nav.classList.contains('open');
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav?.classList.contains('open')) {
      nav.classList.remove('open');
      toggle?.setAttribute('aria-expanded', 'false');
      toggle?.focus();
    }
  });
}

async function start() {
  wireShell();
  api.onUnauthenticated(() => {
    if (!state.session) return;
    state.session = null;
    updateShell();
    toast('Your session ended. Sign in again.', { kind: 'error' });
    const path = location.hash.replace(/^#/, '').split('?')[0];
    navigate(`/login?next=${encodeURIComponent(path)}`, { replace: true });
  });
  // Someone else signed in in another tab (api.js found it on a change): this tab is theirs now.
  api.onSessionChanged(async (session) => {
    toast(`${session.user?.username || 'Someone else'} signed in on this browser, in another tab: this page shows their account now.`, { kind: 'error' });
    await loadSession().catch(() => { state.session = null; });
    await loadSystem();
    updateShell();
    render();
  });
  window.addEventListener('hashchange', () => render());
  await loadSession().catch(() => { state.session = null; });
  if (state.session) await loadSystem();
  if (!location.hash || location.hash === '#' || location.hash === '#/') history.replaceState(null, '', '#/live');
  await render();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
