// The settings form (04 §4.3, 08 §8.3), generated from a template's settings schema: templates never
// ship a settings UI of their own. It accepts and refuses what the platform does
// (src/templates/settings.js): types, choices, lengths in characters (never more than 4096),
// ranges, patterns, the colour / date / time / https formats, media values, list sizes, and the
// 24 KiB limit on what is saved.
//
//   const form = schemaForm({ schema, definitions, values, resolved, onChange, mediaList });
//   form.el          the fields, in a <div> (no buttons: the page adds Save and Reset)
//   form.values()    only what the operator set: an emptied field is left out, so its default, or
//                    the live value it follows (x-skp-bind), applies again
//   form.validate()  [] or [{ path, message }] (JSON pointers, as the API's); marks the fields
//   form.reset(values)  shows these values; reset(values, resolved) also takes what the overlay
//                    now sees, for the placeholders
//
// What applies when a field is empty shows as its placeholder (or, for a date or time, under it).
// A switch or a list can't be emptied: once set, it has a "Use default" button. A choice list has a
// "Default: …" option. Fields of one x-skp-group share a collapsible section (details.group); a
// nested object is a fieldset. Anything the form doesn't understand is edited as plain text, with
// a note; nothing in a schema makes it throw (H17).
import { dialog, field, h, mount, notice } from './dom.js';

// What a settings schema may use (04 §4.3; settings.js KEYWORDS); x-skp-* extensions besides.
const KEYWORDS = new Set([
  '$ref', 'type', 'title', 'description', 'default', 'enum', 'examples',
  'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format',
  'items', 'minItems', 'maxItems', 'uniqueItems',
  'properties', 'additionalProperties',
]);
const QUIET = new Set(['$comment', '$schema', '$id']); // annotations that change nothing on a form
const PRIMITIVES = new Set(['string', 'number', 'integer', 'boolean']);
const TYPES = new Set([...PRIMITIVES, 'array', 'object']);
const MAX_VALUE_LENGTH = 4096; // no setting value is longer, whatever maxLength says
const SAVED_BYTES = 24 * 1024; // what an operator saves, as UTF-8 JSON
const MAX_GROUP_DEPTH = 3;
const FONTS = ['system-ui', 'sans-serif', 'serif', 'monospace', 'Arial', 'Helvetica', 'Verdana', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Courier New', 'Impact'];
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
const UNSUPPORTED_NOTE = 'This form can\'t show this setting properly, so it is edited as plain text.';

// ---- what the platform accepts (src/schema.js FORMATS, src/templates/settings.js) -------------
const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const parses = (s) => { try { new URL(s); return true; } catch { return false; } }; // eslint-disable-line no-new
const isUri = (s) => /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]*$/.test(s) && parses(s);
const isHttps = (s) => s.length <= 2048 && /^https:\/\/[^\s]+$/i.test(s) && isUri(s);
const MEDIA_PATH = /^\/media\/[A-Za-z0-9_-]{1,64}\/(?!\.{1,2}$)[^/\\?#%\s]{1,255}$/;
const isMedia = (s) => MEDIA_PATH.test(s) || isHttps(s);
function validDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
const FORMATS = {
  color: (s) => COLOR.test(s),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && validDate(s),
  time: (s) => /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s),
  uri: isHttps,
};
const FORMAT_MESSAGES = {
  color: 'Enter a colour code like #16E0FF.',
  date: 'Enter a date like 2026-10-31.',
  time: 'Enter a time like 21:30.',
  uri: 'Enter a web address that starts with https://',
};

// ---- small helpers ---------------------------------------------------------------------------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
const pointer = (path) => path.map((k) => `/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('') || '/';
const getPath = (o, path) => path.reduce((x, k) => (own(x, k) ? x[k] : undefined), o);
const hasPath = (o, path) => {
  let x = o;
  for (const k of path) {
    if (!own(x, k)) return false;
    x = x[k];
  }
  return true;
};
const css = (el, styles) => { Object.assign(el.style, styles); return el; };
let seq = 0;
const uid = (what) => `sf${++seq}-${what}`;
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v));

function equal(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => own(b, k) && equal(a[k], b[k]));
}

const regexes = new Map();
function regex(source) {
  if (!regexes.has(source)) {
    let re = null;
    try { re = new RegExp(source, 'u'); } catch { re = null; } // refused at install; never fatal here
    if (regexes.size > 200) regexes.clear();
    regexes.set(source, re);
  }
  return regexes.get(source);
}

// "lineClip" → "Line clip".
function humanize(key) {
  const s = String(key).replace(/[_.-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Setting';
}
const words = (key) => humanize(key).toLowerCase();

// "Follows the show's headliner unless you set it."
const SHOW_WORDS = new Map([['currentSlot', 'current act'], ['goLiveAt', 'go-live time'], ['recStartedAt', 'recording start']]);
const LIVE_WORDS = new Map([['viewers.total', 'the viewer count'], ['music.nowPlaying', 'the track playing now'], ['obs.scene', 'the OBS scene']]);
function bindNote(key) {
  if (key.startsWith('show.')) {
    const rest = key.slice(5);
    return `Follows the show's ${SHOW_WORDS.get(rest) || words(rest)} unless you set it.`;
  }
  return `Follows ${LIVE_WORDS.get(key) || `the live ${words(key)}`} unless you set it.`;
}

const labelOf = (s, key) => {
  const title = isObj(s) && typeof s.title === 'string' && s.title.trim() ? s.title.trim() : humanize(key);
  const unit = isObj(s) && typeof s['x-skp-unit'] === 'string' && s['x-skp-unit'].trim() ? s['x-skp-unit'].trim() : '';
  return unit ? `${title} (${unit})` : title;
};

// Whether a file a media field names is an image (to show it): its type when the media list said,
// else its name.
const fileName = (v) => { try { return decodeURIComponent(v.split('/').pop() || v); } catch { return v; } };

