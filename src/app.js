// Starts the platform for a given configuration: data and config directories, the data-directory
// lock, crash log, store (with migrations), bus, templates, overlays, media and the HTTP server.
// Returns a handle with stop(). Installs no process-wide handlers, so tests can run several
// instances.
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { alertSpec, createAlertQueue } from './alerts/queue.js';
import { alertRoutes } from './alerts/routes.js';
import { createAudit } from './auth/audit.js';
import { createAuth } from './auth/index.js';
import { createHasher } from './auth/passwords.js';
import { authRoutes, createGuard } from './auth/routes.js';
import { createBus } from './bus/index.js';
import { createConnectorHost } from './connectors/host.js';
import { BUILTIN, createConnectorRegistry } from './connectors/registry.js';
import { connectorRoutes } from './connectors/routes.js';
import { createCrashLog } from './crashlog.js';
import { createApi } from './http/api.js';
import { close, createHttpServer, listen } from './http/server.js';
import { systemRoutes } from './http/system.js';
import { uiRoutes } from './http/ui.js';
import { lockDataDir, LockError, REFRESH_MS } from './lock.js';
import { createMediaLibrary } from './media/library.js';
import { mediaApiRoutes } from './media/api.js';
import { mediaRoutes } from './media/routes.js';
import { isPrivateAddress, liveMachineNames, machineNames } from './net.js';
import { overlayApiRoutes } from './overlays/api.js';
import { createOverlays } from './overlays/registry.js';
import { overlayRoutes } from './overlays/routes.js';
import { simulateRoutes } from './overlays/simulate.js';
import { createSecrets, loadMasterKey, SecretsError } from './secrets.js';
import { createShows } from './shows/registry.js';
import { createTimeline } from './shows/timeline.js';
import { showRoutes } from './shows/routes.js';
import { createStreams } from './streams.js';
import { migrate } from './store/migrate.js';
import { migrations } from './store/migrations.js';
import { openStore } from './store/index.js';
import { BUILTIN_DIR, createTemplateRegistry } from './templates/registry.js';
import { templateRoutes } from './templates/api.js';
import { createGithub, githubRoutes } from './templates/github.js';
import { createTemplateSources } from './templates/sources.js';
import { VERSION } from './version.js';

// code: 'locked' when another process holds the data directory, else 'startup'.
export class StartupError extends Error {
  constructor(message, code = 'startup') {
    super(message);
    this.name = 'StartupError';
    this.code = code;
  }
}

