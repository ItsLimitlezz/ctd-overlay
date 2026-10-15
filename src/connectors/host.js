// The connector host (01 §1.2, 06 §6.1–6.4): every connection's lifecycle, its sign-in, and what
// the API and the timeline ask of it. One runner per connection (runner.js) keeps a failing
// connector from touching the others or the process (01 §1.7, H11).
//
// - Created with the data (app.js openData), so the timeline can check and run connector.action
//   cues; started by the platform once it listens (the redirect URI needs its address), connections
//   250 ms apart; the command line never starts it.
// - At start, credentials the v0 importer kept (store "pending_connections", import/v0.js) become
//   connections, turned off, when a connector for their platform exists (fromV0).
// - Sign-in (06 §6.4): the device flow where the service has it (a code to type on any device,
//   polled here); else a redirect with PKCE (S256) to /oauth/callback/<connector>, its state single
//   use, 10 minutes, bound to whoever started it; and when the browser that lands there isn't that
//   person's (another device, or a redirect URI on 127.0.0.1 opened from a phone), they paste the
//   address they landed on (POST …/authorize/complete). Client credentials and passwords need no
//   sign-in. Pairing (an app's own way, CTD Multi-Stream's): the service shows a code an admin
//   approves there; the platform polls at the interval it gives, and the secret it hands over
//   (once) is saved into the connection's secret field as if typed.
// - Connections that share overlays with their service (CTD Multi-Stream's hub) get them through
//   share.js; deleting or turning one off lets its definition undo what it registered (retire).
// - Nothing secret leaves it: not in answers, the audit log, health details or logs.
import { randomBytes as cryptoRandom } from 'node:crypto';
import { ConnectorError } from './errors.js';
import { createHttpClient, lanRefusal } from './http.js';
import { createFlowTable, createOAuthClient, newState, pkcePair, principalOf, samePrincipal } from './oauth.js';
import { createRecords, fieldsOf, withDefaults } from './records.js';
import { isOAuthFlow } from './registry.js';
import { ConnectionRunner, LIMITS } from './runner.js';
import { createShare } from './share.js';

// Where the v0 importer keeps Twitch and Kick credentials until a connector takes them (import/v0.js).
const PENDING_CONNECTIONS = 'pending_connections';

const SPACING_MS = 250;
const TEST_EVERY_MS = 5000;
const AUTHORIZE_PER_MINUTE = 10;
const DONE_KEEP_MS = 10 * 60 * 1000; // how long a finished sign-in's outcome stays on the resource
const RETIRE_MS = 5000;
const CONNECTION_ID = /^con_[0-9A-Z]{26}$/;

