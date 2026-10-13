// Starts the platform for a given configuration: data and config directories, the data-directory
// lock, crash log, store (with migrations), bus, templates, overlays, media and the HTTP server.
// Returns a handle with stop(). Installs no process-wide handlers, so tests can run several
// instances.
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createAudit } from './auth/audit.js';
import { createAuth } from './auth/index.js';
import { createHasher } from './auth/passwords.js';
import { authRoutes, createGuard } from './auth/routes.js';
import { createBus } from './bus/index.js';
import { createCrashLog } from './crashlog.js';
import { createApi } from './http/api.js';
import { close, createHttpServer, listen } from './http/server.js';
import { systemRoutes } from './http/system.js';
import { lockDataDir, LockError, REFRESH_MS } from './lock.js';
import { createMediaLibrary } from './media/library.js';
import { mediaApiRoutes } from './media/api.js';
import { mediaRoutes } from './media/routes.js';
import { isPrivateAddress, machineNames } from './net.js';
import { overlayApiRoutes } from './overlays/api.js';
import { createOverlays } from './overlays/registry.js';
import { overlayRoutes } from './overlays/routes.js';
import { simulateRoutes } from './overlays/simulate.js';
import { createSecrets, loadMasterKey, SecretsError } from './secrets.js';
import { createShows } from './shows/registry.js';
import { createTimeline } from './shows/timeline.js';
import { showRoutes } from './shows/routes.js';
import { migrate } from './store/migrate.js';
import { migrations } from './store/migrations.js';
import { openStore } from './store/index.js';
import { BUILTIN_DIR, createTemplateRegistry } from './templates/registry.js';
import { templateRoutes } from './templates/api.js';
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
// { lock, store, bus, audit, templates, overlays, media, shows, timeline, sources, close() }. Holds the
// data-directory lock until close(). ffmpeg, media, fetch, lookup and clock: test hooks
// ([executable, ...args] in place of config.ffmpeg; options for the media library; what template
// sources fetch and resolve with; { now, timers } for shows and the timeline, a server clock set
// ahead, H19).
export function openData(config, { log, templateDirs = [], purpose = 'platform', ffmpeg, media: mediaOptions = {}, fetch, sourceLimits, lookup, clock = {} }) {
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
    // command line command reads it, or makes it, only when it needs it.
    const keyFor = () => {
      try {
        return createSecrets(loadMasterKey(config, { log: log.child('secrets') }));
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
    const templates = createTemplateRegistry({ dirs: [BUILTIN_DIR, ...templateDirs], dataDir: config.dataDir, log: log.child('templates') });
    const overlays = createOverlays({ store, bus, templates, log: log.child('overlays'), secrets, exposure: config.exposure });
    const media = createMediaLibrary({ ...mediaOptions, dataDir: config.dataDir, store, log: log.child('media'), ffmpeg: ffmpeg ?? config.ffmpeg });
    const shows = createShows({ store, bus, overlays, templates, log: log.child('shows'), ...clock });
    const timeline = createTimeline({
      store, shows, overlays, media, log: log.child('timeline'), ...clock,
      record: (action, details) => audit.record({ action, ...details }),
    });
    const sources = createTemplateSources({
      store, templates, overlays, log: log.child('sources'), token: config.githubToken, fetch, limits: sourceLimits, lookup, allowPrivate: config.allowPrivateDownloads,
      onAir: (overlayId) => shows.onAir(overlayId),
      record: (action, details) => audit.record({ action, actor: 'updater', ...details }),
    });
    return {
      lock, store, bus, secrets, audit, templates, overlays, media, shows, timeline, sources,
      close() {
        clearInterval(freshen);
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
// is the clock shows, the timeline and sign-in run on, options.scrypt lowers the password hash's
// cost for tests ({ N }), and options.rateLimit replaces the API's requests a minute.
export async function startPlatform(config, { log, routes = [], heartbeatMs, templateDirs = [], ffmpeg, media: mediaOptions, fetch, sourceLimits, lookup, simulateHoldMs, clock = {}, scrypt, rateLimit } = {}) {
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

  const data = openData(config, { log, templateDirs, ffmpeg, media: mediaOptions, fetch, sourceLimits, lookup, clock });
  const { store, bus, secrets, audit, templates, overlays, media, shows, timeline, sources } = data;
  const network = config.exposure === 'local' ? [] : machineNames();
  const hosts = () => ownHosts(server, config.host, { exposure: config.exposure, extra: [...network, ...config.hosts], publicUrl: config.publicUrl, tls: Boolean(tls) });
  const auth = createAuth({ store, audit, secrets, log: log.child('auth'), now: clock.now, hasher: createHasher(scrypt ? { params: { r: 8, p: 1, ...scrypt } } : {}), configDir: config.configDir });
  const guard = createGuard({ auth, hosts });
  const api = createApi({ guard, hosts, store, log: log.child('api'), now: clock.now, ...(rateLimit ? { perMinute: rateLimit } : {}) });
  const server = createHttpServer({
    log: log.child('http'),
    crash,
    tls,
    trustProxy: config.trustProxy,
    admit: admission(config),
    routes: [
      ...overlayRoutes({ overlays, log: log.child('overlays'), heartbeatMs }),
      ...mediaRoutes({ media }),
      // The API (03): every route on its conventions (http/api.js).
      ...authRoutes({ api, auth, audit }),
      ...showRoutes({ api, shows, timeline }),
      ...simulateRoutes({ api, overlays, bus, log: log.child('simulate'), holdMs: simulateHoldMs }),
      // An overlay's URL is the public URL's, else the one the request came to (the guard checked
      // it is one of the platform's own names).
      ...overlayApiRoutes({ api, overlays, templates, shows, audit, base: (req) => config.publicUrl || `${req.client.https ? 'https' : 'http'}://${req.headers.host}` }),
      ...templateRoutes({ api, templates, overlays, sources, audit, config, fetch, lookup }),
      ...mediaApiRoutes({ api, media, overlays, audit }),
      ...systemRoutes({ api, bus, store, media, templates, overlays, shows, config, version: VERSION, heartbeatMs, now: clock.now }),
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

// Which clients a mode serves (07 §7.8): lan, the local network only; public, anyone over HTTPS
// (from the local network, plain HTTP too, so OBS on the LAN needs no certificate).
function admission(config) {
  if (config.exposure === 'local') return undefined;
  return (req) => {
    const { ip, https } = req.client;
    const inside = isPrivateAddress(ip);
    if (config.exposure === 'lan' && !inside) {
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