// Everything but HTTP, for the platform and for CLI commands that change the data directory:
// { lock, store, bus, audit, templates, overlays, media, shows, timeline, sources, connectors,
// close() }. Holds the data-directory lock until close(). ffmpeg, media, fetch, lookup and clock:
// test hooks ([executable, ...args] in place of config.ffmpeg; options for the media library; what
// template sources fetch and resolve with; { now, timers } for shows, the timeline and connections,
// a server clock set ahead, H19). connectors: test hooks for the connector host ({ defs, fetch,
// lookup, endpoints, random, holdMs }: definitions in place of the built-in ones, what connections
// fetch and resolve with, their services' base URLs, the backoff's dice, how long a value is held
// through an error). The connector host is made
// here (the timeline runs connector.action cues through it) but only the platform starts it.
// readOnly: a look that changes nothing (a dry run): templates and media aren't touched, and shows
// don't catch up what fell due while the platform was down (the platform does that when it starts).
// github: test hooks for GitHub's device sign-in ({ secondMs }: how long a second of its polling
// interval is).
export function openData(config, { log, templateDirs = [], purpose = 'platform', ffmpeg, media: mediaOptions = {}, fetch, sourceLimits, lookup, clock = {}, readOnly = false, connectors: connectorOptions = {}, github: githubOptions = {} }) {
  ensureDir(config.dataDir, 'data directory', 'SKP_DATA_DIR');
  ensureDir(config.configDir, 'config directory', 'SKP_CONFIG_DIR', 0o700);
  let lock;
  try {
    lock = lockDataDir(config.dataDir, { log, purpose });
  } catch (err) {
    if (err instanceof LockError) throw new StartupError(err.message, 'locked');
    throw err;
  }
  // The lock stays fresh for as long as it is held, for a process on another host that looks at
  // it: the platform's whole run, or a CLI command converting a long clip.
  const freshen = setInterval(() => lock.refresh(), REFRESH_MS);
  freshen.unref();
  let store;
  let bus;
  try {
    // The master key, made in the config directory on the platform's first start (07 §7.7); a
    // command line command reads it only when it needs it, and never makes one: a new key decrypts
    // nothing already stored, and a command run without the platform's SKP_MASTER_KEY(_FILE) would
    // leave a stray key where the platform looks for one.
    const keyFor = () => {
      try {
        return createSecrets(loadMasterKey(config, { log: log.child('secrets'), create: purpose === 'platform' }));
      } catch (err) {
        if (err instanceof SecretsError) throw new StartupError(err.message);
        throw err;
      }
    };
    let loaded = purpose === 'platform' ? keyFor() : undefined;
    const secrets = {
      encrypt: (plain, aad) => (loaded ??= keyFor()).encrypt(plain, aad),
      decrypt: (text, aad) => (loaded ??= keyFor()).decrypt(text, aad),
      get kid() { return (loaded ??= keyFor()).kid; },
    };
    const storeLog = log.child('store');
    store = openStore({ dataDir: config.dataDir, backend: config.store, log: storeLog });
    migrate(store, migrations, { log: storeLog });
    bus = createBus({ log: log.child('bus') });
    const audit = createAudit({ store, now: clock.now, retentionDays: config.auditDays });
    const templates = createTemplateRegistry({ dirs: [BUILTIN_DIR, ...templateDirs], dataDir: config.dataDir, log: log.child('templates'), readOnly });
    const overlays = createOverlays({ store, bus, templates, log: log.child('overlays'), secrets, exposure: config.exposure, readOnly });
    const media = createMediaLibrary({ ...mediaOptions, dataDir: config.dataDir, store, log: log.child('media'), ffmpeg: ffmpeg ?? config.ffmpeg, readOnly });
    const shows = createShows({ store, bus, overlays, templates, log: log.child('shows'), ...clock, passive: readOnly });
    // Alerts reach overlays through the queue (05 §5.5): one per show, or per overlay outside one.
    const alerts = createAlertQueue({
      groupOf: (id) => shows.list().find((s) => s.overlays.includes(id))?.id,
      specOf: (id) => {
        const doc = store.get('overlays', id);
        const r = doc && overlays.resolve(doc.data.slug);
        return r?.template ? alertSpec(r.template.manifest, r.settings) : undefined;
      },
      deliver: (id, env) => bus.deliver(id, env),
      cut: (ids, alertId) => { for (const id of ids) bus.publish('alerts.cut', { alertId }, { target: id }); },
      stamp: (env, data) => bus.envelope(env.type, data, env.src),
      now: clock.now, timers: clock.timers, log: log.child('alerts'),
    });
    bus.useAlertQueue(alerts);
    let registry;
    try {
      registry = createConnectorRegistry(connectorOptions.defs ?? BUILTIN);
    } catch (err) {
      throw new StartupError(err.message);
    }
    const connectors = createConnectorHost({
      store, bus, secrets, overlays, templates, audit, log: log.child('connectors'), registry, ...clock,
      fetch: connectorOptions.fetch, lookup: connectorOptions.lookup, endpoints: connectorOptions.endpoints, random: connectorOptions.random,
      ...(connectorOptions.holdMs ? { holdMs: connectorOptions.holdMs } : {}),
      exposure: config.exposure, publicUrl: config.publicUrl,
    });
    const timeline = createTimeline({
      store, shows, overlays, media, connectors, log: log.child('timeline'), ...clock,
      record: (action, details) => audit.record({ action, ...details }),
    });
    // The GitHub token template sources read private repositories with: the one saved in Settings
    // → Integrations, else SKP_GITHUB_TOKEN (04 §4.13).
    const github = createGithub({ store, secrets, config, audit, log: log.child('github'), fetch, lookup, limits: sourceLimits, ...githubOptions });
    const sources = createTemplateSources({
      store, templates, overlays, log: log.child('sources'), github: github.auth, fetch, limits: sourceLimits, lookup, allowPrivate: config.allowPrivateDownloads,
      onAir: (overlayId) => shows.onAir(overlayId),
      record: (action, details) => audit.record({ action, actor: 'updater', ...details }),
    });
    return {
      lock, store, bus, secrets, audit, templates, overlays, media, shows, timeline, sources, connectors, alerts, github,
      close() {
        clearInterval(freshen);
        alerts.close();
        github.stop();
        sources.stop();
        timeline.stop();
        shows.stop();
        media.close();
        bus.close();
        store.close();
        lock.release();
      },
    };
  } catch (err) {
    clearInterval(freshen);
    bus?.close();
    store?.close();
    lock.release();
    throw err;
  }
}

