// Template settings (04 §4.3, §4.10): the schema a template declares, the values an operator saves,
// and what the template receives as SK.settings.
//
//   checkSettingsSchema(manifest)            → { errors, warnings }  at install (04 §4.11)
//   validateSettings(manifest, settings)     → [{ path, message }]   before saving
//   resolveSettings(manifest, saved, state)  → the values SK.settings gets
//   migrateSettings(from, to, settings)      → { settings, changes } on upgrade
//
// A manifest's `settings` is a JSON Schema for one object, usually { "$ref":
// "#/definitions/settings" }; references resolve inside the manifest. Only the subset 04 §4.3
// lists is accepted, so the admin UI can always render the form. A template without a settings
// schema has no settings: it gets {}, and any saved key is refused (07 §7.11).
//
// Resolution, per field: the saved value if it is valid, else the value of the state key named by
// x-skp-bind if that is valid, else the default; groups (nested objects) resolve field by field
// and are always objects. Fields the schema doesn't know are left out.
import { KEY } from '../bus/names.js';
import { FORMATS, SchemaError, isObject, resolve, validate } from '../schema.js';
import { boundedMatch } from './pattern.js';

const PRIMITIVES = new Set(['string', 'number', 'integer', 'boolean']);
const TYPES = new Set([...PRIMITIVES, 'array', 'object']);
// The JSON Schema keywords a settings schema may use (04 §4.3, plus harmless annotations). A form
// can't render combinators, conditionals, or constraints like multipleOf, so those are refused.
const KEYWORDS = new Set([
  '$ref', 'type', 'title', 'description', 'default', 'enum', 'examples',
  'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format',
  'items', 'minItems', 'maxItems', 'uniqueItems',
  'properties', 'additionalProperties',
]);
// What the formats mean for a settings form: colours as the colour picker writes them, a local
// date and time of day (no offset: the show's time zone applies), and a web address an overlay
// can load (its CSP allows https: images, 04 §4.8).
const https = (s) => s.length <= 2048 && /^https:\/\/[^\s]+$/i.test(s) && FORMATS.uri(s);
export const SETTINGS_FORMATS = {
  color: FORMATS.color,
  date: FORMATS.date,
  time: (s) => /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s),
  uri: https,
};
// A media field holds an uploaded file (/media/<fileId>/<name>, 03 §3.4) or an https URL.
const isMediaValue = (s) => /^\/media\/[A-Za-z0-9_-]{1,64}\/[^/\\?#\s]{1,255}$/.test(s) || https(s);
// No setting value is longer than this; a template's pattern never runs on more.
export const MAX_VALUE_LENGTH = 4096;
// Sizes, in UTF-8 bytes of JSON. overlay.settings travels in a state.changed envelope beside its
// previous value, and an envelope is at most 64 KiB (02 §2.9): the resolved settings stay under
// half that. The operator's values and the template's defaults each have a share.
export const SAVED_BYTES = 24 * 1024;
export const DEFAULTS_BYTES = 6 * 1024;
export const RESOLVED_BYTES = 31 * 1024;
export const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v) ?? '');
const WIDGETS = new Set(['color', 'font', 'media', 'position', 'size', 'slider', 'textarea', 'code']);
const EXTENSIONS = new Set(['x-skp-widget', 'x-skp-labels', 'x-skp-group', 'x-skp-bind', 'x-skp-showIf', 'x-skp-preview', 'x-skp-axis', 'x-skp-accept', 'x-skp-step', 'x-skp-unit']);
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const MAX_DEPTH = 3; // nested groups; a form deeper than this isn't a settings form
const opts = (manifest, match) => ({ root: manifest, formats: SETTINGS_FORMATS, maxStringLength: MAX_VALUE_LENGTH, match });
const has = (o, k) => isObject(o) && Object.prototype.hasOwnProperty.call(o, k);

// The settings object's schema, with any top-level $ref followed; undefined when there is none.
export function settingsSchema(manifest) {
  let schema = manifest && manifest.settings;
  for (let hops = 0; isObject(schema) && schema.$ref !== undefined; hops++) {
    if (hops > 8) throw new SchemaError('settings: the $ref chain is too long');
    schema = resolve(manifest, schema.$ref);
  }
  return isObject(schema) && Object.keys(schema).length ? schema : undefined;
}

