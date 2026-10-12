// The command line: `skp <noun> <verb>` (npm run skp -- template install x.skp). For template
// authors and for operators until the admin UI and its API arrive (steps 13–14).
//
// Commands that change the data directory (install, uninstall, upgrade, revert) take its lock, so
// they run while the platform is stopped: a running server would neither see the change nor keep
// the JSON store's copy of it. Each is appended to <dataDir>/operations.log, the record of who
// changed what from the command line until the audit log arrives (step 14). validate and pack
// never touch the data directory.
//
// Exit codes: 0 done, 1 refused or invalid, 64 usage, 75 the data directory is in use, 77 wrong
// user (root on a data directory another user owns), 78 config.
import { appendFileSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openData, StartupError } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './log.js';
import { OverlayError } from './overlays/registry.js';
import { StoreVersionError } from './store/migrate.js';
import { MigrateError } from './templates/migrate.js';
import { packageFromDir, validatePackage } from './templates/package.js';
import { BUILTIN_DIR, createTemplateRegistry, TemplateError, validateTemplate } from './templates/registry.js';
import { writeZip, ZipError } from './templates/zip.js';

export const USAGE = `Usage: skp <command> [options]

  template validate <file.skp|dir>        check a template package (04 §4.11)
  template pack <dir> [-o <file.skp>]     make a package from a template directory
  template list                           bundled and installed templates
  template install <file.skp>             install a package (the platform must be stopped)
  template uninstall <id>[@<version>]     remove an installed version, or every version
  overlay upgrade <slug> --to <version>   move an overlay to a newer template version
        [--dry-run] [--yes]               show what would change / confirm it
        [--run-migrate]                   let an installed package's migrate.js run
  overlay revert <slug>                   go back to the version and settings before the last upgrade

Options: --json (machine-readable output), and the server's own --data-dir, --config-dir and
--store to find the data directory (the same environment variables work too).`;

const CONFIG_FLAGS = ['data-dir', 'config-dir', 'store', 'log-level'];
const NOTE = 'Templates are code: they run in OBS and in the admin UI\'s previews, and see the data their manifest declares.';

