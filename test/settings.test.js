// Template settings (04 §4.3, §4.10): checking a template's schema, validating saved values,
// resolving what SK.settings gets, carrying settings across versions, and running migrate.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrate, MigrateError } from '../src/templates/migrate.js';
import { boundKeys, checkSettingsSchema, migrateSettings, resolveSettings, validateSettings } from '../src/templates/settings.js';

// The 04 §4.3 example, as a manifest would carry it.
const manifest = (properties, extra = {}) => ({
  settings: { $ref: '#/definitions/settings' },
  definitions: { settings: { type: 'object', properties } },
  ...extra,
});
const EXAMPLE = manifest({
  headliner: { type: 'string', title: 'Headliner', 'x-skp-bind': 'show.headliner' },
  accent: { type: 'string', format: 'color', title: 'Accent', default: '#EFC33F' },
  starStyle: { type: 'string', enum: ['rake', 'rise', 'ghost', 'stamp'], 'x-skp-labels': ['Gold rake', 'Rise reveal', 'Ghost trail', 'Stamp + ring'], default: 'rake' },
  showPoster: { type: 'boolean', default: true },
  chatX: { type: 'integer', minimum: 0, maximum: 1920, 'x-skp-widget': 'position', 'x-skp-axis': 'x' },
  poster: { type: 'string', 'x-skp-widget': 'media', 'x-skp-accept': 'image/*', 'x-skp-showIf': { field: 'showPoster', equals: true } },
  colors: { type: 'object', 'x-skp-group': 'Colours', properties: { text: { type: 'string', format: 'color', default: '#FFFFFF' } } },
  tags: { type: 'array', items: { type: 'string' }, maxItems: 3, default: [] },
});

test('the 04 §4.3 example schema is accepted', () => {
  assert.deepEqual(checkSettingsSchema(EXAMPLE), { errors: [], warnings: [] });
  assert.deepEqual(checkSettingsSchema({}), { errors: [], warnings: [] }); // no settings at all
});

