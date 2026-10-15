// Connections in the store (07 §7.7): three collections per connection, all deleted together.
//
//   connections/<con_…>        { connector, name, enabled, config, secrets?, secretFields,
//                                createdAt, createdBy, updatedAt, updatedBy, source? }
//       config: the definition's fields that aren't secret; secrets: the writeOnly ones, as one
//       JSON object, encrypted with AAD "connection:<id>"; secretFields: the names that hold a
//       value (the admin UI says "saved" for them). Its rev is the resource's ETag.
//   connection_tokens/<con_…>  { user?, account?, scopes?, obtainedAt?, expiresAt?, authorizedAt?,
//                                authorizedBy?, needsReauth?: { at, reason } }
//       user: the account's token set, encrypted with AAD "tokens:<id>". Written by the platform
//       (a renewal), so a renewal never makes an operator's edit a 412.
//   connection_state/<con_…>   { memory?, quota? }: what a connector keeps between starts (a cursor,
//       a subscription id; at most 16 KiB), written at most every 5 s.
//
// Nothing secret leaves this module except to the connector host: view() shows a connection
// without its secrets or tokens.
import { newId } from '../ids.js';
import { validate } from '../schema.js';
import { ConnectorError } from './errors.js';

export const CONNECTIONS = 'connections';
export const TOKENS = 'connection_tokens';
export const STATE = 'connection_state';
export const MEMORY_BYTES = 16 * 1024;
const NAME_CHARS = 80;
const VALUE_CHARS = 4096;
export const CONNECTION_ID = /^con_[0-9A-Z]{26}$/;

const RecordError = ConnectorError;
const iso = (t) => new Date(t).toISOString();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The definition's fields split: { config: {name: schema}, secret: {name: schema}, required: [] }.
export function fieldsOf(def) {
  const props = isObj(def.fields?.properties) ? def.fields.properties : {};
  const config = {};
  const secret = {};
  for (const [k, s] of Object.entries(props)) (s?.writeOnly === true ? secret : config)[k] = s;
  return { config, secret, required: Array.isArray(def.fields?.required) ? def.fields.required : [] };
}

// Config with the definition's defaults filled in: what the connector sees.
export function withDefaults(def, config = {}) {
  const out = {};
  for (const [k, s] of Object.entries(fieldsOf(def).config)) if (s && s.default !== undefined) out[k] = structuredClone(s.default);
  return { ...out, ...structuredClone(config) };
}

