// Starts the platform for a given configuration: data and config directories, crash log,
// store (with migrations), HTTP server. Returns a handle with stop(). Installs no process-wide
// handlers, so tests can run several instances.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createCrashLog } from './crashlog.js';
import { close, createHttpServer, listen } from './http/server.js';
import { migrate } from './store/migrate.js';
import { migrations } from './store/migrations.js';
import { openStore } from './store/index.js';

export class StartupError extends Error {}

export async function startPlatform(config, { log, routes = [] }) {
  ensureDir(config.dataDir, 'data directory', 'SKP_DATA_DIR');
  ensureDir(config.configDir, 'config directory', 'SKP_CONFIG_DIR', 0o700);

  const crash = createCrashLog(path.join(config.dataDir, 'crash.log'));
  const pruned = crash.prune(30);
  if (pruned) log.info('pruned old crash.log entries', { pruned });

  const storeLog = log.child('store');
  const store = openStore({ dataDir: config.dataDir, backend: config.store, log: storeLog });
  try {
    migrate(store, migrations, { log: storeLog });
  } catch (err) {
    store.close();
    throw err;
  }

  const server = createHttpServer({ log: log.child('http'), crash, routes });
  let address;
  try {
    address = await listen(server, config.port, config.host);
  } catch (err) {
    store.close();
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
    crash,
    server,
    port: address.port,
    url: `http://${host}:${address.port}`,
    async stop() {
      if (stopped) return;
      stopped = true;
      await close(server);
      store.close();
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