export function checkSettingsSchema(manifest) {
  const errors = [];
  const warnings = [];
  let root;
  try {
    root = settingsSchema(manifest);
  } catch (err) {
    errors.push(`settings: ${err.message}`);
    return { errors, warnings };
  }
  if (!root) {
    if (manifest.alerts && manifest.alerts.durationSetting) warnings.push(`alerts.durationSetting names "${manifest.alerts.durationSetting}", but the template declares no settings; alerts.durationMs is used instead`);
    return { errors, warnings };
  }
  if (root.type !== 'object' || !isObject(root.properties)) {
    errors.push('settings: must describe an object, with "type": "object" and "properties"');
    return { errors, warnings };
  }
  // Install-time checks get a larger time budget than one save: a template may have many enum
  // values and defaults to check, but still not unlimited.
  const match = boundedMatch({ budgetMs: 500 });

  // groups: how many nested objects deep this field is (the settings object itself is 0).
  const walk = (schema, path, groups, hops = 0) => {
    if (groups > MAX_DEPTH) { errors.push(`${path}: groups are nested more than ${MAX_DEPTH} deep`); return; }
    if (!isObject(schema)) { errors.push(`${path}: must be a schema object`); return; }
    if (schema.$ref !== undefined) {
      // A keyword beside $ref would apply too (2020-12), unseen by these checks: only labels.
      const beside = Object.keys(schema).filter((k) => k !== '$ref' && k !== 'title' && k !== 'description');
      if (beside.length) { errors.push(`${path}: nothing but "title" and "description" may stand beside "$ref" (found ${beside.join(', ')})`); return; }
      if (hops > 8) { errors.push(`${path}: the $ref chain is too long`); return; }
      try {
        walk(resolve(manifest, schema.$ref), path, groups, hops + 1);
      } catch (err) {
        errors.push(`${path}: ${err.message}`);
      }
      return;
    }
    for (const key of Object.keys(schema)) {
      if (key.startsWith('x-skp-')) { if (!EXTENSIONS.has(key)) warnings.push(`${path}: ${key} is not a known extension and is ignored`); }
      else if (!KEYWORDS.has(key)) errors.push(`${path}: "${key}" is not supported in a settings schema (04 §4.3)`);
    }
    const type = schema.type;
    if (type === undefined) errors.push(`${path}: needs a "type"`);
    else if (!TYPES.has(type)) errors.push(`${path}: "type" must be one of ${[...TYPES].join(', ')}`);
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) errors.push(`${path}: "additionalProperties" can only be false`);
    checkKeywordValues(schema, path, errors, warnings);

    if (type === 'object') {
      if (!isObject(schema.properties)) { errors.push(`${path}: an object needs "properties"`); return; }
      if (schema.default !== undefined) errors.push(`${path}: ${groups > 0 ? 'a group' : 'the settings object'} can't have a default; give its fields defaults`);
      if (schema['x-skp-bind'] !== undefined) errors.push(`${path}: x-skp-bind goes on a field, not on a group`);
      for (const [name, prop] of Object.entries(schema.properties)) {
        if (!NAME.test(name)) errors.push(`${path}: "${name}" can't be a setting name (use letters, digits and _, starting with a letter)`);
        walk(prop, `${path}.${name}`, isObject(prop) && deref(manifest, prop)?.type === 'object' ? groups + 1 : groups);
      }
    }
    if (type === 'array') {
      const items = isObject(schema.items) && schema.items.$ref !== undefined ? safeResolve(schema.items.$ref) : schema.items;
      if (!isObject(items) || !PRIMITIVES.has(items.type)) errors.push(`${path}: an array's "items" must be a string, number, integer or boolean (04 §4.3)`);
      else walk(items, `${path}[]`, groups);
    }
    if (schema.pattern !== undefined) checkPattern(schema, path, errors, warnings);
    if (schema.format !== undefined && !Object.prototype.hasOwnProperty.call(SETTINGS_FORMATS, schema.format)) warnings.push(`${path}: format "${schema.format}" isn't one the settings form knows (${Object.keys(SETTINGS_FORMATS).join(', ')})`);
    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum) || !schema.enum.length) errors.push(`${path}: "enum" must be a non-empty array`);
      else {
        for (const v of schema.enum) {
          const problems = safeValidate({ ...schema, enum: undefined, default: undefined }, v);
          if (problems.length) errors.push(`${path}: the enum value ${shown(v)} ${problems[0].message}`);
        }
        const labels = schema['x-skp-labels'];
        if (labels !== undefined && (!Array.isArray(labels) || labels.length !== schema.enum.length || !labels.every((l) => typeof l === 'string'))) {
          errors.push(`${path}: x-skp-labels must be one string per enum value`);
        }
      }
    }
    if (schema.default !== undefined && type !== 'object') {
      const problems = safeValidate(schema, schema.default);
      if (problems.length) errors.push(`${path}: the default ${shown(schema.default)} ${problems[0].message}`);
    }
    const bind = schema['x-skp-bind'];
    if (bind !== undefined && type !== 'object') {
      if (typeof bind !== 'string' || !KEY.test(bind)) errors.push(`${path}: x-skp-bind must name a state key`);
      else if (bind === 'overlay.settings') errors.push(`${path}: x-skp-bind can't name the overlay's own settings`);
    }
    const widget = schema['x-skp-widget'];
    if (widget !== undefined && !WIDGETS.has(widget)) warnings.push(`${path}: x-skp-widget "${widget}" isn't one the settings form knows`);
    if (widget === 'media' && type !== 'string') errors.push(`${path}: a media field must be a string`);
    const preview = schema['x-skp-preview'];
    if (preview !== undefined && preview !== 'live') warnings.push(`${path}: x-skp-preview can only be "live"`);
  };

  const safeResolve = (ref) => {
    try { return resolve(manifest, ref); } catch (err) { errors.push(`settings: ${err.message}`); return undefined; }
  };
  const safeValidate = (schema, value) => {
    try { return fieldProblems(manifest, schema, value, match); } catch (err) { return [{ message: err.message }]; }
  };

  walk(root, 'settings', 0);

  // What the defaults alone resolve to is part of every overlay's settings: bounded, so an
  // operator's own values always fit beside them (RESOLVED_BYTES).
  if (!errors.length) {
    const bytes = safe(() => jsonBytes(resolveSettings(manifest, {})));
    if (bytes > DEFAULTS_BYTES) errors.push(`settings: the defaults together take ${bytes} bytes; the limit is ${DEFAULTS_BYTES / 1024} KiB`);
  }

  // x-skp-showIf names a sibling field.
  for (const [name, prop] of Object.entries(root.properties)) {
    const cond = isObject(prop) && prop['x-skp-showIf'];
    if (cond !== undefined && (!isObject(cond) || !Object.prototype.hasOwnProperty.call(root.properties, cond.field))) {
      warnings.push(`settings.${name}: x-skp-showIf must name another setting ({ "field": …, "equals": … })`);
    }
  }
  // alerts.durationSetting names a numeric setting (05 §5.5); otherwise the runtime falls back to
  // alerts.durationMs, so it's a warning.
  const ds = manifest.alerts && manifest.alerts.durationSetting;
  if (ds !== undefined) {
    const prop = Object.prototype.hasOwnProperty.call(root.properties, ds) ? root.properties[ds] : undefined;
    const t = isObject(prop) && (prop.$ref ? safeResolve(prop.$ref) : prop);
    if (!isObject(t) || (t.type !== 'number' && t.type !== 'integer')) warnings.push(`alerts.durationSetting names "${ds}", which isn't a number or integer setting; alerts.durationMs is used instead`);
  }
  return { errors, warnings };
}