export function createRecords({ store, secrets, now = Date.now }) {
  const decryptJson = (text, aad) => JSON.parse(secrets.decrypt(text, aad));

  function* all() {
    for (let after = ''; ;) {
      const page = store.list(CONNECTIONS, { after, limit: 1000 });
      yield* page;
      if (page.length < 1000) break;
      after = page[page.length - 1].id;
    }
  }

  // Checks config and secrets against the definition: unknown fields refused, each value against
  // its schema, the required ones present (in config, or among the secrets given or kept). Never
  // says a secret's value: problems name the field.
  function check(def, config, secretValues) {
    const { config: cf, secret: sf, required } = fieldsOf(def);
    if (!isObj(config)) throw new RecordError('"config" is an object of the connection\'s settings.');
    const unknown = Object.keys(config).filter((k) => !Object.hasOwn(cf, k));
    if (unknown.length) {
      const secretOnes = unknown.filter((k) => Object.hasOwn(sf, k));
      throw new RecordError(secretOnes.length
        ? `${secretOnes.join(', ')} ${secretOnes.length > 1 ? 'are secrets' : 'is a secret'}: send ${secretOnes.length > 1 ? 'them' : 'it'} in "secrets", never in "config".`
        : `Unknown setting${unknown.length > 1 ? 's' : ''} for ${def.name}: ${unknown.join(', ')}. It takes ${Object.keys(cf).join(', ') || 'none'}.`, 'unknown-field');
    }
    const problems = [];
    for (const [k, v] of Object.entries(config)) {
      if (typeof v === 'string' && v.length > VALUE_CHARS) problems.push(`${k} is longer than ${VALUE_CHARS} characters`);
      else for (const p of validate(cf[k], v)) problems.push(`${k}${p.path === '/' ? '' : p.path} ${p.message}`);
    }
    for (const [k, v] of Object.entries(secretValues)) {
      if (typeof v !== 'string' || !v || v.length > VALUE_CHARS) { problems.push(`${k} must be text, 1 to ${VALUE_CHARS} characters`); continue; }
      // The pattern is checked, the value never repeated.
      for (const p of validate(sf[k], v)) problems.push(`${k} ${p.message.startsWith('must match') ? 'isn\'t in the form it needs' : p.message}`);
    }
    const missing = required.filter((k) => (Object.hasOwn(cf, k) ? config[k] === undefined || config[k] === '' : !Object.hasOwn(secretValues, k)));
    if (missing.length) problems.push(`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} needed`);
    if (problems.length) throw new RecordError(`${def.name} settings don't fit: ${problems.join('; ')}.`);
  }

  function sealSecrets(id, values) {
    const names = Object.keys(values).filter((k) => typeof values[k] === 'string' && values[k]);
    if (!names.length) return {};
    const kept = Object.fromEntries(names.map((k) => [k, values[k]]));
    return { secrets: secrets.encrypt(JSON.stringify(kept), `connection:${id}`), secretFields: names.sort() };
  }

  return {
    all,
    get: (id) => (typeof id === 'string' && CONNECTION_ID.test(id) ? store.get(CONNECTIONS, id) : undefined),

    // A connection's secrets, decrypted ({} when it has none). Throws (SecretsError) when they
    // can't be: another master key, or a record moved.
    secretsOf(doc) {
      return doc.data.secrets ? decryptJson(doc.data.secrets, `connection:${doc.id}`) : {};
    },

    create(def, { name, enabled = true, config = {}, secrets: given = {}, actor, source }) {
      const id = newId('con');
      const n = cleanName(name ?? def.name);
      if (!isObj(given)) throw new RecordError('"secrets" is an object of the connection\'s secret fields.');
      const values = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== null && v !== undefined));
      const unknown = Object.keys(values).filter((k) => !Object.hasOwn(fieldsOf(def).secret, k));
      if (unknown.length) throw new RecordError(`Unknown secret${unknown.length > 1 ? 's' : ''} for ${def.name}: ${unknown.join(', ')}. Its secrets are ${Object.keys(fieldsOf(def).secret).join(', ') || 'none'}.`, 'unknown-field');
      check(def, config, values);
      if (typeof enabled !== 'boolean') throw new RecordError('"enabled" is true or false.');
      const t = iso(now());
      return store.put(CONNECTIONS, id, {
        connector: def.id, name: n, enabled, config, ...sealSecrets(id, values), secretFields: Object.keys(values).sort(),
        createdAt: t, createdBy: actor, updatedAt: t, updatedBy: actor, ...(source ? { source } : {}),
      }, { ifRev: 0 });
    },

    // changes: { name?, enabled?, config? (replaces it), secrets? ({ field: text | null }: null
    // clears, absent keeps) }. Returns { doc, changed: [field names], reauth: bool (a field marked
    // x-skp-reauth changed: the account's tokens no longer fit) }.
    update(def, doc, changes, { ifRev, actor } = {}) {
      const next = { ...doc.data };
      const changed = [];
      let reauth = false;
      const reauthFields = new Set(Object.entries(def.fields?.properties || {}).filter(([, s]) => s?.['x-skp-reauth']).map(([k]) => k));
      if (changes.name !== undefined) {
        const n = cleanName(changes.name);
        if (n !== doc.data.name) { next.name = n; changed.push('name'); }
      }
      if (changes.enabled !== undefined) {
        if (typeof changes.enabled !== 'boolean') throw new RecordError('"enabled" is true or false.');
        if (changes.enabled !== doc.data.enabled) { next.enabled = changes.enabled; changed.push('enabled'); }
      }
      let values = this.secretsOf(doc);
      if (changes.secrets !== undefined) {
        if (!isObj(changes.secrets)) throw new RecordError('"secrets" is an object: { field: "new value" } to set one, null to clear it; fields left out are kept.');
        const sf = fieldsOf(def).secret;
        const unknown = Object.keys(changes.secrets).filter((k) => !Object.hasOwn(sf, k));
        if (unknown.length) throw new RecordError(`Unknown secret${unknown.length > 1 ? 's' : ''} for ${def.name}: ${unknown.join(', ')}.`, 'unknown-field');
        values = { ...values };
        for (const [k, v] of Object.entries(changes.secrets)) {
          if (v === null) {
            if (k in values) { delete values[k]; changed.push(k); if (reauthFields.has(k)) reauth = true; }
          } else if (v !== values[k]) {
            values[k] = v;
            changed.push(k);
            if (reauthFields.has(k)) reauth = true;
          }
        }
      }
      if (changes.config !== undefined) {
        const before = doc.data.config || {};
        for (const k of new Set([...Object.keys(before), ...Object.keys(isObj(changes.config) ? changes.config : {})])) {
          if (JSON.stringify(before[k]) !== JSON.stringify(changes.config?.[k])) {
            changed.push(k);
            if (reauthFields.has(k)) reauth = true;
          }
        }
        next.config = changes.config;
      }
      check(def, next.config || {}, values);
      if (!changed.length) return { doc, changed, reauth: false };
      Object.assign(next, { updatedAt: iso(now()), updatedBy: actor });
      delete next.secrets;
      Object.assign(next, sealSecrets(doc.id, values), { secretFields: Object.keys(values).filter((k) => values[k]).sort() });
      const saved = store.put(CONNECTIONS, doc.id, next, { ifRev: ifRev ?? doc.rev });
      return { doc: saved, changed, reauth };
    },

    // The connection, its tokens and its memory, in one transaction.
    remove(id) {
      return store.transaction((tx) => {
        const had = Boolean(tx.get(CONNECTIONS, id));
        tx.delete(CONNECTIONS, id);
        tx.delete(TOKENS, id);
        tx.delete(STATE, id);
        return had;
      });
    },

    // { user?, account?, scopes?, obtainedAt?, expiresAt?, authorizedAt?, authorizedBy?, needsReauth? }
    // with the token set decrypted; undefined without a record.
    tokensOf(id) {
      const doc = store.get(TOKENS, id);
      if (!doc) return undefined;
      const { user, ...rest } = doc.data;
      return { ...rest, ...(user ? { user: decryptJson(user, `tokens:${id}`) } : {}) };
    },
    tokenInfo(id) {
      const doc = store.get(TOKENS, id);
      if (!doc) return undefined;
      const { user, ...rest } = doc.data;
      return { ...rest, signedIn: Boolean(user) };
    },
    saveTokens(id, set, { account, authorizedBy } = {}) {
      const cur = store.get(TOKENS, id)?.data || {};
      const { needsReauth, ...keep } = cur;
      const data = {
        ...keep,
        user: secrets.encrypt(JSON.stringify(set), `tokens:${id}`),
        scopes: set.scope || [],
        obtainedAt: iso(set.obtainedAt ?? now()),
        ...(set.expiresAt ? { expiresAt: iso(set.expiresAt) } : {}),
      };
      if (!set.expiresAt) delete data.expiresAt;
      if (account) data.account = account;
      if (authorizedBy) Object.assign(data, { authorizedAt: iso(now()), authorizedBy });
      store.put(TOKENS, id, data);
    },
    setAccount(id, account) {
      const cur = store.get(TOKENS, id)?.data || {};
      store.put(TOKENS, id, { ...cur, account });
    },
    markNeedsReauth(id, reason) {
      const cur = store.get(TOKENS, id)?.data || {};
      store.put(TOKENS, id, { ...cur, needsReauth: { at: iso(now()), reason: String(reason).slice(0, 200) } });
    },
    clearTokens(id) {
      store.delete(TOKENS, id);
    },

    memoryOf(id) {
      return store.get(STATE, id)?.data || {};
    },
    saveMemory(id, data) {
      store.put(STATE, id, data);
    },

    // A connection as the API shows it: never its secrets or tokens.
    view(doc) {
      const d = doc.data;
      const t = this.tokenInfo(doc.id);
      return {
        id: doc.id,
        rev: doc.rev,
        connector: d.connector,
        name: d.name,
        enabled: d.enabled,
        config: d.config || {},
        secretFields: d.secretFields || [],
        ...(t?.account ? { account: t.account } : {}),
        ...(t?.signedIn ? { signedIn: true, scopes: t.scopes || [], ...(t.authorizedAt ? { authorizedAt: t.authorizedAt } : {}), ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}) } : {}),
        ...(t?.needsReauth ? { needsReauth: t.needsReauth } : {}),
        ...(d.source ? { source: d.source } : {}),
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      };
    },
  };
}

function cleanName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > NAME_CHARS) throw new RecordError(`"name" is text, 1 to ${NAME_CHARS} characters.`);
  return name.trim();
}
