// Templates over HTTP (03 §3.4, 04 §4.11–4.13), on the API's conventions (http/api.js):
//
//   GET    /api/v1/templates                      installed templates, one entry per id (?category=)
//   GET    /api/v1/templates/:id                  its manifest (newest version), versions, previews
//   GET    /api/v1/templates/:id/versions         its installed versions, newest first ({ items, next })
//   GET    /api/v1/templates/:id/versions/:version/previews/<path>   a preview image (its path in previews/)
//   POST   /api/v1/templates                      install: a .skp/.zip as the body, or { "url" }
//                                                 (an https URL or a GitHub repository, 04 §4.13)
//   DELETE /api/v1/templates/:id                  uninstall every version, or ?version= one
//   POST   /api/v1/templates/validate             lint a package without installing it (04 §4.11)
//   GET    /api/v1/templates/sources · POST { source, autoUpgrade?, template? } · DELETE …/sources/:ref
//   POST   /api/v1/templates/sources/check        check followed sources now (?source=one)
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from '../http/api.js';
import { packageFromZip, previewType, SEMVER, validatePackage } from './package.js';
import { compareVersions } from './registry.js';
import { fetchPackage, parseSource } from './sources.js';
import { bufferSource } from './zip.js';

const PACKAGE_LIMIT = 100 * 1024 * 1024; // 07 §7.11