// accept ("image/*", "video/mp4,image/*", ".png") against a file's type and URL.
function accepts(accept, m) {
  if (!accept) return true;
  const type = typeof m.type === 'string' ? m.type.toLowerCase() : '';
  return accept.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean).some((a) => {
    if (a.startsWith('.')) return m.url.toLowerCase().endsWith(a);
    if (!type) return true;
    return a.endsWith('/*') ? type.startsWith(a.slice(0, -1)) : a === type;
  });
}
const acceptWords = (accept) => accept.split(',').map((a) => a.trim()).filter(Boolean)
  .map((a) => ({ 'image/*': 'images', 'video/*': 'videos', 'audio/*': 'audio' }[a.toLowerCase()] || a)).join(' or ');

// #abc, #abcd, #aabbcc, #aabbccdd → #aabbcc (what <input type=color> takes), else undefined.
function hex6(c) {
  if (typeof c !== 'string' || !COLOR.test(c)) return undefined;
  let x = c.slice(1);
  if (x.length <= 4) x = [...x.slice(0, 3)].map((d) => d + d).join('');
  return `#${x.slice(0, 6).toLowerCase()}`;
}
// The picker's #rrggbb, keeping the alpha the field had.
function withAlpha(hex, prev) {
  const m = /^#(?:[0-9a-f]{3}([0-9a-f])|[0-9a-f]{6}([0-9a-f]{2}))$/i.exec(typeof prev === 'string' ? prev : '');
  const alpha = m ? (m[1] ? m[1] + m[1] : m[2]) : '';
  return `${hex}${alpha}`.toUpperCase();
}

// A field schema's problem with a value, in plain words, or undefined. Refuses exactly what the
// server's validateSettings does for one field (same checks, same limits).
function checkValue(s, v) {
  switch (s.type) {
    case 'string': if (typeof v !== 'string') return 'Enter text here.'; break;
    case 'number': if (typeof v !== 'number' || !Number.isFinite(v)) return 'Enter a number.'; break;
    case 'integer': if (!Number.isInteger(v)) return 'Enter a whole number.'; break;
    case 'boolean': if (typeof v !== 'boolean') return 'Turn this on or off.'; break;
    default: return undefined;
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => equal(e, v))) return 'Choose one of the options.';
  if (typeof v === 'string') {
    const n = [...v].length; // characters (code points), as the server counts
    const max = Math.min(typeof s.maxLength === 'number' ? s.maxLength : Infinity, MAX_VALUE_LENGTH);
    if (typeof s.minLength === 'number' && n < s.minLength) return `Use at least ${s.minLength} characters.`;
    if (n > max) return `Use at most ${max} characters (this has ${n}).`;
    if (typeof s.pattern === 'string') {
      const re = regex(s.pattern);
      if (re && !re.test(v)) {
        if (s['x-skp-widget'] === 'media' && /^\^(\\\/|\/)media/.test(s.pattern)) return 'Choose one of your uploaded files: a web address can\'t be used here.';
        const example = Array.isArray(s.examples) && s.examples.length ? ` (for example: ${show(s.examples[0])})` : '';
        return `This doesn't fit the form this setting needs${example}.`;
      }
    }
    if (typeof s.format === 'string' && own(FORMATS, s.format) && !FORMATS[s.format](v)) return FORMAT_MESSAGES[s.format];
  }
  if (typeof v === 'number') {
    const lo = typeof s.minimum === 'number' ? s.minimum : undefined;
    const hi = typeof s.maximum === 'number' ? s.maximum : undefined;
    if ((lo !== undefined && v < lo) || (hi !== undefined && v > hi)) {
      return lo !== undefined && hi !== undefined ? `Enter a number from ${lo} to ${hi}.` : lo !== undefined ? `Enter ${lo} or more.` : `Enter ${hi} or less.`;
    }
  }
  if (s['x-skp-widget'] === 'media' && typeof v === 'string' && !isMedia(v)) return 'Choose an uploaded file, or paste a web address that starts with https://';
  return undefined;
}

// $ref → its schema, inside the manifest's definitions ("#/definitions/…"). A title or description
// beside the $ref labels the field. Undefined when it points at nothing or loops.
function dereferencer(definitions) {
  // The definitions; or a whole manifest, passed instead (then tried first: its own "definitions").
  const roots = own(definitions, 'definitions') ? [definitions, { definitions }] : [{ definitions }, definitions];
  const lookup = (ref) => {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
    let parts;
    try { parts = ref.slice(2).split('/').map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~')); } catch { return undefined; }
    for (const root of roots) {
      let node = root;
      let ok = true;
      for (const p of parts) {
        if (Array.isArray(node) && /^(0|[1-9]\d*)$/.test(p) && Number(p) < node.length) node = node[Number(p)];
        else if (own(node, p)) node = node[p];
        else { ok = false; break; }
      }
      if (ok) return node;
    }
    return undefined;
  };
  return (schema) => {
    let s = schema;
    const label = {};
    for (let hops = 0; isObj(s) && s.$ref !== undefined; hops++) {
      if (hops >= 8) return undefined;
      for (const k of ['title', 'description']) if (typeof s[k] === 'string' && label[k] === undefined) label[k] = s[k];
      s = lookup(s.$ref);
    }
    return isObj(s) && Object.keys(label).length ? { ...s, ...label } : s;
  };
}

// Whether the form can't render a schema properly (it then edits it as plain text).
function unsupported(s, deref) {
  if (!isObj(s)) return true;
  for (const k of Object.keys(s)) if (!k.startsWith('x-skp-') && !KEYWORDS.has(k) && !QUIET.has(k)) return true;
  if (!TYPES.has(s.type)) return true;
  if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length || s.type === 'array' || s.type === 'object')) return true;
  if (s.type === 'object' && !isObj(s.properties)) return true;
  if (s.type === 'array') {
    const items = deref(s.items);
    if (!isObj(items) || !PRIMITIVES.has(items.type) || unsupported(items, deref)) return true;
  }
  return false;
}

