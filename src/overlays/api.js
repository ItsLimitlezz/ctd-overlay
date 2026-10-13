// Overlays over HTTP (03 §3.4), on the API's conventions (http/api.js):
//
//   GET    /api/v1/overlays                    every overlay, paged
//   POST   /api/v1/overlays                    { slug, template: { id, version }, settings? }
//   GET    /api/v1/overlays/:ref               by slug or id
//   PATCH  /api/v1/overlays/:ref               { settings?, slug?, keyRequired? } (If-Match)
//   DELETE /api/v1/overlays/:ref
//   POST   /api/v1/overlays/:ref/upgrade       { version, dryRun?, confirm?, runMigrate? } (04 §4.10)
//   POST   /api/v1/overlays/:ref/revert        back to the version and settings before the last upgrade
//   GET    /api/v1/overlays/:ref/url           its URLs for OBS, one per canvas, with its key
//   POST   /api/v1/overlays/:ref/key/rotate    a new key: the old URL stops working, in OBS too
//
// An overlay as a resource carries its saved settings (only what the operator set) and the
// settings it sees (defaults applied), never its key: the URL shows the key, so reading it needs
// overlays:read like the rest, and the key's changes are recorded in the audit log.
import { ApiError } from '../http/api.js';

export function overlayApiRoutes({ api, overlays, templates, shows, audit, base }) {
  const tag = 'Overlays';
  const r = (def) => api.route({ tag, ...def });
  const docOf = (ref) => {
    const found = overlays.resolve(ref) || overlays.resolve(overlays.list().find((d) => d.id === ref)?.data.slug);
    if (!found) throw new ApiError(404, 'not-found', `There is no overlay "${ref}".`);
    return found;
  };
  // The overlay as the API shows it.
  function resource(found) {
    const { doc } = found;
    const d = doc.data;
    const installed = templates.get(d.template.id, d.template.version);
    return {
      id: doc.id,
      rev: doc.rev,
      slug: d.slug,
      template: d.template,
      status: !installed ? 'template-missing' : found.template ? 'ok' : 'template-unusable',
      settings: d.settings || {},
      resolvedSettings: found.settings,
      keyRequired: overlays.keyRequired(doc),
      ...(d.previous ? { previous: { template: d.previous.template, at: d.previous.at } } : {}),
      ...(shows ? { show: shows.list().find((s) => s.overlays.includes(doc.id))?.name } : {}),
    };
  }
  const rev = (p) => {
    const { doc } = docOf(p.ref);
    return { id: doc.id, rev: doc.rev };
  };
  const recordKey = (who, req, action, slug, extra) => audit.record({ action, actor: who.label, ip: req.client?.ip, target: slug, ...extra });
  return [
    r({ method: 'GET', path: '/api/v1/overlays', scope: 'overlays:read', summary: 'List overlays', run: ({ url }) => api.paginate(overlays.list().map((d) => resource(docOf(d.data.slug))).sort((a, b) => (a.slug < b.slug ? -1 : 1)), url, (o) => o.slug) }),
    r({ method: 'POST', path: '/api/v1/overlays', scope: 'overlays:write', summary: 'Create an overlay from an installed template', body: { fields: ['slug', 'template', 'settings'] }, run: ({ body, who, req }) => {
      const doc = overlays.create({ slug: body.slug, template: body.template, settings: body.settings ?? {} });
      audit.record({ action: 'overlay.create', actor: who.label, ip: req.client?.ip, target: doc.data.slug, template: `${doc.data.template.id}@${doc.data.template.version}` });
      return { status: 201, body: resource(docOf(doc.data.slug)) };
    } }),
    r({ method: 'GET', path: '/api/v1/overlays/:ref', scope: 'overlays:read', summary: 'An overlay, by slug or id', run: ({ params }) => resource(docOf(params.ref)) }),
    r({ method: 'PATCH', path: '/api/v1/overlays/:ref', scope: 'overlays:write', summary: 'Change an overlay\'s settings, slug, or whether its URL needs its key', body: { fields: ['settings', 'slug', 'keyRequired'] }, resource: rev, run: ({ params, body, ifRev, who, req }) => {
      let { doc } = docOf(params.ref);
      if (body.keyRequired !== undefined && typeof body.keyRequired !== 'boolean') throw new ApiError(422, 'invalid', '"keyRequired" is true or false.');
      if (body.settings !== undefined) doc = overlays.updateSettings(doc.id, body.settings, { ifRev });
      if (body.slug !== undefined && body.slug !== doc.data.slug) {
        const from = doc.data.slug;
        doc = overlays.rename(doc.id, body.slug, { ifRev: body.settings !== undefined ? undefined : ifRev });
        audit.record({ action: 'overlay.rename', actor: who.label, ip: req.client?.ip, target: doc.data.slug, from });
      }
      if (body.keyRequired !== undefined) {
        doc = overlays.setKeyRequired(doc.id, body.keyRequired);
        recordKey(who, req, 'overlay.key-required', doc.data.slug, { required: body.keyRequired });
      }
      return resource(docOf(doc.data.slug));
    } }),
    r({ method: 'DELETE', path: '/api/v1/overlays/:ref', scope: 'overlays:write', summary: 'Delete an overlay (its URL stops working)', resource: rev, run: ({ params, who, req }) => {
      const { doc } = docOf(params.ref);
      overlays.remove(doc.id);
      audit.record({ action: 'overlay.delete', actor: who.label, ip: req.client?.ip, target: doc.data.slug });
      return { id: doc.id, slug: doc.data.slug };
    } }),
    r({ method: 'POST', path: '/api/v1/overlays/:ref/upgrade', scope: 'overlays:write', summary: 'Move to a newer installed version of the template (dryRun for the plan)', body: { fields: ['version', 'dryRun', 'confirm', 'runMigrate'] }, run: async ({ params, body, who, req }) => {
      const { doc } = docOf(params.ref);
      if (typeof body.version !== 'string') throw new ApiError(422, 'invalid', '"version" is the installed version to move to.');
      const plan = await overlays.upgrade(doc.id, body.version, { dryRun: body.dryRun === true, confirm: body.confirm === true, runMigrate: body.runMigrate === true });
      const { doc: saved, ...rest } = plan;
      if (!body.dryRun) audit.record({ action: 'overlay.upgrade', actor: who.label, ip: req.client?.ip, target: doc.data.slug, from: plan.from, to: plan.to, migrated: plan.migrated });
      return { ...rest, ...(saved ? { overlay: resource(docOf(saved.data.slug)) } : {}) };
    } }),
    r({ method: 'POST', path: '/api/v1/overlays/:ref/revert', scope: 'overlays:write', summary: 'Back to the version and settings before the last upgrade', body: { fields: [] }, run: ({ params, who, req }) => {
      const { doc } = docOf(params.ref);
      const out = overlays.revert(doc.id);
      audit.record({ action: 'overlay.revert', actor: who.label, ip: req.client?.ip, target: doc.data.slug, from: out.from, to: out.to });
      return { from: out.from, to: out.to, overlay: resource(docOf(doc.data.slug)) };
    } }),
    r({ method: 'GET', path: '/api/v1/overlays/:ref/url', scope: 'overlays:read', summary: 'The overlay\'s URLs for OBS, with its key', run: ({ params, req }) => {
      const { doc } = docOf(params.ref);
      return { overlay: doc.data.slug, urls: overlays.urls(doc.id, base(req)) };
    } }),
    r({ method: 'POST', path: '/api/v1/overlays/:ref/key/rotate', scope: 'overlays:write', summary: 'A new key: the old URL stops working, in OBS too', body: { fields: [] }, run: ({ params, who, req }) => {
      const { doc } = docOf(params.ref);
      overlays.rotateKey(doc.id);
      recordKey(who, req, 'overlay.key-rotate', doc.data.slug);
      return { overlay: doc.data.slug, urls: overlays.urls(doc.id, base(req)), note: 'The old URL no longer works: update the OBS browser sources that use it.' };
    } }),
  ];
}
