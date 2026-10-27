// The admin UI's shell (08): who is signed in, the look they chose, the navigation, and a hash
// router that hands each page its view. Pages live in pages/; each exports one function per
// route, render(view, ctx), which may return a cleanup function (or a promise of one). A page with
// edits not saved yet says so (ctx.guardLeave), and leaving it asks first.
import * as api from './api.js';
import { confirm, h, mount, q, toast } from './dom.js';

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

// guards: the page's ctx.guardLeave functions; asking: the "Leave without saving?" open now;
// place: where the page shown is in the tab's history (placeOf); pushing: the address the app is
// moving to with a new entry; undoing: a move away from unsaved edits being undone (undo()).
const state = { session: undefined, system: {}, cleanup: undefined, seq: 0, guards: new Set(), asking: undefined, place: 0, pushing: undefined, undoing: undefined };

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

// The page's address in the app, its query too ("/live?show=…&overlay=…", a show's "?tab=lineup"):
// where signing in again comes back to (auth.js takes it only when it is one of ours).
const here = () => location.hash.replace(/^#/, '') || '/';

export function navigate(hash, { replace } = {}) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (replace) history.replaceState({ i: state.place }, '', target);
  else if (location.hash !== target) {
    state.pushing = target; // a new entry, the app's own (onHashChange)
    location.hash = target;
    return;
  }
  render();
}

// ---- where the page is in the tab's history ---------------------------------------------------
// Each entry the app shows carries its place ({ i } in history.state; a page that changes its
// address with history.replaceState passes history.state on), so a move that changes the address
// is told apart: Back or Forward (an entry with a place, so many entries away) or a new entry (a
// link, ctx.navigate, an address typed: the place after this one, unmarked yet). That is how a
// move away from edits not saved is undone the way it came, and made again the same way: the
// history stays as the browser had it, Back after Cancel still goes back.
const placeOf = (st) => (Number.isInteger(st?.i) ? st.i : undefined);
function mark(i) {
  state.place = i;
  if (placeOf(history.state) !== i) history.replaceState({ ...(history.state || {}), i }, '', location.href);
}

// ---- leaving a page with edits not saved ----------------------------------------------------
// A page says what leaving it now would lose: ctx.guardLeave(() => 'Your changes to the lineup are
// lost…', or '' for nothing). A link, the browser's Back or a page's own move (ctx.navigate) then
// asks "Leave without saving?" first; Cancel stays: the page as it is, its edits, its address and
// the history (Back undone with Forward, a new entry with Back, the page not drawn again); Leave
// makes the move as it was made. Reloading or closing the tab gets the browser's own question.
// One question at a time: a move made while one is open is undone, not asked about again. The
// guards go with the page; a move with { replace: true } (after a rename or a delete) doesn't ask.
function lostWords() {
  for (const fn of state.guards) {
    try {
      const lost = fn();
      if (lost) return String(lost);
    } catch (err) {
      console.warn(err);
    }
  }
  return '';
}

function confirmLeave(consequence) {
  if (!state.asking) state.asking = confirm({ title: 'Leave without saving?', consequence, confirmLabel: 'Leave' }).finally(() => { state.asking = undefined; });
  return state.asking;
}

// Asked before making a move (go()). Agreed to, the page is over (its ctx no longer alive, its
// guards dropped), so nothing it still does asks again, and the move draws the next page.
async function leaveFor(lost, go) {
  const seq = state.seq;
  closeNav();
  if (!(await confirmLeave(lost)) || seq !== state.seq) return;
  state.seq += 1;
  dropGuards();
  endUndo();
  go();
}

