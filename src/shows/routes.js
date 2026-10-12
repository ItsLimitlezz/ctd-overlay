// The show API (03 §3.3), local-only until sign-in exists (http/local.js):
//
//   GET    /api/v1/shows                           every show, with resolved times and live
//   POST   /api/v1/shows                           { name, overlays, date, timezone, dayBoundary?, goLive?, lineup? }
//   GET    /api/v1/shows/:ref                      by id or name
//   PATCH  /api/v1/shows/:ref                      any of the above
//   DELETE /api/v1/shows/:ref
//   PUT    /api/v1/shows/:ref/scene                { scene, transition? }: on every member
//   POST   /api/v1/shows/:ref/triggers/:name       { args? }: to every member with the action
//   PUT    /api/v1/shows/:ref/slot                 { slot }: a lineup position or act, or null
//   POST   /api/v1/shows/:ref/rec                  { action: "start" | "reset" }
//   GET    /api/v1/shows/:ref/cues                 the timeline (09 §9.3)
//   POST   /api/v1/shows/:ref/cues                 { at: "HH:MM" | ISO, action, label? }
//   POST   /api/v1/shows/:ref/cues/build           { recipe? }: generate cues from the lineup (09 §9.5)
//   PATCH  /api/v1/shows/:ref/cues/:cueId          { at?, action?, label? }
//   DELETE /api/v1/shows/:ref/cues/:cueId
//   POST   /api/v1/shows/:ref/cues/:cueId/fire|skip|rearm   operator overrides (09 §9.4)
//   GET    /api/v1/shows/:ref/plans · POST (a planned show, 09 §9.6) · DELETE …/plans/:planId
//   PUT    /api/v1/overlays/:ref/scene             an overlay outside a show
//   POST   /api/v1/overlays/:ref/actions/:name     one overlay's action
import { jsonBody, refusedHere } from '../http/local.js';
import { sendJson, sendProblem } from '../http/server.js';
import { ShowError } from './registry.js';

const BODY_LIMIT = 64 * 1024;
const TITLES = { 404: 'Not found', 409: 'Conflict', 422: 'Not possible' };

export function showRoutes({ shows, timeline, hosts, log }) {
  // Every route: the local guard, the JSON body, and ShowErrors as problems.
  const route = (method, path, run) => ({
    method,
    path,
    async handler({ req, res, params }) {
      if (refusedHere(req, res, hosts)) return;
      const body = method === 'GET' || method === 'DELETE' ? {} : await jsonBody(req, res, BODY_LIMIT);
      if (body === undefined) return;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendProblem(res, 400, 'Bad request', 'The body must be a JSON object.');
      try {
        const [status, value] = run(params, body);
        sendJson(res, status, value);
      } catch (err) {
        if (err instanceof ShowError) return sendProblem(res, err.status, TITLES[err.status] || 'Refused', err.message, { type: `https://skp.dev/errors/${err.code}` });
        if (err.name === 'ConflictError') return sendProblem(res, 409, 'conflict', 'The show changed meanwhile; read it again and retry.');
        log.error('a show request failed', { method, path, err });
        throw err;
      }
    },
  });
  return [
    route('GET', '/api/v1/shows', () => [200, shows.list()]),
    route('POST', '/api/v1/shows', (_p, body) => [201, shows.create(body, { actor: 'local' })]),
    route('GET', '/api/v1/shows/:ref', (p) => [200, shows.get(p.ref)]),
    route('PATCH', '/api/v1/shows/:ref', (p, body) => [200, shows.update(p.ref, body)]),
    route('DELETE', '/api/v1/shows/:ref', (p) => [200, shows.remove(p.ref)]),
    route('PUT', '/api/v1/shows/:ref/scene', (p, body) => [200, shows.take(p.ref, body.scene, { transition: body.transition ?? 'fade', actor: 'local' })]),
    route('POST', '/api/v1/shows/:ref/triggers/:name', (p, body) => [200, shows.trigger(p.ref, p.name, { args: body.args ?? {}, actor: 'local' })]),
    route('PUT', '/api/v1/shows/:ref/slot', (p, body) => [200, shows.setSlot(p.ref, body.slot === undefined ? undefined : body.slot)]),
    route('POST', '/api/v1/shows/:ref/rec', (p, body) => [200, shows.rec(p.ref, body.action)]),
    // The timeline (09 §9.3–9.6).
    route('GET', '/api/v1/shows/:ref/cues', (p) => [200, timeline.list(p.ref)]),
    route('POST', '/api/v1/shows/:ref/cues', (p, body) => [201, timeline.add(p.ref, body, { actor: 'local' })]),
    route('POST', '/api/v1/shows/:ref/cues/build', (p, body) => [200, timeline.build(p.ref, body.recipe)]),
    route('PATCH', '/api/v1/shows/:ref/cues/:cueId', (p, body) => [200, timeline.update(p.ref, p.cueId, body)]),
    route('DELETE', '/api/v1/shows/:ref/cues/:cueId', (p) => [200, timeline.remove(p.ref, p.cueId)]),
    route('POST', '/api/v1/shows/:ref/cues/:cueId/:op', (p) => [200, timeline.override(p.ref, p.cueId, p.op, { actor: 'local' })]),
    route('GET', '/api/v1/shows/:ref/plans', (p) => [200, timeline.plans.list(p.ref)]),
    route('POST', '/api/v1/shows/:ref/plans', (p, body) => [201, timeline.plans.add(p.ref, body)]),
    route('DELETE', '/api/v1/shows/:ref/plans/:planId', (p) => [200, timeline.plans.remove(p.ref, p.planId)]),
    route('PUT', '/api/v1/overlays/:ref/scene', (p, body) => [200, shows.takeOverlay(p.ref, body.scene, { transition: body.transition ?? 'fade', actor: 'local' })]),
    route('POST', '/api/v1/overlays/:ref/actions/:name', (p, body) => [200, shows.fireOverlay(p.ref, p.name, { args: body.args ?? {}, actor: 'local' })]),
  ];
}
