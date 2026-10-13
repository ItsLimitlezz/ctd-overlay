// Event types, state keys, and the patterns templates use to declare what they consume.

// Registered types (02 §2.6) plus the two custom namespaces (02 §2.7).
export const TYPE = /^(state\.changed|chat\.(message|message\.deleted|user\.cleared|cleared)|alert\.[a-z]+|alerts\.cut|show\.(scene\.changed|trigger|cue\.fired)|media\.(play|stop)|system\.(connection|notice)|custom\.[a-z0-9_.-]+|x-[a-z0-9-]+\.[a-z0-9_.-]+)$/;

// Dotted keys. The standard's own keys use camelCase segments (show.recStartedAt), so segments
// may contain capitals; the first segment starts with a lowercase letter.
export const KEY = /^[a-z][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

const CUSTOM = /^(custom|x-[a-z0-9-]+)\./;

// External apps may only publish into custom.* and x-<vendor>.* (02 §2.7); everything else is
// reserved for the standard.
export const isCustom = (name) => CUSTOM.test(name);

// Operator-facing only; never sent to an overlay (02 §2.6).
export const OPERATOR_ONLY = new Set(['system.connection', 'system.notice']);

// What the runtime itself needs, whatever the template declared: scene changes and triggers
// for its actions, the overlay's settings and its scene.
export const RUNTIME_TYPES = new Set(['show.scene.changed', 'show.trigger']);
export const RUNTIME_KEYS = new Set(['overlay.settings', 'show.scene']);

export const CHAT_TYPES = new Set(['chat.message', 'chat.message.deleted', 'chat.user.cleared', 'chat.cleared']);

// consumes patterns: an exact name, or a prefix ending in ".*" (`alert.*`, `show.*`).
export function compilePatterns(patterns = [], what = 'pattern') {
  const exact = new Set();
  const prefixes = [];
  for (const p of patterns) {
    if (typeof p !== 'string') throw new TypeError(`${what} must be a string (got ${JSON.stringify(p)})`);
    if (p.endsWith('.*')) {
      const prefix = p.slice(0, -1);
      if (!KEY.test(prefix.slice(0, -1))) throw new TypeError(`bad ${what} "${p}"`);
      prefixes.push(prefix);
    } else {
      if (!KEY.test(p)) throw new TypeError(`bad ${what} "${p}"`);
      exact.add(p);
    }
  }
  const test = (name) => exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
  test.patterns = [...patterns];
  return test;
}
