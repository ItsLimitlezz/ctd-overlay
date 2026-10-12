// Starts the platform for a given configuration: data and config directories, the data-directory
// lock, crash log, store (with migrations), bus, templates, overlays, media and the HTTP server.
// Returns a handle with stop(). Installs no process-wide handlers, so tests can run several
// instances.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createBus } from './bus/index.js';
import { createCrashLog } from './crashlog.js';
import { close, createHttpServer, listen } from './http/server.js';
import { lockDataDir, LockError, REFRESH_MS } from './lock.js';
import { createMediaLibrary } from './media/library.js';
import { mediaRoutes } from './media/routes.js';
import { recordOperation } from './oplog.js';
import { createOverlays } from './overlays/registry.js';
import { overlayRoutes } from './overlays/routes.js';
import { simulateRoutes } from './overlays/simulate.js';
import { createShows } from './shows/registry.js';
import { createTimeline } from './shows/timeline.js';
import { showRoutes } from './shows/routes.js';
import { migrate } from './store/migrate.js';
import { migrations } from './store/migrations.js';
import { openStore } from './store/index.js';
import { BUILTIN_DIR, createTemplateRegistry } from './templates/registry.js';
import { createTemplateSources } from './templates/sources.js';

// code: 'locked' when another process holds the data directory, else 'startup'.
export class StartupError extends Error {
  constructor(message, code = 'startup') {
    super(message);
    this.name = 'StartupError';
    this.code = code;
  }
}

// Everything but HTTP, for the platform and for CLI commands that change the data directory:
// { lock, store, bus, templates, overlays, media, shows, timeline, sources, close() }. Holds the
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
    const storeLog = log.child('store');
    store = openStore({ dataDir: config.dataDir, backend: config.store, log: storeLog });
    migrate(store, migrations, { log: storeLog });
    bus = createBus({ log: log.child('bus') });
    const templates = createTemplateRegistry({ dirs: [BUILTIN_DIR, ...templateDirs], dataDir: config.dataDir, log: log.child('templates') });
    const overlays = createOverlays({ store, bus, templates, log: log.child('overlays') });
    const media = createMediaLibrary({ ...mediaOptions, dataDir: config.dataDir, store, log: log.child('media'), ffmpeg: ffmpeg ?? config.ffmpeg });
    const shows = createShows({ store, bus, overlays, templates, log: log.child('shows'), ...clock });
    const timeline = createTimeline({
      store, shows, overlays, media, log: log.child('timeline'), ...clock,
      record: (op, details) => recordOperation(config.dataDir, op, details),
    });
    const sources = createTemplateSources({
      store, templates, overlays, log: log.child('sources'), token: config.githubToken, fetch, limits: sourceLimits, lookup, allowPrivate: config.allowPrivateDownloads,
      onAir: (overlayId) => shows.onAir(overlayId),
      record: (op, details) => recordOperation(config.dataDir, op, { ...details, actor: 'updater' }),
    });
    return {
      lock, store, bus, templates, overlays, media, shows, timeline, sources,
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
// options.simulateHoldMs shortens how long simulated state lasts, and options.clock ({ now,
// timers }) is the clock shows and the timeline run on.
export async function startPlatform(config, { log, routes = [], heartbeatMs, templateDirs = [], ffmpeg, media: mediaOptions, fetch, sourceLimits, lookup, simulateHoldMs, clock } = {}) {
  ensureDir(config.dataDir, 'data directory', 'SKP_DATA_DIR');
  const crash = createCrashLog(path.join(config.dataDir, 'crash.log'));
  const pruned = crash.prune(30);
  if (pruned) log.info('pruned old crash.log entries', { pruned });

  const data = openData(config, { log, templateDirs, ffmpeg, media: mediaOptions, fetch, sourceLimits, lookup, clock });
  const { store, bus, templates, overlays, media, shows, timeline, sources } = data;
  const hosts = () => ownHosts(server, config.host);
  const server = createHttpServer({
    log: log.child('http'),
    crash,
    routes: [
      ...overlayRoutes({ overlays, log: log.child('overlays'), heartbeatMs }),
      ...showRoutes({ shows, timeline, hosts, log: log.child('shows') }),
      ...simulateRoutes({ overlays, bus, log: log.child('simulate'), hosts, holdMs: simulateHoldMs }),
      ...mediaRoutes({ media }),
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

  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  log.info('listening', { url: `http://${host}:${address.port}/`, exposure: config.exposure, store: store.kind, schemaVersion: store.schemaVersion });

  // Whether phone video can be converted, in the log from the start (not only at the first upload).
  media.ffmpeg();
  // New releases of followed templates, checked by the platform itself (04 §4.13).
  sources.start(config.templateCheckMinutes);
  const followed = sources.list().length;
  if (followed) log.info('checking template sources for new releases', { sources: followed, everyMinutes: config.templateCheckMinutes || 'never' });
  // The timeline fires cues on the server's own clock (09 §9.4).
  timeline.start();

  let stopped = false;
  return {
    config,
    store,
    bus,
    templates,
    overlays,
    media,
    shows,
    timeline,
    sources,
    crash,
    server,
    port: address.port,
    url: `http://${host}:${address.port}`,
    async stop() {
      if (stopped) return;
      stopped = true;
      await close(server);
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

// The names this platform answers to on this machine, as host:port (until LAN and public modes
// add theirs, step 12): what a request that changes something must be addressed to.
// The configured host is one of them (SKP_HOST=127.0.0.2, say), and on port 80 each name also
// without the port, as browsers and fetch send it.
export function ownHosts(server, configuredHost) {
  const port = server.address()?.port;
  if (!port) return [];
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  if (configuredHost) {
    const h = String(configuredHost).toLowerCase();
    const name = h.includes(':') ? `[${h}]` : h;
    if (!names.includes(name)) names.push(name);
  }
  return [...names.map((n) => `${n}:${port}`), ...(port === 80 ? names : [])];
}

function ensureDir(dir, label, envName, mode) {
  try {
    mkdirSync(dir, { recursive: true, mode });
  } catch (err) {
    throw new StartupError(`Can't create the ${label} ${dir} (${err.code || err.message}). Check that this user can write there, or set ${envName}.`);
  }
}
