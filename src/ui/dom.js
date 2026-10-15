// The admin UI's building blocks. Pages build DOM with h() (text is always text, never HTML), and
// use these for the things every page needs the same way: dialogs, menus, toasts, previews,
// copying, busy buttons, time. See README.md for the conventions.

// h('button.btn.primary', { onclick, type: 'button', 'aria-label': … }, 'Save', child, [more])
// A tag may carry classes after dots and an id after #. Attributes: on* are listeners, class,
// dataset ({}), hidden/disabled/checked… booleans, value/selected properties; null/false skip.
export function h(spec, attrs, ...children) {
  if (attrs === null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs !== undefined && attrs !== null) children.unshift(attrs);
    attrs = {};
  }
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(spec) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') for (const c of String(v).split(/\s+/).filter(Boolean)) el.classList.add(c);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'indeterminate') el[k] = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// Replace an element's children.
export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// q(selector, root): one element or null (H17: callers tolerate null).
export const q = (sel, root = document) => root.querySelector(sel);

// ---- toasts --------------------------------------------------------------------------------
// toast('Scene changed to BRB') · toast(err) for an error (its detail says what to do).
export function toast(message, { kind, ms } = {}) {
  const host = q('[data-toasts]');
  if (!host) return;
  const isError = message instanceof Error || kind === 'error';
  const text = message instanceof Error ? message.message : String(message);
  const el = h('div.toast', { class: isError ? 'error' : undefined, role: isError ? 'alert' : undefined }, h('span', text), h('button', { type: 'button', 'aria-label': 'Dismiss', onclick: () => el.remove() }, '✕'));
  host.append(el);
  setTimeout(() => el.remove(), ms ?? (isError ? 8000 : 3500));
}

// ---- dialogs -------------------------------------------------------------------------------
// The control the user last focused or pressed: the one that opened a dialog, even when run() has
// disabled it meanwhile (a disabled button loses the focus) or the browser doesn't focus a button
// on a click (Safari).
let lastControl;
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => { lastControl = e.target; });
  document.addEventListener('pointerdown', (e) => {
    const c = e.target?.closest?.('button, summary, a[href], input, select, textarea');
    if (c) lastControl = c;
  }, true);
}
const invokerNow = () => (document.activeElement && document.activeElement !== document.body ? document.activeElement : lastControl);

// Where the focus goes back to when a dialog closes (WCAG 2.4.3): the control that opened it. A
// button still busy with what the dialog started (run() disables it) gets it once it is enabled
// again; an item of a closed menu, the menu's button; one that is gone (the page redrew), the
// page. Not if the focus has moved on meanwhile (the page focused a field of its own).
function returnFocus(invoker) {
  const lost = () => !document.activeElement || document.activeElement === document.body;
  const page = () => q('[data-view]')?.focus({ preventScroll: true });
  let tries = 0;
  const attempt = () => {
    if (!lost()) return;
    if (!invoker || invoker === document.body || !invoker.isConnected) { page(); return; }
    if (!invoker.disabled) {
      invoker.focus({ preventScroll: true });
      if (document.activeElement !== invoker) {
        const summary = invoker.closest?.('details.menu')?.querySelector('summary');
        if (summary) summary.focus({ preventScroll: true });
        else page();
      }
      return;
    }
    if (++tries < 100) setTimeout(attempt, 100); // up to 10 s for the request it started
    else page();
  };
  attempt();
}

// For a page's own <dialog>: call when it opens; the function it returns, when it closes.
export function focusBack() {
  const invoker = invokerNow();
  return () => returnFocus(invoker);
}

// dialog({ title, body, actions: [{ label, value, kind }], describe }) → the chosen value, or
// undefined. describe: the body is what the dialog is about, read with its title (a confirmation's
// consequence); leave it off for a long body, a form or a plan.
export function dialog({ title, body, actions = [{ label: 'OK', value: true, kind: 'primary' }], dismissable = true, describe = false }) {
  const invoker = invokerNow();
  return new Promise((resolve) => {
    const id = `dlg-${Math.random().toString(36).slice(2)}`;
    let result;
    const d = h('dialog', { 'aria-labelledby': id, 'aria-describedby': describe ? `${id}-desc` : undefined },
      h('div.dialog-body', h('h2', { id }, title), describe ? h('div', { id: `${id}-desc` }, body) : body),
      h('div.form-actions', actions.map((a) => h('button.btn', {
        type: 'button', class: a.kind, onclick: () => { result = a.value; d.close(); },
      }, a.label))));
    d.addEventListener('cancel', (e) => { if (!dismissable) e.preventDefault(); });
    d.addEventListener('close', () => { d.remove(); returnFocus(invoker); resolve(result); });
    document.body.append(d);
    d.showModal();
    // Focus the safe choice first, so Enter doesn't destroy anything.
    d.querySelector('.form-actions .btn')?.focus();
  });
}