// Test hooks: options.routes adds routes, options.heartbeatMs shortens the SSE heartbeat,
// options.templateDirs adds directories of templates beside the built-in ones, options.ffmpeg
// replaces the configured ffmpeg, options.media goes to the media library, options.fetch and
// options.sourceLimits are what template sources fetch with and their limits,
// options.simulateHoldMs shortens how long simulated state lasts, options.clock ({ now, timers })
// is the clock shows, the timeline and sign-in run on (and how long the machine's addresses are
// kept), options.scrypt lowers the password hash's cost for tests ({ N }), options.rateLimit
// replaces the API's requests a minute, options.interfaces is what os.networkInterfaces() would
// answer, and options.connectors goes to the connector host ({ defs, fetch, lookup, endpoints,
// random }, openData), options.github to GitHub's device sign-in ({ secondMs }, openData).
export async function startPlatform(config, { log, routes = [], heartbeatMs, templateDirs = [], ffmpeg, media: mediaOptions, fetch, sourceLimits, lookup, simulateHoldMs, clock = {}, scrypt, rateLimit, interfaces, connectors: connectorOptions, github: githubOptions } = {}) {
  ensureDir(config.dataDir, 'data directory', 'SKP_DATA_DIR');
  const crash = createCrashLog(path.join(config.dataDir, 'crash.log'));
  const pruned = crash.prune(30);
  if (pruned) log.info('pruned old crash.log entries', { pruned });

  // Built-in TLS (07 §7.8): the certificate and key, read once at startup.
  let tls;
  if (config.tlsCert) {
    try {
      tls = { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) };
    } catch (err) {
      throw new StartupError(`Can't read the TLS certificate or key (${err.path || ''}: ${err.code || err.message}). Check SKP_TLS_CERT and SKP_TLS_KEY.`);
    }
  }

  const data = openData(config, { log, templateDirs, ffmpeg, media: mediaOptions, fetch, sourceLimits, lookup, clock, connectors: connectorOptions, github: githubOptions });
  const { store, bus, secrets, audit, templates, overlays, media, shows, timeline, sources, connectors, github } = data;
  // In lan and public modes the machine's own names too, read again as its addresses change; a
  // container's are its own, not the host's: SKP_HOSTS names those. hosts(req): with the request,
  // a Host that isn't among them has them read again (http/local.js).
  const network = config.exposure === 'local' ? () => [] : liveMachineNames({ read: () => machineNames(interfaces ? { interfaces } : {}), now: clock.now });
  const hosts = (req) => ownHosts(server, config.host, { exposure: config.exposure, extra: [...network(req?.headers?.host), ...config.hosts], publicUrl: config.publicUrl, tls: Boolean(tls) });
  const auth = createAuth({ store, audit, secrets, log: log.child('auth'), now: clock.now, hasher: createHasher(scrypt ? { params: { r: 8, p: 1, ...scrypt } } : {}), configDir: config.configDir });
  const guard = createGuard({ auth, hosts });
  const api = createApi({ guard, hosts, store, log: log.child('api'), now: clock.now, ...(rateLimit ? { perMinute: rateLimit } : {}) });
  // Each show's and overlay's stream status (what feeds it, whether it is on air), worked out on read.
  const streams = createStreams({ bus, connections: connectors, store });
  const server = createHttpServer({
    log: log.child('http'),
    crash,
    tls,
    trustProxy: config.trustProxy,
    admit: admission(config),
    routes: [
      ...overlayRoutes({ overlays, templates, guard, log: log.child('overlays'), heartbeatMs }),
      ...uiRoutes(),
      ...mediaRoutes({ media }),
      // The API (03): every route on its conventions (http/api.js).
      ...authRoutes({ api, auth, audit }),
      ...showRoutes({ api, shows, timeline, streams }),
      ...simulateRoutes({ api, overlays, bus, log: log.child('simulate'), holdMs: simulateHoldMs }),
      ...alertRoutes({ api, alerts: data.alerts, overlays, shows }),
      // An overlay's URL is the public URL's, else the one the request came to (the guard checked
      // it is one of the platform's own names).
      ...overlayApiRoutes({ api, overlays, templates, shows, audit, connections: connectors, streams, base: (req) => config.publicUrl || `${req.client.https ? 'https' : 'http'}://${req.headers.host}` }),
      ...templateRoutes({ api, templates, overlays, sources, audit, config, fetch, lookup, github: github.auth }),
      // The GitHub token template installs use (Settings → Integrations → GitHub).
      ...githubRoutes({ api, github }),
      // A file is in use while an overlay, a lineup, a cue or a plan points to it (03 §3.4).
      ...mediaApiRoutes({ api, media, overlays, shows, timeline, audit, now: clock.now }),
      // Connections (06): their setup, sign-in, the OAuth callback and inbound webhooks.
      ...connectorRoutes({ api, host: connectors, auth, hosts, log: log.child('connectors') }),
      ...systemRoutes({ api, bus, store, media, templates, overlays, shows, connectors, config, version: VERSION, heartbeatMs, now: clock.now }),
      ...routes,
    ],
  });

  let address;
  try {
    address = await listen(server, config.port, config.host);
  } catch (err) {
    data.close();
    if (err.code === 'EADDRINUSE') {
      throw new StartupError(
        `Port ${config.port} on ${config.host} is already in use. Is another copy running (v0 also uses 4848)? ` +
        'Stop it, or set SKP_PORT.');
    }
    throw err;
  }

  // The address this process reaches itself at (0.0.0.0 and :: are any interface: loopback).
  const bound = address.address === '0.0.0.0' ? '127.0.0.1' : address.address === '::' ? '::1' : address.address;
  const host = bound.includes(':') ? `[${bound}]` : bound;
  const scheme = tls ? 'https' : 'http';
  log.info('listening', { url: `${scheme}://${host}:${address.port}/`, exposure: config.exposure, ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}), store: store.kind, schemaVersion: store.schemaVersion });

  // Whether phone video can be converted, in the log from the start (not only at the first upload).
  media.ffmpeg();
  // New releases of followed templates, checked by the platform itself (04 §4.13).
  sources.start(config.templateCheckMinutes);
  const followed = sources.list().length;
  if (followed) log.info('checking template sources for new releases', { sources: followed, everyMinutes: config.templateCheckMinutes || 'never' });
  // The timeline fires cues on the server's own clock (09 §9.4).
  timeline.start();
  // A setup code if there's no owner yet (in the log), and the command line's local token.
  auth.start();
  // Connections, once the address a redirect URI names is known: the one this process listens at
  // (127.0.0.1, never "localhost": services compare redirect URIs as text), unless SKP_PUBLIC_URL.
  connectors.setOrigin(`${scheme}://${host}:${address.port}`);
  // Where OBS reaches this platform from another machine, for the overlays connections share
  // with CTD Relay's hub (06 §6.11).
  const shared = shareBase(config, { scheme, port: address.port });
  connectors.setShareBase(() => shared);
  connectors.start().catch((err) => log.error('connections could not start', { err }));

  let stopped = false;
  return {
    config,
    store,
    bus,
    audit,
    auth,
    templates,
    overlays,
    media,
    shows,
    timeline,
    sources,
    connectors,
    github,
    alerts: data.alerts,
    crash,
    server,
    port: address.port,
    url: `${scheme}://${host}:${address.port}`,
    async stop() {
      if (stopped) return;
      stopped = true;
      await close(server);
      auth.stop();
      // Nothing fires while the rest shuts down (a conversion can take seconds to stop).
      timeline.stop();
      shows.stop();
      // A template check in progress is abandoned before the store closes.
      await sources.stop();
      // Connections stop (their memory saved) before the bus and the store close.
      await connectors.stop();
      // Conversions are stopped, and what they leave is cleared before the store closes.
      await media.close();
      data.close();
    },
  };
}

