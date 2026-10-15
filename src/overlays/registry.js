// Overlays: a template plus settings and bindings, with a permanent slug (01 §1.3–1.4). Kept in
// the store; each one gets a bus channel shaped by what its template consumes. The overlay's
// resolved settings (defaults applied, 04 §4.4) are published to it as channel-only state
// (`overlay.settings`); the store keeps only the values the operator set, so a new template
// version's defaults reach every field nobody touched.
//
// The overlays API (create/update from the admin UI) arrives with step 13; until then overlays
// are created in code (the diagnostic script, tests) and upgraded with the CLI.
//
// Each overlay has a key (07 §7.6): skp_ovl_ + 24 random bytes, the capability its OBS URL
// carries (?key=). It is stored encrypted, not hashed, so its URL can be shown again. It is
// needed for the overlay's page, snapshot, stream, poll and log; in local and lan modes the owner
// may mark an overlay "no key required". Rotating it breaks the URL in OBS.
import { randomBytes, timingSafeEqual } from 'node:crypto';
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

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function base62(bytes, length) {
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let s = '';
  while (n > 0n) {
    s = B62[Number(n % 62n)] + s;
    n /= 62n;
  }
  return s.padStart(length, '0');
}
export const newOverlayKey = () => `skp_ovl_${base62(randomBytes(24), 33)}`;

// Bindings (01 §1.3): which connections feed an overlay. 'all' (every connection, including ones
// made later: the default, so an overlay shows the Twitch count as soon as Twitch is connected), or
// a list of connection ids. A stored overlay without one (made before migration 2) is 'all'.
export const MAX_BINDINGS = 50;
export const bindingOf = (doc) => (Array.isArray(doc.data.connections) ? doc.data.connections : 'all');
export function checkBinding(value) {
  if (value === 'all') return 'all';
  if (!Array.isArray(value) || value.length > MAX_BINDINGS || value.some((c) => typeof c !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(c))) {
    throw new OverlayError(`"connections" is "all" (every connection, including ones made later), or a list of up to ${MAX_BINDINGS} connection ids.`, 'bad-connections');
  }
  return [...new Set(value)];
}
const feeds = (doc, connId) => { const b = bindingOf(doc); return b === 'all' || b.includes(connId); };