// A pattern runs with a deadline (pattern.js), so a slow one can't stall the platform, but a value
// it can't check in time is refused. Shapes known to backtrack badly are flagged at install so the
// author hears about it before an operator does.
function checkPattern(schema, path, errors, warnings) {
  const pattern = schema.pattern;
  if (typeof pattern !== 'string' || pattern.length > 200) { errors.push(`${path}: "pattern" must be a string of at most 200 characters`); return; }
  try {
    new RegExp(pattern, 'u'); // eslint-disable-line no-new
  } catch {
    errors.push(`${path}: "pattern" is not a valid regular expression`);
    return;
  }
  const problem = patternProblem(pattern);
  if (problem) warnings.push(`${path}: "pattern" ${problem}; checking some values against it can take too long, and those values are refused`);
}

// The keywords' own values: a form can't render, and no value can satisfy, a maxLength of null or
// a minimum above the maximum.
function checkKeywordValues(schema, path, errors, warnings) {
  for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[k] !== undefined && !(Number.isSafeInteger(schema[k]) && schema[k] >= 0)) errors.push(`${path}: "${k}" must be a whole number, 0 or more`);
  }
  for (const k of ['minimum', 'maximum']) {
    if (schema[k] !== undefined && !Number.isFinite(schema[k])) errors.push(`${path}: "${k}" must be a number`);
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') errors.push(`${path}: "uniqueItems" must be true or false`);
  for (const k of ['title', 'description']) {
    if (schema[k] !== undefined && typeof schema[k] !== 'string') errors.push(`${path}: "${k}" must be a string`);
  }
  if (schema.examples !== undefined && !Array.isArray(schema.examples)) errors.push(`${path}: "examples" must be an array`);
  for (const [lo, hi] of [['minimum', 'maximum'], ['minLength', 'maxLength'], ['minItems', 'maxItems']]) {
    if (typeof schema[lo] === 'number' && typeof schema[hi] === 'number' && schema[lo] > schema[hi]) errors.push(`${path}: "${lo}" is more than "${hi}", so no value fits`);
  }
  if (schema.minLength > MAX_VALUE_LENGTH) errors.push(`${path}: "minLength" is more than ${MAX_VALUE_LENGTH}, the longest a setting can be`);
  else if (schema.maxLength > MAX_VALUE_LENGTH) warnings.push(`${path}: values are limited to ${MAX_VALUE_LENGTH} characters whatever "maxLength" says`);
}

