// A JSON Schema (draft 2020-12) validator for the keywords the standard's schemas and template
// settings use, with no dependencies (decision 8). Template manifests, settings and, later, API
// bodies (07 §7.11) are checked with it.
//
//   validate(schema, value, { root }) → [{ path: '/scenes/2/id', message: 'must match …' }]
//
// Supported: true/false schemas, $ref to a JSON pointer inside the root ("#/definitions/x",
// "#/$defs/x"), type, enum, const, minLength, maxLength, pattern, format, minimum, maximum,
// exclusiveMinimum, exclusiveMaximum, multipleOf, items, prefixItems, minItems, maxItems,
// uniqueItems, properties, required, additionalProperties, patternProperties, propertyNames,
// minProperties, maxProperties, dependentRequired, allOf, anyOf, oneOf, not, if/then/else. Other
// keywords (title, default, x-skp-* …) are annotations and ignored here. Schemas can come from a
// template, so the work is bounded: a $ref cycle, a schema nested deeper than MAX_DEPTH, or more
// than MAX_STEPS checks in one validation (nested anyOf/oneOf can branch exponentially) is a
// SchemaError, never a stack overflow or a hung server.
export const MAX_DEPTH = 64;
export const MAX_STEPS = 200000;

export const FORMATS = {
  uri: (s) => /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]*$/.test(s) && parses(s),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && validDate(s),
  time: (s) => /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)?$/i.test(s),
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/i.test(s) && validDate(s.slice(0, 10)),
  color: (s) => /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s),
};

export class SchemaError extends Error {}

// maxStringLength: a string longer than this fails as too long before any pattern or format runs
// on it (a template's pattern is then never tried on a huge value).
export function validate(schema, value, { root = schema, formats = FORMATS, maxStringLength = Infinity } = {}) {
  const errors = [];
  check(schema, value, '', { root, formats, errors, depth: 0, steps: { n: 0 }, maxStringLength });
  return errors;
}

