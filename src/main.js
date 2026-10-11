// Entry point: `npm start` or `node src/main.js [--port 4848 …]`.
import { startPlatform, StartupError } from './app.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { createLogger } from './log.js';
import { StoreVersionError } from './store/migrate.js';
import { VERSION } from './version.js';

const EX_CONFIG = 78;

let config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  process.stderr.write(`skp: configuration error: ${err.message}\n`);
  process.exit(EX_CONFIG);
}

const log = createLogger({ level: config.logLevel });
log.info('starting', { version: VERSION, node: process.version, config: describeConfig(config) });
for (const warning of config.warnings) log.warn(warning);

let platform;
try {
  platform = await startPlatform(config, { log });
} catch (err) {
  if (err instanceof StartupError || err instanceof StoreVersionError) {
    log.error(err.message);
    process.stderr.write(`skp: ${err.message}\n`);
  } else {
    log.error('startup failed', { err });
  }
  process.exit(1);
}

// From here on, nothing may take the process down (H11): log, record, keep serving.
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { err });
  platform.crash.record('uncaughtException', err);
});
process.on('unhandledRejection', (err) => {
  log.error('unhandled rejection', { err });
  platform.crash.record('unhandledRejection', err);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info('stopping', { signal });
  setTimeout(() => process.exit(0), 5000).unref();
  await platform.stop();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
