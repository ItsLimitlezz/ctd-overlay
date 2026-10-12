// The command line: `skp <noun> <verb>` (npm run skp -- template install x.skp). For template
// authors and for operators until the admin UI and its API arrive (steps 13–14).
//
// Commands that change the data directory (install, uninstall, upgrade, revert) take its lock, so
// they run while the platform is stopped: a running server would neither see the change nor keep
// the JSON store's copy of it. Each is appended to <dataDir>/operations.log, the record of who
// changed what from the command line until the audit log arrives (step 14). validate and pack
// never touch the data directory.
//
// The show commands (show …, overlay take / fire) are different: they drive the running platform
// through its local API (src/shows/routes.js), so a show can be run while it is on air.
//
// Exit codes: 0 done, 1 refused or invalid, 64 usage, 69 the platform isn't running (for the
// commands that drive it), 75 the data directory is in use, 77 wrong user (root on a data
// directory another user owns), 78 config.
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openData, StartupError } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './log.js';
import { MediaError, mediaUrl } from './media/library.js';
import { recordOperation } from './oplog.js';
import { OverlayError } from './overlays/registry.js';
import { StoreVersionError } from './store/migrate.js';
import { MigrateError } from './templates/migrate.js';
import { packageFromDir, validatePackage } from './templates/package.js';
import { BUILTIN_DIR, createTemplateRegistry, TemplateError, validateTemplate } from './templates/registry.js';
import { fetchPackage, parseSource, SourceError } from './templates/sources.js';
import { writeZip, ZipError } from './templates/zip.js';

export const USAGE = `Usage: skp <command> [options]

  template validate <file.skp|dir>        check a template package (04 §4.11)
  template pack <dir> [-o <file.skp>]     make a package from a template directory
  template list                           bundled and installed templates
  template install <package>              install a package (the platform must be stopped): a
                                          .skp or .zip file, an https URL, or a GitHub
                                          repository's latest release (owner/name[@tag])
  template uninstall <id>[@<version>]     remove an installed version, or every version
  template follow <owner/name|url>        install its releases as they come out, and move
        [--auto-upgrade safe|off]         overlays to them when nothing breaks (default safe)
        [--template <id>]                 let it update a template installed from elsewhere
  template unfollow <owner/name|url>      stop following (installed versions stay)
  template sources                        followed sources and what they last installed
  template update [<owner/name|url>]      check followed sources now (the running platform
                                          checks every SKP_TEMPLATE_CHECK_MINUTES, default 60)
  overlay upgrade <slug> --to <version>   move an overlay to a newer template version
        [--dry-run] [--yes]               show what would change / confirm it
        [--run-migrate]                   let an installed package's migrate.js run
  overlay revert <slug>                   go back to the version and settings before the last upgrade
  media add <file> [--name <name>]        upload a clip, image, sound or font (phone video is
                                          converted for OBS when ffmpeg is available)
  media list                              uploaded files and their URLs
  media remove <id>                       delete one (refused while an overlay uses it)

These drive the running platform (start it first):
  show list                               shows, their members, scene and whether they're live
  show create --name <n> --overlays <a,b> --date <YYYY-MM-DD> --timezone <zone>
        [--go-live HH:MM] [--day-boundary HH:MM] [--lineup <file.json>]   (or --from <show.json>)
  show edit <show> [any of the above]     change a show (a lineup edit shows at once)
  show delete <show>
  show take <show> <scene> [--transition fade|cut]   take a scene on every member
  show fire <show> <action> [--args <json>]          trigger an action on every member
  show slot <show> <position|name|none>   who's on now
  show rec <show> start|reset             the REC timer (it starts by itself at the first take
                                          of the live scene, or at go-live under "auto")
  show build <show> [--recipe <file.json>|none]      cues from the lineup: who's on, title cards,
                                          the Event Intro, now playing (none stops generating)
  show cues <show>                        the timeline: each cue, when, and what happened to it
  show cue add <show> --at <HH:MM|ISO instant> [--label <text>] and one of
        --scene <id> [--transition ...] | --action <name> [--args <json>] | --slot <n>
        | --play <media id> | --stop | --cue <cue.json>
  show cue fire|skip|rearm|delete <show> <cue>       fire now, skip, arm again, or remove
  show plans <show>                       the show's planned dates
  show plan add <show> --date <YYYY-MM-DD> [--go-live HH:MM] [--day-boundary HH:MM]
        [--lineup <file.json>] [--settings <file.json>]   becomes the show at that day's start
  show plan delete <show> <plan>
  overlay take <slug> <scene> [--transition ...]     an overlay outside a show
  overlay fire <slug> <action> [--args <json>]

Options: --json (machine-readable output), and the server's own --data-dir, --config-dir,
--store and --port to find the data directory and the platform (the same environment variables
work too).`;