export function createConnectorHost({
  store, bus, secrets, overlays, templates, audit, log, registry, now = Date.now, timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  fetch = globalThis.fetch, lookup, endpoints = {}, exposure = 'local', publicUrl, random = Math.random, randomBytes = cryptoRandom,
  holdMs = LIMITS.holdMs, spacingMs = SPACING_MS,
}) {
  const records = createRecords({ store, secrets, now });
  const runners = new Map();
  const flows = createFlowTable({ now });
  const devices = new Map(); // connection id → a device flow in progress
  const pairings = new Map(); // connection id → a pairing in progress
  // Where OBS reaches this platform, for the overlays a connection shares (setShareBase).
  let shareBase = () => ({ problem: 'The platform hasn\'t started listening yet.' });
  const outcomes = new Map(); // connection id → { flow, status, detail?, at }
  const lastTest = new Map();
  const authorizeCounts = new Map(); // connection id → [times]
  let origin;
  let started = false;
  let stopped = false;
  const startTimers = new Set();

  // Origins a test pointed an endpoint at: reached over plain http (http.js 'service').
  const allowHttp = new Set();
  for (const map of Object.values(endpoints)) {
    for (const u of Object.values(map || {})) {
      try { allowHttp.add(new URL(u).origin); } catch { /* not a URL */ }
    }
  }
  const endpointsOf = (def) => ({ ...(def.endpoints || {}), ...Object.fromEntries(Object.entries(endpoints[def.id] || {}).filter(([k]) => Object.hasOwn(def.endpoints || {}, k))) });
  const oauthOf = (def) => {
    const o = { ...(def.oauth || {}) };
    for (const k of ['authorizeUrl', 'tokenUrl', 'deviceUrl', 'revokeUrl']) if (endpoints[def.id]?.[k]) o[k] = endpoints[def.id][k];
    return o;
  };
  // Token requests: a form POST, sent once (oauth.js), whose 4xx error bodies are read.
  const oauthHttp = createHttpClient({ fetch, lookup, now, timers, allowHttp, log, random });
  const post = (url, { form, headers }) => oauthHttp.request(url, { method: 'POST', form, headers, retries: 0, acceptStatus: (s) => s >= 400 && s < 500 && s !== 429 });

  const env = {
    bus, records, registry, log, now, timers, fetch, lookup, allowHttp, random, holdMs, endpointsOf, oauthOf, post, publicUrl,
    publish: (type, data) => bus.publish(type, data),
    inboundUrl: (def, id) => (publicUrl && def.inbound ? `${publicUrl}/hooks/${def.id}/${id}` : undefined),
    share: overlays && templates ? createShare({ overlays, templates, audit, log, base: () => shareBase() }) : undefined,
    suggestName,
  };
  // A request client of the platform's own, outside any connection's instance (pairing, retire).
  const plainHttp = () => createHttpClient({ fetch, lookup, now, timers, allowHttp, log, random });

  const docOf = (id) => {
    const doc = records.get(id);
    if (!doc) throw new ConnectorError(`There is no connection "${id}".`, 'not-found');
    return doc;
  };
  const defOf = (doc) => {
    const def = registry.get(doc.data.connector);
    if (!def) throw new ConnectorError(`The connector "${doc.data.connector}" isn't in this version of the platform.`, 'unknown-connector');
    return def;
  };
  function runnerOf(doc) {
    let r = runners.get(doc.id);
    if (!r) {
      r = new ConnectionRunner(env, doc);
      runners.set(doc.id, r);
      const def = registry.get(doc.data.connector);
      if (def?.relay) bus.setRank(doc.id, 1);
    }
    return r;
  }
  const record = (action, who, ip, target, details = {}) => audit?.record({ action, actor: who?.label ?? who ?? 'platform', ip, target, ...details });

  // ---- what a connector is, for the setup screen (08 §8.7) -----------------------------------
  function redirectFor(connectorId) {
    const base = publicUrl || origin;
    return base ? `${base}/oauth/callback/${connectorId}` : undefined;
  }
  function connectorView(def) {
    const redirect = def.auth === 'oauth-pkce' || def.auth === 'oauth-code' ? { uri: redirectFor(def.id), origin: publicUrl || origin, kind: publicUrl ? 'public' : 'loopback' } : undefined;
    const fill = (s) => s.replaceAll('{redirectUri}', redirect ? redirect.uri || '(shown once the platform is running)' : '(none needed)');
    const applies = (w) => !w.when || w.when === exposure || (w.when === 'no-public-url' && !publicUrl);
    return {
      id: def.id,
      name: def.name,
      ...(def.platform ? { platform: def.platform } : {}),
      platforms: def.platforms,
      ...(def.relay ? { relay: true } : {}),
      capabilities: def.capabilities,
      auth: def.auth,
      userAuth: def.userAuth,
      fields: def.fields,
      ...(def.oauth?.scopes?.length ? { scopes: def.oauth.scopes.map((s) => ({ scope: s.scope, why: s.why })) } : {}),
      ...(redirect ? { redirect } : {}),
      ...(def.requiresPublicUrl ? { requiresPublicUrl: true } : {}),
      publicUrlAvailable: Boolean(publicUrl),
      guide: {
        ...(def.guide.before ? { before: fill(def.guide.before) } : {}),
        steps: def.guide.steps.map(fill),
        warnings: (def.guide.warnings || []).filter(applies).map((w) => fill(w.text)),
        ...(def.guide.links?.length ? { links: def.guide.links } : {}),
      },
      actions: Object.entries(def.actions || {}).map(([name, a]) => ({ name, label: a.label, ...(a.args ? { args: a.args } : {}), scope: a.scope || 'overlays:control' })),
    };
  }

  // ---- a connection as the API shows it ------------------------------------------------------
  function resource(doc) {
    const r = runners.get(doc.id);
    const mine = bus.stateOf(doc.id);
    const def = registry.get(doc.data.connector);
    const out = outcomes.get(doc.id);
    const dev = devices.get(doc.id);
    const red = flows.open(doc.id);
    const pair = pairings.get(doc.id);
    let authorization;
    if (dev) authorization = { flow: 'device', status: 'pending', userCode: dev.userCode, verificationUri: dev.verificationUri, ...(dev.verificationUriComplete ? { verificationUriComplete: dev.verificationUriComplete } : {}), expiresAt: new Date(dev.expiresAt).toISOString(), intervalS: dev.intervalS };
    else if (pair) authorization = pairingView(pair, 'pending');
    else if (red) authorization = { flow: 'redirect', status: 'pending', expiresAt: new Date(red.expiresAt).toISOString() };
    else if (out && now() - out.at < DONE_KEEP_MS) authorization = { flow: out.flow, status: out.status, ...(out.detail ? { detail: out.detail } : {}) };
    return {
      ...records.view(doc),
      health: r ? r.health.view() : { status: doc.data.enabled ? 'connecting' : 'disabled', since: doc.data.updatedAt, warnings: [] },
      state: Object.fromEntries(mine.map((e) => [e.key, e.value])),
      ...(mine.some((e) => e.stale) ? { stale: mine.filter((e) => e.stale).map((e) => e.key) } : {}),
      ...(authorization ? { authorization } : {}),
      capabilities: def?.capabilities || [],
      overlays: overlays?.fedBy(doc.id) || [],
      ...(r?.view().info ? { info: r.view().info } : {}),
      ...(r?.view().deliveries ? { deliveries: r.view().deliveries } : {}),
    };
  }
  // A pairing as the resource and the authorize answer show it: the code and where to approve it,
  // never what it is polled with.
  const pairingView = (p, status) => ({ flow: 'pairing', ...(status ? { status } : {}), code: p.code, ...(p.approveUrl ? { approveUrl: p.approveUrl } : {}), expiresAt: new Date(p.expiresAt).toISOString(), intervalS: p.intervalS });

  // ---- settings checks the records can't make ------------------------------------------------
  // An address the operator types (x-skp-egress lan) must be one connections may reach (07 §7.11).
  function checkEgress(def, config) {
    for (const [k, s] of Object.entries(fieldsOf(def).config)) {
      if (s['x-skp-egress'] !== 'lan' || config[k] === undefined || config[k] === '') continue;
      let u;
      try { u = new URL(String(config[k])); } catch { throw new ConnectorError(`${s.title || k} must be an address like http://192.168.1.50:30080.`, 'invalid'); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConnectorError(`${s.title || k} must start with http:// or https://.`, 'invalid');
      if (u.username || u.password) throw new ConnectorError(`${s.title || k} can't carry a user name or password: put them in their own fields, where they are kept encrypted.`, 'invalid');
      const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
      const why = /^[\d.]+$|:/.test(host) ? lanRefusal(host) : undefined;
      if (why && why !== 'not an address') throw new ConnectorError(`${s.title || k} is ${why}, which connections never reach.`, 'invalid');
    }
  }

  // ---- lifecycle -----------------------------------------------------------------------------
  function adoptPending() {
    let page = [];
    try { page = store.list(PENDING_CONNECTIONS, { limit: 1000 }); } catch { return; }
    for (const p of page) {
      try {
        const def = registry.list().find((d) => d.fromV0 && d.platform === p.data.platform);
        if (!def) continue; // kept for a version that has a connector for it
        let secret;
        if (p.data.clientSecret) secret = secrets.decrypt(p.data.clientSecret, p.id);
        const { clientSecret: _s, ...rest } = p.data;
        const mapped = def.fromV0(structuredClone(rest), { secret });
        if (!mapped) continue;
        const doc = records.create(def, { name: mapped.name || def.name, enabled: false, config: mapped.config || {}, secrets: mapped.secrets || {}, actor: 'platform', source: 'v0' });
        store.delete(PENDING_CONNECTIONS, p.id);
        record('connection.import', 'platform', undefined, doc.id, { connector: def.id, platform: p.data.platform, name: doc.data.name });
        log.info('credentials kept by the v0 import became a connection, turned off until you check it', { connection: doc.id, connector: def.id });
      } catch (err) {
        log.warn('credentials kept by the v0 import could not become a connection; they stay kept', { platform: p.data?.platform, err: err.message });
      }
    }
  }

  const host = {
    records,

    // The address this platform listens at (http://127.0.0.1:4848, never "localhost": a service
    // compares redirect URIs as text), for redirect URIs when there is no public URL.
    setOrigin(o) { origin = o; },
    redirectFor,
    // fn() → { url } where OBS reaches this platform, or { problem } saying what to set, for the
    // overlays connections share (app.js works it out once it listens).
    setShareBase(fn) { shareBase = fn; },

    async start() {
      if (started) return;
      started = true;
      adoptPending();
      let i = 0;
      for (const doc of records.all()) {
        const r = runnerOf(doc);
        if (!doc.data.enabled) { r.start(); continue; }
        const h = timers.setTimeout(() => { startTimers.delete(h); if (!stopped) r.start(); }, spacingMs * i++);
        h?.unref?.();
        startTimers.add(h);
      }
    },

    async stop() {
      stopped = true;
      for (const h of startTimers) timers.clearTimeout(h);
      startTimers.clear();
      for (const d of devices.values()) timers.clearTimeout(d.timer);
      devices.clear();
      for (const p of pairings.values()) timers.clearTimeout(p.timer);
      pairings.clear();
      await Promise.all([...runners.values()].map((r) => r.close({ shutdown: true }).catch(() => {})));
    },

    definitions: () => registry.list().map(connectorView),
    connector(id) {
      const def = registry.get(id);
      if (!def) throw new ConnectorError(`There is no connector "${id}"${registry.list().length ? ` (there are ${registry.list().map((d) => d.id).join(', ')})` : ''}.`, 'not-found');
      return connectorView(def);
    },

    exists: (id) => Boolean(records.get(id)),
    list: () => [...records.all()].map(resource),
    get: (id) => resource(docOf(id)),
    rev: (id) => { const d = docOf(id); return { id: d.id, rev: d.rev }; },

    // For GET /system/health and the Live strip (operators, without connections:read): no settings.
    summary() {
      return [...records.all()].map((doc) => {
        const r = runners.get(doc.id);
        const h = r ? r.health.view() : { status: doc.data.enabled ? 'connecting' : 'disabled' };
        const mine = bus.stateOf(doc.id);
        const counts = mine.filter((e) => /^viewers\.[a-z0-9-]+$/.test(e.key) && typeof e.value === 'number');
        // The stream it follows at its service (a CTD Multi-Stream profile: name, colour, live or not).
        const profile = r?.info?.profile;
        return {
          id: doc.id, name: doc.data.name, connector: doc.data.connector, status: h.status,
          ...(h.detail ? { detail: h.detail } : {}), ...(h.since ? { since: h.since } : {}),
          ...(counts.length ? { viewers: counts.reduce((n, e) => n + e.value, 0) } : {}),
          ...(mine.some((e) => e.stale) ? { stale: true } : {}),
          ...(profile && typeof profile === 'object' ? { profile } : {}),
        };
      });
    },

    create(body, { who, ip } = {}) {
      const def = registry.get(body.connector);
      if (!def) throw new ConnectorError(`There is no connector "${body.connector}"${registry.list().length ? `; there are ${registry.list().map((d) => d.id).join(', ')}` : ''}.`, 'unknown-connector');
      checkEgress(def, body.config || {});
      const doc = records.create(def, { name: body.name ?? def.name, enabled: body.enabled ?? true, config: body.config ?? {}, secrets: body.secrets ?? {}, actor: who?.label });
      record('connection.create', who, ip, doc.id, { connector: def.id, name: doc.data.name });
      if (started && !stopped) runnerOf(doc).start();
      return resource(doc);
    },

    async update(id, body, { ifRev, who, ip } = {}) {
      const doc = docOf(id);
      const def = defOf(doc);
      if (body.config !== undefined) checkEgress(def, body.config || {});
      const { doc: saved, changed, reauth } = records.update(def, doc, body, { ifRev, actor: who?.label });
      if (!changed.length) return resource(saved);
      if (reauth) {
        flows.cancel(id);
        cancelDevice(id);
        cancelPairing(id);
        records.clearTokens(id);
      }
      const onOff = changed.includes('enabled');
      const others = changed.filter((f) => f !== 'enabled' && f !== 'name');
      // The audit log names what changed, never a value (07 §7.12).
      const fields = changed.filter((f) => f !== 'enabled');
      if (fields.length) record('connection.update', who, ip, id, { fields, ...(reauth ? { signedOut: true } : {}) });
      if (onOff) record(saved.data.enabled ? 'connection.enable' : 'connection.disable', who, ip, id);
      const r = runnerOf(saved);
      // A new name changes nothing that runs: no restart mid-show for a rename.
      if (others.length || onOff) {
        if (started && !stopped) await r.reload(saved);
        else r.rename(saved);
      } else r.rename(saved);
      // Turned off: what it registered at its service goes too (it registers again when on).
      if (onOff && !saved.data.enabled) retire(saved, def);
      return resource(saved);
    },

    async remove(id, { who, ip, ifRev } = {}) {
      const doc = docOf(id);
      if (ifRev !== undefined && ifRev !== doc.rev) throw new ConnectorError('It changed meanwhile: read it again, then retry.', 'conflict');
      const fed = overlays?.fedBy(id) || [];
      flows.cancel(id);
      cancelDevice(id);
      cancelPairing(id);
      const r = runners.get(id);
      if (r) {
        await r.stop({ deliberate: true });
        await r.close({ shutdown: false });
        runners.delete(id);
      }
      const def = registry.get(doc.data.connector);
      // Before its secrets and memory go: what it registered at its service is undone.
      if (def) retire(records.get(id) || doc, def);
      bus.clearOwner(id);
      bus.purgeChat(id);
      bus.setRank(id, 0);
      // The service forgets the sign-in too, where it allows (best effort).
      let tokens;
      try { tokens = records.tokensOf(id)?.user; } catch { tokens = undefined; }
      if (def?.oauth?.revokeUrl && tokens) {
        try {
          const client = clientFor(def, doc);
          client?.revoke(tokens.refreshToken || tokens.accessToken, tokens.refreshToken ? 'refresh_token' : 'access_token').catch(() => {});
        } catch { /* best effort */ }
      }
      records.remove(id);
      overlays?.unbind(id);
      outcomes.delete(id);
      record('connection.delete', who, ip, id, { connector: doc.data.connector, name: doc.data.name });
      return { id, name: doc.data.name, overlays: fed };
    },

    // ---- sign-in -----------------------------------------------------------------------------
    async authorize(id, { who, ip } = {}) {
      const doc = docOf(id);
      const def = defOf(doc);
      if (!isOAuthFlow(def) && def.auth !== 'pairing') {
        const how = def.auth === 'client-credentials' ? 'it uses its client ID and secret, from its settings'
          : def.auth === 'password' ? 'it uses the password or token in its settings'
            : 'it needs no account';
        throw new ConnectorError(`No sign-in needed: ${how}.`, 'no-sign-in');
      }
      const times = (authorizeCounts.get(id) || []).filter((t) => now() - t < 60000);
      if (times.length >= AUTHORIZE_PER_MINUTE) throw new ConnectorError(`More than ${AUTHORIZE_PER_MINUTE} sign-ins a minute: wait a moment.`, 'rate-limited', { retryAfterS: 60 });
      authorizeCounts.set(id, [...times, now()]);
      if (def.auth === 'pairing') return startPairing(doc, def, who);
      const client = clientFor(def, doc);
      if (!client) throw new ConnectorError(`Enter the app's client ID in ${doc.data.name}'s settings first (the setup guide says where to find it).`, 'invalid');
      const principal = principalOf(who);
      outcomes.delete(id);
      if (def.auth === 'device-code') {
        cancelDevice(id);
        flows.cancel(id);
        let start;
        try { start = await client.deviceStart(); } catch (err) {
          throw new ConnectorError(`${def.name}: ${scrubFor(doc, err.message)}`, err.transient ? 'action-failed' : 'invalid');
        }
        const d = { ...start, principal, actor: who?.label, client, timer: null };
        devices.set(id, d);
        pollDevice(id, d, start.intervalS * 1000);
        return { flow: 'device', userCode: d.userCode, verificationUri: d.verificationUri, ...(d.verificationUriComplete ? { verificationUriComplete: d.verificationUriComplete } : {}), expiresAt: new Date(d.expiresAt).toISOString(), intervalS: d.intervalS };
      }
      const redirectUri = redirectFor(def.id);
      if (!redirectUri) throw new ConnectorError('The platform\'s address isn\'t known yet; try again in a moment.', 'busy');
      cancelDevice(id);
      const state = newState(randomBytes);
      const { verifier, challenge } = pkcePair(randomBytes);
      const expiresAt = flows.add(state, { conn: id, connector: def.id, principal, actor: who?.label, verifier, redirectUri });
      return { flow: 'redirect', url: client.authorizeUrl({ redirectUri, state, challenge }), redirectUri, expiresAt: new Date(expiresAt).toISOString() };
    },

    // Where a redirect landed (the callback, or the address pasted): { id } of the connection, or
    // throws. principal: who is finishing it; it must be who started it.
    async completeRedirect({ state, code, error, connector, id: expected }, { who, ip } = {}) {
      const found = flows.peek(state);
      if (!found.flow) throw new ConnectorError(found.reason === 'used' ? 'That sign-in was already finished. Start again with Authorize if it didn\'t work.' : 'That sign-in has expired or isn\'t known (they last 10 minutes). Start again with Authorize.', 'flow-expired');
      const f = found.flow;
      if ((connector && f.connector !== connector) || (expected && f.conn !== expected)) throw new ConnectorError('That sign-in belongs to another connection.', 'invalid');
      if (!samePrincipal(principalOf(who), f.principal) || !who?.scopes?.has('connections:write')) throw new ConnectorError('Only whoever started this sign-in can finish it: sign in to the platform as them, or start again.', 'session-required');
      flows.take(state);
      const doc = docOf(f.conn);
      const def = defOf(doc);
      if (error) {
        const said = /^[A-Za-z0-9_.-]{1,40}$/.test(String(error)) ? String(error) : 'refused';
        outcomes.set(doc.id, { flow: 'redirect', status: 'denied', detail: `${def.name} didn't allow the sign-in (${said}).`, at: now() });
        record('connection.authorize-failed', who, ip, doc.id, { reason: said });
        throw new ConnectorError(`${def.name} didn't allow the sign-in (${said}).`, 'invalid');
      }
      const client = clientFor(def, doc);
      let set;
      try {
        set = await client.exchange({ code, redirectUri: f.redirectUri, verifier: f.verifier });
      } catch (err) {
        const detail = scrubFor(doc, err.message, [code]);
        outcomes.set(doc.id, { flow: 'redirect', status: 'failed', detail, at: now() });
        record('connection.authorize-failed', who, ip, doc.id, { reason: err.code || 'refused' });
        throw new ConnectorError(detail, 'action-failed');
      }
      await finishSignIn(doc, def, set, { flow: 'redirect', who, ip });
      return doc.id;
    },

    // A redirect flow's state, for the callback page: { flow } (open) or { reason }.
    peekFlow: (state) => flows.peek(state),
    // The service said no (?error=access_denied): the flow is used up.
    denyFlow(state, error, { who, ip } = {}) {
      const { flow } = flows.take(state);
      if (!flow) return;
      const name = registry.get(flow.connector)?.name || flow.connector;
      const code = /^[A-Za-z0-9_.-]{1,40}$/.test(String(error)) ? String(error) : 'refused';
      outcomes.set(flow.conn, { flow: 'redirect', status: 'denied', detail: `${name} didn't allow the sign-in (${code}).`, at: now() });
      record('connection.authorize-failed', who || flow.actor, ip, flow.conn, { reason: code });
    },

    // Ends a sign-in in progress; with none, signs the connection out (its tokens forgotten, and
    // revoked where the service allows).
    async cancelAuthorization(id, { who, ip } = {}) {
      const doc = docOf(id);
      const had = flows.cancel(id) + (cancelDevice(id) ? 1 : 0) + (cancelPairing(id) ? 1 : 0);
      if (had) return { cancelled: true };
      const def = defOf(doc);
      let tokens;
      try { tokens = records.tokensOf(id); } catch { tokens = undefined; }
      if (!tokens) return { signedOut: false };
      if (def.oauth?.revokeUrl && tokens.user) {
        try { await clientFor(def, doc)?.revoke(tokens.user.refreshToken || tokens.user.accessToken, tokens.user.refreshToken ? 'refresh_token' : 'access_token'); } catch { /* best effort */ }
      }
      records.clearTokens(id);
      record('connection.sign-out', who, ip, id);
      const r = runnerOf(doc);
      if (started && !stopped) await r.reload(doc);
      return { signedOut: true };
    },

    async test(id, { who, ip } = {}) {
      const doc = docOf(id);
      const last = lastTest.get(id);
      if (last && now() - last < TEST_EVERY_MS) throw new ConnectorError('One test every 5 seconds: wait a moment.', 'rate-limited', { retryAfterS: Math.ceil((last + TEST_EVERY_MS - now()) / 1000) });
      lastTest.set(id, now());
      const out = await runnerOf(doc).test();
      record('connection.test', who, ip, id, { ok: out.ok });
      return out;
    },

    // A connector action (03 §3.4 POST /connections/{id}/actions/{name}, and connector.action cues):
    // ref is a connection id, or a connector id with one connection of it turned on.
    async runAction(ref, name, args = {}, { who, ip, actor } = {}) {
      const doc = refOf(ref);
      const result = await runnerOf(doc).runAction(name, args);
      record('connection.action', who || actor, ip, doc.id, { name });
      return { connection: doc.id, action: name, result };
    },
    // The scope an action needs (overlays:control unless its definition says more).
    actionScope(ref, name) {
      const doc = refOf(ref);
      const spec = registry.get(doc.data.connector)?.actions?.[name];
      if (!spec) throw new ConnectorError(`${doc.data.name} has no action "${name}".`, 'not-found');
      return spec.scope || 'overlays:control';
    },
    // Whether a cue may name this connection (or connector) and action: throws if not. A
    // connector's connection may be off or not made yet when the cue is written: that is the
    // cue's error when it fires, not a refusal now.
    checkAction(ref, name) {
      const def = typeof ref === 'string' && CONNECTION_ID.test(ref) ? defOf(docOf(ref)) : registry.get(ref);
      if (!def) throw new ConnectorError(`There is no connection or connector "${ref}".`, 'not-found');
      if (!def.actions?.[name]) throw new ConnectorError(`${def.name} has no action "${name}"${def.actions ? ` (it has ${Object.keys(def.actions).join(', ')})` : ''}.`, 'invalid');
      return { connector: def.id };
    },

    // POST /hooks/<connector>[/<connection>]: { status, body? }.
    async inbound(connectorId, connId, req) {
      const def = registry.get(connectorId);
      if (!def?.inbound) throw new ConnectorError('Nothing takes deliveries here.', 'not-found');
      let doc;
      if (connId) {
        doc = records.get(connId);
        if (!doc || doc.data.connector !== connectorId) throw new ConnectorError('Nothing takes deliveries here.', 'not-found');
      } else {
        const on = [...records.all()].filter((d) => d.data.connector === connectorId && d.data.enabled);
        if (on.length !== 1) throw new ConnectorError(on.length ? `More than one ${def.name} connection is on: deliver to /hooks/${connectorId}/<connection id>.` : 'Nothing takes deliveries here.', on.length ? 'invalid' : 'not-found');
        doc = on[0];
      }
      return runnerOf(doc).inbound(req);
    },

    runnerOf: (id) => runners.get(id),
  };

  function refOf(ref) {
    if (typeof ref === 'string' && CONNECTION_ID.test(ref)) return docOf(ref);
    const def = registry.get(ref);
    if (!def) throw new ConnectorError(`There is no connection or connector "${ref}".`, 'not-found');
    const list = [...records.all()].filter((d) => d.data.connector === ref);
    const on = list.filter((d) => d.data.enabled);
    if (on.length === 1) return on[0];
    if (!list.length) throw new ConnectorError(`There is no ${def.name} connection.`, 'not-found');
    if (!on.length) throw new ConnectorError(`The ${def.name} connection is turned off.`, 'not-connected');
    throw new ConnectorError(`More than one ${def.name} connection is on: name the connection (its id) instead.`, 'invalid');
  }

  function clientFor(def, doc) {
    const config = withDefaults(def, doc.data.config);
    let s = {};
    try { s = records.secretsOf(doc); } catch { throw new ConnectorError('Its saved secrets can\'t be read (the data was restored without its master key?): enter them again.', 'invalid'); }
    const o = oauthOf(def);
    const idField = o.client?.id || 'clientId';
    const secretField = o.client?.secret || 'clientSecret';
    const clientId = config[idField] ?? s[idField];
    if (!clientId) return null;
    return createOAuthClient({ oauth: o, clientId, clientSecret: s[secretField] ?? config[secretField], post, now });
  }

  // A message for the operator with the connection's secrets (and any code given) taken out.
  function scrubFor(doc, text, extra = []) {
    let s = String(text ?? '');
    let values = [];
    try { values = Object.values(records.secretsOf(doc)); } catch { values = []; }
    for (const v of [...values, ...extra]) if (typeof v === 'string' && v.length >= 8) s = s.split(v).join('[redacted]');
    return s.slice(0, 300);
  }

  function cancelDevice(id) {
    const d = devices.get(id);
    if (!d) return false;
    timers.clearTimeout(d.timer);
    devices.delete(id);
    return true;
  }

  // ---- pairing -------------------------------------------------------------------------------
  // The service gives a code (an admin approves it in its own settings) and a secret to poll with,
  // kept here only, never in an answer or a log. Polled at its interval (longer when it asks for a
  // pause) until it hands over the connection's secret, says no, or the code expires.
  async function startPairing(doc, def, who) {
    cancelPairing(doc.id);
    outcomes.delete(doc.id);
    const config = withDefaults(def, doc.data.config);
    const problem = def.validate?.(config, {});
    if (typeof problem === 'string' && problem) throw new ConnectorError(problem, 'invalid');
    const http = plainHttp();
    let start;
    try {
      start = await def.pairing.start({ config, http });
    } catch (err) {
      const limited = err.status === 429 || err.code === 'rate-limited';
      throw new ConnectorError(`${def.name}: ${scrubFor(doc, err.message)}`, limited ? 'rate-limited' : 'action-failed', limited ? { retryAfterS: Math.max(1, Math.ceil((err.retryAfterMs || 60000) / 1000)) } : {});
    }
    const intervalS = Math.max(1, Math.min(60, Number(start.intervalS) || 5));
    const p = {
      code: String(start.code).slice(0, 40),
      ...(typeof start.approveUrl === 'string' && /^https?:\/\/\S+$/.test(start.approveUrl) ? { approveUrl: start.approveUrl.slice(0, 2048) } : {}),
      expiresAt: now() + Math.max(30, Math.min(3600, Number(start.expiresInS) || 600)) * 1000,
      intervalS, state: start.state, config, http, actor: who?.label, timer: null,
    };
    pairings.set(doc.id, p);
    pollPairing(doc.id, p, intervalS * 1000);
    return pairingView(p);
  }

  function cancelPairing(id) {
    const p = pairings.get(id);
    if (!p) return false;
    timers.clearTimeout(p.timer);
    pairings.delete(id);
    return true;
  }

  function pollPairing(id, p, wait) {
    p.timer = timers.setTimeout(async () => {
      if (pairings.get(id) !== p || stopped) return;
      const doc = records.get(id);
      const def = doc && registry.get(doc.data.connector);
      if (!def) { pairings.delete(id); return; }
      if (now() >= p.expiresAt) {
        pairings.delete(id);
        outcomes.set(id, { flow: 'pairing', status: 'expired', detail: 'The code expired before it was approved. Connect again for a new one.', at: now() });
        record('connection.authorize-failed', p.actor, undefined, id, { reason: 'expired' });
        return;
      }
      let r;
      try {
        r = await def.pairing.poll({ config: p.config, http: p.http }, p.state);
      } catch (err) {
        if (pairings.get(id) !== p) return;
        pairings.delete(id);
        const status = err.code === 'denied' ? 'denied' : err.code === 'expired' ? 'expired' : 'failed';
        outcomes.set(id, { flow: 'pairing', status, detail: scrubFor(doc, err.message), at: now() });
        record('connection.authorize-failed', p.actor, undefined, id, { reason: err.code || 'refused' });
        return;
      }
      if (pairings.get(id) !== p) return;
      if (r?.secrets) {
        pairings.delete(id);
        await finishPairing(id, def, r, p);
        return;
      }
      pollPairing(id, p, Math.max(p.intervalS * 1000, Math.min(Number(r?.waitMs) || 0, 10 * 60 * 1000)));
    }, wait);
    p.timer?.unref?.();
  }

  // The secret in hand: saved (encrypted) into the connection's secret field, as if typed, and the
  // connection started again with it.
  async function finishPairing(id, def, r, p) {
    let saved;
    try {
      const doc = records.get(id);
      if (!doc) return;
      saved = records.update(def, doc, { secrets: r.secrets }, { actor: p.actor || 'platform' }).doc;
    } catch (err) {
      outcomes.set(id, { flow: 'pairing', status: 'failed', detail: `What ${def.name} sent couldn't be saved (${String(err.message).slice(0, 200)}). Connect again.`, at: now() });
      record('connection.authorize-failed', p.actor, undefined, id, { reason: 'unsaved' });
      return;
    }
    outcomes.set(id, { flow: 'pairing', status: 'done', at: now() });
    record('connection.authorize', p.actor, undefined, id, { flow: 'pairing', ...(r.audit && typeof r.audit === 'object' ? r.audit : {}) });
    log.info('a connection was paired with its service', { connection: id, connector: def.id });
    if (started && !stopped) await runnerOf(saved).reload(saved);
  }

  // ---- what a connection leaves at its service --------------------------------------------------
  // Deleted or turned off: its definition undoes what it registered there (an app in CTD
  // Multi-Stream's hub), best effort, with the secrets and memory it had. Not awaited: a service
  // that doesn't answer mustn't hold up a delete.
  function retire(doc, def) {
    if (typeof def.retire !== 'function') return;
    let s;
    try { s = records.secretsOf(doc); } catch { return; }
    const memory = records.memoryOf(doc.id).memory || {};
    const config = withDefaults(def, doc.data.config);
    const http = plainHttp();
    Promise.resolve()
      .then(() => withTimeoutOf(def.retire({ config, secrets: s, memory, http }), RETIRE_MS))
      .catch((err) => log.warn('what a connection registered at its service could not be undone', { connection: doc.id, err: scrubFor(doc, err?.message) }));
  }
  const withTimeoutOf = (promise, ms) => new Promise((resolve, reject) => {
    const t = timers.setTimeout(() => reject(new Error('no answer in time')), ms);
    t?.unref?.();
    Promise.resolve(promise).then((v) => { timers.clearTimeout(t); resolve(v); }, (e) => { timers.clearTimeout(t); reject(e); });
  });

  // A name a running connector suggests (records.suggestName): taken while nobody named it.
  function suggestName(id, name) {
    try {
      const doc = records.get(id);
      const def = doc && registry.get(doc.data.connector);
      if (!def) return;
      const saved = records.suggestName(def, id, name);
      if (saved) runners.get(id)?.rename(saved);
    } catch (err) {
      log.warn('a connection could not take the name its service suggests', { connection: id, err: err.message });
    }
  }

  // The device flow (RFC 8628 §3.4–3.5): poll at the interval the service gave, 5 s slower each
  // time it says slow_down, until the code is used, refused or expired.
  function pollDevice(id, d, wait) {
    d.timer = timers.setTimeout(async () => {
      if (devices.get(id) !== d || stopped) return;
      const doc = records.get(id);
      if (!doc) { devices.delete(id); return; }
      if (now() >= d.expiresAt) {
        devices.delete(id);
        outcomes.set(id, { flow: 'device', status: 'expired', detail: 'The code expired before it was used. Start again with Authorize.', at: now() });
        record('connection.authorize-failed', d.actor, undefined, id, { reason: 'expired' });
        return;
      }
      let r;
      try {
        r = await d.client.devicePoll(d.deviceCode);
      } catch (err) {
        if (devices.get(id) !== d) return;
        devices.delete(id);
        const denied = err.code === 'access_denied';
        outcomes.set(id, { flow: 'device', status: denied ? 'denied' : err.code === 'expired_token' ? 'expired' : 'failed', detail: denied ? 'The sign-in was declined.' : scrubFor(doc, err.message), at: now() });
        record('connection.authorize-failed', d.actor, undefined, id, { reason: err.code || 'refused' });
        return;
      }
      if (devices.get(id) !== d) return;
      if (r.tokens) {
        devices.delete(id);
        try {
          await finishSignIn(doc, defOf(doc), r.tokens, { flow: 'device', who: d.actor });
        } catch (err) {
          log.error('a sign-in could not be finished', { connection: id, err: scrubFor(doc, err.message) });
        }
        return;
      }
      if (r.slowDown) d.intervalS += 5;
      pollDevice(id, d, d.intervalS * 1000);
    }, wait);
    d.timer?.unref?.();
  }

  // Tokens in hand: saved (encrypted), the account looked up, recorded, and the connection started
  // again with them.
  async function finishSignIn(doc, def, set, { flow, who, ip }) {
    const actor = who?.label ?? who;
    records.saveTokens(doc.id, set, { authorizedBy: actor || 'unknown' });
    let account;
    if (def.identify) {
      try {
        const http = createHttpClient({
          fetch, lookup, now, timers, allowHttp, log, random,
          auth: { header: async () => `Bearer ${set.accessToken}`, refresh: async () => {}, rejected: () => {} },
          scrub: (s) => s.split(set.accessToken).join('[redacted]'),
        });
        const config = withDefaults(def, doc.data.config);
        account = await def.identify({ connection: { id: doc.id, name: doc.data.name, connector: def.id, config }, endpoints: endpointsOf(def), http, accessToken: set.accessToken });
        if (account && typeof account === 'object') {
          account = Object.fromEntries(['id', 'login', 'name'].filter((k) => typeof account[k] === 'string' || typeof account[k] === 'number').map((k) => [k, String(account[k]).slice(0, 100)]));
          records.setAccount(doc.id, account);
        }
      } catch (err) {
        log.warn('the account behind a sign-in could not be looked up', { connection: doc.id, err: scrubFor(doc, err.message, [set.accessToken]) });
      }
    }
    outcomes.set(doc.id, { flow, status: 'done', at: now() });
    record('connection.authorize', who, ip, doc.id, { flow, ...(account?.login || account?.name ? { account: account.login || account.name } : {}) });
    const r = runnerOf(records.get(doc.id));
    if (started && !stopped) await r.reload(records.get(doc.id));
  }

  return host;
}