// A form that shows a note instead of fields, and keeps the saved values as they are.
function stillForm(values, text) {
  let kept = isObj(values) ? values : {};
  const el = h('div.settings-form', text);
  return { el, values: () => structuredClone(kept), validate: () => [], reset: (v) => { kept = isObj(v) ? v : {}; } };
}

export function schemaForm(options) {
  try {
    return create(isObj(options) ? options : {});
  } catch (err) {
    // H17: a schema this form trips over still leaves the page usable.
    console.error(err);
    return stillForm(options?.values, notice('These settings can\'t be shown here, so they can\'t be changed right now. The overlay keeps the ones it has.', 'warn'));
  }
}

function create({ schema, definitions, values, resolved, onChange, mediaList }) {
  const deref = dereferencer(definitions);
  const root = deref(schema);
  if (!isObj(root) || !Object.keys(root).length || (root.type === 'object' && isObj(root.properties) && !Object.keys(root.properties).length)) {
    return stillForm(values, h('p.muted', 'This template has no settings to change.'));
  }
  if (root.type !== 'object' || !isObj(root.properties)) {
    return stillForm(values, notice('This template\'s settings can\'t be shown here. Its overlay keeps working with the settings it has.', 'warn'));
  }

  const mediaTypes = new Map(); // url → type, from mediaList()
  const registry = new Map(); // pointer → { label, el }, for validate()
  // What the overlay sees (`seen`) is known for a field only if `seenWith`, the saved values it was
  // resolved with, didn't set it: otherwise it is that saved value, not what an empty field gets.
  let seen = isObj(resolved) ? resolved : {};
  let seenWith = isObj(values) ? values : {};
  const el = h('div.settings-form');
  const message = h('div', { 'aria-live': 'polite' });

  const form = {
    el,
    values() {
      const r = top.get();
      return r.set ? r.value : {};
    },
    validate,
    reset(next, nextResolved) {
      const v = isObj(next) ? next : {};
      if (isObj(nextResolved)) { seen = nextResolved; seenWith = v; }
      load(v);
      mount(message);
    },
  };
  const fire = (live) => { if (typeof onChange === 'function') onChange(form.values(), { live }); };

  // What applies when a field is left empty: what the overlay sees now, when that isn't a saved
  // value; else, for a field bound to a live value, unknown; else its default.
  function fallbackOf(path, s) {
    const r = getPath(seen, path);
    if (r !== undefined && !hasPath(seenWith, path)) return r;
    if (typeof s['x-skp-bind'] === 'string') return undefined;
    return s.default;
  }

  const refreshAll = () => refresh(top);
  const top = container(root, [], 0);
  el.append(...top.body, message);
  load(isObj(values) ? values : {});
  return form;

  function load(v) {
    top.fallback();
    top.set(v);
    refresh(top);
  }

  // ---- validation ----------------------------------------------------------------------------
  function validate() {
    const problems = top.validate(true);
    const hidden = [];
    for (const p of problems) {
      const entry = registry.get(p.path) || registry.get(p.path.replace(/\/[^/]*$/, ''));
      if (!entry) continue;
      // Open the sections it is in, so the mark can be seen.
      for (let d = entry.el.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
      if (entry.el.closest('[hidden]') && !hidden.includes(entry.label)) hidden.push(entry.label);
    }
    const notes = [];
    if (hidden.length) notes.push(`${hidden.join(', ')} ${hidden.length === 1 ? 'needs' : 'need'} fixing too, but another setting hides ${hidden.length === 1 ? 'it' : 'them'}: change that setting to see ${hidden.length === 1 ? 'it' : 'them'}.`);
    let bytes = 0;
    try { bytes = new TextEncoder().encode(JSON.stringify(form.values())).length; } catch { bytes = 0; }
    if (bytes > SAVED_BYTES) {
      const text = 'These settings are too long to save. Shorten some of the text or the lists.';
      problems.push({ path: '/', message: text });
      notes.push(text);
    }
    mount(message, notes.length ? notice(notes.join(' '), 'danger') : null);
    return problems;
  }

  function mark(targets, text) {
    for (const t of targets) {
      if (text) t.setAttribute('aria-invalid', 'true');
      else t.removeAttribute('aria-invalid');
    }
  }
  function describe(input, ids) {
    const list = ids.filter(Boolean);
    if (list.length) input.setAttribute('aria-describedby', list.join(' '));
    else input.removeAttribute('aria-describedby');
  }

  // ---- showIf, sections ----------------------------------------------------------------------
  function refresh(c) {
    for (const n of c.nodes) {
      const cond = n.cond;
      let visible = true;
      if (isObj(cond) && typeof cond.field === 'string' && c.byKey.has(cond.field) && c.byKey.get(cond.field) !== n) {
        const current = c.byKey.get(cond.field).current();
        visible = own(cond, 'equals') ? equal(current, cond.equals) : Boolean(current);
      }
      n.el.hidden = !visible;
      if (n.inner) refresh(n.inner);
    }
    for (const sec of c.sections) {
      sec.el.hidden = sec.nodes.every((n) => n.el.hidden);
      const k = sec.nodes.reduce((a, n) => a + n.count(), 0);
      sec.count.textContent = `${k} changed`;
      sec.count.hidden = !k;
    }
  }

  function section(name) {
    const sign = h('span', { 'aria-hidden': 'true' }, '▸');
    const count = h('span.badge', { hidden: true });
    const body = h('div.group-body');
    const det = h('details.group', h('summary', sign, h('span', name), count), body);
    css(sign, { width: '1.4em', flex: 'none' });
    css(count, { marginLeft: 'auto' });
    det.addEventListener('toggle', () => { sign.textContent = det.open ? '▾' : '▸'; });
    return { name, el: det, body, count, nodes: [] };
  }

  // ---- objects: the settings object, and nested groups ---------------------------------------
  function container(s, path, depth) {
    const nodes = [];
    const byKey = new Map();
    const sections = [];
    const body = [];
    for (const [key, raw] of Object.entries(s.properties)) {
      const fs = deref(raw);
      const at = [...path, key];
      const node = isObj(fs) && fs.type === 'object' && depth < MAX_GROUP_DEPTH && !unsupported(fs, deref)
        ? groupNode(fs, at, key, depth + 1)
        : fieldNode(fs, at, key, raw);
      nodes.push(node);
      byKey.set(key, node);
      const name = isObj(fs) && typeof fs['x-skp-group'] === 'string' ? fs['x-skp-group'].trim() : '';
      if (name) {
        let sec = sections.find((x) => x.name === name);
        if (!sec) {
          sec = section(name);
          sections.push(sec);
          body.push(sec.el);
        }
        sec.nodes.push(node);
        sec.body.append(node.el);
      } else {
        body.push(node.el);
      }
    }
    return {
      nodes, byKey, sections, body,
      get() {
        const out = {};
        for (const n of nodes) {
          const r = n.get();
          if (r.set) out[n.key] = r.value;
        }
        return Object.keys(out).length ? { set: true, value: out } : { set: false };
      },
      set(v) { for (const n of nodes) n.set(own(v, n.key) ? v[n.key] : undefined); },
      current() {
        const out = {};
        for (const n of nodes) {
          const c = n.current();
          if (c !== undefined) out[n.key] = c;
        }
        return out;
      },
      fallback() { for (const n of nodes) n.fallback(); },
      validate(showMarks) { return nodes.flatMap((n) => n.validate(showMarks)); },
      count() { return nodes.reduce((a, n) => a + n.count(), 0); },
    };
  }

  function groupNode(s, path, key, depth) {
    const inner = container(s, path, depth);
    const label = labelOf(s, key);
    const el = h('fieldset', h('legend', label), typeof s.description === 'string' && s.description ? h('p.muted.small', s.description) : null, inner.body);
    css(el, { minWidth: '0' });
    registry.set(pointer(path), { label, el });
    return {
      key, el, inner, cond: s['x-skp-showIf'],
      get: inner.get, set: inner.set, current: inner.current, fallback: inner.fallback, validate: inner.validate, count: inner.count,
    };
  }

  // ---- one field -----------------------------------------------------------------------------
  function fieldNode(s, path, key, raw) {
    const sch = isObj(s) ? s : {};
    // A group nested deeper than a settings form goes (refused at install) is text too.
    const why = unsupported(s, deref) || sch.type === 'object';
    // A $ref that points at nothing still has the title beside it.
    const label = labelOf(isObj(s) ? sch : isObj(raw) ? raw : {}, key);
    if (!why && sch.type === 'array') return listNode(sch, path, key, label);
    const ctl = why ? plainCtl(sch) : control(sch, label, false);
    const bind = !why && typeof sch['x-skp-bind'] === 'string' ? sch['x-skp-bind'] : undefined;
    const liveField = !why && sch['x-skp-preview'] === 'live';
    const here = pointer(path);
    const axis = sch['x-skp-axis'] === 'y' ? 'top' : sch['x-skp-axis'] === 'x' ? 'left' : '';
    const hint = [
      typeof sch.description === 'string' ? sch.description : '',
      !why && sch['x-skp-widget'] === 'position' && axis ? `Pixels from the ${axis} edge.` : '',
    ].filter(Boolean).join(' ');

    const input = ctl.input;
    const wrap = field(label, input, { hint: hint || undefined });
    if (ctl.compose) {
      const next = input.nextSibling; // before compose() moves the input into its box
      wrap.insertBefore(ctl.compose(), next);
    }
    const described = [input.getAttribute('aria-describedby')];
    const addHint = (text) => {
      const span = h('span.hint', { id: uid('hint') }, text);
      wrap.append(span);
      described.push(span.id);
      return span;
    };
    if (bind) addHint(bindNote(bind));
    if (why) addHint(UNSUPPORTED_NOTE);
    const fbHint = ctl.note ? addHint('') : null;
    const err = h('span.error', { id: uid('error'), hidden: true });
    wrap.append(err);
    const resetLabel = bind ? 'Follow the show' : 'Use default';
    const resetBtn = ctl.stateful ? h('button.btn.ghost', {
      type: 'button', hidden: true, 'aria-label': `${resetLabel}: ${label}`,
      onclick: () => { node.set(undefined); refreshAll(); fire(false); input.focus(); },
    }, resetLabel) : null;
    if (wrap.classList.contains('check')) {
      // A switch's whole label is its 44 px target; notes go under it.
      css(wrap, { flexWrap: 'wrap' });
      const lab = wrap.querySelector('label');
      if (lab) css(lab, { minHeight: 'var(--tap)', display: 'inline-flex', alignItems: 'center' });
      if (resetBtn) (lab || input).after(css(resetBtn, { marginLeft: 'auto' }));
      for (const x of wrap.querySelectorAll('.hint, .error')) css(x, { flexBasis: '100%' });
    } else if (resetBtn) {
      wrap.append(css(resetBtn, { alignSelf: 'flex-start' }));
    }
    describe(input, described);
    registry.set(here, { label, el: wrap });

    let isSet = false; // a switch's: it can't be emptied
    let fb;
    let showing = false;
    const read = () => (ctl.stateful && !isSet ? { empty: true } : ctl.read());
    const problems = () => {
      const r = read();
      if (r.bad) return [{ path: here, message: r.bad }];
      if (r.empty || why) return [];
      const m = checkValue(sch, r.value);
      return m ? [{ path: here, message: m }] : [];
    };
    const showError = (text) => {
      err.textContent = text || '';
      err.hidden = !text;
      showing = Boolean(text);
      mark(ctl.marks, text);
      describe(input, text ? [...described, err.id] : described);
    };
    const check = (showMarks) => {
      const p = problems();
      if (showMarks) showError(p[0]?.message);
      return p;
    };
    const after = () => {
      if (resetBtn) resetBtn.hidden = !isSet;
      if (fbHint) {
        const text = read().empty ? ctl.note(fb) : '';
        fbHint.textContent = text;
        fbHint.hidden = !text;
      }
    };

    wrap.addEventListener('input', () => {
      if (ctl.stateful) isSet = true;
      after();
      if (showing) check(true);
      refreshAll();
      if (liveField) fire(true);
    });
    wrap.addEventListener('change', () => {
      if (ctl.stateful) isSet = true;
      after();
      check(true);
      refreshAll();
      fire(false);
    });
    wrap.addEventListener('focusout', (e) => { if (!wrap.contains(e.relatedTarget)) check(true); });

    const node = {
      key, el: wrap, cond: sch['x-skp-showIf'],
      get() {
        const r = read();
        return r.empty || r.bad ? { set: false } : { set: true, value: r.value };
      },
      set(v) {
        if (ctl.stateful) {
          isSet = v !== undefined;
          ctl.write(isSet ? v : fb);
        } else {
          ctl.write(v);
        }
        showError(undefined);
        after();
      },
      current() {
        const r = read();
        return r.empty || r.bad ? fb : r.value;
      },
      fallback() {
        fb = why ? undefined : fallbackOf(path, sch);
        ctl.fallback?.(fb);
        if (ctl.stateful && !isSet) ctl.write(fb);
        after();
      },
      validate: check,
      count: () => (node.get().set ? 1 : 0),
    };
    return node;
  }

  // ---- a list of text, numbers, switches or choices --------------------------------------------
  function listNode(s, path, key, label) {
    const items = deref(s.items);
    const here = pointer(path);
    const bind = typeof s['x-skp-bind'] === 'string' ? s['x-skp-bind'] : undefined;
    const liveField = s['x-skp-preview'] === 'live' || items['x-skp-preview'] === 'live';
    const min = Number.isSafeInteger(s.minItems) && s.minItems > 0 ? s.minItems : undefined;
    const max = Number.isSafeInteger(s.maxItems) ? s.maxItems : undefined;
    let isSet = false;
    let fb;
    let rows = [];
    let showing = false;

    const ul = h('ul.list');
    const status = h('span.hint', { hidden: true });
    const err = h('span.error', { id: uid('error'), hidden: true });
    const addBtn = h('button.btn', { type: 'button', onclick: () => { addRow(undefined, rows.length, true); edited(); } }, 'Add an item');
    const resetLabel = bind ? 'Follow the show' : 'Use default';
    const resetBtn = h('button.btn.ghost', {
      type: 'button', hidden: true, 'aria-label': `${resetLabel}: ${label}`,
      onclick: () => { isSet = false; render(Array.isArray(fb) ? fb : []); edited(false); addBtn.focus(); },
    }, resetLabel);
    const limits = [
      min !== undefined ? `At least ${min} ${min === 1 ? 'item' : 'items'}.` : '',
      max !== undefined ? `Up to ${max} ${max === 1 ? 'item' : 'items'}.` : '',
    ].filter(Boolean).join(' ');
    const hint = [typeof s.description === 'string' ? s.description : '', limits].filter(Boolean).join(' ');
    const box = h('div.field',
      hint ? h('span.hint', hint) : null,
      bind ? h('span.hint', bindNote(bind)) : null,
      status, ul, h('div.row', addBtn, resetBtn), err);
    css(box, { marginBottom: '0' });
    // A fieldset for its legend, drawn like any other field: on a phone, inside a section, another
    // border would leave the items no room.
    const legend = css(h('legend', label), { padding: '0', marginBottom: '6px', fontWeight: '600' });
    const el = css(h('fieldset', legend, box), { minWidth: '0', border: '0', padding: '0', margin: '0 0 var(--gap)' });
    registry.set(here, { label, el });

    function addRow(v, index, focus) {
      const ctl = control(items, label, true);
      ctl.fallback?.(undefined);
      ctl.write(v);
      const row = { ctl };
      const square = { padding: '0', width: 'var(--tap)', flex: 'none' };
      row.up = css(h('button.btn', { type: 'button', onclick: () => move(row) }, '↑'), square);
      row.remove = css(h('button.btn', { type: 'button', onclick: () => removeRow(row) }, '✕'), square);
      const editor = ctl.compose ? ctl.compose() : ctl.input;
      if (!ctl.stateful) css(editor, { flex: '1 1 auto', minWidth: '0', width: 'auto' });
      else css(editor, { marginRight: 'auto' }); // a switch keeps its size
      row.li = css(h('li', editor, row.up, row.remove), { gap: '8px' });
      if (ctl.input.tagName === 'INPUT' && ctl.input.type !== 'checkbox') {
        // Enter adds the next item, as in a bulleted list.
        ctl.input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' || e.isComposing) return;
          e.preventDefault();
          if (max !== undefined && rows.length >= max) return;
          addRow(undefined, rows.indexOf(row) + 1, true);
          edited();
        });
      }
      rows.splice(index, 0, row);
      ul.insertBefore(row.li, ul.children[index] || null);
      renumber();
      if (focus) ctl.input.focus();
    }
    function move(row) {
      const i = rows.indexOf(row);
      if (i <= 0) return;
      [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
      ul.insertBefore(row.li, rows[i].li);
      renumber();
      (row.up.disabled ? row.ctl.input : row.up).focus();
      edited();
    }
    function removeRow(row) {
      const i = rows.indexOf(row);
      if (i < 0) return;
      rows.splice(i, 1);
      row.li.remove();
      renumber();
      const next = rows[i] || rows[i - 1];
      (next ? next.ctl.input : addBtn).focus();
      edited();
    }
    function renumber() {
      rows.forEach((r, i) => {
        r.ctl.input.setAttribute('aria-label', `Item ${i + 1} of ${label}`);
        r.up.setAttribute('aria-label', `Move item ${i + 1} of ${label} up`);
        r.remove.setAttribute('aria-label', `Remove item ${i + 1} of ${label}`);
        r.up.disabled = i === 0;
      });
      after();
    }
    function render(list) {
      ul.replaceChildren();
      rows = [];
      for (const v of list) addRow(v, rows.length, false);
      after();
    }
    function after() {
      resetBtn.hidden = !isSet;
      addBtn.disabled = max !== undefined && rows.length >= max;
      const note = !isSet && rows.length
        ? (bind ? 'This is the show\'s list right now. Change anything to use your own.' : 'This is the default list. Change anything to make it your own.')
        : '';
      status.textContent = note;
      status.hidden = !note;
    }
    function edited(set = true) {
      if (set) isSet = true;
      after();
      if (showing || !set) check(true);
      refreshAll();
      fire(false);
    }
    // The list as values() sends it: empty rows left out; map[k] is the row of item k.
    function collect() {
      const arr = [];
      const map = [];
      const bad = [];
      rows.forEach((r, i) => {
        const x = r.ctl.read();
        if (x.bad) bad.push({ i, message: x.bad });
        else if (!x.empty) { map.push(i); arr.push(x.value); }
      });
      return { arr, map, bad };
    }
    function check(showMarks) {
      const problems = [];
      const rowText = new Map();
      const listText = [];
      if (isSet) {
        const { arr, map, bad } = collect();
        for (const b of bad) {
          rowText.set(b.i, b.message);
          problems.push({ path: `${here}/${b.i}`, message: b.message });
        }
        arr.forEach((v, k) => {
          const m = checkValue(items, v);
          if (m) {
            rowText.set(map[k], m);
            problems.push({ path: `${here}/${k}`, message: m });
          }
        });
        if (min !== undefined && arr.length < min) listText.push(`Add at least ${min} ${min === 1 ? 'item' : 'items'}.`);
        if (max !== undefined && arr.length > max) listText.push(`Keep it to ${max} ${max === 1 ? 'item' : 'items'} or fewer.`);
        for (const m of listText) problems.push({ path: here, message: m });
        if (s.uniqueItems === true) {
          const dup = arr.findIndex((v, i) => arr.findIndex((w) => equal(v, w)) !== i);
          if (dup >= 0) {
            problems.push({ path: here, message: 'Each item can be in the list only once.' });
            if (!rowText.has(map[dup])) rowText.set(map[dup], 'This item is in the list twice.');
          }
        }
      }
      if (showMarks) {
        rows.forEach((r, i) => {
          mark(r.ctl.marks, rowText.get(i));
          if (rowText.has(i)) r.ctl.input.setAttribute('aria-describedby', err.id);
          else r.ctl.input.removeAttribute('aria-describedby');
        });
        const text = [...listText, ...[...rowText].sort((a, b) => a[0] - b[0]).map(([i, m]) => `Item ${i + 1}: ${m}`)].join(' ');
        err.textContent = text;
        err.hidden = !text;
        showing = Boolean(text);
        el.toggleAttribute('data-invalid', showing);
        if (showing) el.setAttribute('aria-describedby', err.id);
        else el.removeAttribute('aria-describedby');
      }
      return problems;
    }

    el.addEventListener('input', () => {
      isSet = true;
      after();
      if (showing) check(true);
      refreshAll();
      if (liveField) fire(true);
    });
    el.addEventListener('change', () => {
      isSet = true;
      after();
      check(true);
      refreshAll();
      fire(false);
    });
    el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) check(true); });

    const node = {
      key, el, cond: s['x-skp-showIf'],
      get: () => (isSet ? { set: true, value: collect().arr } : { set: false }),
      set(v) {
        isSet = Array.isArray(v);
        render(isSet ? v : Array.isArray(fb) ? fb : []); // fresh rows: none marked
        err.textContent = '';
        err.hidden = true;
        showing = false;
        el.removeAttribute('data-invalid');
        el.removeAttribute('aria-describedby');
      },
      current: () => (isSet ? collect().arr : fb),
      fallback() {
        fb = fallbackOf(path, s);
        if (!isSet) render(Array.isArray(fb) ? fb : []);
      },
      validate: check,
      count: () => (isSet ? 1 : 0),
    };
    return node;
  }

  // ---- controls --------------------------------------------------------------------------------
  // A control edits one value:
  //   input      the element its label names
  //   compose()  the box around it, built after field() labelled it (optional)
  //   marks      what aria-invalid goes on
  //   read()     { empty } | { value } | { bad: message }
  //   write(v)   show v (undefined: empty)
  //   fallback(fb)  show what applies when empty (a placeholder)
  //   note(fb)   a line under an empty field saying what applies, where a placeholder can't (optional)
  //   stateful   it can't be emptied (a switch): the field tracks whether it is set
  // item: inside a list (no "Default" choice).
  function control(s, label, item) {
    const widget = s['x-skp-widget'];
    if (Array.isArray(s.enum)) return selectCtl(s, item);
    switch (s.type) {
      case 'boolean': return checkCtl();
      case 'number':
      case 'integer': {
        const bounded = typeof s.minimum === 'number' && typeof s.maximum === 'number' && s.maximum > s.minimum;
        return bounded && (widget === 'slider' || widget === 'position' || widget === 'size') ? sliderCtl(s, label) : numberCtl(s);
      }
      case 'string':
        if (widget === 'media') return mediaCtl(s, label);
        if (s.format === 'color' || widget === 'color') return colorCtl(s, label);
        if (widget === 'textarea' || widget === 'code') return textCtl(s, { area: true, code: widget === 'code' });
        if (s.format === 'date' || s.format === 'time') return textCtl(s, { type: s.format });
        if (s.format === 'uri') return textCtl(s, { type: 'url' });
        return textCtl(s, { font: widget === 'font' });
      default: return plainCtl(s);
    }
  }

  function example(s) {
    return Array.isArray(s.examples) && s.examples.length ? `e.g. ${show(s.examples[0])}` : '';
  }

  function textCtl(s, { area, code, type, font } = {}) {
    const raw = code || type === 'url';
    const input = area
      ? h('textarea', { rows: code ? 8 : 3, class: code ? 'code' : undefined, spellcheck: code ? 'false' : undefined, autocapitalize: code ? 'off' : undefined, autocomplete: 'off' })
      : h('input', { type: type || 'text', autocomplete: 'off', spellcheck: raw ? 'false' : undefined, autocapitalize: raw ? 'off' : undefined, inputmode: type === 'url' ? 'url' : undefined });
    let list;
    if (font) {
      list = h('datalist', { id: uid('fonts') });
      input.setAttribute('list', list.id);
    }
    const seconds = (v) => type === 'time' && typeof v === 'string' && /^\d\d:\d\d:\d\d$/.test(v);
    const timeless = type === 'date' || type === 'time';
    return {
      input,
      marks: [input],
      compose: list ? () => h('div', input, list) : undefined,
      read() {
        if (input.validity?.badInput) return { bad: type === 'date' ? 'Enter the whole date.' : type === 'time' ? 'Enter the whole time.' : 'Check this value.' };
        return input.value === '' ? { empty: true } : { value: input.value };
      },
      write(v) {
        if (seconds(v)) input.step = '1';
        input.value = v === undefined || v === null ? '' : show(v);
      },
      fallback(fb) {
        if (seconds(fb)) input.step = '1';
        if (list) mount(list, [...new Set([...(typeof fb === 'string' && fb ? [fb] : []), ...FONTS])].map((f) => h('option', { value: f })));
        if (timeless) return;
        input.placeholder = fb !== undefined && fb !== '' ? show(fb) : example(s) || (type === 'url' ? 'https://' : '');
      },
      note: timeless ? (fb) => (typeof fb === 'string' && fb ? `Leave it empty to use ${fb}.` : '') : undefined,
    };
  }

  function numberCtl(s) {
    const int = s.type === 'integer';
    const step = typeof s['x-skp-step'] === 'number' && s['x-skp-step'] > 0 ? s['x-skp-step'] : int ? 1 : 'any';
    const positive = typeof s.minimum === 'number' && s.minimum >= 0; // a phone keypad without a minus sign is then fine
    const input = h('input', {
      type: 'number', step, autocomplete: 'off',
      min: typeof s.minimum === 'number' ? s.minimum : undefined,
      max: typeof s.maximum === 'number' ? s.maximum : undefined,
      inputmode: positive ? (int ? 'numeric' : 'decimal') : undefined,
    });
    return {
      input,
      marks: [input],
      read() {
        if (input.validity?.badInput) return { bad: int ? 'Enter a whole number.' : 'Enter a number.' };
        if (input.value === '') return { empty: true };
        const n = Number(input.value);
        return Number.isFinite(n) ? { value: n } : { bad: 'Enter a number.' };
      },
      write(v) { input.value = v === undefined || v === null ? '' : String(v); },
      fallback(fb) { input.placeholder = fb !== undefined ? show(fb) : example(s); },
    };
  }

  // A slider beside the number it sets (x-skp-widget slider, position, size, with both bounds).
  function sliderCtl(s, label) {
    const num = numberCtl(s);
    const step = num.input.getAttribute('step') === 'any' ? (s.maximum - s.minimum) / 100 : num.input.getAttribute('step');
    const range = h('input', { type: 'range', min: s.minimum, max: s.maximum, step, 'aria-label': `${label}, slider` });
    let fb;
    const sync = () => {
      const typed = num.input.value === '' ? undefined : Number(num.input.value);
      const v = Number.isFinite(typed) ? typed : typeof fb === 'number' ? fb : s.minimum;
      range.value = String(v);
    };
    range.addEventListener('input', () => { num.input.value = range.value; });
    num.input.addEventListener('input', sync);
    return {
      input: num.input,
      marks: [num.input],
      compose: () => h('div.row',
        css(range, { flex: '1 1 8rem', width: 'auto', minWidth: '0' }),
        css(num.input, { flex: '0 0 7rem', width: '7rem' })),
      read: num.read,
      write(v) { num.write(v); sync(); },
      fallback(f) {
        fb = typeof f === 'number' ? f : undefined;
        num.fallback(f);
        sync();
      },
    };
  }

  function checkCtl() {
    const input = h('input', { type: 'checkbox' });
    return {
      input,
      marks: [input],
      stateful: true,
      read: () => ({ value: input.checked }),
      write(v) { input.checked = v === true; },
    };
  }

  function selectCtl(s, item) {
    const labels = Array.isArray(s['x-skp-labels']) ? s['x-skp-labels'] : [];
    const nameOf = (v) => {
      const i = s.enum.findIndex((e) => equal(e, v));
      return i >= 0 && typeof labels[i] === 'string' ? labels[i] : show(v);
    };
    const first = h('option', { value: '' }, 'Choose…');
    const extra = h('option', { value: 'x' });
    let extraValue;
    const select = h('select', first, s.enum.map((v, i) => h('option', { value: String(i) }, nameOf(v))));
    return {
      input: select,
      marks: [select],
      read() {
        if (select.value === '') return { empty: true };
        if (select.value === 'x') return { value: extraValue };
        return { value: s.enum[Number(select.value)] };
      },
      write(v) {
        extra.remove();
        if (v === undefined) { select.value = ''; return; }
        const i = s.enum.findIndex((e) => equal(e, v));
        if (i >= 0) { select.value = String(i); return; }
        // A saved value that is no longer a choice: kept visible, and marked by validate().
        extraValue = v;
        extra.textContent = `${show(v)} (not a choice any more)`;
        select.append(extra);
        select.value = 'x';
      },
      fallback(fb) {
        if (item) first.textContent = 'Choose…';
        else if (typeof s['x-skp-bind'] === 'string') first.textContent = fb !== undefined ? `Follow the show: ${nameOf(fb)}` : 'Follow the show';
        else first.textContent = fb !== undefined ? `Default: ${nameOf(fb)}` : 'Choose…';
      },
    };
  }

  // A colour: the picker, and the code it writes (#rgb, #rgba, #rrggbb or #rrggbbaa).
  function colorCtl(s, label) {
    const text = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
    const swatch = h('input', { type: 'color', 'aria-label': `${label}: pick a colour` });
    let fb;
    const sync = () => {
      const hex = hex6(text.value) || hex6(fb) || '#000000';
      if (swatch.value !== hex) swatch.value = hex;
    };
    swatch.addEventListener('input', () => { text.value = withAlpha(swatch.value, text.value || fb); });
    text.addEventListener('input', sync);
    return {
      input: text,
      marks: [text],
      compose: () => h('div.row', swatch, css(text, { flex: '1 1 8rem', width: 'auto', minWidth: '0', maxWidth: '16rem' })),
      read: () => (text.value === '' ? { empty: true } : { value: text.value }),
      write(v) {
        text.value = v === undefined || v === null ? '' : show(v);
        sync();
      },
      fallback(f) {
        fb = typeof f === 'string' ? f : undefined;
        text.placeholder = fb || example(s) || '#RRGGBB';
        sync();
      },
    };
  }

  // A media field: an uploaded file (chosen from mediaList()) or a pasted https URL. An uploaded
  // image shows as a thumbnail (this origin only: the page's CSP loads nothing else).
  function mediaCtl(s, label) {
    const accept = typeof s['x-skp-accept'] === 'string' ? s['x-skp-accept'] : '';
    const text = h('input', { type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
    const thumb = h('img.thumb', { alt: '', hidden: true, decoding: 'async' });
    css(thumb, { maxWidth: '240px' });
    thumb.addEventListener('error', () => { thumb.hidden = true; });
    const name = h('span.small.muted', { hidden: true });
    const choose = typeof mediaList === 'function'
      ? h('button.btn', { type: 'button', 'aria-label': `Choose a file for ${label}`, onclick: () => pick() }, 'Choose…')
      : null;
    const isImage = (v) => {
      const type = mediaTypes.get(v);
      return typeof type === 'string' ? type.toLowerCase().startsWith('image/') : IMAGE_NAME.test(v);
    };
    const update = () => {
      const v = text.value;
      const local = MEDIA_PATH.test(v);
      if (local && isImage(v)) {
        if (thumb.getAttribute('src') !== v) thumb.src = v;
        thumb.hidden = false;
      } else {
        thumb.hidden = true;
        thumb.removeAttribute('src');
      }
      name.textContent = local ? fileName(v) : '';
      name.hidden = !local;
    };
    text.addEventListener('input', update);

    async function pick() {
      let chosen;
      const body = h('div', h('p.muted', 'Loading your files…'));
      const closed = dialog({ title: `Choose a file for ${label}`, body, actions: [{ label: 'Cancel', value: false }] });
      try {
        const all = await mediaList();
        const list = (Array.isArray(all) ? all : []).filter((m) => isObj(m) && typeof m.url === 'string' && m.url);
        for (const m of list) if (typeof m.type === 'string') mediaTypes.set(m.url, m.type);
        const fits = list.filter((m) => accepts(accept, m));
        if (!fits.length) {
          mount(body, h('p', list.length
            ? `None of your files fit here: it takes ${acceptWords(accept)}. Upload one in Media, or paste an https:// address.`
            : 'You have no files yet. Upload one in Media, or paste an https:// address.'));
        } else {
          mount(body, h('ul.list', fits.map((m) => {
            const image = MEDIA_PATH.test(m.url) && (typeof m.type === 'string' ? m.type.toLowerCase().startsWith('image/') : IMAGE_NAME.test(m.url));
            const pic = image ? css(h('img', { src: m.url, alt: '', loading: 'lazy' }), { width: '64px', height: '36px', objectFit: 'cover', borderRadius: '4px', flex: 'none' }) : null;
            const btn = h('button.btn.ghost.block', {
              type: 'button',
              onclick: () => { chosen = m.url; btn.closest('dialog')?.close(); },
            }, pic, css(h('span.truncate', m.name || fileName(m.url)), { flex: '1 1 auto', textAlign: 'left' }), m.type ? h('span.small.muted', m.type) : null);
            css(btn, { justifyContent: 'flex-start', gap: '12px' });
            return h('li', btn);
          })));
        }
      } catch (err) {
        mount(body, notice(err?.message || 'Your files could not be loaded. Try again.', 'danger'));
      }
      await closed;
      if (chosen === undefined) return;
      text.value = chosen;
      update();
      text.dispatchEvent(new Event('input', { bubbles: true }));
      text.dispatchEvent(new Event('change', { bubbles: true }));
      text.focus();
    }

    return {
      input: text,
      marks: [text],
      compose: () => {
        const box = h('div', h('div.row', css(text, { flex: '1 1 9rem', width: 'auto', minWidth: '0' }), choose), name, thumb);
        css(name, { display: 'block', marginTop: '6px' });
        css(thumb, { marginTop: '8px' });
        return box;
      },
      read: () => (text.value === '' ? { empty: true } : { value: text.value }),
      write(v) {
        text.value = v === undefined || v === null ? '' : show(v);
        update();
      },
      fallback(f) {
        text.placeholder = typeof f === 'string' && f ? f : choose ? 'Choose a file, or paste an https:// address' : 'Paste an https:// address';
      },
    };
  }

  // Anything else: plain text. A value that isn't text is shown and read as JSON.
  function plainCtl(s) {
    const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
    const json = s.type !== 'string';
    return {
      input,
      marks: [input],
      read() {
        if (input.value === '') return { empty: true };
        if (json) {
          try { return { value: JSON.parse(input.value) }; } catch { /* text, then */ }
        }
        return { value: input.value };
      },
      write(v) { input.value = v === undefined || v === null ? '' : show(v); },
      fallback(fb) { input.placeholder = fb !== undefined ? show(fb) : ''; },
    };
  }
}
