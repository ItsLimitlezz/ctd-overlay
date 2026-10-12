// The JSON Schema validator: each keyword, the standard's own schemas against real documents, and
// the bounds that keep a template's schema from hanging the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { MAX_DEPTH, SchemaError, validate } from '../src/schema.js';

const schemaDir = new URL('../docs/standard/schemas/', import.meta.url);
const schemaOf = (name) => JSON.parse(readFileSync(new URL(name, schemaDir), 'utf8'));
const messages = (schema, value) => validate(schema, value).map((e) => `${e.path} ${e.message}`);

test('types, enum and const', () => {
  assert.deepEqual(messages({ type: 'integer' }, 3), []);
  assert.deepEqual(messages({ type: 'integer' }, 3.5), ['/ must be an integer']);
  assert.deepEqual(messages({ type: 'number' }, NaN), ['/ must be a number']);
  assert.deepEqual(messages({ type: ['string', 'null'] }, null), []);
  assert.deepEqual(messages({ type: 'object' }, []), ['/ must be an object']);
  assert.deepEqual(messages({ enum: ['a', { b: 1 }] }, { b: 1 }), []);
  assert.deepEqual(messages({ enum: ['a', 'b'] }, 'c'), ['/ must be one of "a", "b"']);
  assert.deepEqual(messages({ const: 'skp/1' }, 'skp/2'), ['/ must be "skp/1"']);
  assert.deepEqual(messages(false, 1), ['/ is not allowed here']);
  assert.deepEqual(messages(true, 1), []);
});

test('strings: length in code points, unicode patterns, formats', () => {
  assert.deepEqual(messages({ maxLength: 2 }, '😀😀'), []); // two code points, four UTF-16 units
  assert.deepEqual(messages({ minLength: 1 }, ''), ['/ must be at least 1 characters']);
  assert.deepEqual(messages({ pattern: '^\\p{Lu}' }, 'Abc'), []);
  assert.deepEqual(messages({ pattern: '^[a-z]+$' }, 'abc1'), ['/ must match ^[a-z]+$']);
  const fmt = (format, value) => validate({ format }, value).length === 0;
  assert.ok(fmt('uri', 'https://fonts.googleapis.com/css2?family=Archivo'));
  assert.ok(!fmt('uri', 'not a uri') && !fmt('uri', '/relative/path'));
  assert.ok(fmt('date', '2026-08-28') && !fmt('date', '2026-02-30') && !fmt('date', '26-08-28'));
  assert.ok(fmt('date', '0050-01-01') && fmt('date', '0000-02-29') && !fmt('date', '0100-02-29'), 'years 0000–0099 are years, not 1900–1999');
  // RFC 3339 full-time: seconds and an offset are required; 60 is a leap second.
  assert.ok(fmt('time', '21:30:05Z') && fmt('time', '21:30:05.25+02:00') && fmt('time', '23:59:60Z'));
  assert.ok(!fmt('time', '21:30') && !fmt('time', '21:30:05') && !fmt('time', '24:00:00Z'));
  assert.ok(fmt('date-time', '2026-08-28T21:30:00Z') && !fmt('date-time', '2026-08-28 21:30') && !fmt('date-time', '2026-08-28T21:30Z'));
  assert.ok(fmt('color', '#EFC33F') && fmt('color', '#fff') && !fmt('color', 'gold') && !fmt('color', '#ggg'));
  assert.ok(fmt('something-unknown', 'anything'), 'unknown formats are annotations');
  // A format name is looked up among the formats, never on Object.prototype.
  for (const name of ['constructor', '__defineGetter__', 'isPrototypeOf', 'toString']) assert.ok(fmt(name, 'anything'), name);
  assert.deepEqual(messages({ type: 'string', format: 'color' }, 7), ['/ must be a string']);
});

