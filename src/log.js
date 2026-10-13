// Structured JSON-lines logging (10 §10.8): one object per line with ts, level, msg, component
// and context. Secrets are redacted here, at the logger, so a call site can't leak one by
// accident: values under secret-looking keys, overlay keys and tokens inside URLs, bearer
// credentials, and SKP tokens anywhere in a string.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /pass(word|phrase)?|secret|token|authorization|cookie|credential|api[-_]?key|master[-_]?key|private[-_]?key|^key$/i;

const SECRET_STRINGS = [
  [/\b(skp_(?:pat|ovl)_)[A-Za-z0-9]+/g, '$1[redacted]'],
  [/([?&](?:key|token|access_token|refresh_token|code|client_secret)=)[^&#\s"']+/gi, '$1[redacted]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]'],
  [/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, '$1[redacted]'], // GitHub tokens (template sources)
];

export const REDACTED = '[redacted]';

export function redactString(s) {
  let out = s;
  for (const [re, rep] of SECRET_STRINGS) out = out.replace(re, rep);
  return out;
}

// A JSON-safe copy of any value with secrets removed. Handles errors, cycles and deep nesting.
export function redact(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depth > 6) return '[too deep]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (value instanceof Error) {
    const out = { name: value.name, message: redactString(String(value.message)) };
    if (value.code !== undefined) out.code = value.code;
    if (value.stack) out.stack = redactString(String(value.stack));
    if (value.cause !== undefined) out.cause = redact(value.cause, depth + 1, seen);
    return out;
  }
  if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) && v !== undefined && v !== null && v !== '' ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}

export function createLogger({ level = 'info', write = (line) => process.stdout.write(line), component = 'core', now = () => new Date() } = {}) {
  if (!(level in LEVELS)) throw new Error(`unknown log level "${level}"`);
  const threshold = LEVELS[level];

  const make = (comp) => {
    const emit = (lvl, msg, context) => {
      if (LEVELS[lvl] < threshold) return;
      const entry = { ts: now().toISOString(), level: lvl, msg: redactString(String(msg)), component: comp };
      if (context !== undefined) entry.context = redact(context);
      try { write(JSON.stringify(entry) + '\n'); } catch { /* a closed stdout must not take the process down */ }
    };
    return {
      debug: (msg, context) => emit('debug', msg, context),
      info: (msg, context) => emit('info', msg, context),
      warn: (msg, context) => emit('warn', msg, context),
      error: (msg, context) => emit('error', msg, context),
      child: (name) => make(name),
    };
  };
  return make(component);
}

// A logger that drops everything; handy in tests that don't look at logs.
export const silentLogger = createLogger({ write: () => {} });
