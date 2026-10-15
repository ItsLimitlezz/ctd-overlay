// Overlays shared with a connection's service (06 §6.11): what a connector whose definition says
// `sharesOverlays` gets as ctx.overlays, so it can tell an app hub (CTD Multi-Stream's) which
// overlays it feeds, with their URLs for OBS, and make one when another app asks.
//
//   ctx.overlays.baseUrl       where OBS reaches this platform: SKP_PUBLIC_URL, else the first
//                              SKP_HOSTS name (lan and public modes) with the platform's port;
//                              undefined when it isn't known (baseProblem says what to set)
//   ctx.overlays.list()        the overlays bound to this connection ("all" counts), by slug, each
//                              { id, slug, role?, template: { id, version, name }, canvases: [{ id,
//                              label, kind: landscape | vertical, width, height, url }] }; an
//                              overlay whose template can't run is left out
//   ctx.overlays.onChange(fn)  fn() after an overlay is made, deleted, renamed, re-keyed, re-bound…
//   ctx.overlays.create({ template, canvas?, slugBase?, from })   an overlay bound to this connection
//                              only, recorded in the audit log as made by app:<from>; throws an
//                              Error whose message says in plain words why not
//
// The URLs carry the overlays' keys: they go only to the service this connection reaches, which
// the owner set up (07 §7.6).
import { compareVersions } from '../templates/registry.js';

const SLUG_CHARS = 56; // room for "-99" under the 63 a slug may have

// landscape or vertical, the OBS canvas a template's canvas belongs on. Its id says so when it is
// h / v (landscape / vertical); else, in a template that has a vertical canvas, the others are
// the main output's (Chat's 560 × 1000 "side" column sits in a landscape scene); else its shape.
export function canvasKind(canvases, c) {
  const said = (x) => (/^(v|vertical|portrait)$/i.test(x?.id || '') ? 'vertical' : /^(h|landscape|horizontal)$/i.test(x?.id || '') ? 'landscape' : undefined);
  if (said(c)) return said(c);
  if ((canvases || []).some((x) => said(x) === 'vertical')) return 'landscape';
  return (c?.width || 0) >= (c?.height || 0) ? 'landscape' : 'vertical';
}

// The last part of a template id, as a slug: com.dprtmnt.takeover → takeover.
export const shortName = (id) => String(id || '').split('.').pop().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'overlay';

export function createShare({ overlays, templates, audit, log, base = () => undefined }) {
  // The newest installed version of each template.
  function latest() {
    const by = new Map();
    for (const t of templates.list()) {
      const cur = by.get(t.id);
      if (!cur || compareVersions(t.version, cur.version) > 0) by.set(t.id, t);
    }
    return [...by.values()];
  }

  // A template named by its id, or by the last part of its id or its name (any case).
  function templateOf(ref) {
    if (typeof ref !== 'string' || !ref.trim() || ref.length > 100) throw new Error('Say which template: its id (com.dprtmnt.takeover) or its short name (takeover).');
    const want = ref.trim().toLowerCase();
    const all = latest();
    const exact = all.filter((t) => t.id.toLowerCase() === want);
    const found = exact.length ? exact : all.filter((t) => shortName(t.id) === want || String(t.manifest?.name || '').toLowerCase() === want);
    if (!found.length) throw new Error(`CTD Overlay has no template "${ref.trim().slice(0, 100)}" installed.`);
    if (found.length > 1) throw new Error(`"${ref.trim()}" could be ${found.map((t) => t.id).join(' or ')}: ask for one by its id.`);
    return found[0];
  }

  function itemOf(doc, baseUrl) {
    const found = overlays.resolve(doc.data.slug);
    const t = found?.template;
    if (!t) return undefined;
    const list = t.manifest.canvases || [];
    const urls = baseUrl ? overlays.urls(doc.id, baseUrl) : [];
    return {
      id: doc.id,
      slug: doc.data.slug,
      ...(doc.data.role ? { role: doc.data.role } : {}),
      template: { id: t.id, version: t.version, name: t.manifest.name || t.id },
      canvases: list.map((c) => ({
        id: c.id,
        ...(typeof c.label === 'string' && c.label ? { label: c.label } : {}),
        kind: canvasKind(list, c),
        width: c.width,
        height: c.height,
        ...(urls.find((u) => u.canvas === c.id)?.url ? { url: urls.find((u) => u.canvas === c.id).url } : {}),
      })),
    };
  }

  function uniqueSlug(wanted) {
    const stem = wanted.slice(0, SLUG_CHARS).replace(/-+$/, '') || 'overlay';
    if (!overlays.resolve(stem)) return stem;
    for (let n = 2; n < 1000; n++) if (!overlays.resolve(`${stem}-${n}`)) return `${stem}-${n}`;
    throw new Error('Every name for it is taken: delete some overlays first.');
  }

  return {
    // The capability for one connection: { id, name } (its name read when it is used).
    forConnection(conn) {
      const bound = (doc) => { const b = overlays.bindingOf(doc); return b === 'all' || b.includes(conn.id); };
      return {
        get baseUrl() { return base().url; },
        get baseProblem() { return base().problem; },
        list() {
          const url = base().url;
          return overlays.list().filter(bound).map((d) => itemOf(d, url)).filter(Boolean).sort((a, b) => (a.slug < b.slug ? -1 : 1));
        },
        onChange: (fn) => overlays.onChange(fn),
        create({ template, canvas, slugBase, from }) {
          if (canvas !== undefined && canvas !== null && canvas !== 'landscape' && canvas !== 'vertical') throw new Error('"canvas" is "landscape" or "vertical" (or left out for every canvas).');
          const t = templateOf(template);
          const list = t.manifest.canvases || [];
          const picked = canvas ? list.find((c) => canvasKind(list, c) === canvas) : undefined;
          if (canvas && !picked) throw new Error(`${t.manifest.name || t.id} has no ${canvas} canvas.`);
          const tail = typeof slugBase === 'string' ? slugBase.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') : '';
          const slug = uniqueSlug(tail ? `${shortName(t.id)}-${tail}` : shortName(t.id));
          const doc = overlays.create({ slug, template: { id: t.id, version: t.version }, settings: {}, connections: [conn.id] });
          audit?.record({ action: 'overlay.create', actor: `app:${String(from || 'unknown').slice(0, 40)}`, target: slug, template: `${t.id}@${t.version}`, via: conn.name, connection: conn.id });
          log?.info('another app made an overlay through a connection', { overlay: slug, template: t.id, connection: conn.id, app: from });
          return { ...itemOf(doc, base().url), ...(picked ? { canvas: picked.id } : {}) };
        },
      };
    },
  };
}