// The names this platform answers to, as host:port: what an API request must be addressed to
// (http/local.js; a DNS-rebinding page uses another). On this machine: 127.0.0.1, localhost, [::1]
// and the configured host (SKP_HOST=127.0.0.2, say). In lan and public modes also the machine's
// addresses and host name (extra), SKP_HOSTS, and the public URL's host. On the default port (80,
// or 443 with TLS) each name also without the port, as browsers and fetch send it.
export function ownHosts(server, configuredHost, { exposure = 'local', extra = [], publicUrl, tls = false } = {}) {
  const port = server.address()?.port;
  if (!port) return [];
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  const add = (h) => { if (h && !names.includes(h)) names.push(h); };
  if (configuredHost && configuredHost !== '0.0.0.0' && configuredHost !== '::') {
    const h = String(configuredHost).toLowerCase();
    add(h.includes(':') ? `[${h}]` : h);
  }
  const withPort = [];
  if (exposure !== 'local') {
    for (const e of extra) {
      if (/:\d+$/.test(e) && !e.endsWith(']')) withPort.push(e.toLowerCase());
      else add(String(e).toLowerCase());
    }
  }
  const hostPorts = names.map((n) => `${n}:${port}`);
  const bare = port === (tls ? 443 : 80) ? names : [];
  // The public URL as people reach it (through a proxy, on its own port or none).
  const pub = publicUrl ? [new URL(publicUrl).host] : [];
  return [...new Set([...hostPorts, ...bare, ...withPort, ...pub])];
}