// A value as an error message shows it: short.
function shown(v) {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

// Why a (valid, u-flag) pattern can backtrack badly, or undefined: a backreference or lookaround,
// a repeated group that itself repeats or alternates ((a+)+, (a|a)*, ((a)+)+, (a{1,3})+ …), or more
// than 3 repeating quantifiers. A small tokenizer: atoms are characters, escapes, classes and
// groups; each may carry a quantifier. Advisory (see checkPattern): it errs both ways.
export function patternProblem(src) {
  const groups = [{ repeats: false, alternates: false }];
  let counted = 0; // quantifiers that repeat: *, +, {n,}, {n,m}, and {n} with n > 1
  let i = 0;
  // After an atom: reads its quantifier and returns whether it repeats.
  const quantifier = () => {
    const m = /^(?:[*+?]|\{(\d+)(,(\d*))?\})\??/.exec(src.slice(i));
    if (!m) return false;
    i += m[0].length;
    const q = m[0][0];
    const repeats = q === '*' || q === '+' || (q === '{' && (m[2] !== undefined || Number(m[1]) > 1));
    if (repeats) counted++;
    return repeats;
  };
  while (i < src.length) {
    const c = src[i];
    const top = groups[groups.length - 1];
    if (c === '\\') {
      const next = src[i + 1];
      if (/[1-9]/.test(next) || next === 'k') return 'uses a backreference';
      if ((next === 'u' || next === 'p' || next === 'P') && src[i + 2] === '{') i = src.indexOf('}', i) + 1;
      else if (next === 'u') i += 6;
      else if (next === 'x') i += 4;
      else if (next === 'c') i += 3;
      else i += 2;
      if (quantifier()) top.repeats = true;
    } else if (c === '[') {
      i++;
      if (src[i] === '^') i++;
      if (src[i] === ']') i++;
      while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
      i++;
      if (quantifier()) top.repeats = true;
    } else if (c === '(') {
      if (/^\(\?<?[=!]/.test(src.slice(i))) return 'uses a lookahead or lookbehind';
      const named = /^\(\?<[^>]*>/.exec(src.slice(i));
      i += named ? named[0].length : src.startsWith('(?:', i) ? 3 : 1;
      groups.push({ repeats: false, alternates: false });
    } else if (c === ')') {
      const g = groups.pop();
      i++;
      const parent = groups[groups.length - 1];
      if (quantifier()) {
        if (g.repeats || g.alternates) return 'repeats a group that itself repeats or alternates';
        parent.repeats = true;
      } else if (g.repeats) parent.repeats = true;
    } else if (c === '|') {
      top.alternates = true;
      i++;
    } else {
      i++;
      if (quantifier()) top.repeats = true;
    }
    if (counted > 3) return 'has more than 3 repeating quantifiers';
  }
  return undefined;
}

// The values an operator saves: each must fit its field, and every key must be a field, at any
// depth (07 §7.11: unknown fields are refused on writes).
export function validateSettings(manifest, settings) {
  if (!isObject(settings)) return [{ path: '/', message: 'must be an object' }];
  const root = settingsSchema(manifest);
  if (!root) return Object.keys(settings).map((key) => ({ path: `/${key}`, message: 'is not a setting of this template (it has none)' }));
  const match = boundedMatch();
  const errors = validate(root, settings, opts(manifest, match)).filter((e) => e.message !== 'is not a known field');
  const unknown = (schema, value, path, depth) => {
    if (depth > MAX_DEPTH || !isObject(value)) return;
    for (const key of Object.keys(value)) {
      const field = has(schema.properties, key) ? deref(manifest, schema.properties[key]) : undefined;
      if (!isObject(field)) errors.push({ path: `${path}/${key}`, message: 'is not a setting of this template' });
      else if (field.type === 'object') unknown(field, value[key], `${path}/${key}`, depth + 1);
      else for (const p of mediaProblems(manifest, field, value[key])) errors.push({ ...p, path: `${path}/${key}${p.path === '/' ? '' : p.path}` });
    }
  };
  unknown(root, settings, '', 0);
  return errors;
}

// state(key) → the value an x-skp-bind key has for this overlay, or undefined.
export function resolveSettings(manifest, saved = {}, state = () => undefined) {
  const root = settingsSchema(manifest);
  if (!root) return {};
  return resolveObject(manifest, root, isObject(saved) ? saved : {}, state, 0, boundedMatch());
}

function resolveObject(manifest, schema, saved, state, depth, match) {
  const out = {};
  if (depth > MAX_DEPTH || !isObject(schema.properties)) return out;
  for (const [key, raw] of Object.entries(schema.properties)) {
    const field = deref(manifest, raw);
    if (!isObject(field)) continue;
    const value = has(saved, key) ? saved[key] : undefined;
    if (field.type === 'object') {
      out[key] = resolveObject(manifest, field, isObject(value) ? value : {}, state, depth + 1, match);
      continue;
    }
    const ok = (v) => v !== undefined && valid(manifest, field, v, match);
    if (ok(value)) out[key] = structuredClone(value);
    else {
      const bound = typeof field['x-skp-bind'] === 'string' ? state(field['x-skp-bind']) : undefined;
      if (ok(bound)) out[key] = structuredClone(bound);
      else if (field.default !== undefined) out[key] = structuredClone(field.default);
    }
  }
  return out;
}

// The state keys a template's settings are bound to, so the platform can re-resolve when they
// change. Only fields bind; a group can't (checkSettingsSchema).
export function boundKeys(manifest) {
  const keys = new Set();
  const root = safe(() => settingsSchema(manifest));
  const walk = (schema, depth) => {
    if (depth > MAX_DEPTH || !isObject(schema) || !isObject(schema.properties)) return;
    for (const raw of Object.values(schema.properties)) {
      const field = deref(manifest, raw);
      if (!isObject(field)) continue;
      if (field.type === 'object') walk(field, depth + 1);
      else if (typeof field['x-skp-bind'] === 'string') keys.add(field['x-skp-bind']);
    }
  };
  walk(root, 0);
  return [...keys];
}

// Settings saved for one version, carried to another (04 §4.10): unchanged keys copy over, keys the
// new version doesn't have are dropped, and values the new version no longer accepts are dropped
// (the field falls back to its bound state value or default). New keys take their defaults by not
// being saved. Returns what changed, for the confirmation an upgrade shows:
//   { path, change: 'removed', from }         a saved value for a setting the new version lacks
//   { path, change: 'invalid', from, to }      a saved value the new version refuses; to = default
//   { path, change: 'added', to, saved? }      a new setting; to = its saved value (saved: true,
//                                              when migrate.js set one) or its default
//   { path, change: 'default', from, to }      an unsaved setting whose default changed
// 'invalid', 'added' and 'default' carry bind: the state key the field falls back to first.
export function migrateSettings(fromManifest, toManifest, settings) {
  const to = settingsSchema(toManifest);
  const from = safe(() => settingsSchema(fromManifest));
  const changes = [];
  if (!to) {
    for (const [key, v] of Object.entries(isObject(settings) ? settings : {})) changes.push({ path: `/${key}`, change: 'removed', from: v });
    return { settings: {}, changes };
  }
  const match = boundedMatch();
  const bindOf = (field) => (typeof field['x-skp-bind'] === 'string' ? { bind: field['x-skp-bind'] } : {});
  const carry = (toSchema, fromSchema, value, path, depth) => {
    const out = {};
    if (depth > MAX_DEPTH) return out;
    const props = toSchema.properties || {};
    const old = (fromSchema && fromSchema.properties) || {};
    for (const [key, v] of Object.entries(isObject(value) ? value : {})) {
      const at = `${path}/${key}`;
      const field = has(props, key) ? deref(toManifest, props[key]) : undefined;
      if (!isObject(field)) { changes.push({ path: at, change: 'removed', from: v }); continue; }
      if (field.type === 'object') {
        // A field that became a group: its value has nowhere to go.
        if (!isObject(v)) changes.push({ path: at, change: 'invalid', from: v });
        out[key] = carry(field, deref(fromManifest, old[key]), isObject(v) ? v : {}, at, depth + 1);
        continue;
      }
      if (valid(toManifest, field, v, match)) out[key] = structuredClone(v);
      else changes.push({ path: at, change: 'invalid', from: v, to: field.default, ...bindOf(field) });
    }
    for (const [key, raw] of Object.entries(props)) {
      const field = deref(toManifest, raw);
      const before = has(old, key) ? deref(fromManifest, old[key]) : undefined;
      const at = `${path}/${key}`;
      if (!isObject(field)) continue;
      const saved = has(value, key);
      if (!isObject(before)) {
        if (field.type === 'object') changes.push({ path: at, change: 'added' });
        else if (has(out, key)) changes.push({ path: at, change: 'added', to: out[key], saved: true, ...bindOf(field) });
        else changes.push({ path: at, change: 'added', to: field.default, ...bindOf(field) });
      } else if (field.type !== 'object' && !saved && JSON.stringify(before.default) !== JSON.stringify(field.default)) {
        changes.push({ path: at, change: 'default', from: before.default, to: field.default, ...bindOf(field) });
      } else if (field.type === 'object' && !saved) {
        carry(field, before, {}, at, depth + 1);
      }
    }
    return out;
  };
  return { settings: carry(to, from, settings, '', 0), changes };
}

// What migrate.js did to the saved settings, leaf by leaf: [{ path, from, to }], where from or to is
// undefined for a key it removed or added. Arrays and other values compare whole.
export function diffSettings(before, after, path = '', depth = 0) {
  const out = [];
  const a = isObject(before) ? before : {};
  const b = isObject(after) ? after : {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const at = `${path}/${key}`;
    const x = has(a, key) ? a[key] : undefined;
    const y = has(b, key) ? b[key] : undefined;
    if (isObject(x) && isObject(y) && depth < MAX_DEPTH) out.push(...diffSettings(x, y, at, depth + 1));
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ path: at, from: x, to: y });
  }
  return out;
}

function deref(manifest, schema) {
  for (let hops = 0; isObject(schema) && schema.$ref !== undefined && hops < 8; hops++) {
    schema = safe(() => resolve(manifest, schema.$ref));
  }
  return schema;
}

// A field's problems with a value: its schema, then what a media field may point at.
function fieldProblems(manifest, field, value, match) {
  const problems = validate(field, value, opts(manifest, match));
  return problems.length ? problems : mediaProblems(manifest, field, value);
}

function mediaProblems(manifest, field, value) {
  const items = field.type === 'array' ? deref(manifest, field.items) : undefined;
  const message = 'must be an uploaded file (/media/…) or an https URL';
  if (field['x-skp-widget'] === 'media' && typeof value === 'string' && !isMediaValue(value)) return [{ path: '/', message }];
  if (isObject(items) && items['x-skp-widget'] === 'media' && Array.isArray(value)) {
    return value.flatMap((v, i) => (typeof v === 'string' && !isMediaValue(v) ? [{ path: `/${i}`, message }] : []));
  }
  return [];
}

function valid(manifest, schema, value, match = boundedMatch()) {
  try {
    return fieldProblems(manifest, schema, value, match).length === 0;
  } catch {
    return false;
  }
}

function safe(fn) {
  try { return fn(); } catch { return undefined; }
}
