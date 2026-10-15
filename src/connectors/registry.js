// Connector definitions (06 §6.1): what a connector is, checked once when the platform starts, so
// a mistake in one shows at startup with its name, never as a crash mid-show. Built in: CTD
// Multi-Stream (step 16b); Twitch and Kick (17), OBS (18) and the rest follow.
//
//   {
//     id: 'ctd-multistream', name: 'CTD Multi-Stream',
//     platform?: 'twitch',                     its main platform (src.platform by default)
//     platforms?: ['twitch', …],               every platform it may speak for (default [platform])
//     vendor?: 'ctd',                          may publish x-ctd.* events and state
//     relay?: true,                            relays other platforms: a direct connection wins ties
//     capabilities: ['chat.read', 'alerts', 'viewers', 'stream.status', 'music', 'obs'],
//     auth: 'device-code' | 'oauth-pkce' | 'oauth-code' | 'client-credentials' | 'password' | 'none',
//     userAuth?: 'required' | 'optional' | 'none',   an account sign-in (OAuth flows; default:
//                                              required for the OAuth flows, none otherwise)
//     oauth?: { authorizeUrl, tokenUrl, deviceUrl?, revokeUrl?, scopes: [{ scope, why }],
//               appScopes?, pkce? (default true), clientAuth?: 'body' | 'basic' | 'none',
//               extraParams?, scopeSeparator?, client?: { id: 'clientId', secret: 'clientSecret' } },
//     endpoints?: { api: 'https://…' },        base URLs (a test points them at a fake service)
//     fields: JSON Schema object               its settings: a writeOnly field is a secret,
//                                              x-skp-egress: 'lan' an address the operator types,
//                                              x-skp-reauth: changing it signs the account out
//     requiresPublicUrl?, holdOnError? (default true: values held 120 s on an error, 02 §2.8),
//     guide: { before?, steps: ['… {redirectUri} …'], warnings?: [{ when?, text }], links? },
//     actions?: { name: { label, args?: JSON Schema, scope? } },
//     validate?(config, secrets) → problem text | undefined,
//     identify?(ctx) → { id, login, name },    who signed in (after a sign-in)
//     fromV0?(pending, { secret }) → { name, config, secrets } | undefined,
//     inbound?(ctx, { headers, body, query }) → { status, body? },   POST /hooks/<id>
//     create(ctx) → { start(), stop(), test?(), actions?: { name: async (args) => result } },
//   }
import { CAPABILITIES, PLATFORMS } from './names.js';
import { ctdMultistream } from './defs/ctd-multistream.js';

export const AUTH = Object.freeze(['device-code', 'oauth-pkce', 'oauth-code', 'client-credentials', 'password', 'none']);
const OAUTH_FLOWS = new Set(['device-code', 'oauth-pkce', 'oauth-code']);
const ID = /^[a-z][a-z0-9-]{1,39}$/;
const ACTION = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const BUILTIN = Object.freeze([ctdMultistream]);

