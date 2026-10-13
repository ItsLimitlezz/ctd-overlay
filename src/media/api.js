// Media over HTTP (03 §3.4, 10 §10.2), on the API's conventions (http/api.js):
//
//   GET    /api/v1/media                 uploaded files, newest first, with their URLs and users
//   POST   /api/v1/media?name=<name>     an upload: the file as the body (streamed, up to 600 MiB);
//                                        identified by its content, converted for OBS when ffmpeg is there
//   GET    /api/v1/media/:id
//   DELETE /api/v1/media/:id             refused while an overlay's settings use it
import { ApiError } from '../http/api.js';
import { mediaUrl } from './library.js';

export function mediaApiRoutes({ api, media, overlays, audit }) {
  const tag = 'Media';
  const r = (def) => api.route({ tag, ...def });
  const view = (doc) => ({ id: doc.id, rev: doc.rev, url: mediaUrl(doc), ...doc.data, usedBy: overlays.mediaUsers(doc.data.fileId) });
  const find = (id) => {
    const doc = typeof id === 'string' && /^med_[0-9A-Z]{26}$/.test(id) ? media.get(id) : undefined;
    if (!doc) throw new ApiError(404, 'not-found', `There is no media "${id}".`);
    return doc;
  };
  return [
    r({ method: 'GET', path: '/api/v1/media', scope: 'overlays:read', summary: 'Uploaded files, newest first', run: ({ url }) => api.paginate(media.list().map(view).sort((a, b) => (a.id < b.id ? 1 : -1)), url, (m) => `~${m.id}`.replace(/./g, (c) => String.fromCharCode(0xffff - c.charCodeAt(0)))) }),
    r({ method: 'GET', path: '/api/v1/media/:id', scope: 'overlays:read', summary: 'An uploaded file', run: ({ params }) => view(find(params.id)) }),
    r({ method: 'POST', path: '/api/v1/media', scope: 'media:write', summary: 'Upload a file (the body; ?name= what it is called)', body: { stream: true }, run: async ({ body, url, who, req }) => {
      const name = url.searchParams.get('name') || undefined;
      const doc = await media.add(body, { name, actor: who.label });
      audit.record({ action: 'media.add', actor: who.label, ip: req.client?.ip, target: doc.id, name: doc.data.name, converted: doc.data.converted });
      return { status: 201, body: view(doc) };
    } }),
    r({ method: 'DELETE', path: '/api/v1/media/:id', scope: 'media:write', summary: 'Delete a file (refused while an overlay uses it)', run: ({ params, who, req }) => {
      find(params.id);
      const doc = media.remove(params.id, { usedBy: (d) => overlays.mediaUsers(d.data.fileId) });
      audit.record({ action: 'media.remove', actor: who.label, ip: req.client?.ip, target: doc.id, name: doc.data.name });
      return { removed: doc.id };
    } }),
  ];
}
