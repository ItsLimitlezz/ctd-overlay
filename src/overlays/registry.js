// Overlays: a template plus settings and bindings, with a permanent slug (01 §1.3–1.4). Kept in
// the store; each one gets a bus channel shaped by what its template consumes. Settings are
// published to the overlay as channel-only state (`overlay.settings`).
//
// The overlays API (create/update from the admin UI) arrives with step 13; until then overlays
// are created in code (the diagnostic script, tests).
import { newId } from '../ids.js';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class OverlayError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OverlayError';
    this.code = code;
  }
}

export function createOverlays({ store, bus, templates, log }) {
  const bySlug = new Map(); // slug → id

  function open(doc) {
    const template = templates.get(doc.data.template.id, doc.data.template.version);
    if (!template) {
      log.error('an overlay\'s template is not installed; it will not render', { overlay: doc.id, template: doc.data.template });
    }
    const ch = bus.channel(doc.id, {
      consumes: template?.manifest.consumes || {},
      connections: doc.data.connections || [],
    });
    ch.setLocalState('overlay.settings', doc.data.settings || {});
    bySlug.set(doc.data.slug, doc.id);
  }

  // Load every stored overlay.
  for (let after = ''; ;) {
    const page = store.list('overlays', { after, limit: 1000 });
    for (const doc of page) open(doc);
    if (page.length < 1000) break;
    after = page[page.length - 1].id;
  }

  return {
    create({ slug, template, settings = {}, connections = [] }) {
      if (typeof slug !== 'string' || !SLUG.test(slug)) {
        throw new OverlayError(`"${slug}" isn't a valid slug: use lowercase letters, digits and dashes, starting with a letter or digit`, 'bad-slug');
      }
      if (bySlug.has(slug)) throw new OverlayError(`the slug "${slug}" is taken`, 'slug-taken');
      if (!templates.get(template?.id, template?.version)) {
        throw new OverlayError(`template ${template?.id}@${template?.version} isn't installed`, 'no-template');
      }
      const id = newId('ovl');
      const doc = store.put('overlays', id, { slug, template: { id: template.id, version: template.version }, settings, connections }, { ifRev: 0 });
      open(doc);
      return doc;
    },

    remove(id) {
      const doc = store.get('overlays', id);
      if (!doc) return false;
      store.delete('overlays', id);
      bySlug.delete(doc.data.slug);
      bus.removeChannel(id);
      return true;
    },

    // { doc, template, channel } for a slug, or undefined.
    resolve(slug) {
      const id = bySlug.get(slug);
      if (!id) return undefined;
      const doc = store.get('overlays', id);
      if (!doc) return undefined;
      const template = templates.get(doc.data.template.id, doc.data.template.version);
      return { doc, template, channel: bus.channel(id) };
    },

    list() { return store.list('overlays', { limit: 1000 }); },
  };
}