test('a pattern check can be handed to a match function: true, false, or null when it couldn\'t check in time', () => {
  const calls = [];
  const match = (pattern, value) => {
    calls.push(value);
    return value === 'slow' ? null : value === 'yes';
  };
  const run = (schema, value, opts = {}) => validate(schema, value, { match, ...opts }).map((e) => `${e.path} ${e.message}`);
  assert.deepEqual(run({ pattern: '^yes$' }, 'yes'), []);
  assert.deepEqual(run({ pattern: '^yes$' }, 'no'), ['/ must match ^yes$']);
  assert.deepEqual(run({ pattern: '^yes$' }, 'slow'), ['/ couldn\'t be checked against ^yes$ in time']);
  assert.deepEqual(calls, ['yes', 'no', 'slow']);
  // A pattern never runs on a value over either length limit, and a value over both is one error.
  calls.length = 0;
  assert.deepEqual(run({ pattern: '^yes$', maxLength: 2 }, 'long'), ['/ must be at most 2 characters']);
  assert.deepEqual(run({ pattern: '^yes$', maxLength: 10 }, 'x'.repeat(20), { maxStringLength: 5 }), ['/ must be at most 5 characters']);
  assert.deepEqual(calls, []);
});

test('multipleOf is exact for large quotients and allows decimal rounding', () => {
  assert.deepEqual(messages({ multipleOf: 2 }, 2000000000001), ['/ must be a multiple of 2']);
  assert.deepEqual(messages({ multipleOf: 1 }, 1234567890123.5), ['/ must be a multiple of 1']);
  assert.deepEqual(messages({ multipleOf: 0.5 }, 1e13 + 0.25), ['/ must be a multiple of 0.5']);
  assert.deepEqual(messages({ multipleOf: 0.1 }, 0.3), []);
  assert.deepEqual(messages({ multipleOf: 0.01 }, 19.99), []);
  assert.deepEqual(messages({ multipleOf: 3 }, 9e15), []);
});

test('$ref is a JSON pointer: "#" or "#/…", into objects and arrays; anything else is refused', () => {
  const root = { $defs: { list: [{ type: 'string' }, { type: 'integer' }], 'a/b': { type: 'boolean' } } };
  assert.deepEqual(validate({ ...root, $ref: '#/$defs/list/1' }, 3), []);
  assert.equal(validate({ ...root, $ref: '#/$defs/list/1' }, 'x').length, 1);
  assert.deepEqual(validate({ ...root, $ref: '#/$defs/a~1b' }, true), []);
  for (const ref of ['#foo', '#$defs/list', '#/$defs/list/01', '#/$defs/list/2', '#/$defs/nope', '#/%E0%A4%A']) {
    assert.throws(() => validate({ ...root, properties: { a: { $ref: ref } } }, { a: 1 }), SchemaError, ref);
  }
});

test('numbers and arrays', () => {
  assert.deepEqual(messages({ minimum: 0, maximum: 200 }, 201), ['/ must be at most 200']);
  assert.deepEqual(messages({ exclusiveMinimum: 0 }, 0), ['/ must be more than 0']);
  assert.deepEqual(messages({ multipleOf: 0.1 }, 0.3), []);
  assert.deepEqual(messages({ items: { type: 'string' }, minItems: 1, maxItems: 2 }, ['a', 2, 'c']), ['/1 must be a string', '/ must have at most 2 items']);
  assert.deepEqual(messages({ uniqueItems: true }, [1, { a: 1 }, { a: 1 }]), ['/ must not repeat an item']);
  assert.deepEqual(messages({ prefixItems: [{ type: 'string' }], items: { type: 'number' } }, ['a', 1, 'b']), ['/2 must be a number']);
});

test('objects: required, additional and pattern properties, dependentRequired, paths escaped', () => {
  const schema = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' }, 'a/b': { type: 'number' } },
    patternProperties: { '^x-': { type: 'string' } },
    additionalProperties: false,
    dependentRequired: { then: ['durationMs'] },
  };
  assert.deepEqual(messages(schema, { id: 'x', 'x-note': 'ok' }), []);
  assert.deepEqual(messages(schema, { 'a/b': 'no', extra: 1, then: 'program' }).sort(), [
    '/ must have "durationMs" when it has "then"', '/ must have "id"', '/a~1b must be a number', '/extra is not a known field', '/then is not a known field',
  ]);
  assert.deepEqual(messages({ additionalProperties: { type: 'integer' } }, { n: 1, m: 'x' }), ['/m must be an integer']);
  // "__proto__" is an ordinary key in JSON, and must be validated like one.
  assert.deepEqual(messages(JSON.parse('{"properties": {"__proto__": {"type": "string"}}}'), JSON.parse('{"__proto__": 5}')), ['/__proto__ must be a string']);
  assert.deepEqual(messages({ properties: { id: { type: 'string' } } }, JSON.parse('{"__proto__": 5}')), []);
});

