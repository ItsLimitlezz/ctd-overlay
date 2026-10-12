// Entry point: `npm start` or `node src/main.js [--port 4848 …]` runs the platform;
// `node src/main.js <command> …` (npm run skp -- …) runs a command (src/cli.js).
import { startPlatform, StartupError } from './app.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { createLogger } from './log.js';
import { StoreVersionError } from './store/migrate.js';
import { VERSION } from './version.js';

const EX_CONFIG = 78;

const argv = process.argv.slice(2);
if (isCommand(argv)) {
  // A command: it closes what it opened, so the process ends once its output is written.
  const { run } = await import('./cli.js');
  try {
    process.exitCode = await run(argv);
  } catch (err) {
    process.stderr.write(`skp: unexpected error: ${err?.stack || err}\n`);
    process.exitCode = 1;
  }
} else {
  await serve();
}

// A command has a word (`template list`), or a flag only commands take (--help, --json …), in any
// order with the server's own flags, which all take a value (`--data-dir D template list`).
function isCommand(args) {
  const commandFlags = new Set(['--help', '-h', '--json', '--dry-run', '--yes', '--run-migrate', '-o', '--out', '--to', '--name', '--auto-upgrade', '--template', '--from', '--overlays', '--date', '--go-live', '--day-boundary', '--lineup', '--transition', '--args', '--at', '--scene', '--action', '--slot', '--play', '--stop', '--cue', '--label', '--recipe', '--settings', '--all', '--code', '--username', '--role', '--scopes', '--expires-days', '--ips', '--limit']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-') || commandFlags.has(a.split('=')[0])) return true;
    if (!a.includes('=')) i++; // the server flag's value
  }
  return false;
}

async function serve() {
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
}