const CONFIG_FLAGS = ['data-dir', 'config-dir', 'store', 'log-level', 'port'];
const SHOW_FLAGS = ['from', 'overlays', 'date', 'timezone', 'go-live', 'day-boundary', 'lineup', 'transition', 'args', 'at', 'scene', 'action', 'slot', 'play', 'cue', 'label', 'recipe', 'settings'];
const NOTE = 'Templates are code: they run in OBS and in the admin UI\'s previews, and see the data their manifest declares.';

// fetch and lookup: test hooks for what template sources download with and resolve names with.
export async function run(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, fetch: fetchHook, lookup: lookupHook } = {}) {
  const out = (s) => stdout.write(`${s}\n`);
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' }, 'run-migrate': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, stop: { type: 'boolean' },
        to: { type: 'string' }, out: { type: 'string', short: 'o' }, name: { type: 'string' }, 'auto-upgrade': { type: 'string' }, template: { type: 'string' },
        ...Object.fromEntries([...CONFIG_FLAGS, ...SHOW_FLAGS].map((f) => [f, { type: 'string' }])),
      },
    });
  } catch (err) {
    stderr.write(`skp: ${err.message}\n\n${USAGE}\n`);
    if (argv.includes('--json')) out(JSON.stringify({ error: 'usage', message: err.message }, null, 2));
    return 64;
  }
  const { values: opts, positionals: [noun, verb, ...rest] } = args;
  const json = (value) => out(JSON.stringify(value, null, 2));
  const usage = (msg) => {
    stderr.write(`${msg ? `skp: ${msg}\n\n` : ''}${USAGE}\n`);
    if (msg && opts.json) json({ error: 'usage', message: msg });
    return msg ? 64 : 0;
  };
  if (opts.help || noun === 'help') return usage();

  const config = () => loadConfig({ argv: CONFIG_FLAGS.flatMap((f) => (opts[f] === undefined ? [] : [`--${f}`, opts[f]])), env });
  // Warnings and errors only, on stderr: stdout is the command's result.
  const logger = () => createLogger({ level: opts['log-level'] || 'warn', write: (line) => stderr.write(`${line}\n`) }).child('cli');
  // The data directory, locked, for a command that may write to it.
  const openFor = (purpose, cfg = config()) => {
    checkOwner(cfg.dataDir);
    const data = openData(cfg, { log: logger(), purpose, fetch: fetchHook, lookup: lookupHook });
    return Object.assign(data, { record: (details) => recordOperation(cfg.dataDir, purpose, details) });
  };
  // The running platform's local API: the parsed answer, or a PlatformError.
  const platform = (method, apiPath, body) => callPlatform(config(), method, apiPath, body, fetchHook || globalThis.fetch);

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
          if (!(err instanceof StartupError) || err.code !== 'locked') throw err;
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
        if (rest.length !== 1) return usage('template install takes one package: a file, an https URL or owner/name');
        const cfg = config();
        const data = openFor('template install', cfg);
        let fetched;
        try {
          // A file that exists is a file; anything else may name a source (an https URL,
          // owner/name). A missing .skp/.zip, or anything with a backslash or a leading dot or ~,
          // is a file that isn't there, never a repository.
          let source;
          if (!existsSync(rest[0])) {
            const missing = () => Object.assign(new Error(`no such file: ${rest[0]}`), { code: 'ENOENT', path: rest[0] });
            if (!rest[0].includes('://') && (/\.(skp|zip)$/i.test(rest[0]) || /^[.~]|\\/.test(rest[0]))) throw missing();
            try {
              source = parseSource(rest[0]);
            } catch (err) {
              if (err.code !== 'bad-source') throw err;
              throw missing();
            }
          }
          if (source) fetched = await fetchPackage(source, { dir: data.templates.downloadDir, token: cfg.githubToken, fetch: fetchHook, lookup: lookupHook, allowPrivate: cfg.allowPrivateDownloads });
          const { template, warnings, noop } = fetched
            ? data.templates.install(fetched.file, { actor: 'cli', name: fetched.label, origin: fetched.origin })
            : data.templates.install(rest[0], { actor: 'cli' });
          if (!noop) data.record({ ...(fetched ? { from: fetched.label } : { file: path.resolve(rest[0]) }), template: `${template.id}@${template.version}`, build: template.build });
          if (opts.json) json({ id: template.id, version: template.version, build: template.build, noop, warnings });
          else {
            printFindings(out, { errors: [], warnings });
            out(noop ? `${template.id}@${template.version} is already installed (build ${template.build}).` : `installed ${template.id}@${template.version} (build ${template.build})`);
            out(NOTE);
          }
          return 0;
        } finally {
          if (fetched) rmSync(fetched.file, { force: true });
          data.close();
        }
      }

      case 'template follow': {
        if (rest.length !== 1) return usage('template follow takes one source: owner/name or an https URL');
        const data = openFor('template follow');
        try {
          const doc = data.sources.add(rest[0], { autoUpgrade: opts['auto-upgrade'] ?? 'safe', actor: 'cli', claim: opts.template });
          data.record({ source: doc.data.label, autoUpgrade: doc.data.autoUpgrade });
          // The first check now, so a mistyped repository shows up while you're here.
          const results = await data.sources.check(doc.id);
          if (opts.json) json({ source: doc.data.label, id: doc.id, autoUpgrade: doc.data.autoUpgrade, check: results[0] });
          else {
            out(`following ${doc.data.label} (${doc.data.autoUpgrade === 'safe' ? 'overlays move to new versions when nothing breaks' : 'new versions are installed; overlays stay until you upgrade them'})`);
            printChecks(out, results);
            if (results[0]?.error) out('It stays followed; the running platform tries again at every check.');
            out(NOTE);
          }
          return 0;
        } finally {
          data.close();
        }
      }

      case 'template unfollow': {
        if (rest.length !== 1) return usage('template unfollow takes one source');
        const data = openFor('template unfollow');
        try {
          const doc = data.sources.remove(rest[0]);
          data.record({ source: doc.data.label });
          if (opts.json) json({ removed: doc.data.label });
          else out(`stopped following ${doc.data.label}${doc.data.templateId ? `; the versions of ${doc.data.templateId} it installed stay` : ''}`);
          return 0;
        } finally {
          data.close();
        }
      }

      case 'template sources': {
        if (rest.length) return usage('template sources takes no arguments');
        const data = openFor('template sources');
        try {
          const rows = data.sources.list().map((d) => ({
            id: d.id, source: d.data.label, autoUpgrade: d.data.autoUpgrade, template: d.data.templateId, version: d.data.version,
            release: d.data.release, checkedAt: d.data.checkedAt, error: d.data.error,
          }));
          if (opts.json) json(rows);
          else {
            for (const r of rows) {
              out(`${r.source}  ${r.template ? `${r.template}@${r.version}${r.release ? ` (release ${r.release})` : ''}` : 'nothing installed yet'}  auto-upgrade ${r.autoUpgrade}${r.checkedAt ? `  checked ${r.checkedAt}` : ''}`);
              if (r.error) out(`  last check failed: ${r.error.message}`);
            }
            if (!rows.length) out('No template sources: skp template follow <owner/name>.');
          }
          return 0;
        } finally {
          data.close();
        }
      }

      case 'template update': {
        if (rest.length > 1) return usage('template update takes at most one source');
        const data = openFor('template update');
        try {
          const results = await data.sources.check(rest[0]);
          if (opts.json) json(results);
          else {
            printChecks(out, results);
            if (!results.length) out('No template sources: skp template follow <owner/name>.');
          }
          return results.some((r) => r.error) ? 1 : 0;
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

      case 'media add': {
        if (rest.length !== 1) return usage('media add takes one file');
        const data = openFor('media add');
        try {
          const doc = await data.media.add(rest[0], { name: opts.name, actor: 'cli' });
          data.record({ media: doc.id, name: doc.data.name, url: mediaUrl(doc), converted: doc.data.converted });
          if (opts.json) json(mediaJson(doc));
          else {
            out(`added ${doc.id}: ${doc.data.name} (${doc.data.type}, ${formatBytes(doc.data.size)}${doc.data.converted ? `, converted from ${doc.data.original.type}` : ''})`);
            out(`  ${mediaUrl(doc)}`);
            if (doc.data.note) out(`  note: ${doc.data.note}`);
          }
          return 0;
        } finally {
          data.close();
        }
      }

      case 'media list': {
        if (rest.length) return usage('media list takes no arguments');
        const data = openFor('media list');
        try {
          const docs = data.media.list();
          if (opts.json) json(docs.map(mediaJson));
          else {
            for (const d of docs) out(`${d.id}  ${d.data.status.padEnd(10)} ${formatBytes(d.data.size).padStart(9)}  ${mediaUrl(d)}${d.data.note ? '  (kept as uploaded)' : ''}`);
            if (!docs.length) out('No media yet: skp media add <file>.');
          }
          return 0;
        } finally {
          data.close();
        }
      }

      case 'media remove': {
        if (rest.length !== 1) return usage('media remove takes <id>');
        const data = openFor('media remove');
        try {
          const doc = data.media.remove(rest[0], { usedBy: (d) => data.overlays.mediaUsers(d.data.fileId) });
          data.record({ media: doc.id, name: doc.data.name });
          if (opts.json) json({ removed: doc.id });
          else out(`removed ${doc.id} (${doc.data.name})`);
          return 0;
        } finally {
          data.close();
        }
      }

      case 'show list': {
        if (rest.length) return usage('show list takes no arguments');
        const list = await platform('GET', '/shows');
        if (opts.json) json(list);
        else {
          for (const s of list) {
            out(`${s.name}  (${s.id})  ${s.live ? 'LIVE  ' : ''}scene ${s.scene || '-'}  ${s.date}${s.goLive ? ` go-live ${s.goLive}` : ''} ${s.timezone}  overlays: ${s.members.join(', ') || 'none'}`);
          }
          if (!list.length) out('No shows yet: skp show create --name … (skp help).');
        }
        return 0;
      }

      case 'show create': {
        if (rest.length) return usage('show create takes options only: --name, --overlays, --date, --timezone … (skp help)');
        const s = await platform('POST', '/shows', showInput(opts));
        if (opts.json) json(s);
        else out(`created ${s.name} (${s.id}) with ${s.members.join(', ') || 'no overlays yet'}`);
        return 0;
      }

      case 'show edit': {
        if (rest.length !== 1) return usage('show edit takes <show> and the options to change');
        const s = await platform('PATCH', `/shows/${encodeURIComponent(rest[0])}`, showInput(opts));
        if (opts.json) json(s);
        else out(`updated ${s.name}${s.lineup.some((x) => x.clockGap || x.clockOverlap) ? ' (a lineup time falls in a clock change: skp show list --json shows the instant it resolved to)' : ''}`);
        return 0;
      }

      case 'show delete': {
        if (rest.length !== 1) return usage('show delete takes <show>');
        const s = await platform('DELETE', `/shows/${encodeURIComponent(rest[0])}`);
        if (opts.json) json(s);
        else out(`deleted ${s.name}; its overlays keep their URLs and go back to their own scenes`);
        return 0;
      }

      case 'show take':
      case 'overlay take': {
        if (rest.length !== 2) return usage(`${command} takes <${noun === 'show' ? 'show' : 'slug'}> <scene>`);
        const s = await platform('PUT', `/${noun === 'show' ? 'shows' : 'overlays'}/${encodeURIComponent(rest[0])}/scene`, { scene: rest[1], ...(opts.transition ? { transition: opts.transition } : {}) });
        if (opts.json) json(s);
        else out(`${s.name || s.overlay}: ${s.scene}`);
        return 0;
      }

      case 'show fire':
      case 'overlay fire': {
        if (rest.length !== 2) return usage(`${command} takes <${noun === 'show' ? 'show' : 'slug'}> <action>`);
        let actionArgs = {};
        if (opts.args !== undefined) {
          try { actionArgs = JSON.parse(opts.args); } catch { return usage('--args must be JSON, e.g. --args \'{"name":"VIKKSTAR"}\''); }
        }
        const s = await platform('POST', `/${noun === 'show' ? 'shows' : 'overlays'}/${encodeURIComponent(rest[0])}/${noun === 'show' ? 'triggers' : 'actions'}/${encodeURIComponent(rest[1])}`, { args: actionArgs });
        if (opts.json) json(s);
        else out(`${s.action} on ${s.overlays.join(', ')}`);
        return 0;
      }

      case 'show slot': {
        if (rest.length !== 2) return usage('show slot takes <show> <position|name|none>');
        const slot = rest[1] === 'none' ? null : /^\d+$/.test(rest[1]) ? Number(rest[1]) : rest[1];
        const s = await platform('PUT', `/shows/${encodeURIComponent(rest[0])}/slot`, { slot });
        if (opts.json) json(s);
        else out(s.currentSlot === undefined ? `${s.name}: nobody picked (who's on follows the clock)` : `${s.name}: ${s.lineup[s.currentSlot].name} is on`);
        return 0;
      }

      case 'show rec': {
        if (rest.length !== 2 || !['start', 'reset'].includes(rest[1])) return usage('show rec takes <show> start|reset');
        const s = await platform('POST', `/shows/${encodeURIComponent(rest[0])}/rec`, { action: rest[1] });
        if (opts.json) json(s);
        else out(s.live ? `${s.name}: REC from ${new Date(s.recStartedAt).toLocaleTimeString()}` : `${s.name}: REC reset`);
        return 0;
      }

      case 'show build': {
        if (rest.length !== 1) return usage('show build takes <show>');
        const body = {};
        if (opts.recipe !== undefined) body.recipe = opts.recipe === 'none' ? null : readJsonFile(opts.recipe, 'the recipe file');
        const cues = await platform('POST', `/shows/${encodeURIComponent(rest[0])}/cues/build`, body);
        if (opts.json) json(cues);
        else {
          const made = cues.filter((c) => c.generated);
          out(body.recipe === null ? `${rest[0]}: no more generated cues (${made.length} that already happened stay)` : `${rest[0]}: ${made.length} generated cue${made.length === 1 ? '' : 's'} (skp show cues ${quoteArg(rest[0])})`);
        }
        return 0;
      }

      case 'show cues': {
        if (rest.length !== 1) return usage('show cues takes <show>');
        const show = await platform('GET', `/shows/${encodeURIComponent(rest[0])}`);
        const cues = await platform('GET', `/shows/${show.id}/cues`);
        if (opts.json) json(cues);
        else {
          for (const c of cues) out(cueLine(c, show.timezone));
          if (!cues.length) out(`No cues yet: skp show build ${quoteArg(show.name)} makes them from the lineup, or skp show cue add.`);
        }
        return 0;
      }

      case 'show cue': {
        const [op, ref, cueId, ...extra] = rest;
        if (op === 'add') {
          if (!ref || cueId !== undefined) return usage('show cue add takes <show> and --at with what the cue does');
          const cue = cueInput(opts);
          const c = await platform('POST', `/shows/${encodeURIComponent(ref)}/cues`, cue);
          const show = await platform('GET', `/shows/${encodeURIComponent(ref)}`);
          if (opts.json) json(c);
          else out(`added ${cueLine(c, show.timezone)}`);
          return 0;
        }
        if (!['fire', 'skip', 'rearm', 'delete'].includes(op) || !ref || !cueId || extra.length) return usage('show cue takes add, or fire|skip|rearm|delete <show> <cue>');
        const base = `/shows/${encodeURIComponent(ref)}/cues/${encodeURIComponent(cueId)}`;
        const c = op === 'delete' ? await platform('DELETE', base) : await platform('POST', `${base}/${op}`);
        if (opts.json) json(c);
        else if (op === 'delete') out(`deleted ${c.id}`);
        else out(`${c.id}: ${c.status}${c.error ? ` (${c.error})` : ''}`);
        return 0;
      }

      case 'show plans': {
        if (rest.length !== 1) return usage('show plans takes <show>');
        const plans = await platform('GET', `/shows/${encodeURIComponent(rest[0])}/plans`);
        if (opts.json) json(plans);
        else {
          for (const p of plans) {
            const what = [
              p.lineup && `${p.lineup.length} slot${p.lineup.length === 1 ? '' : 's'}`,
              p.goLive === null ? 'no go-live' : p.goLive && `go-live ${p.goLive}`,
              p.dayBoundary && `day boundary ${p.dayBoundary}`,
              p.overlaySettings && `settings for ${Object.keys(p.overlaySettings).join(', ')}`,
            ].filter(Boolean).join(', ');
            out(`${p.date}  ${p.activatedAt ? (p.error ? `not activated: ${p.error}` : 'activated') : `activates ${p.activateAt}`}  ${what || 'same show, new date'}  (${p.id})`);
            for (const w of p.warnings || []) out(`    ${w}`);
          }
          if (!plans.length) out('No planned dates: skp show plan add <show> --date <YYYY-MM-DD> …');
        }
        return 0;
      }

      case 'show plan': {
        const [op, ref, planId, ...extra] = rest;
        if (op === 'add') {
          if (!ref || planId !== undefined) return usage('show plan add takes <show> --date <YYYY-MM-DD> and what changes');
          const plan = {};
          if (opts.date !== undefined) plan.date = opts.date;
          if (opts['go-live'] !== undefined) plan.goLive = opts['go-live'] === 'none' ? null : opts['go-live'];
          if (opts['day-boundary'] !== undefined) plan.dayBoundary = opts['day-boundary'];
          if (opts.lineup !== undefined) plan.lineup = readJsonFile(opts.lineup, 'the lineup file');
          if (opts.settings !== undefined) plan.overlaySettings = readJsonFile(opts.settings, 'the settings file');
          const p = await platform('POST', `/shows/${encodeURIComponent(ref)}/plans`, plan);
          if (opts.json) json(p);
          else out(`planned ${ref} for ${p.date}: it becomes the show at ${p.activateAt} (${p.id})`);
          return 0;
        }
        if (op !== 'delete' || !ref || !planId || extra.length) return usage('show plan takes add <show> …, or delete <show> <plan>');
        const p = await platform('DELETE', `/shows/${encodeURIComponent(ref)}/plans/${encodeURIComponent(planId)}`);
        if (opts.json) json(p);
        else out(`deleted ${p.id}`);
        return 0;
      }

      default:
        return usage(noun ? `unknown command "${command}"` : '');
    }
  } catch (err) {
    // A refusal before the command could start: one line on stderr, and with --json the same as
    // JSON on stdout, like every other error.
    const refuse = (code, message, exit) => {
      stderr.write(`skp: ${message}\n`);
      if (opts.json) json({ error: code, message });
      return exit;
    };
    if (err instanceof ConfigError) return refuse('config', `configuration error: ${err.message}`, 78);
    if (err instanceof WrongUserError) return refuse('wrong-user', err.message, 77);
    if (err instanceof StartupError && err.code === 'locked') return refuse('locked', err.message, 75);
    if (err instanceof PlatformError) return refuse(err.code, err.message, err.exit);
    if (err instanceof TemplateError && err.findings.length) {
      if (opts.json) json({ error: err.code, message: err.message, ...findingsJson({ errors: err.findings.filter((f) => f.level === 'error'), warnings: err.findings.filter((f) => f.level === 'warning') }) });
      else {
        printFindings(out, { errors: err.findings.filter((f) => f.level === 'error'), warnings: err.findings.filter((f) => f.level === 'warning') });
        stderr.write(`skp: ${err.message}\n`);
      }
      return 1;
    }
    if (err instanceof TemplateError || err instanceof OverlayError || err instanceof ZipError || err instanceof MigrateError || err instanceof MediaError || err instanceof SourceError || err instanceof StartupError || err instanceof StoreVersionError || err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.name === 'ConflictError') {
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

// A command that drives the running platform was refused, or the platform isn't there (exit 69).
class PlatformError extends Error {
  constructor(message, code, exit = 1) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
    this.exit = exit;
  }
}

// One request to the running platform's local API (http://<host>:<port>/api/v1…, the same
// configuration the platform reads): its JSON answer, or a PlatformError with the platform's
// reason.
async function callPlatform(cfg, method, apiPath, body, fetchFn) {
  const base = `http://${cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host}:${cfg.port}`;
  let res;
  try {
    res = await fetchFn(`${base}/api/v1${apiPath}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new PlatformError(`The platform isn't running at ${base} (${err.cause?.code || err.name}). Start it first (npm start): show commands drive it.`, 'not-running', 69);
  }
  const value = await res.json().catch(() => null);
  if (!res.ok) throw new PlatformError(value?.detail || `The platform answered ${res.status}.`, (value?.type || '').split('/').pop() || `http-${res.status}`);
  return value;
}

function readJsonFile(file, what) {
  let text;
  try { text = readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch (err) { throw new PlatformError(`can't read ${what} ${file} (${err.code || err.message})`, 'bad-file'); }
  try { return JSON.parse(text); } catch (err) { throw new PlatformError(`${file} isn't JSON: ${err.message}`, 'bad-file'); }
}

// A cue from the command line's options: --at, a label, and exactly one thing it does.
function cueInput(opts) {
  const kinds = ['scene', 'action', 'slot', 'play', 'stop', 'cue'].filter((k) => opts[k] !== undefined);
  if (kinds.length !== 1) throw new PlatformError('A cue does one thing: give one of --scene, --action, --slot, --play, --stop or --cue.', 'usage', 64);
  const usage = (msg) => { throw new PlatformError(msg, 'usage', 64); };
  let action;
  switch (kinds[0]) {
    case 'scene': action = { type: 'show.scene', scene: opts.scene, ...(opts.transition ? { transition: opts.transition } : {}) }; break;
    case 'action': {
      let args;
      if (opts.args !== undefined) {
        try { args = JSON.parse(opts.args); } catch { usage('--args must be JSON, e.g. --args \'{"name":"VIKKSTAR"}\''); }
      }
      action = { type: 'overlay.action', name: opts.action, ...(args ? { args } : {}) };
      break;
    }
    case 'slot':
      // An act's name (it follows the act through lineup edits), or a position.
      action = { type: 'show.slot', slot: /^\d+$/.test(opts.slot) ? Number(opts.slot) : opts.slot };
      break;
    case 'play': action = { type: 'media.play', mediaId: opts.play }; break;
    case 'stop': action = { type: 'media.stop' }; break;
    default: {
      // A whole cue (or just its action) from a file: a sequence, say.
      const c = readJsonFile(opts.cue, 'the cue file');
      if (!c || typeof c !== 'object' || Array.isArray(c)) usage(`${opts.cue} must hold a JSON object (a cue or an action).`);
      const cue = c.action ? { ...c } : { action: c };
      if (opts.at !== undefined) cue.at = opts.at;
      if (opts.label !== undefined) cue.label = opts.label;
      return cue;
    }
  }
  return { at: opts.at, action, ...(opts.label !== undefined ? { label: opts.label } : {}) };
}

// One cue as a line: when on the show's clock, its status, and what it does.
function cueLine(c, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(c.at)).map((p) => [p.type, p.value]));
  const when = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${parts.second === '00' ? '' : `:${parts.second}`}`;
  const a = c.action;
  const what = c.label || (a.type === 'show.scene' ? `take ${a.scene}` : a.type === 'overlay.action' ? a.name : a.type === 'show.slot' ? `slot ${a.slot}` : a.type);
  return `${when}  ${c.status.padEnd(7)}  ${what}${c.edited ? ' (edited)' : ''}${c.error ? `  — ${c.error}` : ''}  (${c.id})`;
}

function quoteArg(s) {
  return /^[\w.-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
}

// A show from the command line's options: --from a JSON file, then the flags over it.
function showInput(opts) {
  const readJson = readJsonFile;
  const input = opts.from !== undefined ? readJson(opts.from, 'the show file') : {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PlatformError(`${opts.from} must hold a JSON object (a show).`, 'bad-file');
  if (opts.name !== undefined) input.name = opts.name;
  if (opts.overlays !== undefined) input.overlays = opts.overlays.split(',').map((s) => s.trim()).filter(Boolean);
  if (opts.date !== undefined) input.date = opts.date;
  if (opts.timezone !== undefined) input.timezone = opts.timezone;
  if (opts['go-live'] !== undefined) input.goLive = opts['go-live'] === 'none' ? null : opts['go-live'];
  if (opts['day-boundary'] !== undefined) input.dayBoundary = opts['day-boundary'];
  if (opts.lineup !== undefined) input.lineup = readJson(opts.lineup, 'the lineup file');
  return input;
}

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

// What a check of template sources did, one source at a time.
function printChecks(out, results) {
  for (const r of results) {
    if (r.error) out(`${r.source}: the check failed: ${r.error.message}`);
    else if (r.unchanged) out(`${r.source}: no new release${r.tag ? ` (still ${r.tag})` : ''}`);
    else if (r.installed) {
      const what = `${r.installed.id}@${r.installed.version}`;
      out(`${r.source}${r.tag ? ` release ${r.tag}` : ''}: ${r.installed.noop ? `${what} was already installed` : `installed ${what} (build ${r.installed.build})`}`);
      for (const w of r.installed.warnings || []) out(`  warning: ${w.message}`);
    }
    for (const u of r.upgraded || []) out(`  "${u.overlay}" moved from ${u.from} to ${u.to} (skp overlay revert ${u.overlay} goes back)`);
    for (const w of r.waiting || []) out(`  "${w.overlay}" stays on ${w.from}: ${w.why}. To move it: skp overlay upgrade ${w.overlay} --to ${w.to}`);
  }
}

function mediaJson(doc) {
  return { id: doc.id, url: mediaUrl(doc), ...doc.data };
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
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