test('a settings schema outside the 04 §4.3 subset is refused, with the reason', () => {
  const errors = (props, extra) => checkSettingsSchema(manifest(props, extra)).errors;
  assert.match(errors({ a: { oneOf: [{ type: 'string' }] } }).join(), /"oneOf" is not supported/);
  assert.match(errors({ a: { title: 'no type' } }).join(), /needs a "type"/);
  assert.match(errors({ a: { type: 'array', items: { type: 'object', properties: {} } } }).join(), /items/);
  assert.match(errors({ a: { type: 'string', default: 3 } }).join(), /default 3 must be a string/);
  assert.match(errors({ a: { type: 'string', enum: ['x', 'y'], 'x-skp-labels': ['X'] } }).join(), /x-skp-labels/);
  assert.match(errors({ a: { type: 'string', enum: ['x', 2] } }).join(), /enum value 2/);
  assert.match(errors({ a: { type: 'string', pattern: '(a+)+$' } }).join(), /exponential/);
  assert.deepEqual(errors({ ip: { type: 'string', pattern: '^(\\d{1,3}\\.){3}\\d{1,3}$' } }), []); // bounded repeats are fine
  assert.match(errors({ a: { type: 'string', pattern: '[' } }).join(), /not a valid regular expression/);
  assert.match(errors({ a: { type: 'string', 'x-skp-bind': 'Not A Key' } }).join(), /x-skp-bind/);
  assert.match(errors({ a: { type: 'number', 'x-skp-widget': 'media' } }).join(), /media field must be a string/);
  assert.match(errors(JSON.parse('{"__proto__": {"type": "string"}}')).join(), /can't be a setting name/);
  assert.match(errors({ a: { $ref: '#/definitions/nowhere' } }).join(), /points at nothing/);
  assert.match(checkSettingsSchema({ settings: { type: 'string' } }).errors.join(), /must describe an object/);
  let deep = { type: 'string' };
  for (let i = 0; i < 4; i++) deep = { type: 'object', properties: { a: deep } };
  assert.match(errors({ deep }).join(), /nested more than 3 deep/);
  const warnings = checkSettingsSchema(manifest({ a: { type: 'string', format: 'email', 'x-skp-widget': 'knob', 'x-skp-sparkle': 1 } })).warnings.join('\n');
  assert.match(warnings, /format "email"/);
  assert.match(warnings, /x-skp-widget "knob"/);
  assert.match(warnings, /x-skp-sparkle/);
});

test('alerts.durationSetting should name a numeric setting (05 §5.5); otherwise durationMs is used, with a warning', () => {
  assert.deepEqual(checkSettingsSchema(manifest({ hold: { type: 'integer', default: 6000 } }, { alerts: { durationSetting: 'hold' } })), { errors: [], warnings: [] });
  assert.match(checkSettingsSchema(manifest({ hold: { type: 'string' } }, { alerts: { durationSetting: 'hold' } })).warnings.join(), /durationSetting/);
  assert.match(checkSettingsSchema({ alerts: { durationSetting: 'hold' } }).warnings.join(), /declares no settings/);
});

test('constructs a settings form can\'t show are refused: combinators, multipleOf, required, group defaults, bad names', () => {
  const errors = (props) => checkSettingsSchema(manifest(props)).errors.join('\n');
  for (const keyword of ['const', 'required', 'multipleOf', 'exclusiveMinimum', 'anyOf', 'if']) {
    assert.match(errors({ a: { type: 'string', [keyword]: keyword === 'required' ? [] : 1 } }), new RegExp(`"${keyword}" is not supported`), keyword);
  }
  assert.match(errors({ a: { enum: ['x'] } }), /needs a "type"/);
  assert.match(errors({ a: { type: ['string', 'null'] } }), /"type" must be one of/);
  assert.match(errors({ g: { type: 'object', default: {}, properties: { x: { type: 'string' } } } }), /a group can't have a default/);
  assert.match(errors({ 'my-setting': { type: 'string' } }), /can't be a setting name/);
  assert.match(errors({ a: { type: 'object', additionalProperties: true, properties: {} } }), /additionalProperties/);
  assert.deepEqual(checkSettingsSchema(manifest({ a: { type: 'object', additionalProperties: false, properties: { b: { type: 'string' } } } })).errors, []);
});

test('settings formats are what a form writes: a colour, a local time of day, a web address', () => {
  const m = manifest({ c: { type: 'string', format: 'color' }, t: { type: 'string', format: 'time' }, u: { type: 'string', format: 'uri' } });
  assert.deepEqual(validateSettings(m, { c: '#abc', t: '21:30', u: 'https://example.com/poster.png' }), []);
  assert.deepEqual(validateSettings(m, { t: '21:30Z', u: 'javascript:alert(1)' }).map((e) => e.path).sort(), ['/t', '/u']);
  // A long value is refused by its length before any pattern runs on it.
  const p = manifest({ s: { type: 'string', pattern: '^a+$' } });
  assert.match(validateSettings(p, { s: 'a'.repeat(5000) })[0].message, /at most 4096 characters/);
});

test('saved values are validated against the schema before they are saved', () => {
  assert.deepEqual(validateSettings(EXAMPLE, { accent: '#000', chatX: 10 }), []);
  const problems = validateSettings(EXAMPLE, { accent: 'gold', chatX: 5000, mystery: 1, colors: { text: 'white' } }).map((e) => `${e.path} ${e.message}`).sort();
  assert.deepEqual(problems, ['/accent must be a valid color', '/chatX must be at most 1920', '/colors/text must be a valid color', '/mystery is not a setting of this template']);
  // A template without a settings schema has no settings.
  assert.deepEqual(validateSettings({}, { anything: 1 }).map((e) => e.path), ['/anything']);
  assert.deepEqual(validateSettings({}, {}), []);
  assert.deepEqual(validateSettings(EXAMPLE, 'x').map((e) => e.message), ['must be an object']);
  assert.deepEqual(validateSettings(EXAMPLE, { colors: { text: '#000', extra: 1 } }).map((e) => e.path), ['/colors/extra']);
});

test('resolution: saved value, else the bound state key, else the default; unknown keys are left out', () => {
  const state = (key) => (key === 'show.headliner' ? 'VIKKSTAR' : undefined);
  assert.deepEqual(resolveSettings(EXAMPLE, {}, state), {
    headliner: 'VIKKSTAR', accent: '#EFC33F', starStyle: 'rake', showPoster: true, colors: { text: '#FFFFFF' }, tags: [],
  });
  assert.deepEqual(resolveSettings(EXAMPLE, { headliner: 'BIA', accent: 'not a colour', chatX: 100, colors: { text: '#000' }, junk: 1 }, state), {
    headliner: 'BIA', accent: '#EFC33F', starStyle: 'rake', showPoster: true, chatX: 100, colors: { text: '#000' }, tags: [],
  });
  // A bound value of the wrong type is ignored like an invalid saved one.
  assert.equal(resolveSettings(EXAMPLE, {}, () => 42).headliner, undefined);
  // Without a schema there are no settings.
  assert.deepEqual(resolveSettings({}, { accent: 'cyan', size: 2 }), {});
  assert.deepEqual(boundKeys(EXAMPLE), ['show.headliner']);
  // The default is a copy: changing what one overlay got changes nothing for the next.
  const a = resolveSettings(EXAMPLE, {});
  a.tags.push('x');
  assert.deepEqual(resolveSettings(EXAMPLE, {}).tags, []);
});

test('upgrade: unchanged keys copy over, removed keys drop, invalid values fall back, and every change is listed (04 §4.10)', () => {
  const v1 = manifest({ accent: { type: 'string', format: 'color', default: '#EFC33F' }, size: { type: 'integer', maximum: 10 }, old: { type: 'string' }, mode: { type: 'string', default: 'a' } });
  const v2 = manifest({ accent: { type: 'string', format: 'color', default: '#EFC33F' }, size: { type: 'integer', maximum: 5 }, fresh: { type: 'boolean', default: true }, mode: { type: 'string', default: 'b' } });
  const { settings, changes } = migrateSettings(v1, v2, { accent: '#000', size: 8, old: 'x' });
  assert.deepEqual(settings, { accent: '#000' });
  assert.deepEqual(changes, [
    { path: '/size', change: 'invalid', from: 8, to: undefined },
    { path: '/old', change: 'removed', from: 'x' },
    { path: '/fresh', change: 'added', to: true },
    { path: '/mode', change: 'default', from: 'a', to: 'b' },
  ]);
  // A new version without settings drops them all, and says so.
  assert.deepEqual(migrateSettings(v1, {}, { anything: 1 }), { settings: {}, changes: [{ path: '/anything', change: 'removed', from: 1 }] });
});

test('migrate.js renames settings, isolated from the platform', async () => {
  const rename = 'export function migrate(from, s) { s.accentColour = s.accent; delete s.accent; s.from = from; return s; }';
  assert.deepEqual(await runMigrate(rename, '1.2.0', { accent: '#000' }), { accentColour: '#000', from: '1.2.0' });
  assert.deepEqual(await runMigrate('export default function (from, s) { return { n: 1 }; }', '1.0.0', {}), { n: 1 });
  assert.deepEqual(await runMigrate('module.exports = { migrate: (f, s) => ({ cjs: true }) };', '1.0.0', {}), { cjs: true });
});

test('migrate.js can\'t reach the platform, hang it, or exhaust its memory', async () => {
  const fails = async (code, pattern) => {
    await assert.rejects(runMigrate(code, '1.0.0', {}, { timeoutMs: 200 }), (err) => {
      assert.ok(err instanceof MigrateError, String(err));
      assert.match(err.message, pattern);
      return true;
    });
  };
  await fails('function migrate() { return this.constructor.constructor("return process")().env; }', /failed/);
  // Nothing of Node's: no process, require, network or timers. (`console` is V8's own, which
  // writes nowhere unless an inspector is attached.)
  assert.deepEqual(await runMigrate('function migrate() { return { p: typeof process, r: typeof require, f: typeof fetch, t: typeof setTimeout, b: typeof Buffer } }', '1', {}),
    { p: 'undefined', r: 'undefined', f: 'undefined', t: 'undefined', b: 'undefined' });
  await fails('function migrate() { return eval("1+1") }', /failed/); // no string-to-code
  await fails('function migrate() { for (;;) {} }', /timed out|took longer|failed/);
  await fails('function migrate() { const a = []; for (;;) a.push(new Array(1e6).fill(1)); }', /memory|failed|took longer/);
  await fails('async function migrate() { return {}; }', /promise/);
  await fails('function migrate() { return 5; }', /as an object/);
  await fails('function notMigrate() {}', /must define migrate/);
  await fails('this is not javascript', /failed/);
});
