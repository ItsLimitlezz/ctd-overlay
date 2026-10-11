// Starts the platform for a given configuration: data and config directories, the data-directory
// lock, crash log, store (with migrations), bus, templates, overlays and the HTTP server. Returns
// a handle with stop(). Installs no process-wide handlers, so tests can run several instances.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createBus } from './bus/index.js';
import { createCrashLog } from './crashlog.js';
import { close, createHttpServer, listen } from './http/server.js';
import { lockDataDir, LockError } from './lock.js';
import { createOverlays } from './overlays/registry.js';
import { overlayRoutes } from './overlays/routes.js';
import { migrate } from './store/migrate.js';
import { migrations } from './store/migrations.js';
import { openStore } from './store/index.js';
import { BUILTIN_DIR, createTemplateRegistry } from './templates/registry.js';

export class StartupError extends Error {}

// Everything but HTTP, for the platform and for CLI commands that change the data directory:
// { lock, store, bus, templates, overlays, close() }. Holds the data-directory lock until close().
export function openData(config, { log, templateDirs = [], purpose = 'platform' }) {
  ensureDir(config.dataDir, 'data directory', 'SKP_DATA_DIR');
  ensureDir(config.configDir, 'config directory', 'SKP_CONFIG_DIR', 0o700);
  let lock;
  try {
    lock = lockDataDir(config.dataDir, { log, purpose });
  } catch (err) {
    if (err instanceof LockError) throw new StartupError(err.message);
    throw err;
  }
  let store;
  let bus;
  try {
    const storeLog = log.child('store');
    store = openStore({ dataDir: config.dataDir, backend: config.store, log: storeLog });
    migrate(store, migrations, { log: storeLog });
    bus = createBus({ log: log.child('bus') });
    const templates = createTemplateRegistry({ dirs: [BUILTIN_DIR, ...templateDirs], dataDir: config.dataDir, log: log.child('templates') });
    const overlays = createOverlays({ store, bus, templates, log: log.child('overlays') });
    return {
      lock, store, bus, templates, overlays,
      close() {
        bus.close();
        store.close();
        lock.release();
      },
    };
  } catch (err) {
    bus?.close();
    store?.close();
    lock.release();
    throw err;
  }
}

// Test hooks: options.routes adds routes, options.heartbeatMs shortens the SSE heartbeat, and
// options.templateDirs adds directories of templates beside the built-in ones.
export async function startPlatform(config, { log, routes = [], heartbeatMs, templateDirs = [] } = {}) {
  ensureDir(config.dataDir, 'data directory', 'SKP_DATA_DIR');
  const crash = createCrashLog(path.join(config.dataDir, 'crash.log'));
  const pruned = crash.prune(30);
  if (pruned) log.info('pruned old crash.log entries', { pruned });

  const data = openData(config, { log, templateDirs });
  const { store, bus, templates, overlays } = data;
  const server = createHttpServer({
    log: log.child('http'),
    crash,
    routes: [...overlayRoutes({ overlays, log: log.child('overlays'), heartbeatMs }), ...routes],
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

  let stopped = false;
  return {
    config,
    store,
    bus,
    templates,
    overlays,
    crash,
    server,
    port: address.port,
    url: `http://${host}:${address.port}`,
    async stop() {
      if (stopped) return;
      stopped = true;
      await close(server);
      data.close();
    },
  };
}

function ensureDir(dir, label, envName, mode) {
  try {
    mkdirSync(dir, { recursive: true, mode });
  } catch (err) {
    throw new StartupError(`Can't create the ${label} ${dir} (${err.code || err.message}). Check that this user can write there, or set ${envName}.`);
  }
}
