// Overlays: a template plus settings and bindings, with a permanent slug (01 §1.3–1.4). Kept in
// the store; each one gets a bus channel shaped by what its template consumes. The overlay's
// resolved settings (defaults applied, 04 §4.4) are published to it as channel-only state
// (`overlay.settings`); the store keeps only the values the operator set, so a new template
// version's defaults reach every field nobody touched.
//
// The overlays API (create/update from the admin UI) arrives with step 13; until then overlays
// are created in code (the diagnostic script, tests) and upgraded with the CLI.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { newId } from '../ids.js';
import { runMigrate } from '../templates/migrate.js';
import { compareVersions } from '../templates/registry.js';
import { boundKeys, diffSettings, jsonBytes, migrateSettings, RESOLVED_BYTES, resolveSettings, SAVED_BYTES, validateSettings } from '../templates/settings.js';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class OverlayError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'OverlayError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export function createOverlays({ store, bus, templates, log }) {
  const bySlug = new Map(); // slug → id
  const resolved = new Map(); // id → the settings the overlay sees
  const pins = new Map(); // id → { id, version } of its template, for lookups that skip the store
  const broken = new Set(); // ids whose template is installed but can't be used as it is
  const bindings = new Map(); // state key → ids of overlays with a setting bound to it

  // One overlay's channel and settings. A template that can't be used (missing, or a manifest
  // later rules refuse) takes only its own overlays off air (503), never the platform's startup.
  function open(doc) {
    bySlug.set(doc.data.slug, doc.id);
    pins.set(doc.id, doc.data.template);
    broken.delete(doc.id);
    for (const ids of bindings.values()) ids.delete(doc.id);
    const template = templates.get(doc.data.template.id, doc.data.template.version);
    if (!template) log.error('an overlay\'s template is not installed; it will not render', { overlay: doc.id, template: doc.data.template });
    let ch;
    try {
      ch = bus.channel(doc.id, { consumes: template?.manifest.consumes || {}, connections: doc.data.connections || [] });
      const settings = template ? settingsFor(template, doc, ch) : {};
      ch.setLocalState('overlay.settings', settings);
      resolved.set(doc.id, settings);
      for (const key of template ? boundKeys(template.manifest) : []) {
        if (!bindings.has(key)) bindings.set(key, new Set());
        bindings.get(key).add(doc.id);
      }
    } catch (err) {
      log.error('an overlay\'s template can\'t be used as installed; the overlay will not render', { overlay: doc.id, template: doc.data.template, err: err.message });
      broken.add(doc.id);
      ch = bus.channel(doc.id, { consumes: {}, connections: [] });
      resolved.set(doc.id, {});
      try { ch.setLocalState('overlay.settings', {}); } catch { /* {} always fits */ }
    }
    return ch;
  }

  // A bound setting reads state as this overlay sees it: declared, from its own connections. With
  // bound values the settings could outgrow an envelope (02 §2.9); then they're left out.
  function settingsFor(template, doc, ch) {
    const saved = doc.data.settings || {};
    const settings = resolveSettings(template.manifest, saved, (key) => ch.visibleState(key));
    if (jsonBytes(settings) <= RESOLVED_BYTES) return settings;
    log.warn('an overlay\'s settings with their bound state values are too large to send; using them without the bound values', { overlay: doc.id });
    const plain = resolveSettings(template.manifest, saved);
    if (jsonBytes(plain) > RESOLVED_BYTES) throw new OverlayError(`its settings are larger than ${RESOLVED_BYTES / 1024} KiB`, 'bad-settings');
    return plain;
  }

  // A setting bound to a state key (x-skp-bind) follows the key: when it changes, the overlays
  // bound to it get their settings resolved again.
  bus.subscribeAll((env) => {
    if (env.type !== 'state.changed' || !bindings.has(env.data.key)) return;
    for (const id of [...bindings.get(env.data.key)]) {
      const doc = store.get('overlays', id);
      if (doc) open(doc);
    }
  });

  // An overlay waiting for a template that wasn't installed (503) starts rendering once it is.
  templates.onInstalled?.((t) => reopen(t.id, t.version));

  // Every stored overlay, page by page.
  function* all() {
    for (let after = ''; ;) {
      const page = store.list('overlays', { after, limit: 1000 });
      yield* page;
      if (page.length < 1000) break;
      after = page[page.length - 1].id;
    }
  }

  function reopen(id, version) {
    for (const doc of all()) if (doc.data.template.id === id && doc.data.template.version === version) open(doc);
  }

  // At startup, a bundled version an overlay pins is kept in the data directory (retain), so a
  // platform update that drops or changes it can't change the overlay.
  for (const doc of all()) {
    const pin = doc.data.template;
    try {
      if (templates.get(pin.id, pin.version)?.source === 'bundled') templates.retain(pin.id, pin.version);
    } catch (err) {
      log.warn('could not keep a copy of a bundled template an overlay uses', { overlay: doc.id, template: pin, err: err.message });
    }
    open(doc);
  }

  // What every saved settings object must be: an object, at most SAVED_BYTES as UTF-8 JSON, and
  // valid for the template.
  function settingsProblem(template, settings) {
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return { message: 'Settings must be an object.' };
    if (jsonBytes(settings) > SAVED_BYTES) return { message: `Settings are limited to ${SAVED_BYTES / 1024} KiB.` };
    const problems = validateSettings(template.manifest, settings);
    if (problems.length) return { message: `These settings don't fit ${template.id}@${template.version}: ${problems.map((p) => `${p.path} ${p.message}`).join('; ')}.`, problems };
    return undefined;
  }

  function checkSettings(template, settings) {
    const problem = settingsProblem(template, settings);
    if (problem) throw new OverlayError(problem.message, 'bad-settings', problem.problems);
  }

  function byIdOrSlug(ref) {
    const id = bySlug.get(ref) || (typeof ref === 'string' && /^ovl_[0-9A-Z]{26}$/.test(ref) ? ref : undefined);
    const doc = id && store.get('overlays', id);
    if (!doc) throw new OverlayError(`There is no overlay "${ref}".`, 'not-found');
    return doc;
  }

  // Puts an overlay on another pinned template version and settings, keeping where it was as
  // `previous` (one step of undo), then re-syncs its open pages (they reload with the new build).
  function repin(doc, template, settings, ifRev) {
    templates.retain(template.id, template.version);
    const previous = { template: doc.data.template, settings: doc.data.settings || {}, at: new Date().toISOString() };
    const saved = store.put('overlays', doc.id, { ...doc.data, template: { id: template.id, version: template.version }, settings, previous }, { ifRev: ifRev ?? doc.rev });
    open(saved).reset();
    return saved;
  }

  return {
    create({ slug, template, settings = {}, connections = [] }) {
      if (typeof slug !== 'string' || !SLUG.test(slug)) {
        throw new OverlayError(`"${slug}" isn't a valid slug: use lowercase letters, digits and dashes, starting with a letter or digit`, 'bad-slug');
      }
      if (bySlug.has(slug)) throw new OverlayError(`the slug "${slug}" is taken`, 'slug-taken');
      const t = templates.get(template?.id, template?.version);
      if (!t) throw new OverlayError(`template ${template?.id}@${template?.version} isn't installed`, 'no-template');
      checkSettings(t, settings);
      templates.retain(t.id, t.version); // a bundled version stays even if a platform update drops it
      const id = newId('ovl');
      const doc = store.put('overlays', id, { slug, template: { id: t.id, version: t.version }, settings, connections }, { ifRev: 0 });
      open(doc);
      return doc;
    },

    // Replaces the overlay's settings (only the values the operator set). ifRev: the revision the
    // caller last saw; a newer one is a ConflictError (03 §3.1, H16).
    updateSettings(ref, settings, { ifRev } = {}) {
      const doc = byIdOrSlug(ref);
      const t = templates.get(doc.data.template.id, doc.data.template.version);
      if (!t) throw new OverlayError(`The overlay's template ${doc.data.template.id}@${doc.data.template.version} isn't installed.`, 'no-template');
      checkSettings(t, settings);
      const next = store.put('overlays', doc.id, { ...doc.data, settings }, { ifRev: ifRev ?? doc.rev });
      open(next);
      return next;
    },

    remove(id) {
      const doc = store.get('overlays', id);
      if (!doc) return false;
      store.delete('overlays', id);
      bySlug.delete(doc.data.slug);
      resolved.delete(id);
      pins.delete(id);
      broken.delete(id);
      for (const ids of bindings.values()) ids.delete(id);
      bus.removeChannel(id);
      return true;
    },

    // The build an overlay's page should be running now, from memory: stream heartbeats ask
    // often, and may ask while the platform shuts down.
    currentBuild(slug) {
      const pin = pins.get(bySlug.get(slug));
      return pin && templates.get(pin.id, pin.version)?.build;
    },

    // { doc, template, channel, settings } for a slug, or undefined. template is undefined when
    // it isn't installed or can't be used.
    resolve(slug) {
      const id = bySlug.get(slug);
      if (!id) return undefined;
      const doc = store.get('overlays', id);
      if (!doc) return undefined;
      const template = broken.has(id) ? undefined : templates.get(doc.data.template.id, doc.data.template.version);
      return { doc, template, channel: bus.channel(id), settings: resolved.get(id) || {} };
    },

    list() { return [...all()]; },

    // Slugs of the overlays whose settings point to a media file, now or in the version an upgrade
    // kept for revert (a removed file would leave either broken), by its fileId: 128 random bits
    // match nothing else, and an absolute URL to the same file counts too.
    mediaUsers(fileId) {
      if (!/^[0-9a-f]{32}$/.test(fileId)) return [];
      const needle = `/media/${fileId}/`;
      const slugs = [];
      for (const doc of all()) {
        const used = [doc.data.settings, doc.data.previous?.settings].some((s) => s && JSON.stringify(s).includes(needle));
        if (used) slugs.push(doc.data.slug);
      }
      return slugs;
    },

    // Slugs of the overlays that use id@version (uninstall is refused while there are any).
    pinnedBy(id, version) {
      const slugs = [];
      for (const doc of all()) if (doc.data.template.id === id && doc.data.template.version === version) slugs.push(doc.data.slug);
      return slugs;
    },

    // Opens again the overlays on id@version, after it was installed: one that was waiting for a
    // missing template (503) starts rendering.
    reopen,

    // Moves an overlay to a newer installed version of its template (04 §4.10): the template's
    // migrate.js (if any) first, then unchanged settings copy over, removed ones drop, and new ones
    // take their defaults. Returns the plan; with dryRun nothing changes. The operator must see the
    // plan and confirm ({ confirm: true }) a major version, or one that drops anything they set or
    // anything a show or button may name (a scene, action or canvas). The slug, key and URL never
    // change; open pages re-sync and reload with the new build. revert() undoes it.
    //
    // migrate.js is code from the package, run on the server. It runs on its own only for
    // templates that ship with the platform; for an installed package the operator allows it for
    // that upgrade ({ runMigrate: true }). Skipped, renamed settings show up as removed.
    //
    // plan: { overlay, from, to, major, migrated, settings, changes, removed, confirm }; changes
    // lists what migrate.js did ('migrated': { path, from, to }) and then what the copy did
    // (migrateSettings in settings.js).
    async upgrade(ref, version, { ifRev, dryRun = false, confirm = false, runMigrate: allowMigrate } = {}) {
      const doc = byIdOrSlug(ref);
      const pin = doc.data.template;
      const from = templates.get(pin.id, pin.version); // may be gone: upgrading is the way out
      const to = templates.get(pin.id, version);
      if (!to) throw new OverlayError(`${pin.id}@${version} isn't installed.`, 'no-template');
      if (compareVersions(version, pin.version) <= 0) throw new OverlayError(`${pin.id}@${version} is not newer than ${pin.version}.`, 'not-newer');

      const stored = doc.data.settings || {};
      let settings = stored;
      let migrated = false;
      let migrateChanges = [];
      if (to.files.has('migrate.js')) {
        if (allowMigrate ?? templates.fromPlatform?.(to) ?? false) {
          settings = await runMigrate(readFileSync(path.join(to.dir, 'migrate.js'), 'utf8'), pin.version, stored);
          migrated = true;
          migrateChanges = diffSettings(stored, settings).map((d) => ({ change: 'migrated', ...d }));
        } else {
          migrated = 'skipped';
        }
      }
      const { settings: next, changes } = migrateSettings(from?.manifest, to.manifest, settings);
      const removed = (list) => (from?.manifest[list] || []).filter((x) => !(to.manifest[list] || []).some((y) => y.id === x.id)).map((x) => x.id);
      const plan = {
        overlay: doc.data.slug,
        from: pin.version,
        to: version,
        major: isMajor(pin.version, version),
        migrated,
        settings: next,
        changes: [...migrateChanges, ...changes],
        removed: { scenes: removed('scenes'), actions: removed('actions'), canvases: removed('canvases') },
      };
      const loses = changes.some((c) => c.change === 'removed' || c.change === 'invalid') || Object.values(plan.removed).some((ids) => ids.length);
      plan.confirm = plan.major || loses;
      // Checked before a dry run returns: the plan never shows settings the real run would refuse.
      const problem = settingsProblem(to, next);
      if (problem) {
        const what = migrated === true ? 'migrate.js produced settings that' : 'The carried-over settings';
        throw new OverlayError(`${what} can't be saved for ${pin.id}@${version}: ${problem.message}`, 'bad-settings', { ...plan, problems: problem.problems });
      }
      if (dryRun) return plan;
      if (plan.confirm && !confirm) {
        const why = plan.major ? `${pin.version} → ${version} is a major upgrade` : `${pin.version} → ${version} drops something this overlay uses`;
        throw new OverlayError(`${why}; review what changes, then confirm it.`, plan.major ? 'confirm-major' : 'confirm-changes', plan);
      }

      // The doc as read before the (async) migration: a change since then is a conflict, not
      // something to overwrite.
      const saved = repin(doc, to, next, ifRev);
      log.info('overlay upgraded', { overlay: doc.data.slug, template: pin.id, from: pin.version, to: version, changes: plan.changes.length });
      return { ...plan, doc: saved };
    },

    // Puts an overlay back on the version and settings it had before its last upgrade (or revert),
    // exactly as they were. That version must still be installed.
    revert(ref, { ifRev } = {}) {
      const doc = byIdOrSlug(ref);
      const previous = doc.data.previous;
      if (!previous) throw new OverlayError(`"${doc.data.slug}" has not been upgraded, so there is nothing to go back to.`, 'no-previous');
      const t = templates.get(previous.template.id, previous.template.version);
      if (!t) throw new OverlayError(`${previous.template.id}@${previous.template.version} is no longer installed; install it again to go back to it.`, 'no-template');
      const saved = repin(doc, t, previous.settings, ifRev);
      log.info('overlay reverted', { overlay: doc.data.slug, template: t.id, from: doc.data.template.version, to: t.version });
      return { overlay: doc.data.slug, from: doc.data.template.version, to: t.version, doc: saved };
    },
  };
}

// A change the operator must look at first (04 §4.10): another major version; under 1.0.0, another
// minor one (SemVer makes no promises there); and any move involving a prerelease.
export function isMajor(from, to) {
  const parse = (v) => {
    const [core, pre] = String(v).split(/-(.*)/s);
    const [major, minor] = core.split('.').map(Number);
    return { major, minor, pre: pre !== undefined };
  };
  const a = parse(from);
  const b = parse(to);
  if (a.major !== b.major) return true;
  if (a.major === 0 && a.minor !== b.minor) return true;
  return a.pre || b.pre;
}