// confirm({ title, consequence, confirmLabel, danger }) → true when confirmed. Every destructive
// confirmation names its consequence (08 §8.8, H20), and a screen reader reads it with the title.
export async function confirm({ title, consequence, confirmLabel = 'Confirm', danger = true }) {
  const body = typeof consequence === 'string' ? h('p', consequence) : consequence;
  const value = await dialog({ title, body, describe: true, actions: [{ label: 'Cancel', value: false }, { label: confirmLabel, value: true, kind: danger ? 'danger' : 'primary' }] });
  return value === true;
}

// form dialog: prompt({ title, fields: [{ name, label, type, value, hint, required }], submitLabel })
// → { name: value } or undefined.
export function prompt({ title, intro, fields, submitLabel = 'Save' }) {
  const invoker = invokerNow();
  return new Promise((resolve) => {
    const id = `dlg-${Math.random().toString(36).slice(2)}`;
    let result;
    const inputs = {};
    const form = h('form', { method: 'dialog' },
      h('div.dialog-body', h('h2', { id }, title), intro ? h('p.muted', intro) : null,
        fields.map((f) => {
          const fid = `${id}-${f.name}`;
          const input = f.type === 'select'
            ? h('select', { id: fid, name: f.name }, (f.options || []).map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)))
            : f.type === 'textarea'
              ? h('textarea', { id: fid, name: f.name, value: f.value ?? '', required: f.required })
              : h('input', { id: fid, name: f.name, type: f.type || 'text', value: f.value ?? '', required: f.required, autocomplete: f.autocomplete || 'off', placeholder: f.placeholder, pattern: f.pattern, inputmode: f.inputmode });
          inputs[f.name] = input;
          return h('div.field', h('label', { for: fid }, f.label), input, f.hint ? h('span.hint', f.hint) : null);
        })),
      h('div.form-actions',
        h('button.btn', { type: 'button', onclick: () => d.close() }, 'Cancel'),
        h('button.btn.primary', { type: 'submit' }, submitLabel)));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      result = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
      d.close();
    });
    const d = h('dialog', { 'aria-labelledby': id }, form);
    d.addEventListener('close', () => { d.remove(); returnFocus(invoker); resolve(result); });
    document.body.append(d);
    d.showModal();
    Object.values(inputs)[0]?.focus();
  });
}

// ---- menus ---------------------------------------------------------------------------------
// menu('More', [{ label, onSelect, danger, disabled }], { ariaLabel }) — a menu button: opening it
// focuses its first item, the arrow keys, Home and End move among them, Escape closes. Destructive
// actions live in one, never as a top-level button a thumb can hit mid-show (08 §8.1, H20).
// ariaLabel tells a list of "More" buttons apart ("More for clip.mp4").
export function menu(label, items, { buttonClass = 'btn', ariaLabel } = {}) {
  const det = h('details.menu');
  const list = h('div.menu-list', { role: 'menu' });
  const summary = h('summary', { class: buttonClass, 'aria-haspopup': 'menu', 'aria-label': ariaLabel }, label);
  for (const item of items.filter(Boolean)) {
    list.append(h('button', {
      type: 'button', role: 'menuitem', class: item.danger ? 'danger' : undefined, disabled: item.disabled,
      // The focus goes to the menu's button before the menu closes (a closed menu's item can't
      // hold it), so a confirmation it opens hands the focus back there.
      onclick: () => { summary.focus(); det.open = false; item.onSelect(); },
    }, item.label));
  }
  det.append(summary, list);
  // The items that can be chosen now (a menu may hide or disable some).
  const choices = () => [...list.querySelectorAll('[role="menuitem"]')].filter((b) => !b.hidden && !b.disabled);
  det.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && det.open) {
      det.open = false;
      summary.focus();
      return;
    }
    // Arrow keys move among the items (the menu pattern); on the closed menu's button, open it.
    if (!det.open) {
      if (e.target === summary && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        det.open = true; // its toggle focuses the first item
      }
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const all = choices();
    if (!all.length) return;
    const at = all.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1
      : e.key === 'ArrowDown' ? (at + 1) % all.length : (at <= 0 ? all.length - 1 : at - 1);
    all[next].focus();
  });
  det.addEventListener('toggle', () => {
    if (!det.open) return;
    place(det, list);
    choices()[0]?.focus();
  });
  return det;
}

