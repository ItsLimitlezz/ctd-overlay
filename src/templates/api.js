// Templates over HTTP (03 §3.4, 04 §4.11–4.13), on the API's conventions (http/api.js):
//
//   GET    /api/v1/templates                      installed templates, one entry per id (?category=)
//   GET    /api/v1/templates/:id                  its manifest (newest version), versions, previews
//   GET    /api/v1/templates/:id/versions         its installed versions, newest first
//   GET    /api/v1/templates/:id/versions/:version/previews/:file   a preview image
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
import { packageFromZip, validatePackage } from './package.js';
import { fetchPackage, parseSource } from './sources.js';
import { bufferSource } from './zip.js';

const PACKAGE_LIMIT = 100 * 1024 * 1024; // 07 §7.11
const PREVIEW_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif' };

export function templateRoutes({ api, templates, overlays, sources, audit, config, fetch, lookup }) {
  const tag = 'Templates';
  const r = (def) => api.route({ tag, ...def });
  const versionView = (t) => ({ version: t.version, build: t.build, source: templates.fromPlatform(t) ? 'bundled' : t.receipt?.source?.kind || 'installed', overlays: overlays.pinnedBy(t.id, t.version) });
  function summary(id) {
    const versions = templates.versions(id);
    if (!versions.length) throw new ApiError(404, 'not-found', `${id} isn't installed.`);
    const m = versions[0].manifest;
    return { id, name: m.name, category: m.category, description: m.description, latest: versions[0].version, versions: versions.map(versionView) };
  }
  const previewsOf = (t) => (t.manifest.previews || []).map((p) => `/api/v1/templates/${t.id}/versions/${t.version}/${p}`);
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
        fetched = await fetchPackage(parseSource(input.url), { dir: templates.downloadDir, token: config.githubToken, fetch, lookup, allowPrivate: config.allowPrivateDownloads });
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
    r({ method: 'GET', path: '/api/v1/templates/sources', scope: 'templates:read', summary: 'Followed template sources', run: ({ url }) => api.paginate(sources.list().map(sourceView), url, (s) => s.id) }),
    r({ method: 'POST', path: '/api/v1/templates/sources', scope: 'templates:write', summary: 'Follow a GitHub repository or an https URL', body: { fields: ['source', 'autoUpgrade', 'template'] }, run: async ({ body, req, who }) => {
      if (typeof body.source !== 'string') throw new ApiError(422, 'invalid', '"source" is owner/name or an https URL.');
      const s = sources.add(body.source, { autoUpgrade: body.autoUpgrade, actor: who.label, claim: body.template });
      record(who, req, 'template.follow', { target: s.data.label });
      const [check] = await sources.check(s.id).catch((err) => [{ error: err.message }]);
      return { status: 201, body: { ...sourceView(s), check } };
    } }),
    r({ method: 'DELETE', path: '/api/v1/templates/sources/:ref', scope: 'templates:write', summary: 'Stop following a source (installed versions stay)', run: ({ params, req, who }) => {
      const s = sources.remove(params.ref);
      record(who, req, 'template.unfollow', { target: s.data.label });
      return { id: s.id, label: s.data.label };
    } }),
    r({ method: 'POST', path: '/api/v1/templates/sources/check', scope: 'templates:write', summary: 'Check followed sources now (?source= one)', body: { fields: [] }, run: async ({ url }) => ({ items: await sources.check(url.searchParams.get('source') || undefined, { force: true }) }) }),
    r({ method: 'GET', path: '/api/v1/templates', scope: 'templates:read', summary: 'Installed templates', run: ({ url }) => {
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
    r({ method: 'GET', path: '/api/v1/templates/:id/versions', scope: 'templates:read', summary: 'A template\'s installed versions, newest first', run: ({ params }) => summary(params.id).versions }),
    r({ method: 'GET', path: '/api/v1/templates/:id/versions/:version/previews/:file', scope: 'templates:read', summary: 'A preview image', run: async ({ params, res }) => {
      const t = templates.get(params.id, params.version);
      const rel = `previews/${params.file}`;
      const type = PREVIEW_TYPES[path.extname(params.file).toLowerCase()];
      if (!t || !type || !(t.manifest.previews || []).includes(rel) || !t.files?.has(rel)) throw new ApiError(404, 'not-found', 'No such preview.');
      const data = await readFile(path.join(t.dir, 'previews', params.file));
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        // An SVG opened directly runs nothing (07 §7.1).
        'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      });
      res.end(data);
    } }),
    r({ method: 'POST', path: '/api/v1/templates', scope: 'templates:write', summary: 'Install a package (the body) or { url }', body: { raw: true, limit: PACKAGE_LIMIT }, run: ({ body, req, who }) => install(body, req, who) }),
    r({ method: 'DELETE', path: '/api/v1/templates/:id', scope: 'templates:write', summary: 'Uninstall every version, or ?version= one', run: ({ params, url, req, who }) => {
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