// The address OBS on another machine opens this platform's overlays at: { url } or { problem }.
// SKP_PUBLIC_URL when set; else, in lan and public modes, the first SKP_HOSTS name, with the port
// it names or the one the platform listens on (the NAS sets SKP_HOSTS=192.168.1.50:4850 → http://
// 192.168.1.50:4850). The machine's own addresses are never guessed: inside a container they
// aren't the ones the network sees.
export function shareBase(config, { scheme, port }) {
  if (config.publicUrl) return { url: config.publicUrl };
  if (config.exposure === 'local') {
    return { problem: 'This platform answers on this computer only (SKP_EXPOSURE=local), so OBS on another machine can\'t open its overlays: set SKP_EXPOSURE=lan and SKP_HOSTS to this machine\'s address (like 192.168.1.50:4850).' };
  }
  const first = config.hosts?.[0];
  if (!first) return { problem: 'This platform doesn\'t know the address the network reaches it at: set SKP_HOSTS to it (like 192.168.1.50:4850), or SKP_PUBLIC_URL.' };
  const withPort = /:\d+$/.test(first) && !first.endsWith(']') ? first : `${first}:${port}`;
  const bare = (scheme === 'https' && withPort.endsWith(':443')) || (scheme === 'http' && withPort.endsWith(':80')) ? withPort.replace(/:\d+$/, '') : withPort;
  return { url: `${scheme}://${bare}` };
}

// Which clients a mode serves (07 §7.8): lan, the local network only; public, anyone over HTTPS
// (from the local network, plain HTTP too, so OBS on the LAN needs no certificate).
function admission(config) {
  if (config.exposure === 'local') return undefined;
  return (req) => {
    const { ip, https } = req.client;
    const inside = isPrivateAddress(ip);
    // SKP_ALLOW_PLAIN_INTERNET: the owner opened lan mode to the internet (a port forward).
    if (config.exposure === 'lan' && !inside && !config.allowPlainInternet) {
      return { status: 403, title: 'Forbidden', detail: 'This platform serves its local network only (SKP_EXPOSURE=lan).' };
    }
    if (config.exposure === 'public' && !inside && !https) {
      return { status: 403, title: 'HTTPS required', detail: `Use ${config.publicUrl || 'https://'}: from outside the local network this platform answers over HTTPS only.` };
    }
    return undefined;
  };
}

function ensureDir(dir, label, envName, mode) {
  try {
    mkdirSync(dir, { recursive: true, mode });
  } catch (err) {
    throw new StartupError(`Can't create the ${label} ${dir} (${err.code || err.message}). Check that this user can write there, or set ${envName}.`);
  }
}
