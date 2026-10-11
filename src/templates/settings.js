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
// schema gets the saved values as they are.
//
// Resolution, per field: the saved value if it is valid, else the value of the state key named by
// x-skp-bind if that is valid, else the default; nested objects resolve field by field. Fields the
// schema doesn't know are left out.
import { KEY } from '../bus/names.js';
import { FORMATS, SchemaError, isObject, resolve, validate } from '../schema.js';

const PRIMITIVES = new Set(['string', 'number', 'integer', 'boolean']);
const TYPES = new Set([...PRIMITIVES, 'array', 'object']);
// The JSON Schema keywords a settings schema may use (04 §4.3, plus harmless annotations).
const KEYWORDS = new Set([
  '$ref', 'type', 'title', 'description', 'default', 'enum', 'const', 'examples',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'format',
  'items', 'minItems', 'maxItems', 'uniqueItems',
  'properties', 'required', 'additionalProperties',
]);
const SETTING_FORMATS = new Set(['color', 'uri', 'date', 'time']);
const WIDGETS = new Set(['color', 'font', 'media', 'position', 'size', 'slider', 'textarea', 'code']);
const EXTENSIONS = new Set(['x-skp-widget', 'x-skp-labels', 'x-skp-group', 'x-skp-bind', 'x-skp-showIf', 'x-skp-preview', 'x-skp-axis', 'x-skp-accept', 'x-skp-step', 'x-skp-unit']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 8; // nested groups; a form deeper than this isn't a settings form

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
    if (manifest.alerts && manifest.alerts.durationSetting) errors.push(`alerts.durationSetting names "${manifest.alerts.durationSetting}", but the template declares no settings`);
    return { errors, warnings };
  }
  if (root.type !== 'object' || !isObject(root.properties)) {
    errors.push('settings: must describe an object, with "type": "object" and "properties"');
    return { errors, warnings };
  }

  const walk = (schema, path, depth) => {
    if (depth > MAX_DEPTH) { errors.push(`${path}: nested more than ${MAX_DEPTH} deep`); return; }
    if (!isObject(schema)) { errors.push(`${path}: must be a schema object`); return; }
    if (schema.$ref !== undefined) {
      try {
        walk(resolve(manifest, schema.$ref), path, depth + 1);
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
    if (type === undefined && schema.enum === undefined && schema.const === undefined) errors.push(`${path}: needs a "type"`);
    if (type !== undefined && !TYPES.has(type)) errors.push(`${path}: "type" must be one of ${[...TYPES].join(', ')}`);

    if (type === 'object') {
      if (!isObject(schema.properties)) { errors.push(`${path}: an object needs "properties"`); return; }
      for (const [name, prop] of Object.entries(schema.properties)) {
        if (FORBIDDEN_KEYS.has(name)) errors.push(`${path}.properties: "${name}" can't be a setting name`);
        walk(prop, `${path}.${name}`, depth + 1);
      }
      for (const name of schema.required || []) if (!Object.prototype.hasOwnProperty.call(schema.properties, name)) errors.push(`${path}: requires "${name}", which it doesn't define`);
    }
    if (type === 'array') {
      const items = isObject(schema.items) && schema.items.$ref !== undefined ? safeResolve(schema.items.$ref) : schema.items;
      if (!isObject(items) || !PRIMITIVES.has(items.type)) errors.push(`${path}: an array's "items" must be a string, number, integer or boolean (04 §4.3)`);
      else walk(items, `${path}[]`, depth + 1);
    }
    if (schema.pattern !== undefined) checkPattern(schema.pattern, path, errors);
    if (schema.format !== undefined && !SETTING_FORMATS.has(schema.format)) warnings.push(`${path}: format "${schema.format}" isn't one the settings form knows (${[...SETTING_FORMATS].join(', ')})`);
    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum) || !schema.enum.length) errors.push(`${path}: "enum" must be a non-empty array`);
      else {
        for (const v of schema.enum) if (validate({ ...schema, enum: undefined, default: undefined }, v, { root: manifest }).length) errors.push(`${path}: the enum value ${JSON.stringify(v)} doesn't match the field's own type`);
        const labels = schema['x-skp-labels'];
        if (labels !== undefined && (!Array.isArray(labels) || labels.length !== schema.enum.length || !labels.every((l) => typeof l === 'string'))) {
          errors.push(`${path}: x-skp-labels must be one string per enum value`);
        }
      }
    }
    if (schema.default !== undefined) {
      const problems = safeValidate(schema, schema.default);
      if (problems.length) errors.push(`${path}: the default ${JSON.stringify(schema.default)} ${problems[0].message}`);
    }
    const bind = schema['x-skp-bind'];
    if (bind !== undefined && (typeof bind !== 'string' || !KEY.test(bind))) errors.push(`${path}: x-skp-bind must name a state key`);
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
    try { return validate(schema, value, { root: manifest }); } catch (err) { return [{ message: err.message }]; }
  };

  walk(root, 'settings', 0);

  // x-skp-showIf names a sibling field.
  for (const [name, prop] of Object.entries(root.properties)) {
    const cond = isObject(prop) && prop['x-skp-showIf'];
    if (cond !== undefined && (!isObject(cond) || !Object.prototype.hasOwnProperty.call(root.properties, cond.field))) {
      warnings.push(`settings.${name}: x-skp-showIf must name another setting ({ "field": …, "equals": … })`);
    }
  }
  // alerts.durationSetting names a numeric setting (05 §5.5).
  const ds = manifest.alerts && manifest.alerts.durationSetting;
  if (ds !== undefined) {
    const prop = root.properties[ds];
    const t = isObject(prop) && (prop.$ref ? safeResolve(prop.$ref) : prop);
    if (!isObject(t) || (t.type !== 'number' && t.type !== 'integer')) errors.push(`alerts.durationSetting names "${ds}", which must be a number or integer setting`);
  }
  return { errors, warnings };
}