// A menu's list opens under its button, on the side with room, and stays on the screen (a "More"
// at the left edge of a phone would otherwise open off it). Measured when it opens (CSSOM).
function place(det, list) {
  const gap = 8;
  list.style.left = '';
  list.style.right = '';
  list.style.maxWidth = `${Math.max(0, innerWidth - gap * 2)}px`;
  const button = det.getBoundingClientRect();
  const width = list.getBoundingClientRect().width;
  // Its right edge under the button's (styles.css), unless that runs off the left: then its left
  // edge under the button's; and never past either side.
  let left = button.right - width < gap ? button.left : button.right - width;
  left = Math.min(left, innerWidth - gap - width);
  left = Math.max(left, gap);
  list.style.right = 'auto';
  list.style.left = `${Math.round(left - button.left)}px`;
}

// A click outside an open menu closes it. One listener for every menu, so a page left with a
// menu open leaves nothing behind.
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    for (const det of document.querySelectorAll('details.menu[open]')) if (!det.contains(e.target)) det.open = false;
  });
}

// ---- busy buttons --------------------------------------------------------------------------
// run(button, async () => …, { done: 'Scene changed to BRB' }): disables the button while the
// request runs (no double fire from a double tap), toasts the outcome. Resolves with fn's value,
// or undefined when it failed (already shown).
export async function run(button, fn, { done, onError } = {}) {
  if (button) {
    if (button.disabled) return undefined;
    button.disabled = true;
    button.classList.add('busy');
    button.setAttribute('aria-busy', 'true');
  }
  try {
    const out = await fn();
    if (done) toast(typeof done === 'function' ? done(out) : done);
    return out;
  } catch (err) {
    if (onError) onError(err);
    else toast(err);
    return undefined;
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove('busy');
      button.removeAttribute('aria-busy');
    }
  }
}

