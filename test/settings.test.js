// Template settings (04 §4.3, §4.10): checking a template's schema, validating saved values,
// resolving what SK.settings gets, carrying settings across versions, and running migrate.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaError } from '../src/schema.js';
import { classicMigrate, MAX_RESULT_CHARS, migrateProblem, runMigrate, MigrateError } from '../src/templates/migrate.js';
import { boundedMatch } from '../src/templates/pattern.js';
import {
  boundKeys, checkSettingsSchema, DEFAULTS_BYTES, diffSettings, jsonBytes, migrateSettings, patternProblem, resolveSettings, SAVED_BYTES, validateSettings,
} from '../src/templates/settings.js';
import { DIAG, startWithOverlay } from './helpers.js';

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
// A pattern that backtracks exponentially: each "_" can match \w or _, and the "!" makes every
// one of the 2^26 ways fail. Unchecked that takes about a second (twice as long per "_"), far past
// a check's 20 ms deadline, yet short enough that if the deadline is lost these tests fail in
// seconds instead of hanging: a running RegExp blocks the event loop, so no test timeout fires.
const SLOW = '^(\\w|_)+$';
const STALL = `${'_'.repeat(26)}!`;
// STALL does match this one, once the same slow search fails (".*!"): unchecked, it is accepted.
const SLOW_THEN_YES = '^(?:(\\w|_)+|.*!)$';
// A check's 20 ms deadline is wall-clock time, and on a busy machine (the whole suite running at
// once) the scheduler can pause even a quick check for longer than that. A quick check that ran
// out of time is tried again; a slow one runs out every time.
function checkedInTime(validation) {
  for (let tries = 1; ; tries++) {
    const problems = validation();
    if (tries === 10 || !problems.some((e) => /couldn't be checked/.test(e.message))) return problems;
  }
}

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
  // A pattern shape known to backtrack badly is flagged; the pattern still runs, with a deadline.
  assert.deepEqual(errors({ a: { type: 'string', pattern: '(a+)+$' } }), []);
  assert.match(checkSettingsSchema(manifest({ a: { type: 'string', pattern: '(a+)+$' } })).warnings.join(), /repeats a group/);
  assert.deepEqual(errors({ hex: { type: 'string', pattern: '^#[0-9a-f]{6}$' } }), []);
  assert.match(errors({ a: { type: 'string', pattern: '[' } }).join(), /not a valid regular expression/);
  assert.match(errors({ a: { type: 'string', pattern: 'a'.repeat(201) } }).join(), /at most 200 characters/);
  // A keyword beside $ref would apply unchecked: refused.
  const sneaky = manifest({ a: { $ref: '#/definitions/s', pattern: '^((a+))+$' } }, { definitions: { settings: { type: 'object', properties: { a: { $ref: '#/definitions/s', pattern: '^((a+))+$' } } }, s: { type: 'string' } } });
  assert.match(checkSettingsSchema(sneaky).errors.join(), /beside "\$ref"/);
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

test('pattern shapes that could backtrack for a long time are recognised (for the install warning)', () => {
  // The bypasses measured against the earlier heuristic (seconds on under 30 characters), and more.
  for (const p of ['^((a+))+$', '(a|a)*$', '(a+){1,99999}', '(?:a|a)+b', '(\\w*)*$', '(a)\\1', '(?<n>a)\\k<n>', '(?=a)b', '(?<!a)b', '\\d*\\d*\\d*\\d*x', '^(\\d{1,3}\\.){3}\\d{1,3}$']) {
    assert.ok(patternProblem(p), p);
  }
  for (const p of ['^#[0-9a-f]{6}$', '^[A-Za-z0-9_]{3,25}$', '^(ab)?c+$', '^\\p{Lu}[\\p{L} ]*$', '^[a-z]+(-[a-z]+)?$']) {
    assert.equal(patternProblem(p), undefined, p);
  }
});

test('a pattern that backtracks catastrophically can\'t stall a save: the value is refused as uncheckable, and resolves to the default', () => {
  // Given time, this pattern accepts STALL; with a deadline, STALL is neither saved nor used.
  const m = manifest({ s: { type: 'string', pattern: SLOW_THEN_YES, default: 'fine' } });
  // A value the pattern checks quickly is checked as usual.
  assert.deepEqual(checkedInTime(() => validateSettings(m, { s: 'ok_value' })), []);
  assert.match(checkedInTime(() => validateSettings(m, { s: 'not ok' }))[0].message, /must match/);
  let t0 = performance.now();
  const problems = validateSettings(m, { s: STALL });
  assert.ok(performance.now() - t0 < 2000, `took ${performance.now() - t0} ms`);
  assert.deepEqual(problems.map((e) => e.path), ['/s']);
  assert.match(problems[0].message, /couldn't be checked .* in time/);
  t0 = performance.now();
  assert.deepEqual(resolveSettings(m, { s: STALL }), { s: 'fine' });
  assert.ok(performance.now() - t0 < 2000, `took ${performance.now() - t0} ms`);
});

test('every pattern check in one validation shares one time budget, so many slow fields still finish quickly', () => {
  // One such field is refused as uncheckable (and so fails fast if the deadline is ever lost,
  // before 250 unbounded checks).
  assert.match(validateSettings(manifest({ f: { type: 'string', pattern: SLOW } }), { f: STALL })[0]?.message, /couldn't be checked .* in time/);
  // 250 fields: at 20 ms a check without a shared budget that is 5 s; with it, about 100 ms.
  const properties = {};
  const values = {};
  for (let i = 0; i < 250; i++) {
    properties[`f${i}`] = { type: 'string', pattern: SLOW };
    values[`f${i}`] = STALL;
  }
  const t0 = performance.now();
  const problems = validateSettings(manifest(properties), values);
  assert.ok(performance.now() - t0 < 3000, `took ${performance.now() - t0} ms`);
  assert.equal(problems.length, 250);
  assert.ok(problems.every((e) => /couldn't be checked .* in time/.test(e.message)));
});

test('boundedMatch answers true, false, or null when a check ran out of time; an invalid pattern is a SchemaError', () => {
  // Deadlines are wall-clock time, and a busy machine can pause even a trivial check for longer
  // than 20 ms (a 20 ms vm timeout itself takes about 30 ms on Windows): checks that must finish
  // get room.
  const roomy = () => boundedMatch({ perCheckMs: 2000, budgetMs: 10000 });
  const match = roomy();
  assert.equal(match('^a+$', 'aaa'), true);
  assert.equal(match('^a+$', 'b'), false);
  assert.equal(match('^\\p{Lu}$', 'Á'), true); // the u flag, as the install check compiles it
  // With the defaults (20 ms a check, 100 ms a validation) a slow check runs out of time, and once
  // the budget is spent nothing more is checked in that validation...
  const bounded = boundedMatch();
  assert.equal(bounded(SLOW, STALL), null);
  assert.equal(bounded(SLOW_THEN_YES, STALL), null);
  for (let i = 0; i < 10; i++) assert.equal(bounded(SLOW, STALL), null);
  assert.equal(bounded('^a+$', 'aaa'), null);
  assert.equal(roomy()('^a+$', 'aaa'), true); // ...and the next validation has its own budget
  // One slow check spends its own deadline, not the whole budget: what is left still checks. A busy
  // machine can pause a quick check for a few hundred ms, so the deadline is 400 ms, on a value
  // that needs about nine times that (two more "_" than STALL: four times the work).
  const patient = boundedMatch({ perCheckMs: 400, budgetMs: 10000 });
  assert.equal(patient(SLOW, `${'_'.repeat(28)}!`), null);
  assert.equal(patient('^a+$', 'aaa'), true);
  assert.throws(() => roomy()('[', 'x'), SchemaError);
});

test('a check that ran out of time because the machine was busy (it barely ran) gets a longer deadline; one that worked gets none', () => {
  // A fake clock and CPU: each attempt "runs" for its whole deadline on the clock, and uses the CPU
  // time the scenario says.
  const scenario = (cpuShare, finishesAt = Infinity) => {
    const deadlines = [];
    let clock = 0;
    let cpuMs = 0;
    const match = boundedMatch({
      cpu: () => cpuMs,
      wall: () => clock,
      run: (pattern, value, timeout) => {
        deadlines.push(timeout);
        if (timeout >= finishesAt) { clock += 1; cpuMs += 1; return true; }
        clock += timeout;
        cpuMs += timeout * cpuShare;
        throw Object.assign(new Error('timed out'), { code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' });
      },
    });
    return { result: match('^a$', 'a'), deadlines, cpuMs };
  };
  // Starved (5% of the time on the CPU): tried again, longer each time, and answered.
  assert.deepEqual(scenario(0.05, 80), { result: true, deadlines: [20, 40, 80], cpuMs: 1 + 20 * 0.05 + 40 * 0.05 });
  // Starved for good: given up on after the longest wait, never forever.
  assert.deepEqual(scenario(0).deadlines, [20, 40, 80, 160, 320, 640, 1280]);
  assert.equal(scenario(0).result, null);
  // Working (all of its time on the CPU): out of time once is out of time.
  assert.deepEqual(scenario(1, 80), { result: null, deadlines: [20], cpuMs: 20 });
  // Half on the CPU is working, not waiting.
  assert.deepEqual(scenario(0.5, 80).deadlines, [20]);
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

test('keyword values no form can render, or no value can satisfy, are install errors', () => {
  const errors = (field) => checkSettingsSchema(manifest({ a: field })).errors.join('\n');
  const list = { type: 'array', items: { type: 'string' } };
  const cases = [
    [{ type: 'string', maxLength: null }, /"maxLength" must be a whole number, 0 or more/],
    [{ type: 'string', minLength: -1 }, /"minLength" must be a whole number, 0 or more/],
    [{ ...list, maxItems: 1.5 }, /"maxItems" must be a whole number, 0 or more/],
    [{ type: 'number', minimum: 'x' }, /"minimum" must be a number/],
    [{ ...list, uniqueItems: 'yes' }, /"uniqueItems" must be true or false/],
    [{ type: 'string', title: 5 }, /"title" must be a string/],
    [{ type: 'string', examples: {} }, /"examples" must be an array/],
    [{ type: 'number', minimum: 5, maximum: 1 }, /"minimum" is more than "maximum", so no value fits/],
    [{ type: 'string', minLength: 5, maxLength: 1 }, /"minLength" is more than "maxLength", so no value fits/],
    [{ ...list, minItems: 3, maxItems: 1 }, /"minItems" is more than "maxItems", so no value fits/],
    [{ type: 'string', minLength: 4097 }, /"minLength" is more than 4096, the longest a setting can be/],
  ];
  for (const [field, pattern] of cases) assert.match(errors(field), pattern, JSON.stringify(field));
  // A maxLength above what any setting may hold is harmless: a warning.
  assert.deepEqual(checkSettingsSchema(manifest({ a: { type: 'string', maxLength: 4097 } })), {
    errors: [], warnings: ['settings.a: values are limited to 4096 characters whatever "maxLength" says'],
  });
  // At the limits, and with equal bounds, all is well.
  assert.deepEqual(checkSettingsSchema(manifest({
    a: { type: 'string', minLength: 4096, maxLength: 4096, title: 'A', examples: [] },
    n: { type: 'number', minimum: 1, maximum: 1 },
    l: { ...list, minItems: 0, maxItems: 0, uniqueItems: true },
  })), { errors: [], warnings: [] });
  // A long default is shown shortened in its error message.
  const long = 'x'.repeat(100);
  const [message] = checkSettingsSchema(manifest({ a: { type: 'string', maxLength: 10, default: long } })).errors;
  assert.match(message, /the default "x{76}… must be at most 10 characters/);
  assert.ok(!message.includes(long), message);
});

test('defaults go on fields, not on the settings object; bindings go on fields, never to overlay.settings', () => {
  const errors = (m) => checkSettingsSchema(m).errors.join('\n');
  assert.match(errors({ settings: { type: 'object', default: { a: 'x' }, properties: { a: { type: 'string' } } } }), /the settings object can't have a default/);
  assert.match(errors({ settings: { $ref: '#/definitions/s' }, definitions: { s: { type: 'object', default: {}, properties: {} } } }), /the settings object can't have a default/);
  assert.match(errors(manifest({ g: { type: 'object', 'x-skp-bind': 'custom.g', properties: { a: { type: 'string' } } } })), /settings\.g: x-skp-bind goes on a field, not on a group/);
  assert.match(errors(manifest({ a: { type: 'string', 'x-skp-bind': 'overlay.settings' } })), /x-skp-bind can't name the overlay's own settings/);
  // Only fields' bindings count: a group's is never followed.
  const bound = manifest({
    g: { type: 'object', 'x-skp-bind': 'custom.g', properties: { a: { type: 'string', 'x-skp-bind': 'custom.a' } } },
    b: { type: 'string', 'x-skp-bind': 'custom.b' },
  });
  assert.deepEqual(boundKeys(bound).sort(), ['custom.a', 'custom.b']);
});

test('keywords beside the settings object\'s own $ref (the 04 §4.3 form) are refused, like those beside any other $ref', () => {
  const definitions = { s: { type: 'object', properties: { a: { type: 'string' } } } };
  const errors = (beside) => checkSettingsSchema({ settings: { $ref: '#/definitions/s', ...beside }, definitions }).errors.join('\n');
  assert.match(errors({ default: { a: 'x' } }), /can't have a default|beside "\$ref"/);
  assert.match(errors({ 'x-skp-bind': 'custom.s' }), /x-skp-bind goes on a field|beside "\$ref"/);
  assert.match(errors({ additionalProperties: true }), /"additionalProperties" can only be false|beside "\$ref"/);
});

test('the defaults together are limited to 6 KiB of UTF-8 JSON, an install error', () => {
  const fields = (n, value) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, { type: 'string', default: value }]));
  assert.equal(DEFAULTS_BYTES, 6 * 1024);
  assert.deepEqual(checkSettingsSchema(manifest(fields(4, 'x'.repeat(1400)))).errors, []);
  assert.deepEqual(checkSettingsSchema(manifest(fields(4, 'x'.repeat(1600)))).errors, ['settings: the defaults together take 6433 bytes; the limit is 6 KiB']);
  // Bytes, not characters: these defaults are 4,033 characters but 8,033 bytes.
  assert.deepEqual(checkSettingsSchema(manifest(fields(4, 'é'.repeat(1000)))).errors, ['settings: the defaults together take 8033 bytes; the limit is 6 KiB']);
});

test('a format named like an Object.prototype method is an unknown format: values are accepted, with an install warning', () => {
  for (const format of ['__defineGetter__', 'isPrototypeOf']) {
    const m = manifest({ a: { type: 'string', format } });
    assert.deepEqual(validateSettings(m, { a: 'anything' }), [], format);
    assert.deepEqual(resolveSettings(m, { a: 'anything' }), { a: 'anything' }, format);
    assert.deepEqual(checkSettingsSchema(m), { errors: [], warnings: [`settings.a: format "${format}" isn't one the settings form knows (color, date, time, uri)`] });
  }
});

test('settings formats are what a form writes: a colour, a local time of day, a web address', () => {
  const m = manifest({ c: { type: 'string', format: 'color' }, t: { type: 'string', format: 'time' }, u: { type: 'string', format: 'uri' } });
  assert.deepEqual(validateSettings(m, { c: '#abc', t: '21:30', u: 'https://example.com/poster.png' }), []);
  assert.deepEqual(validateSettings(m, { t: '21:30Z', u: 'javascript:alert(1)' }).map((e) => e.path).sort(), ['/t', '/u']);
  // A long value is refused by its length before any pattern runs on it.
  const p = manifest({ s: { type: 'string', pattern: '^a+$' } });
  assert.match(validateSettings(p, { s: 'a'.repeat(5000) })[0].message, /at most 4096 characters/);
});

test('a media field holds an uploaded file or an https URL, in arrays too; the uri format is https only', () => {
  const m = manifest({
    poster: { type: 'string', 'x-skp-widget': 'media' },
    gallery: { type: 'array', items: { type: 'string', 'x-skp-widget': 'media' } },
    link: { type: 'string', format: 'uri' },
  });
  for (const ok of ['/media/f_01-AB/poster.png', 'https://cdn.example/a.png']) {
    assert.deepEqual(validateSettings(m, { poster: ok, gallery: [ok] }), [], ok);
  }
  const message = 'must be an uploaded file (/media/…) or an https URL';
  for (const bad of ['http://cdn.example/a.png', 'javascript:alert(1)', '/etc/passwd', '/media/../x', '/media/f1/../../x']) {
    assert.deepEqual(validateSettings(m, { poster: bad, gallery: ['/media/f1/ok.png', bad] }), [
      { path: '/poster', message },
      { path: '/gallery/1', message },
    ], bad);
  }
  assert.deepEqual(validateSettings(m, { link: 'http://example.com/a.png' }).map((e) => e.path), ['/link']);
  assert.deepEqual(validateSettings(m, { link: 'https://example.com/a.png' }), []);
  // A refused value falls back to the default, and a default must itself be a media value.
  const withDefault = manifest({ poster: { type: 'string', 'x-skp-widget': 'media', default: '/media/f1/default.png' } });
  assert.deepEqual(resolveSettings(withDefault, { poster: 'http://cdn.example/a.png' }), { poster: '/media/f1/default.png' });
  assert.match(checkSettingsSchema(manifest({ poster: { type: 'string', 'x-skp-widget': 'media', default: '/etc/passwd' } })).errors.join(), /must be an uploaded file/);
});

test('a media file name can\'t be a dot segment: a browser resolves /media/<id>/.. (or %2e%2e) to /media/, no uploaded file', () => {
  const m = manifest({
    poster: { type: 'string', 'x-skp-widget': 'media' },
    gallery: { type: 'array', items: { type: 'string', 'x-skp-widget': 'media' } },
  });
  const message = 'must be an uploaded file (/media/…) or an https URL';
  for (const bad of ['/media/f1/..', '/media/f1/.', '/media/f1/%2e%2e', '/media/f1/%2E%2E', '/media/f1/.%2e', '/media/f1/%2e']) {
    assert.deepEqual(validateSettings(m, { poster: bad, gallery: ['/media/f1/ok.png', bad] }), [
      { path: '/poster', message },
      { path: '/gallery/1', message },
    ], bad);
  }
  // A name that merely starts with dots is a file name like any other.
  assert.deepEqual(validateSettings(m, { poster: '/media/f1/..png', gallery: ['/media/f1/.hidden', '/media/f1/...'] }), []);
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

test('settings sizes are UTF-8 bytes of JSON: saved settings are limited to 24 KiB, not 24K characters', async (t) => {
  assert.equal(jsonBytes({ a: 'é' }), 10);
  assert.equal(jsonBytes('😀'), 6);
  assert.equal(SAVED_BYTES, 24 * 1024);
  const { platform } = await startWithOverlay(t);
  // 13,000 characters, 26,000 bytes: too large in bytes only (and checked before the field's own limits).
  assert.throws(() => platform.overlays.create({ slug: 'wide', template: DIAG, settings: { accent: 'é'.repeat(13000) } }), (err) => {
    assert.equal(err.code, 'bad-settings');
    assert.match(err.message, /limited to 24 KiB/);
    return true;
  });
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

test('upgrade: a saved value for a field that became a group is listed as invalid', () => {
  const v1 = manifest({ colors: { type: 'string', default: '#000000' } });
  const v2 = manifest({ colors: { type: 'object', properties: { text: { type: 'string', default: '#ffffff' } } } });
  const { settings, changes } = migrateSettings(v1, v2, { colors: '#000000' });
  assert.deepEqual(settings, { colors: {} });
  assert.deepEqual(changes, [
    { path: '/colors', change: 'invalid', from: '#000000' },
    { path: '/colors/text', change: 'added', to: '#ffffff' },
  ]);
});

test('upgrade: a changed default is listed for settings named like Object.prototype members too', () => {
  const v1 = manifest({ constructor: { type: 'string', default: 'a' }, toString: { type: 'string', default: 'x' } });
  const v2 = manifest({ constructor: { type: 'string', default: 'b' }, toString: { type: 'string', default: 'y' } });
  assert.deepEqual(migrateSettings(v1, v2, {}), {
    settings: {},
    changes: [
      { path: '/constructor', change: 'default', from: 'a', to: 'b' },
      { path: '/toString', change: 'default', from: 'x', to: 'y' },
    ],
  });
});

test('upgrade: a new setting migrate.js filled shows that value; changes carry the state key a field is bound to', () => {
  const v1 = manifest({ old: { type: 'string' } });
  const v2 = manifest({ fresh: { type: 'string', default: 'd' } });
  assert.deepEqual(migrateSettings(v1, v2, { fresh: 'from migrate.js' }).changes, [{ path: '/fresh', change: 'added', to: 'from migrate.js', saved: true }]);
  assert.deepEqual(migrateSettings(v1, v2, {}).changes, [{ path: '/fresh', change: 'added', to: 'd' }]);

  const b1 = manifest({ mode: { type: 'integer', default: 1 }, label: { type: 'string', default: 'a', 'x-skp-bind': 'custom.label' } });
  const b2 = manifest({
    mode: { type: 'integer', default: 1, maximum: 5, 'x-skp-bind': 'custom.mode' },
    label: { type: 'string', default: 'b', 'x-skp-bind': 'custom.label' },
    headliner: { type: 'string', 'x-skp-bind': 'show.headliner' },
    host: { type: 'string', 'x-skp-bind': 'custom.host' },
  });
  assert.deepEqual(migrateSettings(b1, b2, { mode: 9, host: 'BIA' }), {
    settings: { host: 'BIA' },
    changes: [
      { path: '/mode', change: 'invalid', from: 9, to: 1, bind: 'custom.mode' },
      { path: '/label', change: 'default', from: 'a', to: 'b', bind: 'custom.label' },
      { path: '/headliner', change: 'added', to: undefined, bind: 'show.headliner' },
      { path: '/host', change: 'added', to: 'BIA', saved: true, bind: 'custom.host' },
    ],
  });
});

test('diffSettings lists what migrate.js changed leaf by leaf: groups compared field by field, arrays whole, removed and added keys with an undefined side', () => {
  const before = { same: 1, g: { x: 1, list: [1, 2], h: { z: 1 } }, gone: 'x' };
  const after = { same: 1, g: { x: 2, list: [1, 3], h: { z: 1 } }, fresh: true, constructor: 'c' };
  assert.deepEqual(diffSettings(before, after), [
    { path: '/g/x', from: 1, to: 2 },
    { path: '/g/list', from: [1, 2], to: [1, 3] },
    { path: '/gone', from: 'x', to: undefined },
    { path: '/fresh', from: undefined, to: true },
    { path: '/constructor', from: undefined, to: 'c' },
  ]);
  assert.deepEqual(diffSettings({ list: [1, { a: 1 }] }, { list: [1, { a: 1 }] }), []);
  // A group replaced by a plain value compares whole.
  assert.deepEqual(diffSettings({ g: { x: 1 } }, { g: 'flat' }), [{ path: '/g', from: { x: 1 }, to: 'flat' }]);
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
  await fails('function migrate() { for (;;) {} }', /timed out|took longer/);
  // The worker's memory limit ends a memory bomb long before a generous deadline would.
  await assert.rejects(runMigrate('function migrate() { const a = []; for (;;) a.push(new Array(1e6).fill(1)); }', '1.0.0', {}, { timeoutMs: 20000 }), (err) => {
    assert.ok(err instanceof MigrateError, String(err));
    assert.match(err.message, /ran out of memory/);
    return true;
  });
  await fails('async function migrate() { return {}; }', /promise/);
  await fails('function migrate() { return 5; }', /as an object/);
  await fails('function notMigrate() {}', /must define migrate/);
  await fails('this is not javascript', /failed/);
});

test('migrate.js may use a named default export, and may show an export in a comment before the real one', async () => {
  assert.deepEqual(await runMigrate('export default function renameAll(from, s) { return { renamed: s.a, from }; }', '1.0.0', { a: 1 }), { renamed: 1, from: '1.0.0' });
  const commented = '/* For example:\n  export function migrate(v, s) { return {}; }\n*/\nexport function migrate(v, s) { return { real: true }; }';
  assert.deepEqual(await runMigrate(commented, '1.0.0', {}), { real: true });
  assert.equal(migrateProblem(commented), undefined);
});

test('migrate.js that compiles as it is runs as it is: an export inside a template literal is left alone', async () => {
  const literal = 'function migrate(v, s) { return { text: `\nexport function migrate(x)` }; }';
  assert.equal(classicMigrate(literal), literal);
  assert.deepEqual(await runMigrate(literal, '1.0.0', {}), { text: '\nexport function migrate(x)' });
});

test('only the parser decides what is an import in migrate.js; a file that doesn\'t compile with an export gets a hint', async () => {
  const mentions = '// nothing to import here\n/*\nimport x from "y" would be refused\n*/\nfunction migrate(v, s) { return { a: "import(", b: \'import x from "y"\' }; }';
  assert.equal(migrateProblem(mentions), undefined);
  assert.deepEqual(await runMigrate(mentions, '1.0.0', {}), { a: 'import(', b: 'import x from "y"' });
  assert.deepEqual(migrateProblem('import x from "y";\nexport function migrate(v, s) { return s; }'), { code: 'migrate-import', message: 'migrate.js can\'t import anything; it runs with no I/O.' });
  const broken = migrateProblem('export function migrate(v, s) { return s');
  assert.equal(broken.code, 'migrate-syntax');
  assert.match(broken.message, /doesn't compile: Unexpected end of input\. It runs as a classic script/);
  assert.equal(migrateProblem('export const migrate = (v, s) => s;').code, 'migrate-syntax');
  assert.match(migrateProblem('export const migrate = (v, s) => s;').message, /classic script/);
  // Without an export there is nothing to hint at.
  assert.doesNotMatch(migrateProblem('function migrate(v, s) { return s').message, /classic script/);
});

test('migrate.js can\'t return more settings than an overlay can save', async () => {
  assert.equal(MAX_RESULT_CHARS, 64 * 1024);
  await assert.rejects(runMigrate('function migrate() { return { big: "x".repeat(70000) }; }', '1.0.0', {}), (err) => {
    assert.ok(err instanceof MigrateError, String(err));
    assert.match(err.message, /more settings than an overlay can save/);
    return true;
  });
  assert.equal((await runMigrate('function migrate() { return { big: "x".repeat(60000) }; }', '1.0.0', {})).big.length, 60000);
});