// A pattern compiled with the u flag, short, and without an unbounded repeat of a group that itself
// repeats without bound ((a+)+, (\w*)*, (x+){2,}), which can take exponential time on a crafted
// value. Bounded repeats like (\d{1,3}\.){3} are fine.
function checkPattern(pattern, path, errors) {
  if (typeof pattern !== 'string' || pattern.length > 200) { errors.push(`${path}: "pattern" must be a string of at most 200 characters`); return; }
  try {
    new RegExp(pattern, 'u'); // eslint-disable-line no-new
  } catch {
    errors.push(`${path}: "pattern" is not a valid regular expression`);
    return;
  }
  if (/\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\})/.test(pattern)) errors.push(`${path}: "pattern" repeats a group that itself repeats, which can take exponential time`);
}

export function validateSettings(manifest, settings) {
  const root = settingsSchema(manifest);
  if (!isObject(settings)) return [{ path: '/', message: 'must be an object' }];
  if (!root) return [];
  const errors = validate(root, settings, { root: manifest, formats: FORMATS });
  for (const key of Object.keys(settings)) {
    if (!Object.prototype.hasOwnProperty.call(root.properties || {}, key)) errors.push({ path: `/${key}`, message: 'is not a setting of this template' });
  }
  return errors;
}

// state(key) → the bus's current value for an x-skp-bind key, or undefined.
export function resolveSettings(manifest, saved = {}, state = () => undefined) {
  const root = settingsSchema(manifest);
  if (!root) return isObject(saved) ? structuredClone(saved) : {};
  return resolveObject(manifest, root, isObject(saved) ? saved : {}, state, 0);
}

function resolveObject(manifest, schema, saved, state, depth) {
  const out = {};
  if (depth > MAX_DEPTH || !isObject(schema.properties)) return out;
  for (const [key, raw] of Object.entries(schema.properties)) {
    const field = deref(manifest, raw);
    if (!isObject(field)) continue;
    const value = Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : undefined;
    if (field.type === 'object') {
      out[key] = resolveObject(manifest, field, isObject(value) ? value : {}, state, depth + 1);
      continue;
    }
    const ok = (v) => v !== undefined && valid(manifest, field, v);
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
// change.
export function boundKeys(manifest) {
  const keys = new Set();
  const root = safe(() => settingsSchema(manifest));
  const walk = (schema, depth) => {
    if (depth > MAX_DEPTH || !isObject(schema) || !isObject(schema.properties)) return;
    for (const raw of Object.values(schema.properties)) {
      const field = deref(manifest, raw);
      if (!isObject(field)) continue;
      if (typeof field['x-skp-bind'] === 'string') keys.add(field['x-skp-bind']);
      if (field.type === 'object') walk(field, depth + 1);
    }
  };
  walk(root, 0);
  return [...keys];
}

// Settings saved for one version, carried to another (04 §4.10): unchanged keys copy over, keys the
// new version doesn't have are dropped, and values the new version no longer accepts are dropped
// (the field falls back to its default). New keys take their defaults by not being saved. Returns
// what changed, for the confirmation a major upgrade needs.
//   changes: [{ path, change: 'removed' | 'invalid' | 'added' | 'default', from, to }]
export function migrateSettings(fromManifest, toManifest, settings) {
  const to = settingsSchema(toManifest);
  const from = safe(() => settingsSchema(fromManifest));
  const changes = [];
  if (!to) return { settings: isObject(settings) ? structuredClone(settings) : {}, changes };
  const carry = (toSchema, fromSchema, value, path, depth) => {
    const out = {};
    if (depth > MAX_DEPTH) return out;
    const props = toSchema.properties || {};
    const old = (fromSchema && fromSchema.properties) || {};
    for (const [key, v] of Object.entries(isObject(value) ? value : {})) {
      const at = `${path}/${key}`;
      const field = Object.prototype.hasOwnProperty.call(props, key) ? deref(toManifest, props[key]) : undefined;
      if (!isObject(field)) { changes.push({ path: at, change: 'removed', from: v }); continue; }
      if (field.type === 'object') {
        out[key] = carry(field, deref(fromManifest, old[key]), v, at, depth + 1);
        continue;
      }
      if (valid(toManifest, field, v)) out[key] = structuredClone(v);
      else changes.push({ path: at, change: 'invalid', from: v, to: field.default });
    }
    for (const [key, raw] of Object.entries(props)) {
      const field = deref(toManifest, raw);
      const before = Object.prototype.hasOwnProperty.call(old, key) ? deref(fromManifest, old[key]) : undefined;
      const at = `${path}/${key}`;
      if (!isObject(field)) continue;
      if (!isObject(before)) changes.push({ path: at, change: 'added', to: field.default });
      else if (field.type !== 'object' && !(isObject(value) && key in value) && JSON.stringify(before.default) !== JSON.stringify(field.default)) {
        changes.push({ path: at, change: 'default', from: before.default, to: field.default });
      } else if (field.type === 'object' && !(isObject(value) && key in value)) {
        carry(field, before, {}, at, depth + 1);
      }
    }
    return out;
  };
  return { settings: carry(to, from, settings, '', 0), changes };
}

function deref(manifest, schema) {
  for (let hops = 0; isObject(schema) && schema.$ref !== undefined && hops < 8; hops++) {
    schema = safe(() => resolve(manifest, schema.$ref));
  }
  return schema;
}

function valid(manifest, schema, value) {
  try {
    return validate(schema, value, { root: manifest }).length === 0;
  } catch {
    return false;
  }
}

function safe(fn) {
  try { return fn(); } catch { return undefined; }
}