// ---- copying -------------------------------------------------------------------------------
export async function copy(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older Safari, or not a secure context: select a hidden field and copy it.
    const ta = h('textarea', { readonly: true, 'aria-hidden': 'true', class: 'sr-only' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    if (!ok) { toast('Copying is blocked here: select the text and copy it yourself.', { kind: 'error' }); return false; }
  }
  toast(what);
  return true;
}

// copyField(value, label): a read-only field with a Copy button.
export function copyField(value, { label = 'Copy', copied = 'Copied', id } = {}) {
  const input = h('input', { type: 'text', readonly: true, value, id, onfocus: (e) => e.target.select() });
  return h('div.copy-field', input, h('button.btn', { type: 'button', onclick: () => copy(input.value, copied) }, label));
}

// ---- previews (H13) ------------------------------------------------------------------------
// The device: a phone gets lite previews, loaded on tap.
export const isPhone = () => matchMedia('(max-width: 759.98px), (pointer: coarse)').matches;

// preview(url, { width, height, label, eager }): an overlay page scaled into a box of its aspect.
// On a phone it starts as a "Tap to preview" button and loads lite (H13); elsewhere it loads at
// once unless eager is false. A framed overlay knows it is a preview (sk.js); the URL may add
// 04 §4.9 overrides: canvas, scene, mock=1, settings=<base64 JSON>, bg=dark.
// Returns the element; .unload() removes the frame, .reload(url?) loads it again.
export function preview(url, { width = 1920, height = 1080, label, eager, title = 'Overlay preview' } = {}) {
  const phone = isPhone();
  const shape = width > height ? 'h' : width < height ? 'v' : 'sq';
  const box = h('div.preview', { class: shape });
  // A tall preview capped at 70vh keeps its shape: narrower, not clipped.
  if (height > width) box.style.maxWidth = `calc(70vh * ${width / height})`;
  if (label) box.append(h('span.badge.label', label));
  const srcOf = (raw) => {
    const u = new URL(raw, location.origin);
    if (phone) u.searchParams.set('lite', '1');
    return u.pathname + u.search;
  };
  let src = srcOf(url);
  let frame;
  let observer;
  const fit = () => {
    if (!frame) return;
    const scale = box.clientWidth / width;
    frame.style.transform = `scale(${scale})`;
  };
  const load = () => {
    box.querySelector('.tap')?.remove();
    frame = h('iframe', { src, title, width, height, loading: 'lazy', tabindex: '-1', referrerpolicy: 'same-origin' });
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    box.append(frame);
    observer = new ResizeObserver(fit);
    observer.observe(box);
    fit();
  };
  if (eager === false || (phone && eager !== true)) {
    // Named with the preview's title, so several "Show preview" buttons on a page are told apart.
    const text = phone ? 'Tap to preview' : 'Show preview';
    box.append(h('button.tap', { type: 'button', onclick: load, 'aria-label': `${text}: ${title}` }, h('span', text)));
  } else {
    load();
  }
  box.unload = () => {
    observer?.disconnect();
    frame?.remove();
    frame = undefined;
  };
  box.reload = (next) => {
    if (next) src = srcOf(next);
    if (frame) frame.src = src;
  };
  return box;
}

// settingsParam(values): ?settings= for a preview of unsaved settings (04 §4.9).
export function settingsParam(values) {
  const bytes = new TextEncoder().encode(JSON.stringify(values));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---- time ----------------------------------------------------------------------------------
// Countdowns run in server time (08 §8.4): serverNow() in api.js.

// "in 4:05", "2:31:10", "-0:12" for a countdown to ms.
export function countdown(ms) {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const hh = Math.floor(s / 3600);
  s -= hh * 3600;
  const mm = Math.floor(s / 60);
  const ss = s - mm * 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${neg ? '-' : ''}${hh ? `${hh}:${pad(mm)}` : mm}:${pad(ss)}`;
}

// A time of day in a zone: "9:30 PM".
export function clock(iso, timeZone) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleTimeString();
  }
}

// "3 minutes ago" / "in 2 hours".
export function ago(iso) {
  if (!iso) return '';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  for (const [unit, s] of units) if (Math.abs(diff) >= s || unit === 'second') return rtf.format(Math.round(diff / s), unit);
  return '';
}

export function bytes(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

// ---- polling -------------------------------------------------------------------------------
// every(ms, fn): runs fn now and every ms while the page is visible; a failing fn keeps the
// schedule. Returns a stop function.
export function every(ms, fn) {
  let timer;
  let stopped = false;
  let running = false; // a tick in flight: the tab shown again meanwhile must not start a second loop
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      if (document.visibilityState !== 'hidden') await fn();
    } catch (err) {
      console.warn(err);
    } finally {
      running = false;
    }
    if (!stopped) timer = setTimeout(tick, ms);
  };
  const onVisible = () => { if (document.visibilityState === 'visible' && !stopped) { clearTimeout(timer); tick(); } };
  document.addEventListener('visibilitychange', onVisible);
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

// ---- small pieces --------------------------------------------------------------------------
export const empty = (title, text, ...actions) => h('div.empty', h('h2', title), text ? h('p', text) : null, actions.length ? h('div.row', { class: 'center' }, actions) : null);
export const notice = (text, kind) => h('div.notice', { class: kind, role: kind === 'danger' ? 'alert' : undefined }, text);
export const badge = (text, kind) => h('span.badge', { class: kind }, text);
export const statusDot = (kind, label) => h('span.dot', { class: kind, role: 'img', 'aria-label': label });
export function pageHead(title, { crumbs, actions = [] } = {}) {
  return h('div.page-head',
    h('div', crumbs ? h('div.crumbs', crumbs.map((c, i) => [i ? ' / ' : '', c.href ? h('a', { href: c.href }, c.label) : c.label])) : null, h('h1', title)),
    actions.length ? h('div.actions', actions) : null);
}

// tabs([{ id, label, render: (panel) => cleanup? }], { selected, onChange }): an accessible tab list.
export function tabs(list, { selected = list[0]?.id, onChange } = {}) {
  const bar = h('div.tabs', { role: 'tablist' });
  const panel = h('div', { role: 'tabpanel' });
  let cleanup;
  const select = (id) => {
    for (const b of bar.children) b.setAttribute('aria-selected', String(b.dataset.id === id));
    cleanup?.();
    panel.replaceChildren();
    const t = list.find((x) => x.id === id) || list[0];
    panel.setAttribute('aria-labelledby', `tab-${t.id}`);
    cleanup = t.render(panel);
    onChange?.(t.id);
  };
  for (const t of list) bar.append(h('button', { type: 'button', role: 'tab', id: `tab-${t.id}`, dataset: { id: t.id }, onclick: () => select(t.id) }, t.label));
  bar.addEventListener('keydown', (e) => {
    const btns = [...bar.children];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const next = e.key === 'ArrowRight' ? btns[(i + 1) % btns.length] : e.key === 'ArrowLeft' ? btns[(i - 1 + btns.length) % btns.length] : null;
    if (next) { next.focus(); select(next.dataset.id); }
  });
  select(selected);
  const root = h('div', bar, panel);
  root.destroy = () => cleanup?.();
  return root;
}

// field(label, input, { hint, id }): a labelled control.
let fieldSeq = 0;
export function field(label, input, { hint, error } = {}) {
  if (!input.id) input.id = `f${++fieldSeq}`;
  const hintEl = hint ? h('span.hint', { id: `${input.id}-hint` }, hint) : null;
  if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
  const isCheck = input.type === 'checkbox';
  return h('div.field', { class: isCheck ? 'check' : undefined },
    isCheck ? [input, h('label', { for: input.id }, label)] : [h('label', { for: input.id }, label), input],
    hintEl, error ? h('span.error', error) : null);
}