test('combinators and references', () => {
  const root = { $defs: { action: { type: 'object', required: ['kind'] } }, properties: { a: { $ref: '#/$defs/action' } } };
  assert.deepEqual(messages(root, { a: {} }), ['/a must have "kind"']);
  assert.deepEqual(messages({ oneOf: [{ type: 'null' }, { type: 'object' }] }, 1), ['/ must match one of the allowed shapes']);
  assert.deepEqual(messages({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1), ['/ must match exactly one of the allowed shapes']);
  assert.deepEqual(messages({ anyOf: [{ type: 'number' }, { type: 'string' }] }, 'x'), []);
  assert.deepEqual(messages({ not: { type: 'string' } }, 'x'), ['/ must not match the excluded shape']);
  assert.deepEqual(messages({ if: { properties: { kind: { const: 'gift' } } }, then: { required: ['gift'] } }, { kind: 'gift' }), ['/ must have "gift"']);
  assert.throws(() => validate({ $ref: '#/nowhere' }, 1), SchemaError);
  assert.throws(() => validate({ $ref: 'https://example.com/schema.json' }, 1), SchemaError);
});

test('a hostile schema is an error, not a hang or a crash', () => {
  assert.throws(() => validate({ $ref: '#' }, 1), SchemaError); // a cycle that consumes nothing
  let deep = { type: 'object' };
  for (let i = 0; i < MAX_DEPTH + 5; i++) deep = { properties: { a: deep } };
  let value = {};
  for (let i = 0; i < MAX_DEPTH + 5; i++) value = { a: value };
  assert.throws(() => validate(deep, value), SchemaError);
  // Nested anyOf whose branches all fail late branch exponentially without the step budget.
  let bomb = { type: 'string' };
  for (let i = 0; i < 40; i++) bomb = { anyOf: [bomb, bomb] };
  const t0 = Date.now();
  assert.throws(() => validate(bomb, 1), SchemaError);
  assert.ok(Date.now() - t0 < 2000);
  assert.throws(() => validate({ pattern: '(' }, 'x'), SchemaError);
  assert.throws(() => validate({ type: 'thing' }, 'x'), SchemaError);
});

test('the standard\'s own schemas compile, and accept the standard\'s examples', () => {
  for (const name of readdirSync(schemaDir)) {
    const schema = schemaOf(name);
    assert.doesNotThrow(() => validate(schema, {}), name); // every $ref resolves, every pattern compiles
  }
  const manifest = {
    standard: 'skp/1', id: 'com.dprtmnt.vikkstar-event', name: 'VIKKSTAR × D/PRTMNT', version: '1.2.0',
    category: 'show', entry: 'index.html', previews: ['previews/starting.jpg'],
    canvases: [{ id: 'h', width: 1920, height: 1080, default: true }],
    scenes: [{ id: 'intro', label: 'Event Intro', core: 'intro', durationMs: 8000, then: 'program' }],
    author: { name: 'D/PRTMNT', url: 'https://dprtmnt.com' }, fonts: ['https://fonts.googleapis.com/css2?family=Archivo:wght@700;900'],
  };
  assert.deepEqual(messages(schemaOf('template.schema.json'), manifest), []);
  for (const dir of ['../templates/diagnostic/', './fixtures/templates/testbed/']) {
    const m = JSON.parse(readFileSync(new URL(`${dir}template.json`, import.meta.url), 'utf8'));
    assert.deepEqual(messages(schemaOf('template.schema.json'), m), [], dir);
  }
  const bad = { ...manifest, standard: 'skp/2', id: 'NotReverseDns', scenes: [{ id: 'x', label: 'X', then: 'program' }] };
  assert.deepEqual(messages(schemaOf('template.schema.json'), bad).sort(), [
    '/id must match ^[a-z0-9]+(\\.[a-z0-9-]+){2,}$', '/scenes/0 must have "durationMs" when it has "then"', '/standard must be "skp/1"',
  ]);
});
