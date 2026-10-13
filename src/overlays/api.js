// Overlay keys over HTTP (03 §3.4, 07 §7.6), signed in (auth/routes.js):
//
//   GET   /api/v1/overlays/:ref/url          the overlay's URLs for OBS, one per canvas, with its key
//   POST  /api/v1/overlays/:ref/key/rotate   a new key: the old URL stops working, in OBS too
//   PATCH /api/v1/overlays/:ref              { keyRequired: false | true } ("no key required",
//                                            local and lan modes only); the rest of an overlay's
//                                            fields come with the overlays API (step 13)
//
// The URL shows the key, so reading it needs overlays:read; rotating, or changing whether a key
// is needed, overlays:write. Both go to the audit log.
import { jsonBody } from '../http/local.js';
import { sendJson, sendProblem } from '../http/server.js';
import { OverlayError } from './registry.js';

const BODY_LIMIT = 4096;

export function overlayKeyRoutes({ overlays, guard, audit, base }) {
  const route = (method, path, scope, run) => ({
    method,
    path,
    async handler({ req, res, params }) {
      const who = guard(req, res, scope);
      if (!who) return;
      const body = method === 'GET' ? {} : await jsonBody(req, res, BODY_LIMIT);
      if (body === undefined) return;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendProblem(res, 400, 'Bad request', 'The body must be a JSON object.');
      try {
        const [status, value] = run({ params, body, who, req });
        sendJson(res, status, value);
      } catch (err) {
        if (err instanceof OverlayError) {
          const status = err.code === 'not-found' ? 404 : err.code === 'public-needs-key' ? 409 : 422;
          return sendProblem(res, status, status === 404 ? 'Not found' : 'Refused', err.message, { type: `https://skp.dev/errors/${err.code}` });
        }
        throw err;
      }
    },
  });
  const slugOf = (ref) => overlays.resolve(ref)?.doc.data.slug ?? ref;
  return [
    route('GET', '/api/v1/overlays/:ref/url', 'overlays:read', ({ params, req }) => [200, { overlay: slugOf(params.ref), urls: overlays.urls(params.ref, base(req)) }]),
    route('POST', '/api/v1/overlays/:ref/key/rotate', 'overlays:write', ({ params, who, req }) => {
      overlays.rotateKey(params.ref);
      audit.record({ action: 'overlay.key-rotate', actor: who.label, ip: req.client?.ip, target: slugOf(params.ref) });
      return [200, { overlay: slugOf(params.ref), urls: overlays.urls(params.ref, base(req)), note: 'The old URL no longer works: update the OBS browser sources that use it.' }];
    }),
    route('PATCH', '/api/v1/overlays/:ref', 'overlays:write', ({ params, body, who, req }) => {
      const unknown = Object.keys(body).filter((k) => k !== 'keyRequired');
      if (unknown.length) throw new OverlayError(`Only "keyRequired" can be changed here for now; not ${unknown.join(', ')}.`, 'invalid');
      if (typeof body.keyRequired !== 'boolean') throw new OverlayError('"keyRequired" is true or false.', 'invalid');
      const doc = overlays.setKeyRequired(params.ref, body.keyRequired);
      audit.record({ action: 'overlay.key-required', actor: who.label, ip: req.client?.ip, target: doc.data.slug, required: body.keyRequired });
      return [200, { overlay: doc.data.slug, keyRequired: overlays.keyRequired(doc) }];
    }),
  ];
}
