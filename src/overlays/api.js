// Overlays over HTTP (03 §3.4), on the API's conventions (http/api.js):
//
//   GET    /api/v1/overlays                    every overlay, paged
//   POST   /api/v1/overlays                    { slug, template: { id, version }, settings?, connections?, role? }
//   GET    /api/v1/overlays/:ref               by slug or id
//   PATCH  /api/v1/overlays/:ref               { settings?, slug?, keyRequired?, connections?, role? } (If-Match)
//   DELETE /api/v1/overlays/:ref
//   POST   /api/v1/overlays/:ref/upgrade       { version, dryRun?, confirm?, runMigrate? } (04 §4.10)
//   POST   /api/v1/overlays/:ref/revert        back to the version and settings before the last upgrade
//   GET    /api/v1/overlays/:ref/url           its URLs for OBS, one per canvas, with its key
//   POST   /api/v1/overlays/:ref/key/rotate    a new key: the old URL stops working, in OBS too
//
// An overlay as a resource carries its saved settings (only what the operator set) and the
// settings it sees (defaults applied), never its key. Its URL, key included, needs overlays:read
// like the rest: the key lets one read that overlay's page and data, which whoever has
// overlays:read can watch already (the previews). Rotating the key needs overlays:write, as it only
// takes access away; marking an overlay "no key required" is the owner's (system:admin, 07 §7.6).
// The key's changes are recorded in the audit log.
//
// Bindings (01 §1.3): `connections` is "all" (every connection, including ones made later: the
// default) or a list of connection ids, each of which must exist: a whole connection (every
// profile it follows, new ones too), or "<connection id>/<profile id>", one CTD Multi-Stream
// profile of a connection that follows every profile (it must follow it now, 422 otherwise; one
// the overlay is bound to already is kept). `bound` lists what feeds the overlay now (connections,
// and profiles of one), by name and status, for whoever edits overlays (operators don't hold
// connections:read, and need to see what feeds what). `stream` is its stream status (src/streams.js):
// the turned-on connections that feed it, whether it is on air on each platform, its viewers;
// worked out on each read, so it never moves the ETag.
//
// `role` ("Role in OBS", 06 §6.11): the overlay's role in an OBS scene, the same for the equivalent
// overlay of every stream ("chat-main"); CTD Multi-Stream's OBS plugin uses it to re-point its
// browser sources when it switches stream. Absent: the template's short name ("takeover").
import { connectionOf, profileOf } from '../bus/owners.js';
import { ApiError } from '../http/api.js';