function check(schema, value, path, ctx) {
  if (schema === true || schema === undefined) return;
  if (schema === false) return fail(ctx, path, 'is not allowed here');
  if (!isObject(schema)) throw new SchemaError(`the schema at ${path || '/'} is not an object`);
  if (ctx.depth > MAX_DEPTH) throw new SchemaError(`the schema is nested more than ${MAX_DEPTH} deep (or a $ref refers to itself)`);
  if (++ctx.steps.n > MAX_STEPS) throw new SchemaError('the schema is too complex to check');
  const inner = { ...ctx, depth: ctx.depth + 1 };

  if (schema.$ref !== undefined) check(resolve(ctx.root, schema.$ref), value, path, inner);

  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some((t) => isType(value, t))) return fail(ctx, path, `must be ${types.map(article).join(' or ')}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((v) => equal(v, value))) fail(ctx, path, `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  if (schema.const !== undefined && !equal(schema.const, value)) fail(ctx, path, `must be ${JSON.stringify(schema.const)}`);

  if (typeof value === 'string') {
    const length = [...value].length; // code points, as the spec counts
    if (schema.minLength !== undefined && length < schema.minLength) fail(ctx, path, `must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && length > schema.maxLength) fail(ctx, path, `must be at most ${schema.maxLength} characters`);
    if (length > ctx.maxStringLength) fail(ctx, path, `must be at most ${ctx.maxStringLength} characters`);
    else {
      if (schema.pattern !== undefined && !regex(schema.pattern).test(value)) fail(ctx, path, `must match ${schema.pattern}`);
      if (schema.format !== undefined && ctx.formats[schema.format] && !ctx.formats[schema.format](value)) fail(ctx, path, `must be a valid ${schema.format}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(ctx, path, `must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(ctx, path, `must be at most ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail(ctx, path, `must be more than ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) fail(ctx, path, `must be less than ${schema.exclusiveMaximum}`);
    if (schema.multipleOf !== undefined && !Number.isInteger(Number((value / schema.multipleOf).toPrecision(12)))) fail(ctx, path, `must be a multiple of ${schema.multipleOf}`);
  }

  if (Array.isArray(value)) {
    const prefix = schema.prefixItems || [];
    prefix.forEach((s, i) => { if (i < value.length) check(s, value[i], `${path}/${i}`, inner); });
    if (schema.items !== undefined) for (let i = prefix.length; i < value.length; i++) check(schema.items, value[i], `${path}/${i}`, inner);
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(ctx, path, `must have at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(ctx, path, `must have at most ${schema.maxItems} items`);
    if (schema.uniqueItems && value.some((v, i) => value.findIndex((w) => equal(v, w)) !== i)) fail(ctx, path, 'must not repeat an item');
  }

  if (isObject(value)) {
    const keys = Object.keys(value);
    for (const key of schema.required || []) if (!has(value, key)) fail(ctx, path, `must have "${key}"`);
    const props = schema.properties || {};
    const patterns = Object.entries(schema.patternProperties || {}).map(([p, s]) => [regex(p), s]);
    for (const key of keys) {
      const at = `${path}/${pointerEscape(key)}`;
      let matched = false;
      if (has(props, key)) { matched = true; check(props[key], value[key], at, inner); }
      for (const [re, s] of patterns) if (re.test(key)) { matched = true; check(s, value[key], at, inner); }
      if (!matched && schema.additionalProperties !== undefined) {
        if (schema.additionalProperties === false) fail(ctx, at, 'is not a known field');
        else check(schema.additionalProperties, value[key], at, inner);
      }
      if (schema.propertyNames !== undefined) check(schema.propertyNames, key, at, inner);
    }
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) fail(ctx, path, `must have at least ${schema.minProperties} fields`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) fail(ctx, path, `must have at most ${schema.maxProperties} fields`);
    for (const [key, needs] of Object.entries(schema.dependentRequired || {})) {
      if (has(value, key)) for (const other of needs) if (!has(value, other)) fail(ctx, path, `must have "${other}" when it has "${key}"`);
    }
  }

  for (const s of schema.allOf || []) check(s, value, path, inner);
  if (schema.anyOf !== undefined && !schema.anyOf.some((s) => passes(s, value, path, inner))) fail(ctx, path, 'must match one of the allowed shapes');
  if (schema.oneOf !== undefined) {
    const n = schema.oneOf.filter((s) => passes(s, value, path, inner)).length;
    if (n !== 1) fail(ctx, path, n === 0 ? 'must match one of the allowed shapes' : 'must match exactly one of the allowed shapes');
  }
  if (schema.not !== undefined && passes(schema.not, value, path, inner)) fail(ctx, path, 'must not match the excluded shape');
  if (schema.if !== undefined) {
    const branch = passes(schema.if, value, path, inner) ? schema.then : schema.else;
    if (branch !== undefined) check(branch, value, path, inner);
  }
}

function passes(schema, value, path, ctx) {
  const errors = [];
  check(schema, value, path, { ...ctx, errors });
  return errors.length === 0;
}

function fail(ctx, path, message) {
  ctx.errors.push({ path: path || '/', message });
}

// "#", "#/definitions/settings", "#/$defs/a~1b" inside the root document. Nothing remote.
export function resolve(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) throw new SchemaError(`"${ref}" is not a reference inside this document`);
  let node = root;
  for (const part of ref.slice(1).split('/').slice(1)) {
    const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(node) || !has(node, key)) throw new SchemaError(`"${ref}" points at nothing`);
    node = node[key];
  }
  return node;
}

const regexCache = new Map();
function regex(source) {
  let re = regexCache.get(source);
  if (!re) {
    try {
      re = new RegExp(source, 'u');
    } catch (err) {
      throw new SchemaError(`the pattern ${source} is not a valid regular expression`);
    }
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(source, re);
  }
  return re;
}

function isType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return isObject(value);
    default: throw new SchemaError(`"${type}" is not a JSON Schema type`);
  }
}

export function equal(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => has(b, k) && equal(a[k], b[k]));
}

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const pointerEscape = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
const article = (t) => ({ array: 'an array', integer: 'an integer', object: 'an object', null: 'null' }[t] || `a ${t}`);

function parses(s) {
  try {
    new URL(s); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
}

function validDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
