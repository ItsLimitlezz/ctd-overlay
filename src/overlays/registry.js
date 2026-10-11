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
import { migrateSettings, resolveSettings, validateSettings } from '../templates/settings.js';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
// overlay.settings travels in a state.changed envelope with its previous value; keep both well
// under the 64 KiB envelope limit (02 §2.9).
const SETTINGS_BYTES = 24 * 1024;

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

  function open(doc) {
    const template = templates.get(doc.data.template.id, doc.data.template.version);
    if (!template) {
      log.error('an overlay\'s template is not installed; it will not render', { overlay: doc.id, template: doc.data.template });
    }
    const ch = bus.channel(doc.id, {
      consumes: template?.manifest.consumes || {},
      connections: doc.data.connections || [],
    });
    const settings = template
      ? resolveSettings(template.manifest, doc.data.settings || {}, (key) => bus.getState(key))
      : (doc.data.settings || {});
    resolved.set(doc.id, settings);
    pins.set(doc.id, doc.data.template);
    ch.setLocalState('overlay.settings', settings);
    bySlug.set(doc.data.slug, doc.id);
    return ch;
  }

  // Every stored overlay, page by page.
  function* all() {
    for (let after = ''; ;) {
      const page = store.list('overlays', { after, limit: 1000 });
      yield* page;
      if (page.length < 1000) break;
      after = page[page.length - 1].id;
    }
  }

  for (const doc of all()) open(doc);

  function checkSettings(template, settings) {
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw new OverlayError('Settings must be an object.', 'bad-settings');
    if (JSON.stringify(settings).length > SETTINGS_BYTES) throw new OverlayError(`Settings are limited to ${SETTINGS_BYTES / 1024} KiB.`, 'bad-settings');
    const problems = validateSettings(template.manifest, settings);
    if (problems.length) {
      throw new OverlayError(`These settings don't fit ${template.id}@${template.version}: ${problems.map((p) => `${p.path} ${p.message}`).join('; ')}.`, 'bad-settings', problems);
    }
  }

  function byIdOrSlug(ref) {
    const doc = store.get('overlays', bySlug.get(ref) || ref);
    if (!doc) throw new OverlayError(`There is no overlay "${ref}".`, 'not-found');
    return doc;
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
      bus.removeChannel(id);
      return true;
    },

    // The build an overlay's page should be running now, from memory: stream heartbeats ask
    // often, and may ask while the platform shuts down.
    currentBuild(slug) {
      const pin = pins.get(bySlug.get(slug));
      return pin && templates.get(pin.id, pin.version)?.build;
    },

    // { doc, template, channel, settings } for a slug, or undefined.
    resolve(slug) {
      const id = bySlug.get(slug);
      if (!id) return undefined;
      const doc = store.get('overlays', id);
      if (!doc) return undefined;
      const template = templates.get(doc.data.template.id, doc.data.template.version);
      return { doc, template, channel: bus.channel(id), settings: resolved.get(id) || {} };
    },

    list() { return [...all()]; },

    // Slugs of the overlays that use id@version (uninstall is refused while there are any).
    pinnedBy(id, version) {
      const slugs = [];
      for (const doc of all()) if (doc.data.template.id === id && doc.data.template.version === version) slugs.push(doc.data.slug);
      return slugs;
    },

    // Opens again the overlays on id@version, after it was installed: one that was waiting for a
    // missing template (503) starts rendering.
    reopen(id, version) {
      for (const doc of all()) if (doc.data.template.id === id && doc.data.template.version === version) open(doc);
    },

    // Moves an overlay to a newer installed version of its template (04 §4.10): the template's
    // migrate.js (if any) first, then unchanged settings copy over, removed ones drop, and new ones
    // take their defaults. Returns the plan; with dryRun nothing changes. A major version needs
    // { confirm: true } (the operator must see what changes first). The slug, key and URL never
    // change; open pages re-sync and reload with the new build.
    async upgrade(ref, version, { ifRev, dryRun = false, confirm = false } = {}) {
      const doc = byIdOrSlug(ref);
      const pin = doc.data.template;
      const from = templates.get(pin.id, pin.version); // may be gone: upgrading is the way out
      const to = templates.get(pin.id, version);
      if (!to) throw new OverlayError(`${pin.id}@${version} isn't installed.`, 'no-template');
      if (compareVersions(version, pin.version) <= 0) throw new OverlayError(`${pin.id}@${version} is not newer than ${pin.version}.`, 'not-newer');

      let settings = doc.data.settings || {};
      let migrated = false;
      if (to.files.has('migrate.js')) {
        settings = await runMigrate(readFileSync(path.join(to.dir, 'migrate.js'), 'utf8'), pin.version, settings);
        migrated = true;
      }
      const { settings: next, changes } = migrateSettings(from?.manifest, to.manifest, settings);
      const removed = (list) => (from?.manifest[list] || []).filter((x) => !(to.manifest[list] || []).some((y) => y.id === x.id)).map((x) => x.id);
      const plan = {
        overlay: doc.data.slug,
        from: pin.version,
        to: version,
        major: major(version) !== major(pin.version),
        migrated,
        settings: next,
        changes,
        removed: { scenes: removed('scenes'), actions: removed('actions'), canvases: removed('canvases') },
      };
      if (dryRun) return plan;
      if (plan.major && !confirm) throw new OverlayError(`${pin.version} → ${version} is a major upgrade; review what changes, then confirm it.`, 'confirm-major', plan);
      const problems = validateSettings(to.manifest, next);
      if (problems.length) throw new OverlayError(`migrate.js produced settings that don't fit ${pin.id}@${version}: ${problems.map((p) => `${p.path} ${p.message}`).join('; ')}.`, 'bad-settings', problems);

      templates.retain(to.id, to.version);
      // The doc as read before the (async) migration: a change since then is a conflict, not
      // something to overwrite.
      const saved = store.put('overlays', doc.id, { ...doc.data, template: { id: to.id, version: to.version }, settings: next }, { ifRev: ifRev ?? doc.rev });
      open(saved).reset();
      log.info('overlay upgraded', { overlay: doc.data.slug, template: pin.id, from: pin.version, to: version, changes: changes.length });
      return { ...plan, doc: saved };
    },
  };
}

const major = (v) => Number(String(v).split('.')[0]);