// The address changed: Back or Forward, or code that set it. Back on the page's own entry (a move
// undone) draws nothing. Away from edits not saved, the move is undone the way it came and asked
// about, and Leave makes it again: an entry the app showed, by as many entries the other way; a new
// one the app made (ctx.navigate), marked first so Forward finds it, with Back. An entry the app
// never marked (an address typed, one from before this page loaded) has no known way back: its
// address is put back in place, as is one an undo didn't land on (undo()).
function onHashChange(e) {
  const at = placeOf(history.state);
  const pushed = at === undefined && state.pushing === location.hash;
  state.pushing = undefined;
  const undoing = state.undoing;
  if (at === state.place) {
    endUndo();
    return;
  }
  if (undoing) {
    endUndo();
    history.replaceState({ i: state.place }, '', undoing.url);
    return;
  }
  const lost = !state.asking && lostWords();
  if (!state.asking && !lost) {
    mark(at ?? state.place + 1);
    render();
    return;
  }
  const target = location.hash;
  let redo;
  if (at !== undefined) {
    const by = at - state.place;
    undo(by, e.oldURL);
    redo = () => history.go(by);
  } else if (pushed) {
    history.replaceState({ ...(history.state || {}), i: state.place + 1 }, '', location.href);
    undo(1, e.oldURL);
    redo = () => history.go(1);
  } else {
    history.replaceState({ i: state.place }, '', e.oldURL);
    redo = () => { location.hash = target; };
  }
  if (lost) leaveFor(lost, redo);
}

// Goes back to the page's own entry, `by` entries the other way. Landing elsewhere, or nowhere
// within a second, its address (url) is put back in place instead.
function undo(by, url) {
  endUndo();
  const timer = setTimeout(() => {
    endUndo();
    if (placeOf(history.state) !== state.place) history.replaceState({ i: state.place }, '', url);
  }, 1000);
  state.undoing = { url, timer };
  history.go(-by);
}
function endUndo() {
  clearTimeout(state.undoing?.timer);
  state.undoing = undefined;
}

// A link inside the app: asked before the address changes, so a move not made leaves nothing in
// the history (a new tab, with a modifier key, isn't a move).
function onLinkClick(e) {
  const a = e.target.closest?.('a[href^="#/"]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (a.target && a.target !== '_self')) return;
  const target = a.getAttribute('href');
  const lost = target !== location.hash && lostWords();
  if (!lost) return;
  e.preventDefault();
  if (!state.asking) leaveFor(lost, () => { if (location.hash === target) render(); else location.hash = target; });
}

// The browser's own question, on a reload or closing the tab. Listened for only while a page has
// guards: some browsers keep a page that listens out of their Back cache.
function onUnload(e) {
  if (!lostWords()) return;
  e.preventDefault();
  e.returnValue = true; // older Chrome and Safari ask only when it is set
}
function syncUnload() {
  if (state.guards.size) window.addEventListener('beforeunload', onUnload);
  else window.removeEventListener('beforeunload', onUnload);
}
function dropGuards() {
  state.guards.clear();
  syncUnload();
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
    // Edits not saved yet: fn() says what leaving the page now would lose, in words ('' for
    // nothing), and leaving asks first. Returns a function that takes it back; it goes with the page.
    guardLeave: (fn) => {
      if (!alive()) return () => {};
      state.guards.add(fn);
      syncUnload();
      return () => {
        state.guards.delete(fn);
        syncUnload();
      };
    },
    // "Leave without saving?" for a move inside the page (another of its tabs): the router's own
    // question, so a Back pressed while it is open isn't asked about twice. → true to leave.
    confirmLeave,
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

function closeNav() {
  q('[data-nav]')?.classList.remove('open');
  q('[data-menu-toggle]')?.setAttribute('aria-expanded', 'false');
}

async function render() {
  const seq = ++state.seq;
  dropGuards(); // the page left, its edits with it
  const view = freshView();
  if (!view) return;
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  closeNav();

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
    navigate(setupNeeded ? '/setup' : `/login?next=${encodeURIComponent(here())}`, { replace: true });
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
    navigate(`/login?next=${encodeURIComponent(here())}`, { replace: true });
  });
  // Someone else signed in in another tab (api.js found it on a change): this tab is theirs now.
  api.onSessionChanged(async (session) => {
    toast(`${session.user?.username || 'Someone else'} signed in on this browser, in another tab: this page shows their account now.`, { kind: 'error' });
    await loadSession().catch(() => { state.session = null; });
    await loadSystem();
    updateShell();
    render();
  });
  window.addEventListener('hashchange', onHashChange);
  document.addEventListener('click', onLinkClick);
  await loadSession().catch(() => { state.session = null; });
  if (state.session) await loadSystem();
  // This entry's place: its own after a reload, else the first.
  if (!location.hash || location.hash === '#' || location.hash === '#/') history.replaceState(history.state, '', '#/live');
  mark(placeOf(history.state) ?? 0);
  await render();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