// Throws a TypeError naming the connector and what is wrong; returns the definition with its
// defaults filled in (frozen).
export function validateDefinition(def) {
  const name = isObj(def) && typeof def.id === 'string' ? def.id : JSON.stringify(def?.id);
  const bad = (msg) => { throw new TypeError(`The connector definition ${name} ${msg}.`); };
  if (!isObj(def)) bad('is not an object');
  if (typeof def.id !== 'string' || !ID.test(def.id)) bad('needs an id of lowercase letters, digits and dashes (2 to 40)');
  if (typeof def.name !== 'string' || !def.name.trim()) bad('needs a name');
  const platforms = def.platforms ?? (def.platform ? [def.platform] : []);
  if (!Array.isArray(platforms) || platforms.some((p) => !PLATFORMS.includes(p))) bad(`has a platform that isn't one of ${PLATFORMS.join(', ')}`);
  if (def.platform !== undefined && !platforms.includes(def.platform)) bad('lists its platform outside its platforms');
  if (def.vendor !== undefined && (typeof def.vendor !== 'string' || !/^[a-z0-9-]{1,30}$/.test(def.vendor))) bad('has a vendor that isn\'t lowercase letters, digits and dashes');
  if (!Array.isArray(def.capabilities) || def.capabilities.some((c) => !CAPABILITIES.includes(c))) bad(`has a capability that isn't one of ${CAPABILITIES.join(', ')}`);
  if (!AUTH.includes(def.auth)) bad(`has auth "${def.auth}", not one of ${AUTH.join(', ')}`);
  const userAuth = def.userAuth ?? (OAUTH_FLOWS.has(def.auth) ? 'required' : 'none');
  if (!['required', 'optional', 'none'].includes(userAuth)) bad('has a userAuth that isn\'t required, optional or none');
  if (OAUTH_FLOWS.has(def.auth) || def.auth === 'client-credentials') {
    const o = def.oauth;
    if (!isObj(o) || typeof o.tokenUrl !== 'string') bad('needs oauth.tokenUrl for its sign-in');
    if (def.auth !== 'device-code' && def.auth !== 'client-credentials' && typeof o.authorizeUrl !== 'string') bad('needs oauth.authorizeUrl for a redirect sign-in');
    if (def.auth === 'device-code' && typeof o.deviceUrl !== 'string') bad('needs oauth.deviceUrl for the device flow');
    if (o.scopes !== undefined && (!Array.isArray(o.scopes) || o.scopes.some((s) => !isObj(s) || typeof s.scope !== 'string' || typeof s.why !== 'string'))) bad('lists oauth.scopes as { scope, why } (why each is asked for, for the setup guide)');
    if (o.clientAuth !== undefined && !['body', 'basic', 'none'].includes(o.clientAuth)) bad('has an oauth.clientAuth that isn\'t body, basic or none');
  }
  if (!isObj(def.fields) || def.fields.type !== 'object' || !isObj(def.fields.properties)) bad('needs fields: a JSON Schema object with properties');
  for (const [k, s] of Object.entries(def.fields.properties)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(k) || !isObj(s)) bad(`has a field "${k}" that isn't a camelCase name with a schema`);
    if (s.writeOnly === true && s.type !== 'string') bad(`has a secret field "${k}" that isn't text`);
    if (s['x-skp-egress'] !== undefined && s['x-skp-egress'] !== 'lan') bad(`has a field "${k}" with an x-skp-egress other than "lan"`);
  }
  if (def.fields.required !== undefined && (!Array.isArray(def.fields.required) || def.fields.required.some((r) => !Object.hasOwn(def.fields.properties, r)))) bad('requires a field it doesn\'t have');
  if (!isObj(def.guide) || !Array.isArray(def.guide.steps) || def.guide.steps.some((s) => typeof s !== 'string')) bad('needs a setup guide: { steps: [text] } (08 §8.7)');
  if (def.guide.warnings !== undefined && (!Array.isArray(def.guide.warnings) || def.guide.warnings.some((w) => !isObj(w) || typeof w.text !== 'string'))) bad('lists guide.warnings as { when?, text }');
  for (const [k, a] of Object.entries(def.actions || {})) {
    if (!ACTION.test(k) || !isObj(a) || typeof a.label !== 'string') bad(`has an action "${k}" without a label`);
    if (a.args !== undefined && !isObj(a.args)) bad(`has an action "${k}" whose args aren't a JSON Schema`);
    if (a.scope !== undefined && !['overlays:control', 'connections:write'].includes(a.scope)) bad(`has an action "${k}" whose scope isn't overlays:control or connections:write`);
  }
  if (typeof def.create !== 'function') bad('needs create(ctx)');
  for (const f of ['validate', 'identify', 'fromV0', 'inbound']) if (def[f] !== undefined && typeof def[f] !== 'function') bad(`has a ${f} that isn't a function`);
  return Object.freeze({ ...def, platforms: Object.freeze([...platforms]), userAuth, holdOnError: def.holdOnError !== false });
}

// The connectors this platform offers: the built-in ones, or a test's. A definition that fails its
// check stops startup (StartupError in app.js): a broken connector must not ship quietly.
export function createConnectorRegistry(defs = BUILTIN) {
  const byId = new Map();
  for (const d of defs) {
    const v = validateDefinition(d);
    if (byId.has(v.id)) throw new TypeError(`Two connector definitions have the id ${v.id}.`);
    byId.set(v.id, v);
  }
  return {
    get: (id) => (typeof id === 'string' ? byId.get(id) : undefined),
    has: (id) => byId.has(id),
    list: () => [...byId.values()],
  };
}

export const isOAuthFlow = (def) => OAUTH_FLOWS.has(def.auth);