export async function run(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const out = (s) => stdout.write(`${s}\n`);
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' }, 'run-migrate': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
        to: { type: 'string' }, out: { type: 'string', short: 'o' },
        ...Object.fromEntries(CONFIG_FLAGS.map((f) => [f, { type: 'string' }])),
      },
    });
  } catch (err) {
    stderr.write(`skp: ${err.message}\n\n${USAGE}\n`);
    return 64;
  }
  const { values: opts, positionals: [noun, verb, ...rest] } = args;
  const json = (value) => out(JSON.stringify(value, null, 2));
  const usage = (msg) => {
    stderr.write(`${msg ? `skp: ${msg}\n\n` : ''}${USAGE}\n`);
    return msg ? 64 : 0;
  };
  if (opts.help || noun === 'help') return usage();

  const config = () => loadConfig({ argv: CONFIG_FLAGS.flatMap((f) => (opts[f] === undefined ? [] : [`--${f}`, opts[f]])), env });
  // Warnings and errors only, on stderr: stdout is the command's result.
  const logger = () => createLogger({ level: opts['log-level'] || 'warn', write: (line) => stderr.write(`${line}\n`) }).child('cli');
  // The data directory, locked, for a command that may write to it.
  const openFor = (purpose, cfg = config()) => {
    checkOwner(cfg.dataDir);
    const data = openData(cfg, { log: logger(), purpose });
    return Object.assign(data, { record: (details) => record(cfg.dataDir, purpose, details) });
  };

  try {
    const command = `${noun ?? ''} ${verb ?? ''}`.trim();
    switch (command) {
      case 'template validate': {
        if (rest.length !== 1) return usage('template validate takes one file or directory');
        const result = validateTemplate(rest[0]);
        if (opts.json) json(findingsJson(result));
        else printFindings(out, result);
        return result.errors.length ? 1 : 0;
      }

      case 'template pack': {
        if (rest.length !== 1) return usage('template pack takes one directory');
        const pkg = packageFromDir(rest[0]);
        const result = validatePackage(pkg);
        if (result.errors.length) {
          if (opts.json) json(findingsJson(result));
          else printFindings(out, result);
          return 1;
        }
        const { id, version } = result.manifest;
        const file = opts.out || `${id}-${version}.skp`;
        writeFileSync(file, writeZip(pkg.names.map((name) => ({ name, data: pkg.read(name) }))));
        if (opts.json) json({ file: path.resolve(file), id, version, warnings: result.warnings });
        else {
          printFindings(out, { ...result, errors: [] });
          out(`wrote ${file}`);
        }
        return 0;
      }

      case 'template list': {
        if (rest.length) return usage('template list takes no arguments');
        const cfg = config();
        let data;
        let pins = null;
        let templates;
        try {
          data = openFor('template list', cfg);
          templates = data.templates;
          pins = (id, version) => data.overlays.pinnedBy(id, version).length;
        } catch (err) {
          if (!(err instanceof StartupError) || !/running|already uses/.test(err.message)) throw err;
          // The platform holds the data directory: list what is installed, without touching it.
          templates = createTemplateRegistry({ dirs: [BUILTIN_DIR], dataDir: cfg.dataDir, log: logger(), readOnly: true });
        }
        try {
          const rows = templates.list()
            .sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1))
            .map((t) => ({ id: t.id, version: t.version, name: t.manifest.name, category: t.manifest.category, build: t.build, source: templates.fromPlatform(t) ? 'bundled' : 'installed', overlays: pins ? pins(t.id, t.version) : undefined }));
          if (opts.json) json(rows);
          else {
            for (const r of rows) out(`${`${r.id}@${r.version}`.padEnd(40)} ${r.build}  ${r.source.padEnd(9)} ${r.overlays === undefined ? '' : `${r.overlays} overlay${r.overlays === 1 ? '' : 's'}`}`);
            if (!pins) out('(the platform is running, so overlay counts are not shown)');
          }
          return 0;
        } finally {
          data?.close();
        }
      }

      case 'template install': {
        if (rest.length !== 1) return usage('template install takes one .skp file');
        const data = openFor('template install');
        try {
          const { template, warnings, noop } = data.templates.install(rest[0], { actor: 'cli' });
          if (!noop) data.record({ file: path.resolve(rest[0]), template: `${template.id}@${template.version}`, build: template.build });
          if (opts.json) json({ id: template.id, version: template.version, build: template.build, noop, warnings });
          else {
            printFindings(out, { errors: [], warnings });
            out(noop ? `${template.id}@${template.version} is already installed (build ${template.build}).` : `installed ${template.id}@${template.version} (build ${template.build})`);
            out(NOTE);
          }
          return 0;
        } finally {
          data.close();
        }
      }

      case 'template uninstall': {
        if (rest.length !== 1) return usage('template uninstall takes <id> or <id>@<version>');
        const [id, version] = rest[0].split('@');
        const data = openFor('template uninstall');
        try {
          const removed = data.templates.uninstall(id, version, { pinnedBy: data.overlays.pinnedBy, actor: 'cli' });
          data.record({ removed: removed.map((r) => `${r.id}@${r.version}`) });
          if (opts.json) json({ removed });
          else for (const r of removed) out(`removed ${r.id}@${r.version} (build ${r.build})`);
          return 0;
        } finally {
          data.close();
        }
      }

      case 'overlay upgrade': {
        if (rest.length !== 1 || !opts.to) return usage('overlay upgrade takes <slug> --to <version>');
        const data = openFor('overlay upgrade');
        try {
          let plan;
          try {
            plan = await data.overlays.upgrade(rest[0], opts.to, { dryRun: opts['dry-run'], confirm: opts.yes, runMigrate: opts['run-migrate'] });
          } catch (err) {
            // Refusals that come with the plan: show it, so the operator sees why.
            if (err instanceof OverlayError && err.detail?.overlay !== undefined) {
              const confirmable = err.code === 'confirm-major' || err.code === 'confirm-changes';
              if (opts.json) json({ error: err.code, message: err.message, plan: err.detail });
              else {
                printPlan(out, err.detail);
                out(confirmable ? `${err.message} Run it again with --yes to apply.` : err.message);
              }
              return 1;
            }
            throw err;
          }
          if (!opts['dry-run']) data.record({ overlay: plan.overlay, from: plan.from, to: plan.to, migrated: plan.migrated, changes: plan.changes.length });
          if (opts.json) json({ ...plan, doc: undefined, applied: !opts['dry-run'] });
          else {
            printPlan(out, plan);
            out(opts['dry-run'] ? `Nothing changed (--dry-run).${plan.confirm ? ' Applying it needs --yes.' : ''}` : `${plan.overlay} now uses ${plan.to}; its URL is unchanged. (skp overlay revert ${plan.overlay} goes back.)`);
          }
          return 0;
        } finally {
          data.close();
        }
      }

      case 'overlay revert': {
        if (rest.length !== 1) return usage('overlay revert takes <slug>');
        const data = openFor('overlay revert');
        try {
          const result = data.overlays.revert(rest[0]);
          data.record({ overlay: result.overlay, from: result.from, to: result.to });
          if (opts.json) json({ ...result, doc: undefined });
          else out(`${result.overlay} is back on ${result.to}, with the settings it had there; its URL is unchanged.`);
          return 0;
        } finally {
          data.close();
        }
      }

      default:
        return usage(noun ? `unknown command "${command}"` : '');
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`skp: configuration error: ${err.message}\n`);
      return 78;
    }
    if (err instanceof WrongUserError) {
      stderr.write(`skp: ${err.message}\n`);
      return 77;
    }
    if (err instanceof StartupError && /running|already uses/.test(err.message)) {
      stderr.write(`skp: ${err.message}\n`);
      return 75;
    }
    if (err instanceof TemplateError && err.findings.length) {
      if (opts.json) json({ error: err.code, message: err.message, ...findingsJson({ errors: err.findings.filter((f) => f.level === 'error'), warnings: err.findings.filter((f) => f.level === 'warning') }) });
      else {
        printFindings(out, { errors: err.findings.filter((f) => f.level === 'error'), warnings: err.findings.filter((f) => f.level === 'warning') });
        stderr.write(`skp: ${err.message}\n`);
      }
      return 1;
    }
    if (err instanceof TemplateError || err instanceof OverlayError || err instanceof ZipError || err instanceof MigrateError || err instanceof StartupError || err instanceof StoreVersionError || err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.name === 'ConflictError') {
      const message = err.code === 'ENOENT' ? `no such file: ${err.path}` : err.code === 'ENOTDIR' ? `not a directory: ${err.path}` : err.message;
      if (opts.json) json({ error: err.code || err.name, message });
      else stderr.write(`skp: ${message}\n`);
      return 1;
    }
    // Anything else is a bug: still one line (and JSON with --json), plus the stack for a report.
    if (opts.json) json({ error: 'internal', message: String(err?.message || err) });
    else stderr.write(`skp: unexpected error: ${err?.stack || err}\n`);
    return 1;
  }
}