export function overlayApiRoutes({ api, overlays, templates, shows, audit, base, connections, streams }) {
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
      connections: overlays.bindingOf(doc),
      bound: boundTo(overlays.bindingOf(doc)),
      ...(d.role ? { role: d.role } : {}),
      ...(streams ? { stream: streams.ofOverlay(doc) } : {}),
      ...(d.previous ? { previous: { template: d.previous.template, at: d.previous.at } } : {}),
      ...(shows ? { show: shows.list().find((s) => s.overlays.includes(doc.id))?.name } : {}),
    };
  }
  // What feeds an overlay with these bindings: [{ id, name, connector, status }] per connection,
  // and per profile of one (a "<connection>/<profile>" binding): { id, connection, profile, name
  // ("Multi-Stream · DPRTMNT"), connector, status, missing? } (missing: the connection doesn't
  // follow that profile now, say it was deleted at its service).
  function boundTo(binding) {
    const list = connections?.summary() || [];
    if (binding === 'all') return list.map((c) => ({ id: c.id, name: c.name, connector: c.connector, status: c.status }));
    const out = [];
    for (const entry of binding) {
      const c = list.find((x) => x.id === connectionOf(entry));
      if (!c) continue;
      const p = profileOf(entry);
      if (p === undefined) { out.push({ id: c.id, name: c.name, connector: c.connector, status: c.status }); continue; }
      const known = (c.profiles || []).find((x) => x.id === p);
      out.push({ id: entry, connection: c.id, profile: p, name: `${c.name} · ${known?.name || p}`, connector: c.connector, status: c.status, ...(known ? {} : { missing: true }) });
    }
    return out;
  }
  // Bindings as sent: "all", or connections that exist, whole or one of the profiles they follow
  // now (the registry checks the shape). An entry the overlay has already is kept as it is, so its
  // bindings, read and sent back, never fail for a profile deleted meanwhile.
  function checkConnections(value, had = []) {
    if (value === undefined || value === 'all' || !Array.isArray(value)) return;
    const named = value.filter((id) => typeof id === 'string');
    const missing = [...new Set(named.map(connectionOf))].filter((id) => !connections?.exists(id));
    if (missing.length) throw new ApiError(422, 'invalid', `There ${missing.length > 1 ? 'are no connections' : 'is no connection'} ${missing.map((id) => `"${id}"`).join(', ')}. "connections" is "all", or ids from GET /api/v1/connections (one of a connection's profiles: "<connection id>/<profile id>").`);
    const kept = Array.isArray(had) ? had : [];
    for (const entry of named) {
      const p = profileOf(entry);
      if (p === undefined || kept.includes(entry)) continue;
      const conn = connectionOf(entry);
      const follows = connections?.feedsOf?.(conn) || [];
      if (follows.includes(p)) continue;
      const name = connections?.summary().find((c) => c.id === conn)?.name || conn;
      throw new ApiError(422, 'invalid', follows.length
        ? `${name} doesn't follow a profile "${p}": it follows ${follows.map((x) => `"${x}"`).join(', ')}. Bind the whole connection ("${conn}") or one of those.`
        : `${name} doesn't follow separate profiles now (it follows one stream, or isn't running): bind the whole connection ("${conn}").`);
    }
  }
  const rev = (p) => {
    const { doc } = docOf(p.ref);
    return { id: doc.id, rev: doc.rev };
  };
  const recordKey = (who, req, action, slug, extra) => audit.record({ action, actor: who.label, ip: req.client?.ip, target: slug, ...extra });
  return [
    r({ method: 'GET', path: '/api/v1/overlays', scope: 'overlays:read', summary: 'List overlays, each with what feeds it and its stream status', paged: true, run: ({ url }) => api.paginate(overlays.list().map((d) => resource(docOf(d.data.slug))).sort((a, b) => (a.slug < b.slug ? -1 : 1)), url, (o) => o.slug) }),
    r({ method: 'POST', path: '/api/v1/overlays', scope: 'overlays:write', summary: 'Create an overlay from an installed template (connections: "all", the default, or connection ids, or "<connection id>/<profile id>" for one CTD Multi-Stream profile)', body: { fields: ['slug', 'template', 'settings', 'connections', 'role'], nested: { template: ['id', 'version'] } }, status: 201, run: ({ body, who, req }) => {
      checkConnections(body.connections);
      const doc = overlays.create({ slug: body.slug, template: body.template, settings: body.settings ?? {}, connections: body.connections ?? 'all', role: body.role });
      audit.record({ action: 'overlay.create', actor: who.label, ip: req.client?.ip, target: doc.data.slug, template: `${doc.data.template.id}@${doc.data.template.version}` });
      return { status: 201, body: resource(docOf(doc.data.slug)) };
    } }),
    r({ method: 'GET', path: '/api/v1/overlays/:ref', scope: 'overlays:read', summary: 'An overlay, by slug or id', run: ({ params }) => resource(docOf(params.ref)) }),
    r({ method: 'PATCH', path: '/api/v1/overlays/:ref', scope: 'overlays:write', summary: 'Change an overlay\'s settings, slug, connections, role in OBS, or whether its URL needs its key ("no key required" is the owner\'s: system:admin)', body: { fields: ['settings', 'slug', 'keyRequired', 'connections', 'role'] }, resource: rev, run: ({ params, body, ifRev, who, req }) => {
      const { doc } = docOf(params.ref);
      if (body.keyRequired !== undefined && typeof body.keyRequired !== 'boolean') throw new ApiError(422, 'invalid', '"keyRequired" is true or false.');
      const had = overlays.bindingOf(doc);
      checkConnections(body.connections, had === 'all' ? [] : had);
      // Opening an overlay's page and data to anyone on the network is the owner's choice (07 §7.6),
      // not every editor's. Asking for the key again only makes it safer, so that stays theirs.
      if (body.keyRequired === false && overlays.keyRequired(doc) && !who.scopes.has('system:admin')) {
        throw new ApiError(403, 'forbidden', `Marking an overlay "no key required" is the owner's choice (07 §7.6): it needs the "system:admin" permission, which ${who.label} doesn't have.`);
      }
      // One save, after every field is checked: a refused one changes nothing.
      const saved = overlays.update(doc.id, body, { ifRev });
      if (saved.data.slug !== doc.data.slug) audit.record({ action: 'overlay.rename', actor: who.label, ip: req.client?.ip, target: saved.data.slug, from: doc.data.slug });
      // Recorded only when the choice changed: asking for what is already so decides nothing, and
      // must not show someone else's choice as theirs.
      if (body.keyRequired !== undefined && (saved.data.keyRequired !== false) !== (doc.data.keyRequired !== false)) recordKey(who, req, 'overlay.key-required', saved.data.slug, { required: body.keyRequired });
      if (body.connections !== undefined && JSON.stringify(overlays.bindingOf(saved)) !== JSON.stringify(overlays.bindingOf(doc))) audit.record({ action: 'overlay.bind', actor: who.label, ip: req.client?.ip, target: saved.data.slug, connections: overlays.bindingOf(saved) });
      return resource(docOf(saved.data.slug));
    } }),
    r({ method: 'DELETE', path: '/api/v1/overlays/:ref', scope: 'overlays:write', summary: 'Delete an overlay (its URL stops working)', resource: rev, run: ({ params, who, req }) => {
      const { doc } = docOf(params.ref);
      overlays.remove(doc.id);
      // It leaves its show too: the show's overlays, read and sent back, name only overlays that exist.
      const show = shows?.list().find((s) => s.overlays.includes(doc.id));
      if (show) shows.update(show.id, { overlays: show.overlays.filter((id) => id !== doc.id) });
      audit.record({ action: 'overlay.delete', actor: who.label, ip: req.client?.ip, target: doc.data.slug });
      return { id: doc.id, slug: doc.data.slug };
    } }),
    r({ method: 'POST', path: '/api/v1/overlays/:ref/upgrade', scope: 'overlays:write', summary: 'Move to a newer installed version of the template (dryRun for the plan)', body: { fields: ['version', 'dryRun', 'confirm', 'runMigrate'] }, run: async ({ params, body, who, req }) => {
      const { doc } = docOf(params.ref);
      if (typeof body.version !== 'string') throw new ApiError(422, 'invalid', '"version" is the installed version to move to.');
      // A flag that is anything but true or false is refused: "true" taken as a dry run by one
      // check and as a real upgrade by another would move the overlay with nothing in the audit log.
      for (const flag of ['dryRun', 'confirm', 'runMigrate']) {
        if (body[flag] !== undefined && typeof body[flag] !== 'boolean') throw new ApiError(422, 'invalid', `"${flag}" is true or false.`);
      }
      const dryRun = body.dryRun === true;
      // runMigrate left out: the template's migrate.js runs on its own if it ships with the platform.
      const plan = await overlays.upgrade(doc.id, body.version, { dryRun, confirm: body.confirm === true, runMigrate: body.runMigrate });
      const { doc: saved, ...rest } = plan;
      if (!dryRun) audit.record({ action: 'overlay.upgrade', actor: who.label, ip: req.client?.ip, target: doc.data.slug, from: plan.from, to: plan.to, migrated: plan.migrated });
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
    // The answer holds the new key, so it is never kept for replay (03 §3.1): replay records are
    // stored as they are, and an overlay key is only ever stored encrypted (07 §7.7). Pressed
    // twice, it rotates twice; the second answer has the key that works.
    r({ method: 'POST', path: '/api/v1/overlays/:ref/key/rotate', scope: 'overlays:write', summary: 'A new key: the old URL stops working, in OBS too', body: { fields: [] }, idempotent: false, run: ({ params, who, req }) => {
      const { doc } = docOf(params.ref);
      overlays.rotateKey(doc.id);
      recordKey(who, req, 'overlay.key-rotate', doc.data.slug);
      return { overlay: doc.data.slug, urls: overlays.urls(doc.id, base(req)), note: 'The old URL no longer works: update the OBS browser sources that use it.' };
    } }),
  ];
}