// secrets: encrypts overlay keys at rest (secrets.js); without it (some tests), overlays have no
// key and need none. exposure: in public mode every overlay needs its key. readOnly: a look that
// changes nothing (a dry run): an overlay without a key isn't given one at startup.
export function createOverlays({ store, bus, templates, log, secrets, exposure = 'local', readOnly = false }) {
  const bySlug = new Map(); // slug → id
  const resolved = new Map(); // id → the settings the overlay sees
  const pins = new Map(); // id → { id, version } of its template, for lookups that skip the store
  const broken = new Set(); // ids whose template is installed but can't be used as it is
  const bindings = new Map(); // state key → ids of overlays with a setting bound to it
  const keys = new Map(); // id → its key, decrypted once

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
      ch = bus.channel(doc.id, { consumes: template?.manifest.consumes || {}, connections: bindingOf(doc) });
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
    const settings = resolveSettings(template.manifest, saved, (key) => ch.visibleState(key, { real: true }));
    if (jsonBytes(settings) <= RESOLVED_BYTES) return settings;
    log.warn('an overlay\'s settings with their bound state values are too large to send; using them without the bound values', { overlay: doc.id });
    const plain = resolveSettings(template.manifest, saved);
    if (jsonBytes(plain) > RESOLVED_BYTES) throw new OverlayError(`its settings are larger than ${RESOLVED_BYTES / 1024} KiB`, 'bad-settings');
    return plain;
  }

  // A setting bound to a state key (x-skp-bind) follows the key as the overlay sees it: when any
  // connection's value for it changes, the overlays bound to it get their settings resolved again
  // (setLocalState sends only what moved).
  bus.onState((keys) => {
    const ids = new Set(keys.flatMap((key) => [...(bindings.get(key) || [])]));
    for (const id of ids) {
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

  // The overlay's key, decrypted (and cached); one is made for an overlay that has none (made
  // before keys existed).
  function keyOf(doc) {
    if (!secrets) return undefined;
    if (keys.has(doc.id)) return keys.get(doc.id);
    let key;
    if (doc.data.key) {
      try { key = secrets.decrypt(doc.data.key, doc.id); } catch (err) {
        log.error('an overlay\'s key can\'t be decrypted (another master key?); rotate it to make a new one', { overlay: doc.data.slug, err: err.message });
        return undefined;
      }
    } else {
      key = newOverlayKey();
      store.put('overlays', doc.id, { ...doc.data, key: secrets.encrypt(key, doc.id) });
    }
    keys.set(doc.id, key);
    return key;
  }
  const keyRequired = (doc) => exposure === 'public' || doc.data.keyRequired !== false;

  // At startup, a bundled version an overlay pins is kept in the data directory (retain), so a
  // platform update that drops or changes it can't change the overlay. Every overlay has a key.
  for (const doc of all()) {
    if (!readOnly) keyOf(doc);
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

  // Changes an overlay's settings, slug, bindings and whether its URL needs its key, any of them
  // (those `changes` has). Every one is checked before anything is saved, then all are saved at
  // once, so a refused one leaves the overlay as it was (a PATCH, 03 §3.1). ifRev: the revision the
  // caller last saw; a newer one is a ConflictError (03 §3.1, H16). A new slug changes the
  // overlay's URL (01 §1.4), so OBS sources must be updated; its key, settings and channel stay.
  // New bindings reach the overlay at once: what a connection no longer bound showed goes, what a
  // newly bound one shows arrives (the URL stays, 01 §1.4).
  function update(ref, changes, { ifRev } = {}) {
    const doc = byIdOrSlug(ref);
    const has = (k) => Object.prototype.hasOwnProperty.call(changes, k);
    const next = { ...doc.data };
    if (has('settings')) {
      const t = templates.get(doc.data.template.id, doc.data.template.version);
      if (!t) throw new OverlayError(`The overlay's template ${doc.data.template.id}@${doc.data.template.version} isn't installed.`, 'no-template');
      checkSettings(t, changes.settings);
      next.settings = changes.settings;
    }
    if (has('slug')) {
      const { slug } = changes;
      if (typeof slug !== 'string' || !SLUG.test(slug)) {
        throw new OverlayError(`"${slug}" isn't a valid slug: use lowercase letters, digits and dashes, starting with a letter or digit`, 'bad-slug');
      }
      if (slug !== doc.data.slug && bySlug.has(slug)) throw new OverlayError(`the slug "${slug}" is taken`, 'slug-taken');
      next.slug = slug;
    }
    if (has('keyRequired')) {
      // "No key required" (local and lan modes only, 07 §7.6).
      if (changes.keyRequired === false && exposure === 'public') throw new OverlayError('In public mode every overlay needs its key.', 'public-needs-key');
      if (changes.keyRequired === false) next.keyRequired = false;
      else delete next.keyRequired;
    }
    if (has('connections')) next.connections = checkBinding(changes.connections);
    const rebound = JSON.stringify(bindingOf({ data: next })) !== JSON.stringify(bindingOf(doc));
    if (!has('settings') && !rebound && next.slug === doc.data.slug && next.keyRequired === doc.data.keyRequired) return doc;
    const saved = store.put('overlays', doc.id, next, { ifRev: ifRev ?? doc.rev });
    if (saved.data.slug !== doc.data.slug) {
      bySlug.delete(doc.data.slug);
      bySlug.set(saved.data.slug, doc.id);
    }
    if (has('settings') || rebound) open(saved);
    // Streams opened without the key end once it is needed: they come back with it, or not at all.
    if (secrets && !keyRequired(doc) && keyRequired(saved)) bus.channel(doc.id).reset();
    return saved;
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
    create({ slug, template, settings = {}, connections = 'all' }) {
      if (typeof slug !== 'string' || !SLUG.test(slug)) {
        throw new OverlayError(`"${slug}" isn't a valid slug: use lowercase letters, digits and dashes, starting with a letter or digit`, 'bad-slug');
      }
      if (bySlug.has(slug)) throw new OverlayError(`the slug "${slug}" is taken`, 'slug-taken');
      const t = templates.get(template?.id, template?.version);
      if (!t) throw new OverlayError(`template ${template?.id}@${template?.version} isn't installed`, 'no-template');
      checkSettings(t, settings);
      connections = checkBinding(connections);
      templates.retain(t.id, t.version); // a bundled version stays even if a platform update drops it
      const id = newId('ovl');
      const key = secrets ? newOverlayKey() : undefined;
      const doc = store.put('overlays', id, { slug, template: { id: t.id, version: t.version }, settings, connections, ...(key ? { key: secrets.encrypt(key, id) } : {}) }, { ifRev: 0 });
      if (key) keys.set(id, key);
      open(doc);
      return doc;
    },

    // Whether a request for this overlay's page or data may be answered: it carries the key, or
    // the overlay doesn't need one.
    admits(doc, given) {
      if (!secrets || !keyRequired(doc)) return true;
      const key = keyOf(doc);
      if (!key || typeof given !== 'string' || given.length !== key.length) return false;
      return timingSafeEqual(Buffer.from(given), Buffer.from(key));
    },
    keyRequired,

    // The overlay's key (for its URL), or undefined without secrets.
    key(ref) {
      return keyOf(byIdOrSlug(ref));
    },

    // A new key: the old URL stops working, in OBS too (07 §7.6). Streams opened with the old key
    // end now, not at their next reconnect, so a leaked URL stops showing anything at once.
    rotateKey(ref) {
      if (!secrets) throw new OverlayError('Overlay keys need the master key.', 'no-secrets');
      const doc = byIdOrSlug(ref);
      const key = newOverlayKey();
      store.put('overlays', doc.id, { ...doc.data, key: secrets.encrypt(key, doc.id) });
      keys.set(doc.id, key);
      bus.channel(doc.id).reset();
      return key;
    },

    // "No key required" (local and lan modes only, 07 §7.6).
    setKeyRequired(ref, required) {
      return update(ref, { keyRequired: required });
    },

    // The overlay's URLs for OBS, one per canvas (01 §1.4): base is the platform's address.
    urls(ref, base) {
      const doc = byIdOrSlug(ref);
      const t = templates.get(doc.data.template.id, doc.data.template.version);
      const key = keyRequired(doc) ? keyOf(doc) : undefined;
      const canvases = t?.manifest.canvases || [{ id: 'default' }];
      return canvases.map((c, i) => {
        const q = new URLSearchParams();
        if (key) q.set('key', key);
        if (i > 0 || !c.default) q.set('canvas', c.id);
        const qs = q.toString();
        return { canvas: c.id, ...(c.width ? { width: c.width, height: c.height } : {}), url: `${base}/o/${doc.data.slug}${qs ? `?${qs}` : ''}` };
      });
    },

    update,

    // Replaces the overlay's settings (only the values the operator set).
    updateSettings(ref, settings, { ifRev } = {}) {
      return update(ref, { settings }, { ifRev });
    },

    // A new slug: the overlay's URL changes (01 §1.4).
    rename(ref, slug, { ifRev } = {}) {
      return update(ref, { slug }, { ifRev });
    },

    // Which connections feed it: 'all', or a list of connection ids (01 §1.3).
    updateConnections(ref, connections, { ifRev } = {}) {
      return update(ref, { connections }, { ifRev });
    },

    bindingOf,

    // Slugs of the overlays a connection feeds (bound to it, or to every connection).
    fedBy(connId) {
      return [...all()].filter((doc) => feeds(doc, connId)).map((doc) => doc.data.slug).sort();
    },

    // A deleted connection leaves every list it was named in, so an overlay's bindings, read and
    // sent back, name only connections that exist. Returns the slugs whose list changed.
    unbind(connId) {
      const changed = [];
      for (const doc of all()) {
        const b = bindingOf(doc);
        if (b === 'all' || !b.includes(connId)) continue;
        const saved = store.put('overlays', doc.id, { ...doc.data, connections: b.filter((c) => c !== connId) });
        open(saved);
        changed.push(saved.data.slug);
      }
      return changed;
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

    // Resolves an overlay's settings again after a key its bound settings read changed on its own
    // channel (a show's show.headliner, 04 §4.3): bus-wide changes are followed already.
    refreshBound(id) {
      const doc = store.get('overlays', id);
      if (doc && boundKeys(templates.get(doc.data.template.id, doc.data.template.version)?.manifest || {}).length) open(doc);
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