class WrongUserError extends Error {}

// Root writing into a data directory another user owns would leave files the platform, running as
// that user, can't change or remove (POSIX; Windows has no such split).
function checkOwner(dataDir) {
  if (typeof process.geteuid !== 'function' || process.geteuid() !== 0) return;
  let st;
  try { st = statSync(dataDir); } catch { return; } // not there yet: it will be root's own
  if (st.uid !== 0) {
    throw new WrongUserError(`${dataDir} belongs to uid ${st.uid}, and this is root: files written now would be root's. Run skp as that user (e.g. sudo -u '#${st.uid}' …).`);
  }
}

// One JSON line per change made from the command line.
function record(dataDir, op, details) {
  let user;
  try { user = userInfo().username; } catch { user = undefined; }
  const line = JSON.stringify({ ts: new Date().toISOString(), op, user, pid: process.pid, ...details });
  try {
    appendFileSync(path.join(dataDir, 'operations.log'), `${line}\n`, { mode: 0o600 });
  } catch {
    // The change itself is done; a log that can't be written must not undo or hide it.
  }
}

function findingsJson({ manifest, errors, warnings, build }) {
  return { id: manifest?.id, version: manifest?.version, build, valid: errors.length === 0, errors, warnings, headless: 'skipped' };
}

function printFindings(out, { manifest, errors, warnings, build }) {
  if (manifest?.id) out(`${manifest.id}@${manifest.version}${build ? `  build ${build}` : ''}`);
  for (const f of [...errors, ...warnings]) out(`  ${f.level.padEnd(7)} ${f.path.padEnd(18)} ${f.message}`);
  if (errors.length) out(`${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`);
  else if (manifest) out(`valid${warnings.length ? `, with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}. (The headless render check is not available here yet.)`);
}

function printPlan(out, plan) {
  out(`${plan.overlay}: ${plan.from} → ${plan.to}${plan.major ? ' (major)' : ''}${plan.migrated === true ? ', settings run through the template\'s migrate.js' : ''}`);
  if (plan.migrated === 'skipped') out('  the package has a migrate.js, which was not run (it is the package\'s own code; allow it with --run-migrate)');
  const v = (x) => (x === undefined ? 'unset' : JSON.stringify(x));
  // A bound field falls back to its state key's value before its default.
  const fallback = (c) => (c.bind ? `the value of ${c.bind}, else its default (${v(c.to)})` : `its default (${v(c.to)})`);
  for (const c of plan.changes) {
    if (c.change === 'migrated') {
      if (c.to === undefined) out(`  migrate.js removed setting ${c.path} (was ${v(c.from)})`);
      else if (c.from === undefined) out(`  migrate.js set ${c.path} = ${v(c.to)}`);
      else out(`  migrate.js changed setting ${c.path} from ${v(c.from)} to ${v(c.to)}`);
    } else if (c.change === 'removed') out(`  setting ${c.path} is no longer used and is dropped (was ${v(c.from)})`);
    else if (c.change === 'invalid') out(`  setting ${c.path} = ${v(c.from)} doesn't fit the new version; it goes back to ${fallback(c)}`);
    else if (c.change === 'added') out(c.saved ? `  new setting ${c.path} = ${v(c.to)}` : `  new setting ${c.path}, which shows ${fallback(c)}`);
    else if (c.change === 'default') out(`  setting ${c.path} keeps its default, which changes from ${v(c.from)} to ${v(c.to)}${c.bind ? ` (when ${c.bind} has no value)` : ''}`);
  }
  for (const [what, ids] of Object.entries(plan.removed)) if (ids.length) out(`  removed ${what}: ${ids.join(', ')}`);
  for (const p of plan.problems || []) out(`  problem: ${p.path} ${p.message}`);
}