// github: who GitHub is asked as (templates/github.js auth: the token saved in Settings →
// Integrations, else SKP_GITHUB_TOKEN).
export function templateRoutes({ api, templates, overlays, sources, audit, config, fetch, lookup, github }) {
  const tag = 'Templates';
  const r = (def) => api.route({ tag, ...def });
  const versionView = (t) => ({ version: t.version, build: t.build, source: templates.fromPlatform(t) ? 'bundled' : t.receipt?.source?.kind || 'installed', overlays: overlays.pinnedBy(t.id, t.version) });
  function summary(id) {
    const versions = templates.versions(id);
    if (!versions.length) throw new ApiError(404, 'not-found', `${id} isn't installed.`);
    const m = versions[0].manifest;
    // What a gallery card shows (08 §8.2), from the newest version: no request per card.
    return {
      id,
      name: m.name,
      category: m.category,
      description: m.description,
      ...(m.author ? { author: typeof m.author === 'string' ? m.author : m.author.name } : {}),
      tags: m.tags || [],
      canvases: (m.canvases || []).map((c) => ({ id: c.id, width: c.width, height: c.height, ...(c.default ? { default: true } : {}) })),
      previews: previewsOf(versions[0]),
      latest: versions[0].version,
      versions: versions.map(versionView),
    };
  }
  // The URLs of a version's previews, each part encoded (a space, # or % in a name); only those the
  // route serves (a version installed before previews had to be images in previews/ may list others).
  const previewsOf = (t) => (t.manifest.previews || []).filter(previewType)
    .map((p) => `/api/v1/templates/${encodeURIComponent(t.id)}/versions/${encodeURIComponent(t.version)}/${p.split('/').map(encodeURIComponent).join('/')}`);
  const sourceView = (doc) => ({ id: doc.id, ...doc.data });
  const record = (who, req, action, details) => audit.record({ action, actor: who.label, ip: req.client?.ip, ...details });

  async function install(body, req, who) {
    let fetched;
    try {
      let result;
      if (/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        let input;
        try { input = JSON.parse(body.toString('utf8')); } catch { throw new ApiError(400, 'bad-request', 'The body is not valid JSON.'); }
        if (!input || typeof input !== 'object' || typeof input.url !== 'string' || Object.keys(input).some((k) => k !== 'url')) throw new ApiError(422, 'invalid', 'Send { "url": "https://…" or "owner/name[@tag]" }, or the package itself as the body.');
        fetched = await fetchPackage(parseSource(input.url), { dir: templates.downloadDir, github, token: config.githubToken, fetch, lookup, allowPrivate: config.allowPrivateDownloads });
        result = templates.install(fetched.file, { actor: who.label, name: fetched.label, origin: fetched.origin });
      } else {
        if (!body.length) throw new ApiError(400, 'bad-request', 'Send the package (.skp or .zip) as the body, or JSON { "url" }.');
        result = templates.install(body, { actor: who.label, name: String(req.headers['x-skp-filename'] || 'upload').slice(0, 200) });
      }
      const { template, warnings, noop } = result;
      if (!noop) record(who, req, 'template.install', { target: `${template.id}@${template.version}`, build: template.build, ...(fetched ? { from: fetched.label } : {}) });
      return { status: noop ? 200 : 201, body: { id: template.id, version: template.version, build: template.build, installed: !noop, warnings } };
    } finally {
      if (fetched?.file) rmSync(fetched.file, { force: true });
    }
  }

  // The sources first: /templates/sources would otherwise be read as a template id.
  return [
    r({ method: 'GET', path: '/api/v1/templates/sources', scope: 'templates:read', summary: 'Followed template sources', paged: true, run: ({ url }) => api.paginate(sources.list().map(sourceView), url, (s) => s.id) }),
    r({ method: 'POST', path: '/api/v1/templates/sources', scope: 'templates:write', summary: 'Follow a GitHub repository or an https URL (tagPrefix: only releases whose tag starts with it)', body: { fields: ['source', 'autoUpgrade', 'template', 'tagPrefix'] }, status: 201, run: async ({ body, req, who }) => {
      if (typeof body.source !== 'string') throw new ApiError(422, 'invalid', '"source" is owner/name or an https URL.');
      const s = sources.add(body.source, { autoUpgrade: body.autoUpgrade, actor: who.label, claim: body.template, tagPrefix: body.tagPrefix ?? undefined });
      record(who, req, 'template.follow', { target: s.data.label });
      const [check] = await sources.check(s.id).catch((err) => [{ error: err.message }]);
      return { status: 201, body: { ...sourceView(s), check } };
    } }),
    r({ method: 'DELETE', path: '/api/v1/templates/sources/:ref', scope: 'templates:write', summary: 'Stop following a source (installed versions stay)', run: ({ params, req, who }) => {
      const s = sources.remove(params.ref);
      record(who, req, 'template.unfollow', { target: s.data.label });
      return { id: s.id, label: s.data.label };
    } }),
    r({ method: 'POST', path: '/api/v1/templates/sources/check', scope: 'templates:write', summary: 'Check followed sources now (?source= one)', body: { fields: [] }, query: ['source'], run: async ({ url }) => ({ items: await sources.check(url.searchParams.get('source') || undefined, { force: true }) }) }),
    r({ method: 'GET', path: '/api/v1/templates', scope: 'templates:read', summary: 'Installed templates (?category=)', paged: true, query: ['category'], run: ({ url }) => {
      const category = url.searchParams.get('category');
      const ids = [...new Set(templates.list().map((t) => t.id))].sort();
      const list = ids.map(summary).filter((t) => !category || t.category === category);
      return api.paginate(list, url);
    } }),
    r({ method: 'GET', path: '/api/v1/templates/:id', scope: 'templates:read', summary: 'A template: its newest manifest, versions and previews', run: ({ params }) => {
      const s = summary(params.id);
      const newest = templates.versions(params.id)[0];
      return { ...s, manifest: newest.manifest, previews: previewsOf(newest) };
    } }),
    r({ method: 'GET', path: '/api/v1/templates/:id/versions', scope: 'templates:read', summary: 'A template\'s installed versions, newest first', paged: true, run: ({ params, url }) => {
      // Paged like every list (03 §3.1). Newest first is SemVer order, not string order, so the
      // cursor is the last version a page gave, and the next page is what sorts below it: a
      // version installed or removed between pages neither repeats nor skips another (a place in
      // the list would shift).
      const versions = summary(params.id).versions;
      const cursor = url.searchParams.get('cursor');
      if (!cursor) return api.paginate(versions, url, (v) => v.version);
      const after = Buffer.from(cursor, 'base64url').toString('utf8');
      if (!SEMVER.test(after)) throw new ApiError(422, 'invalid', '"cursor" is the "next" of the page before.');
      const rest = new URL(url);
      rest.searchParams.delete('cursor');
      return api.paginate(versions.filter((v) => compareVersions(v.version, after) < 0), rest, (v) => v.version);
    } }),
    // An overlay pins a version (04 §4.10): its settings form and scenes come from that version's
    // manifest, which may not be the newest's.
    r({ method: 'GET', path: '/api/v1/templates/:id/versions/:version', scope: 'templates:read', summary: 'One installed version: its manifest, previews and the overlays pinned to it', run: ({ params }) => {
      const t = templates.get(params.id, params.version);
      if (!t) throw new ApiError(404, 'not-found', `${params.id}@${params.version} isn't installed.`);
      return { id: t.id, ...versionView(t), manifest: t.manifest, previews: previewsOf(t) };
    } }),
    r({ method: 'GET', path: '/api/v1/templates/:id/versions/:version/previews/*', scope: 'templates:read', summary: 'A preview image (its path in previews/)', produces: 'image/*', run: async ({ params, res }) => {
      const t = templates.get(params.id, params.version);
      // Only a path the manifest lists as a preview (validated: inside the package) and installed.
      const rel = `previews/${params['*']}`;
      const type = previewType(rel);
      if (!t || !type || !(t.manifest.previews || []).includes(rel) || !t.files?.has(rel)) throw new ApiError(404, 'not-found', 'No such preview.');
      const data = await readFile(path.join(t.dir, ...rel.split('/')));
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        // An SVG opened directly runs nothing (07 §7.1).
        'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      });
      res.end(data);
    } }),
    // 201 installed, or 200: that build of that version was installed already (nothing to do).
    r({ method: 'POST', path: '/api/v1/templates', scope: 'templates:write', summary: 'Install a package (the body) or { url }', body: { raw: true, json: ['url'], limit: PACKAGE_LIMIT }, status: [201, 200], run: ({ body, req, who }) => install(body, req, who) }),
    r({ method: 'DELETE', path: '/api/v1/templates/:id', scope: 'templates:write', summary: 'Uninstall every version, or ?version= one', query: ['version'], run: ({ params, url, req, who }) => {
      const version = url.searchParams.get('version') || undefined;
      const removed = templates.uninstall(params.id, version, { pinnedBy: overlays.pinnedBy, actor: who.label });
      record(who, req, 'template.uninstall', { target: params.id, removed: removed.map((x) => `${x.id}@${x.version}`) });
      return { removed };
    } }),
    r({ method: 'POST', path: '/api/v1/templates/validate', scope: 'templates:read', summary: 'Lint a package without installing it', body: { raw: true, limit: PACKAGE_LIMIT }, idempotent: false, run: ({ body }) => {
      let result;
      try {
        result = validatePackage(packageFromZip(bufferSource(body)));
      } catch (err) {
        throw new ApiError(422, err.code || 'invalid', `That isn't a package: ${err.message}`);
      }
      return { valid: !result.errors.length, id: result.manifest?.id, version: result.manifest?.version, errors: result.errors, warnings: result.warnings };
    } }),
  ];
}
